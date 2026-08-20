import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_ARTIFACT_BYTES } from './store';

/** Bounded binary reader for authenticated artifact uploads. It drains an oversized request so
 * the route can still return a structured 413 instead of destroying the socket mid-response. */
export function readArtifactBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
      req.resume();
      reject(new Error('artifact too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new Error('artifact too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export function sendArtifact(res: ServerResponse, data: Buffer, mime: string, name: string): void {
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'content-type': mime,
    'content-length': String(data.length),
    'content-disposition': `inline; filename="${asciiName}"`,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}
