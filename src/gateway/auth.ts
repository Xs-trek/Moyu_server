// Bearer token verification (S1). Constant-time compare; token generated first-run.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function extractBearer(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim();
  }
  // WS upgrade may carry ?token=
  const url = req.url ?? '';
  const m = /[?&]token=([^&]+)/.exec(url);
  if (m && m[1]) {
    // [M] decodeURIComponent throws URIError on malformed encoding (e.g. %zz). Callers are
    // outside try/catch (server.ts REST path is async -> unhandledRejection; ws.ts upgrade is
    // a sync event handler -> uncaughtException) -> process crash = unauthenticated remote DoS
    // (overlay -n maps a peer onto 127.0.0.1). Treat bad encoding as no token -> 401.
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function verifyToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
