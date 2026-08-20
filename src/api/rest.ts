// REST /api/v1/* routes (Bearer-protected; auth checked in server.ts before dispatch).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerContext } from '../context';
import { applyPatch } from '../config/loader';
import { sanitizeConfig, validateConfigPatch } from '../config/schema';
import type { AdapterKind, ConfigPatch } from '../config/schema';
import type { SwitchableAdapter } from '../accounts/service';
import type { PermissionMode, ReasoningEffort } from '../adapters/types';
import { listDir } from '../fs/service';
import { diffRepo } from '../vcs/git';
import { log, setLogLevel, safeFailure } from '../util/logger';
import { getPlatform, getArch } from '../util/platform';
import { readJsonBody, readJsonObject, sendJson, parseQuery } from './http';
import { MAX_INPUT_TEXT_CHARS } from './ws';
import { createInboundPolicy } from '../net/types';
import { verifyToken } from '../gateway/auth';
import { resolveCliDefaultModel, resolveEffectiveModel } from '../adapters/effective-model';
import { readArtifactBody, sendArtifact } from '../artifacts/http';
import { toClientFailure } from './failure';
import {
  listNativeSessions,
  MAX_NATIVE_LIST_OFFSET,
  pageNativeMessages,
  readNativeSession,
  type NativeHistoryKind,
} from '../history/native';

function notFound(res: ServerResponse, path: string): void {
  sendJson(res, 404, { error: 'not found', path });
}

function isSwitchable(kind: string): kind is SwitchableAdapter {
  return kind === 'claude' || kind === 'codex';
}

