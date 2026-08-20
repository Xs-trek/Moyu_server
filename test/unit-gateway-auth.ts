import type { IncomingMessage } from 'node:http';
import { extractBearer, verifyToken } from '../src/gateway/auth';

function request(url: string, authorization?: string): IncomingMessage {
  return { url, headers: authorization ? { authorization } : {} } as IncomingMessage;
}

const token = 'unit-gateway-token';
if (extractBearer(request('/api/v1/ws', `Bearer ${token}`)) !== token) {
  throw new Error('Bearer header was not extracted');
}
if (extractBearer(request(`/api/v1/ws?token=${encodeURIComponent(token)}`)) !== undefined) {
  throw new Error('URL query credential must not be accepted');
}
if (extractBearer(request('/api/v1/ws', `Basic ${token}`)) !== undefined) {
  throw new Error('non-Bearer authorization must not be accepted');
}
if (!verifyToken(token, token) || verifyToken(token + '-wrong', token)) {
  throw new Error('constant-time token verification contract failed');
}

console.log('unit-gateway-auth: ok');
