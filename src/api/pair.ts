// /pair endpoint (F1): the bootstrap channel. Bearer-EXEMPT (the phone has no token
// pre-pairing); authenticated solely by the one-time code C. Single-use: a correct C is
// consumed on first use; replays get 401. Wired in server.ts alongside /hooks (both are
// the only Bearer-exempt paths; /hooks is localhost-only, /pair is gated by C).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerContext } from '../context';
import { log } from '../util/logger';
import { readJsonObject, sendJson } from './http';

export async function handlePair(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (!ctx.pairing.isActive()) {
    sendJson(res, 409, { error: 'pairing not active (start it on the PC with `moyu -pair`)' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req);
  } catch (e) {
    log.warn('pair: bad body', { err: String(e) });
    sendJson(res, 400, { error: 'bad body' });
    return;
  }
  const handoff = ctx.pairing.verifyAndConsume(typeof body.code === 'string' ? body.code : undefined);
  if (!handoff) {
    sendJson(res, 401, { error: 'invalid or consumed code' });
    return;
  }
  sendJson(res, 200, handoff);
  log.info('pair: handoff delivered, tearing down pairing overlay');
  // Tear down the transient pairing network now that creds are conveyed (fail-closed).
  ctx.pairing.stop().catch((e) => log.warn('pair: teardown error', { err: String(e) }));
}
