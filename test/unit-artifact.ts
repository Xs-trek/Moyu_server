import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { ArtifactStore } from '../src/artifacts/store';
import { sanitizeImageMetadata } from '../src/artifacts/sanitize';

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function pngWithMetadata(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('Software\0Android Camera GPS=1,2')),
    pngChunk('eXIf', Buffer.from('Make=Phone;Model=Secret')),
    pngChunk('vpAg', Buffer.from('private frontend marker')),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpegWithMetadata(): Buffer {
  const segment = (marker: number, payload: Buffer): Buffer => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
  };
  const sof = Buffer.from([8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const sos = Buffer.from([3, 1, 0, 2, 0, 3, 0, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, Buffer.from('Exif\0\0GPS Make=Phone Model=Secret')),
    segment(0xfe, Buffer.from('Android encoder comment')),
    segment(0xc0, sof),
    segment(0xda, sos),
    Buffer.from([0x12, 0xff, 0x00, 0x34]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from('trailing device marker'),
  ]);
}

function webpChunk(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from(type, 'ascii'), size, payload, payload.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function webpWithMetadata(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x2c; // ICC + EXIF + XMP flags, all cleared by the sanitizer
  const vp8l = Buffer.from([0x2f, 0, 0, 0, 0]); // structural 1x1 lossless payload
  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    webpChunk('VP8X', vp8x),
    webpChunk('ICCP', Buffer.from('Phone colour profile')),
    webpChunk('EXIF', Buffer.from('GPS Make Model')),
    webpChunk('XMP ', Buffer.from('<device>Android</device>')),
    webpChunk('VP8L', vp8l),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function gifWithMetadata(): Buffer {
  const comment = Buffer.from('Phone Android GPS!!');
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
    Buffer.from([0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0]),
    Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('APPDEVICE01', 'ascii'), Buffer.from([3, 1, 2, 3, 0]),
    Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'), Buffer.from([3, 1, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
    Buffer.from('trailing phone marker'),
  ]);
}

const fixtures = [
  { mime: 'image/png', name: 'camera.png', input: pngWithMetadata(), forbidden: ['Android Camera', 'Make=Phone', 'frontend marker'] },
  { mime: 'image/jpeg', name: 'camera.jpg', input: jpegWithMetadata(), forbidden: ['GPS Make=Phone', 'Android encoder', 'trailing device'] },
  { mime: 'image/webp', name: 'camera.webp', input: webpWithMetadata(), forbidden: ['Phone colour', 'GPS Make Model', '<device>'] },
  { mime: 'image/gif', name: 'camera.gif', input: gifWithMetadata(), forbidden: ['Phone Android', 'APPDEVICE01', 'trailing phone'] },
] as const;

for (const fixture of fixtures) {
  const sanitized = sanitizeImageMetadata(fixture.input, fixture.mime);
  for (const marker of fixture.forbidden) assert.equal(sanitized.includes(Buffer.from(marker)), false, `${fixture.mime} retained ${marker}`);
  assert.ok(sanitized.length < fixture.input.length, `${fixture.mime} metadata was not removed`);
}

const root = mkdtempSync(join(tmpdir(), 'artifact-test-'));
try {
  const store = new ArtifactStore(root);
  const png = pngWithMetadata();
  const expected = sanitizeImageMetadata(png, 'image/png');
  const stored = store.put(png, 'image/png', '../screen');
  assert.equal(stored.ref.name, 'screen.png');
  assert.deepEqual(readFileSync(stored.path), expected);
  assert.equal(stored.ref.size, expected.length);
  assert.equal(stored.ref.sha256, createHash('sha256').update(expected).digest('hex'));
  assert.equal(store.resolveAll([stored.ref.artifactId])[0]?.path, stored.path);
  if (process.platform !== 'win32') assert.equal(statSync(stored.path).mode & 0o777, 0o600);
  assert.throws(() => store.put(Buffer.from('not an image'), 'image/png', 'bad.png'), /content/);
  assert.throws(() => store.put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'), /structure/);
  assert.throws(() => store.resolveAll([stored.ref.artifactId, stored.ref.artifactId]), /invalid artifact id/);

  const boundedRoot = mkdtempSync(join(tmpdir(), 'artifact-capacity-'));
  const bounded = new ArtifactStore(boundedRoot, { maxBytes: expected.length, maxItems: 1 });
  bounded.put(png, 'image/png', 'one.png');
  assert.throws(() => bounded.put(png, 'image/png', 'two.png'), /capacity/);
  bounded.dispose();

  store.dispose();
  assert.throws(() => store.put(png, 'image/png'), /disposed/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('unit-artifact: metadata stripped, bounded store ok');
