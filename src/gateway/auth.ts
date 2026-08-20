// Bearer token verification (S1). Constant-time compare; token generated first-run.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function extractBearer(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim();
  }
  // Never accept a long-lived gateway credential from a URL. Query strings are routinely
  // copied into diagnostics and proxy/access logs; WebSocket upgrades support Authorization.
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
