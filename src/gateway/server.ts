// HTTP + WebSocket gateway. REST under /api/v1 (Bearer), hook under /hooks (localhost),
// /pair Bearer-exempt (auth = one-time code C, the bootstrap channel).
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { ServerContext } from '../context';
import { handleRest } from '../api/rest';
import { handlePreToolUse } from '../api/hooks';
import { handlePair } from '../api/pair';
import { attachWs } from '../api/ws';
import { extractBearer, verifyToken } from './auth';
import { log, safeFailure } from '../util/logger';
import { sendJson } from '../api/http';
import { toClientFailure } from '../api/failure';

function isLocalhost(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export async function startServer(ctx: ServerContext): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';

    if (path.startsWith('/hooks/')) {
      if (!isLocalhost(req)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (path === '/hooks/pre-tool-use') {
        await handlePreToolUse(ctx.hooks, req, res);
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    // Bootstrap channel: Bearer-exempt, authenticated by the one-time pairing code C.
    // NOT localhost-restricted: the phone reaches it via the overlay's -n->loopback map
    // (which presents as 127.0.0.1 to the backend anyway); the code C is the sole gate.
    if (path === '/pair') {
      try {
        await handlePair(ctx, req, res);
      } catch (e) {
        log.error('pair handler error', safeFailure(e));
        sendJson(res, 500, { error: 'internal' });
      }
      return;
    }

    if (path.startsWith('/api/v1/')) {
      if (!verifyToken(extractBearer(req), ctx.config.token ?? '')) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        await handleRest(ctx, req, res);
      } catch (e) {
        // [L] malformed JSON body -> 400 (readJsonBody rethrows JSON.parse SyntaxError), not 500.
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { error: 'invalid json body' });
          return;
        }
        log.error('rest error', { path, ...safeFailure(e) });
        const failure = toClientFailure(e);
        sendJson(res, failure.status, { error: failure.code, retryable: failure.retryable, category: failure.category, summary: failure.summary });
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  attachWs(ctx, server);

  // §10 I7: broadcast a net change notification on every overlay state transition
  // (start/stop/restart/exit/error). The listener runs synchronously from the state setter;
  // it awaits a fresh net snapshot then broadcasts to all authenticated WS clients.
  ctx.overlay.onStateChange(async (overlay) => {
    try {
      const net = await ctx.net.getStatus();
      await ctx.netNotifier.broadcast({ net, overlay });
    } catch (e) {
      log.warn('net change notify failed', { err: String(e) });
    }
  });

  return new Promise((resolve, reject) => {
    // #7: a listen-time error (EADDRINUSE / EACCES / port-not-allowed) must reject
    // startServer -- without this the promise hangs and callers proceed as if the gateway
    // were up. One-shot: removed once listening so a later runtime error surfaces via the
    // server's own error path, not misattributed to startup.
    let settled = false;
    const onError = (err: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      server.off('error', onError);
      reject(err);
    };
    server.on('error', onError);
    server.listen(ctx.port, ctx.config.gateway.bindHost, () => {
      if (settled) return;
      settled = true;
      server.off('error', onError);
      log.info('gateway listening', { host: ctx.config.gateway.bindHost, port: ctx.port });
      resolve(server);
    });
  });
}
