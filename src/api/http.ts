// Small HTTP helpers shared by REST + hook handlers.
import type { IncomingMessage, ServerResponse } from 'node:http';

export function readJsonBody(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Read the object-shaped JSON bodies used by REST commands. Arrays, scalars and null are
 * rejected at the boundary so route handlers never accidentally dereference untrusted JSON. */
export async function readJsonObject(req: IncomingMessage, limit = 1 << 20): Promise<Record<string, unknown>> {
  const value = await readJsonBody(req, limit);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('json object required');
  }
  return value as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = body === null ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (body !== null) headers['content-length'] = String(Buffer.byteLength(data));
  res.writeHead(status, headers);
  res.end(data);
}

export function parseQuery(url: string): Record<string, string> {
  const q = url.split('?')[1];
  if (!q) return {};
  const out: Record<string, string> = {};
  for (const part of q.split('&')) {
    const [k, v] = part.split('=');
    if (k) {
      // [M] decodeURIComponent throws URIError on malformed encoding (%zz). parseQuery is called
      // at handleRest top (server.ts try) so it only 500s, but keep it non-throwing + tolerant:
      // a bad-encoded value should not break the whole query parse.
      let dk = k;
      let dv = v ?? '';
      try { dk = decodeURIComponent(k); } catch { /* keep raw key */ }
      if (v) {
        try { dv = decodeURIComponent(v); } catch { /* keep raw value */ }
      }
      out[dk] = dv;
    }
  }
  return out;
}
