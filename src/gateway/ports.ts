// Port discovery: scan [min,max] for a free port (no privilege needed, >1024).
import { createServer, type Server } from 'node:net';

function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const s: Server = createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, host);
  });
}

export { isFree };

/** Find a free port in [min,max]; if none, let the OS assign one. */
export async function findFreePort(min: number, max: number, host = '127.0.0.1'): Promise<number> {
  for (let p = min; p <= max; p++) {
    if (await isFree(p, host)) return p;
  }
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.listen(0, host, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('failed to assign port'))));
    });
    s.on('error', reject);
  });
}