export async function handleRest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? '';
  const method = req.method ?? 'GET';
  const q = parseQuery(url);

  // PC-local daemon lifecycle control. Normal /api/v1 auth was already checked by server.ts,
  // but that bearer is also held by the paired phone. Require a second secret that never leaves
  // the PC before allowing a remote-triggerable process shutdown.
  if (path === '/api/v1/admin/exit' && method === 'POST') {
    const provided = req.headers['x-moyu-control'];
    if (!verifyToken(typeof provided === 'string' ? provided : undefined, ctx.config.controlToken ?? '')) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    sendJson(res, 202, { ok: true });
    setImmediate(() => ctx.requestShutdown('cli-exit'));
    return;
  }

  // Pair-session administration is also PC-only. A paired phone holds the gateway bearer for
  // normal product APIs, but may not create credential handoff sessions or keep a second overlay
  // alive. The bearer-exempt /pair bootstrap remains separately gated by the one-time code.
  if (path.startsWith('/api/v1/pair/')) {
    const provided = req.headers['x-moyu-control'];
    if (!verifyToken(typeof provided === 'string' ? provided : undefined, ctx.config.controlToken ?? '')) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
  }

  if (path === '/api/v1/server/info' && method === 'GET') {
    const adapters = (await ctx.adapters.refreshStatus()).map((status) => {
      if (!isSwitchable(status.kind)) return status;
      // Local presentation metadata only. This reads the selected profile's existing CLI files
      // and environment; it never starts the CLI and never probes an AI provider.
      const profileEnv = ctx.accounts.resolveActiveEnv(status.kind, ctx.config);
      const cliDefaultModel = resolveCliDefaultModel(status.kind, ctx.config, profileEnv);
      const effectiveModel = resolveEffectiveModel(status.kind, ctx.config, profileEnv);
      const modelOverride = ctx.config.adapters[status.kind].model?.trim() || undefined;
      return {
        ...status,
        ...(cliDefaultModel ? { cliDefaultModel } : {}),
        ...(effectiveModel ? { effectiveModel } : {}),
        ...(modelOverride ? { modelOverride } : {}),
      };
    });
    sendJson(res, 200, {
      platform: getPlatform(),
      arch: getArch(),
      port: ctx.port,
      startedAt: ctx.startedAt,
      adapters,
      defaultAdapter: ctx.config.defaultAdapter,
      approvalTimeoutSec: ctx.config.approvalTimeoutSec,
      // v3: account-switching status + init auto-reminder (setupHint when unconfigured).
      accountSwitching: ctx.accounts.getAccountSwitchingStatus(ctx.config),
    });
    return;
  }

  if (path === '/api/v1/artifacts' && method === 'POST') {
    const rawMime = req.headers['content-type'];
    const mime = (Array.isArray(rawMime) ? rawMime[0] : rawMime ?? '').split(';')[0]!.trim().toLowerCase();
    const name = (q.name ?? 'image').slice(0, 200);
    try {
      const data = await readArtifactBody(req);
      const stored = ctx.artifacts.put(data, mime, name);
      sendJson(res, 201, stored.ref);
    } catch (error) {
      const summary = String(error);
      const status = summary.includes('capacity') ? 507
        : summary.includes('too large') || summary.includes('size') ? 413
          : summary.includes('mime') ? 415 : 400;
      sendJson(res, status, {
        error: status === 507 ? 'artifact_capacity'
          : status === 413 ? 'artifact_too_large'
            : status === 415 ? 'unsupported_artifact_type' : 'invalid_artifact',
      });
    }
    return;
  }

  let artifact = /^\/api\/v1\/artifacts\/([0-9a-fA-F-]{36})$/.exec(path);
  if (artifact && method === 'GET') {
    const stored = ctx.artifacts.get(artifact[1]!);
    if (!stored) return notFound(res, path);
    const data = ctx.artifacts.read(stored.ref.artifactId);
    if (!data) return notFound(res, path);
    sendArtifact(res, data, stored.ref.mime, stored.ref.name);
    return;
  }

  if (path === '/api/v1/native-sessions' && method === 'GET') {
    const rawLimit = q.limit === undefined ? 50 : Number(q.limit);
    const rawOffset = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      sendJson(res, 400, { error: 'limit must be an integer from 1 to 100' });
      return;
    }
    if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > MAX_NATIVE_LIST_OFFSET) {
      sendJson(res, 400, { error: `offset must be an integer from 0 to ${MAX_NATIVE_LIST_OFFSET}` });
      return;
    }
    try {
      sendJson(res, 200, await listNativeSessions(ctx.config, ctx.accounts, rawLimit, rawOffset));
    } catch (error) {
      sendJson(res, 400, { error: safeFailure(error).summary });
    }
    return;
  }

  let native = new RegExp(`^/api/v1/native-sessions/(claude|codex)/([0-9a-fA-F-]{36})/messages$`).exec(path);
  if (native && method === 'GET') {
    const after = q.after === undefined ? 0 : Number(q.after);
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      sendJson(res, 400, { error: 'after must be a non-negative integer and limit must be an integer from 1 to 100' });
      return;
    }
    let record;
    try {
      record = await readNativeSession(native[1] as NativeHistoryKind, native[2]!, ctx.config, ctx.accounts);
    } catch (error) {
      sendJson(res, 400, { error: safeFailure(error).summary });
      return;
    }
    if (!record) return notFound(res, path);
    sendJson(res, 200, pageNativeMessages(record, after, limit));
    return;
  }

  native = new RegExp(`^/api/v1/native-sessions/(claude|codex)/([0-9a-fA-F-]{36})/resume$`).exec(path);
  if (native && method === 'POST') {
    let record;
    try {
      record = await readNativeSession(native[1] as NativeHistoryKind, native[2]!, ctx.config, ctx.accounts);
    } catch (error) {
      sendJson(res, 400, { error: safeFailure(error).summary });
      return;
    }
    if (!record) return notFound(res, path);
    const sessionId = await ctx.sessions.create(record.item.kind, {
      cliSessionRef: record.item.nativeSessionId,
      cwd: record.item.cwd,
      title: record.item.title,
      profileId: record.selection.profileId,
      profileEnv: record.selection.profileEnv,
      displayModel: record.item.model,
      seedMessages: record.messages,
    });
    sendJson(res, 201, { sessionId, session: ctx.sessions.summary(sessionId) });
    return;
  }

  if (path === '/api/v1/sessions' && method === 'GET') {
    sendJson(res, 200, ctx.sessions.list());
    return;
  }

  if (path === '/api/v1/sessions/snapshot' && method === 'GET') {
    const limit = Number(q.limit ?? 50);
    sendJson(res, 200, ctx.sessions.listSnapshot(q.cursor, Number.isFinite(limit) ? limit : 50));
    return;
  }

  if (path === '/api/v1/sessions' && method === 'POST') {
    const body = await readJsonObject(req);
    if (typeof body.kind !== 'string' || !body.kind) {
      sendJson(res, 400, { error: 'kind required' });
      return;
    }
    // [L] unknown kind -> 400 (not 500): create(kind as never) would throw adapter-not-registered
    // upstream -> server.ts catch -> 500.
    if (!ctx.adapters.has(body.kind)) {
      sendJson(res, 400, { error: 'adapter is not registered' });
      return;
    }
    // v3: resolve the active profile's env (subscription switching) for switchable adapters.
    // Claude injects profile env; Codex injects the selected CODEX_HOME path. Resolved live.
    const stringLimits: Array<[string, number]> = [
      ['profileId', 256], ['model', 128], ['effort', 16], ['permissionMode', 16], ['title', 256], ['cwd', 4096], ['cliSessionRef', 512],
    ];
    for (const [field, limit] of stringLimits) {
      const value = body[field];
      if (value !== undefined && (typeof value !== 'string' || value.length > limit)) {
        sendJson(res, 400, { error: `${field} must be a string <= ${limit} chars` });
        return;
      }
    }
    const profileIdRequested = body.profileId as string | undefined;
    const model = body.model as string | undefined;
    const effort = body.effort as ReasoningEffort | undefined;
    const permissionMode = body.permissionMode as PermissionMode | undefined;
    const title = body.title as string | undefined;
    const cwd = body.cwd as string | undefined;
    const cliSessionRef = body.cliSessionRef as string | undefined;
    let profileEnv: Record<string, string> | undefined;
    let profileId: string | undefined;
    let displayModel: string | undefined;
    try {
      if (isSwitchable(body.kind)) {
        const profile = ctx.accounts.selectedProfile(body.kind, profileIdRequested, ctx.config);
        profileId = profile.id;
        profileEnv = ctx.accounts.resolveEnv(profile);
      }
      displayModel = resolveEffectiveModel(body.kind as AdapterKind, ctx.config, profileEnv, model);
    } catch (error) {
      const failure = toClientFailure(error);
      sendJson(res, failure.status, {
        error: failure.code,
        retryable: failure.retryable,
        category: failure.category,
        summary: failure.summary,
      });
      return;
    }
    const sessionId = await ctx.sessions.create(body.kind as never, {
      cwd,
      title,
      cliSessionRef,
      profileEnv,
      profileId,
      model,
      displayModel,
      effort,
      permissionMode,
    });
    sendJson(res, 201, { sessionId, session: ctx.sessions.summary(sessionId) });
    return;
  }

  let m = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path);
  if (m) {
    if (method === 'GET') {
      const s = ctx.sessions.summary(m[1]!);
      if (!s) {
        notFound(res, path);
        return;
      }
      sendJson(res, 200, s);
      return;
    }
    if (method === 'DELETE') {
      await ctx.sessions.dispose(m[1]!);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  m = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
  if (m && method === 'GET') {
    // [L] consistency: missing session -> 404 (not 500). history() throws on missing session
    // -> server.ts catch -> 500; summary/diff return 404. getCwd mirrors the diff route.
    if (ctx.sessions.getCwd(m[1]!) === null) {
      notFound(res, path);
      return;
    }
    const after = Number(q.after ?? 0);
    sendJson(res, 200, ctx.sessions.history(m[1]!, after));
    return;
  }

  m = /^\/api\/v1\/sessions\/([^/]+)\/sync$/.exec(path);
  if (m && method === 'GET') {
    if (!ctx.sessions.get(m[1]!)) return notFound(res, path);
    const after = Number(q.after ?? 0);
    const messageAfter = q.messageAfter === undefined ? undefined : Number(q.messageAfter);
    const limit = Number(q.limit ?? 256);
    sendJson(res, 200, ctx.sessions.sync(
      m[1]!,
      Number.isFinite(after) ? Math.max(0, after) : 0,
      Number.isFinite(limit) ? limit : 256,
      messageAfter !== undefined && Number.isFinite(messageAfter) ? Math.max(0, messageAfter) : undefined,
    ));
    return;
  }

  if (path === '/api/v1/transport/metrics' && method === 'GET') {
    const net = await ctx.net.getStatus();
    const session = q.sessionId ? ctx.sessions.summary(q.sessionId) : null;
    if (q.sessionId && !session) return notFound(res, path);
    sendJson(res, 200, {
      observedAt: new Date().toISOString(),
      phoneBackendRttMs: null,
      phoneBackendRttSource: 'client-ws-ping',
      session: session ? { sessionId: session.sessionId, ...session.transport } : null,
      relay: net.publicNode
        ? { latencyMs: net.publicNode.latencyMs ?? null, reliable: net.publicNode.reliable, source: 'relay-tcp-connect' }
        : null,
      limitations: ['phoneBackendRttMs is measured by the client', 'cliFirstEventMs is aggregate, not provider one-way latency'],
    });
    return;
  }

  // §9 I6: workspace diff for a session's cwd. Token-protected (auth gate covers /api/v1/*).
  // Non-Git dir -> 200 {repo:false} (distinguishable, NOT 500); missing session -> 404.
  m = /^\/api\/v1\/sessions\/([^/]+)\/diff$/.exec(path);
  if (m && method === 'GET') {
    const cwd = ctx.sessions.getCwd(m[1]!);
    if (cwd === null) {
      notFound(res, path);
      return;
    }
    const result = await diffRepo(cwd);
    sendJson(res, 200, result);
    return;
  }

  m = /^\/api\/v1\/sessions\/([^/]+)\/input$/.exec(path);
  if (m && method === 'POST') {
    // N2: missing session -> 404 (not 500). send() throws 'session not found' on missing,
    // which would surface as 500 via server.ts catch; validate up front (mirrors history/diff).
    if (!ctx.sessions.get(m[1]!)) return notFound(res, path);
    const body = await readJsonObject(req);
    const attachmentIds = body.attachments === undefined ? [] : body.attachments;
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string')) {
      sendJson(res, 400, { error: 'attachments must be an array of artifact ids' });
      return;
    }
    if (typeof body.text !== 'string' || (!body.text && attachmentIds.length === 0)) {
      sendJson(res, 400, { error: 'text or attachment required' });
      return;
    }
    // N6: REST /input length cap, symmetric with WS (MAX_INPUT_TEXT_CHARS). Prevents
    // unbounded text from being enqueued via the REST path that WS already rejects.
    if (body.text.length > MAX_INPUT_TEXT_CHARS) {
      sendJson(res, 400, { error: `text exceeds ${MAX_INPUT_TEXT_CHARS} chars` });
      return;
    }
    let resolvedAttachments;
    try {
      resolvedAttachments = attachmentIds.length === 0
        ? []
        : ctx.artifacts.resolveAll(attachmentIds as string[]).map(({ ref, path }) => ({ ...ref, path }));
    } catch (error) {
      sendJson(res, 400, { error: safeFailure(error).summary });
      return;
    }
    const seq = await ctx.sessions.send(m[1]!, { text: body.text, attachments: resolvedAttachments });
    sendJson(res, 202, { ok: true, seq });
    return;
  }

  m = /^\/api\/v1\/sessions\/([^/]+)\/effort$/.exec(path);
  if (m && method === 'POST') {
    if (!ctx.sessions.get(m[1]!)) return notFound(res, path);
    const body = await readJsonObject(req);
    const raw = body.effort;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      sendJson(res, 400, { error: 'effort must be a string or null' });
      return;
    }
    try {
      const session = await ctx.sessions.setEffort(m[1]!, (raw || undefined) as ReasoningEffort | undefined);
      sendJson(res, 200, { ok: true, session });
    } catch (error) {
      sendJson(res, 409, { error: safeFailure(error).summary });
    }
    return;
  }

  m = /^\/api\/v1\/sessions\/([^/]+)\/model$/.exec(path);
  if (m && method === 'POST') {
    if (!ctx.sessions.get(m[1]!)) return notFound(res, path);
    const body = await readJsonObject(req);
    const raw = body.model;
    if (raw !== null && raw !== undefined && (typeof raw !== 'string' || raw.length > 128)) {
      sendJson(res, 400, { error: 'model must be a string <= 128 chars or null' });
      return;
    }
    try {
      const session = await ctx.sessions.setModel(m[1]!, typeof raw === 'string' ? raw : undefined);
      sendJson(res, 200, { ok: true, session });
    } catch (error) {
      sendJson(res, 409, { error: safeFailure(error).summary });
    }
    return;
  }

  m = /^\/api\/v1\/sessions\/([^/]+)\/permission-mode$/.exec(path);
  if (m && method === 'POST') {
    if (!ctx.sessions.get(m[1]!)) return notFound(res, path);
    const body = await readJsonObject(req);
    const raw = body.permissionMode;
    if (typeof raw !== 'string' || !['plan', 'auto', 'acceptEdits'].includes(raw)) {
      sendJson(res, 400, { error: 'permissionMode must be plan, auto or acceptEdits' });
      return;
    }
    try {
      const session = await ctx.sessions.setPermissionMode(m[1]!, raw as PermissionMode);
      sendJson(res, 200, { ok: true, session });
    } catch (error) {
      sendJson(res, 409, { error: safeFailure(error).summary });
    }
    return;
  }

  m = /^\/api\/v1\/sessions\/([^/]+)\/interrupt$/.exec(path);
  if (m && method === 'POST') {
    // N2: missing session -> 404 (not 500). interrupt() throws on missing session.
    if (!ctx.sessions.get(m[1]!)) return notFound(res, path);
    await ctx.sessions.interrupt(m[1]!);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/v1/fs/list' && method === 'GET') {
    const entries = await listDir(q.path ?? process.cwd());
    sendJson(res, 200, entries);
    return;
  }

  if (path === '/api/v1/net/status' && method === 'GET') {
    const net = await ctx.net.getStatus();
    sendJson(res, 200, { ...net, overlay: ctx.overlay.getState() });
    return;
  }

  if (path === '/api/v1/net/status' && method === 'POST') {
    // Mobile client reports its IPv6 availability to refine the dead-zone verdict.
    const body = await readJsonObject(req);
    if (body.mobileV6Available !== undefined && typeof body.mobileV6Available !== 'boolean') {
      sendJson(res, 400, { error: 'mobileV6Available must be a boolean' });
      return;
    }
    const refreshed = typeof ctx.net.refresh === 'function'
      ? await ctx.net.refresh(body.mobileV6Available as boolean | undefined)
      : await ctx.net.getStatus();
    const net = refreshed;
    // §10 I7: notify all WS clients of the refreshed net snapshot.
    await ctx.netNotifier.broadcast({ net, overlay: ctx.overlay.getState() });
    sendJson(res, 200, { ...net, overlay: ctx.overlay.getState() });
    return;
  }

  if (path === '/api/v1/net/join-params' && method === 'GET') {
    // Mobile join params (includes network-secret). Authenticated endpoint only;
    // do NOT expose via /config (S4/S6). Convey to the trusted client (S5). Real-network
    // params (post-pairing refresh); the initial bootstrap uses /pair instead.
    sendJson(res, 200, ctx.overlay.mobileJoinParams(ctx.port));
    return;
  }

  if (path === '/api/v1/net/overlay' && method === 'POST') {
    // Control the overlay: { action: 'start' | 'stop' | 'restart' }
    const body = await readJsonObject(req);
    const action = body.action;
    if (action === 'start') {
      await ctx.overlay.start();
    } else if (action === 'stop') {
      await ctx.overlay.stop();
    } else if (action === 'restart') {
      await ctx.overlay.restart();
    } else {
      sendJson(res, 400, { error: 'action must be start|stop|restart' });
      return;
    }
    sendJson(res, 200, ctx.overlay.getState());
    return;
  }

  // Pairing admin (Bearer-protected). The phone triggers NONE of these before pairing --
  // it has no token pre-pairing. `moyu -pair` (PC CLI) calls /pair/start, displays the
  // one-time code, then returns immediately; the gateway owns timeout and cleanup.
  if (path === '/api/v1/pair/start' && method === 'POST') {
    try {
      const result = await ctx.pairing.start();
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 409, { error: safeFailure(e).summary });
    }
    return;
  }

  if (path === '/api/v1/pair/stop' && method === 'POST') {
    await ctx.pairing.stop();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/v1/pair/status' && method === 'GET') {
    sendJson(res, 200, ctx.pairing.getStatus());
    return;
  }

  if (path === '/api/v1/config' && method === 'GET') {
    sendJson(res, 200, sanitizeConfig(ctx.config));
    return;
  }

  if (path === '/api/v1/config' && method === 'PATCH') {
    const body = await readJsonBody(req);
    // P2: validate before mutating -- applyPatch trusts the JSON shape, so a string
    // approvalTimeoutSec -> NaN or a bad enum could otherwise persist into runtime config.
    const errors = validateConfigPatch(body);
    if (errors.length > 0) {
      sendJson(res, 400, { error: 'invalid config patch', details: errors });
      return;
    }
    ctx.config = applyPatch(ctx.config, body as ConfigPatch);
    // Apply runtime-affecting config LIVE (review P1: PATCH must reconfigure, not just reassign).
    // Adapters capture approvalTimeoutSec + adapterConfig at construction, so reconfigure them or
    // new sessions spawn with stale config. Logger level, NetProbe's publicNode, and the running
    // overlay are likewise reconfigured. (accounts/gateway/token read ctx.config at request-time.)
    ctx.adapters.reconfigureAll(ctx.config.approvalTimeoutSec, ctx.config.adapters);
    setLogLevel(ctx.config.logLevel);
    ctx.net.setPublicNode?.(ctx.config.network.publicNode);
    ctx.net.setInboundPolicy?.(
      createInboundPolicy(ctx.config.gateway.bindHost, ctx.config.network.backendMapCidr),
    );
    try {
      await ctx.overlay.reconfigure(ctx.config.network);
    } catch (e) {
      log.warn('overlay reconfigure failed (non-fatal)', { err: String(e) });
    }
    // §10 I7: notify config hot-update. If the overlay restarted, onStateChange already
    // broadcast the transition; this covers non-overlay config changes too (logLevel, etc.).
    try {
      const net = await ctx.net.getStatus();
      await ctx.netNotifier.broadcast({ net, overlay: ctx.overlay.getState() });
    } catch (e) {
      log.warn('config-change net notify failed (non-fatal)', { err: String(e) });
    }
    sendJson(res, 200, sanitizeConfig(ctx.config));
    return;
  }

  // v3: account/subscription switching (discovery + activate). No probe: account availability
  // is never tested by the tool -- failures surface through the normal session event flow.
  if (path === '/api/v1/accounts' && method === 'GET') {
    sendJson(res, 200, ctx.accounts.getAccountSwitchingStatus(ctx.config));
    return;
  }

  if (path === '/api/v1/accounts/activate' && method === 'POST') {
    const body = await readJsonObject(req);
    if (typeof body.adapter !== 'string' || typeof body.profileId !== 'string' ||
        !body.profileId || !isSwitchable(body.adapter)) {
      sendJson(res, 400, { error: 'adapter (claude|codex) and profileId required' });
      return;
    }
    try {
      ctx.accounts.activate(body.adapter, body.profileId, ctx.config);
    } catch (e) {
      sendJson(res, 400, { error: safeFailure(e).summary });
      return;
    }
    sendJson(res, 200, ctx.accounts.getAccountSwitchingStatus(ctx.config));
    return;
  }

  log.warn('rest 404', { method, path });
  notFound(res, path);
}
