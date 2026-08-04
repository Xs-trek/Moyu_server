// Claude PreToolUse HTTP hook endpoint (P2). localhost-only, no Bearer (for the route).
// Security: MUST respond 2xx + {hookSpecificOutput:{permissionDecision:"deny"}} to block;
// non-2xx/timeout = non-blocking (tool continues). Fail-closed -> deny on any error.
//
// F8: the gateway shares 127.0.0.1:gwPort with the overlay data plane, and EasyTier's
// `-n 127.0.0.1/32->VIP` maps the overlay peer onto loopback (it appears as 127.0.0.1), so
// the localhost-only route check does NOT stop an overlay peer from POSTing to /hooks. The
// per-session shared secret closes that: the claude CLI sends `Authorization: Bearer <secret>`
// (interpolated from its spawn env via headers+allowedEnvVars), and the backend verifies it.
// An overlay peer has no way to obtain the ephemeral per-session secret. Fail-closed: a
// missing/mismatched secret -> 200+deny (NOT 401; non-2xx would let the tool proceed = fail-open).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../util/logger';
import { readJsonBody, sendJson } from './http';

// #1: HookHandler return is `unknown` (was ClaudeHookResponse) so the same registry serves both
// adapters: claude handlers return ClaudeHookResponse, codex handlers return CodexHookResponse.
export type HookHandler = (payload: unknown) => Promise<unknown>;

interface HookEntry {
  handler: HookHandler;
  /** Per-session shared secret (F8). Undefined only for legacy/no-auth registrations. */
  secret?: string;
  /** §8: backend sessionId that OWNS this hook key. The key is Claude's actual session_id
   *  (cliSessionRef), which is what claude sends in payload.session_id -- NOT the backend
   *  sessionId (they differ on resume). Owner tracking lets us reject two backend sessions
   *  resuming the same Claude session instead of silently overwriting each other's handler. */
  owner: string;
}

export class HookRegistry {
  private m = new Map<string, HookEntry>();

  /**
   * §8: register a PreToolUse hook under Claude's ACTUAL session_id (cliSessionRef = the id
   * claude reports in payload.session_id), owned by the backend sessionId.
   *  - register + unregister use the SAME key (cliSessionRef), so a resumed session's hook is
   *    cleaned up on dispose (previously dispose unregistered backend sessionId, leaving the
   *    cliSessionRef-keyed handler leaked).
   *  - Two backend sessions resuming the same Claude session (same key, different owner) are
   *    REJECTED: the second register throws instead of overwriting the first's handler (which
   *    would misroute the first session's approvals to the second). Same-owner re-register is
   *    allowed (idempotent re-init).
   */
  register(key: string, owner: string, h: HookHandler, secret?: string): void {
    const existing = this.m.get(key);
    if (existing && existing.owner !== owner) {
      throw new Error(
        `hook key already owned by another session (§8 duplicate resume): key=${key} owner=${owner} existing=${existing.owner}`,
      );
    }
    this.m.set(key, { handler: h, secret, owner });
  }

  /** §8: unregister only if the owner matches, so a disposed session can't evict another
   *  session's hook. No-op if the key is absent or owned by someone else. */
  unregister(key: string, owner: string): void {
    const existing = this.m.get(key);
    if (existing && existing.owner === owner) this.m.delete(key);
  }

  get(key: string): HookEntry | undefined {
    return this.m.get(key);
  }
}

/** Constant-time Bearer-secret check. Returns false on any deviation (never throws). */
export function verifyHookSecret(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') return false;
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Length compare first so timingSafeEqual gets equal-length buffers (it throws otherwise).
  if (!got || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
}

// Fail-closed deny. MUST carry hookEventName:"PreToolUse" so it is honored by BOTH adapters:
//  - codex's output parser REQUIRES hookSpecificOutput.hookEventName=="PreToolUse" or it treats
//    the response as unrecognized and FAILS OPEN (proceeds). Without hookEventName a gateway
//    error would let a codex tool run -- exactly the opposite of fail-closed.
//  - claude code docs likewise REQUIRE hookEventName in hookSpecificOutput ("requires a
//    hookEventName field set to the event name"); omitting it -> permissionDecision not
//    reliably honored -> fail-open. (Earlier comment claiming the validated path "omits it
//    without issue" was an unverified assertion, refuted by the official docs; toClaude now
//    carries hookEventName too, consistent with this DENY.)
const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'deny' as const,
    permissionDecisionReason: 'denied by remote-dashboard gateway',
  },
};

export async function handlePreToolUse(
  registry: HookRegistry,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  let payload: ClaudeHookPayload | null;
  try {
    payload = (await readJsonBody(req)) as ClaudeHookPayload | null;
  } catch (e) {
    log.warn('hook: bad body (deny)', { err: String(e) });
    sendJson(res, 200, DENY);
    return;
  }
  // #1: routing key. Claude sends payload.session_id (= cliSessionRef, claude's real session
  // id). Codex exec's PreToolUse COMMAND hook relay cannot use payload.session_id -- codex's
  // thread_id is assigned on first turn and is NOT the backend sessionId -- so the relay command
  // sends X-Moyu-Session: <backend sessionId> and the registry is keyed by that. Header wins.
  const hdrSession = req.headers['x-moyu-session'];
  const headerSession = Array.isArray(hdrSession) ? hdrSession[0] : hdrSession;
  const routingKey =
    typeof headerSession === 'string' && headerSession
      ? headerSession
      : payload?.session_id ?? undefined;
  if (!routingKey) {
    log.warn('hook: no routing key (deny)');
    sendJson(res, 200, DENY);
    return;
  }
  const entry = registry.get(routingKey);
  if (!entry) {
    log.warn('hook: no handler for key (deny)', { key: routingKey });
    sendJson(res, 200, DENY);
    return;
  }
  // F8: verify the per-session shared secret. The overlay's -n->loopback map makes an
  // overlay peer appear as 127.0.0.1, so the route's localhost-only check is insufficient;
  // this secret (sent by the CLI / codex relay via Authorization: Bearer) is the real gate.
  if (entry.secret && !verifyHookSecret(req, entry.secret)) {
    log.warn('hook: bad/missing secret (deny)', { key: routingKey });
    sendJson(res, 200, DENY);
    return;
  }
  try {
    const resp = await entry.handler(payload);
    // Always 2xx + JSON; deny to block, allow to proceed.
    sendJson(res, 200, resp);
  } catch (e) {
    log.error('hook handler error (deny)', { err: String(e) });
    sendJson(res, 200, DENY);
  }
}
