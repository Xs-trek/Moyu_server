// Container-level image metadata removal for phone-originated artifacts.
//
// The provider receives image pixels through the native CLI, so merely hiding the original
// filename is insufficient: EXIF/XMP/text chunks can contain GPS, device model and encoder
// identifiers. Keep the encoded pixels/animation intact, retain only format chunks required for
// rendering, and fail closed on malformed input. This deliberately does not claim to erase
// statistical camera/encoder fingerprints from the compressed pixels themselves.

export const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 16_384;

function invalid(): never {
  throw new Error('artifact image structure is invalid');
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    invalid();
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sanitizePng(input: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (input.length < 8 || !input.subarray(0, 8).equals(signature)) invalid();
  const kept: Buffer[] = [signature];
  // Critical image chunks plus bounded, non-text visual/animation chunks. Unknown ancillary
  // chunks are safe for a decoder to ignore and may carry arbitrary private data, so drop them.
  const allowed = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sBIT', 'gAMA', 'cHRM', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT']);
  const knownCritical = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (offset < input.length) {
    if (offset + 12 > input.length) invalid();
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > input.length) invalid();
    const typeBytes = input.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    const payload = input.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = input.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, payload])) !== expectedCrc) invalid();
    const critical = (typeBytes[0]! & 0x20) === 0;
    if (critical && !knownCritical.has(type)) invalid();

    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) invalid();
      checkDimensions(payload.readUInt32BE(0), payload.readUInt32BE(4));
      sawHeader = true;
    } else if (type === 'IHDR') invalid();
    if (type === 'IDAT' || type === 'fdAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawData) invalid();
      sawEnd = true;
    }
    if (allowed.has(type)) kept.push(Buffer.from(input.subarray(offset, end)));
    offset = end;
    if (sawEnd) {
      // Bytes after IEND are never image data and can be a covert metadata trailer.
      if (offset !== input.length) invalid();
      break;
    }
  }
  if (!sawHeader || !sawData || !sawEnd) invalid();
  return Buffer.concat(kept);
}

function isJpegStandalone(marker: number): boolean {
  return marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7);
}

function isJpegSof(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function sanitizeJpeg(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) invalid();
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawEnd = false;
  while (offset < input.length) {
    if (input[offset] !== 0xff) invalid();
    const markerStart = offset;
    while (offset < input.length && input[offset] === 0xff) offset++;
    if (offset >= input.length || input[offset] === 0x00) invalid();
    const marker = input[offset++]!;
    if (marker === 0xd8) invalid();
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      sawEnd = true;
      break; // discard any non-image trailer after EOI
    }
    if (isJpegStandalone(marker)) {
      out.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (offset + 2 > input.length) invalid();
    const length = input.readUInt16BE(offset);
    if (length < 2 || offset + length > input.length) invalid();
    const segmentEnd = offset + length;
    if (isJpegSof(marker)) {
      if (length < 8) invalid();
      const height = input.readUInt16BE(offset + 3);
      const width = input.readUInt16BE(offset + 5);
      const components = input[offset + 7]!;
      checkDimensions(width, height);
      // Four-component JPEG relies on Adobe APP14 interpretation (CMYK/YCCK). Since all APP
      // metadata is removed, reject it instead of silently changing the rendered colours.
      if (components !== 1 && components !== 3) invalid();
      sawFrame = true;
    }
    const strip = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!strip) out.push(Buffer.from(input.subarray(markerStart, segmentEnd)));
    offset = segmentEnd;

    if (marker === 0xda) {
      if (!sawFrame) invalid();
      sawScan = true;
      const entropyStart = offset;
      while (offset < input.length) {
        if (input[offset] !== 0xff) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (next < input.length && input[next] === 0xff) next++;
        if (next >= input.length) invalid();
        const code = input[next]!;
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
          offset = next + 1;
          continue;
        }
        break;
      }
      out.push(Buffer.from(input.subarray(entropyStart, offset)));
    }
  }
  if (!sawFrame || !sawScan || !sawEnd) invalid();
  return Buffer.concat(out);
}

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

function webpDimensions(type: string, payload: Buffer): [number, number] | null {
  if (type === 'VP8X') {
    if (payload.length !== 10) invalid();
    return [readUInt24LE(payload, 4) + 1, readUInt24LE(payload, 7) + 1];
  }
  if (type === 'VP8 ') {
    if (payload.length < 10 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) invalid();
    return [payload.readUInt16LE(6) & 0x3fff, payload.readUInt16LE(8) & 0x3fff];
  }
  if (type === 'VP8L') {
    if (payload.length < 5 || payload[0] !== 0x2f) invalid();
    return [1 + payload[1]! + ((payload[2]! & 0x3f) << 8), 1 + ((payload[2]! >> 6) | (payload[3]! << 2) | ((payload[4]! & 0x0f) << 10))];
  }
  return null;
}

function webpChunk(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from(type, 'ascii'), size, payload, payload.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function sanitizeWebp(input: Buffer): Buffer {
  if (input.length < 20 || input.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      input.subarray(8, 12).toString('ascii') !== 'WEBP' || input.readUInt32LE(4) + 8 !== input.length) invalid();
  const allowed = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);
  const chunks: Buffer[] = [];
  let offset = 12;
  let sawPixels = false;
  let dimensions: [number, number] | null = null;
  while (offset < input.length) {
    if (offset + 8 > input.length) invalid();
    const type = input.subarray(offset, offset + 4).toString('ascii');
    const length = input.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    const chunkEnd = payloadEnd + (length & 1);
    if (chunkEnd > input.length) invalid();
    let payload = Buffer.from(input.subarray(payloadStart, payloadEnd));
    const foundDimensions = webpDimensions(type, payload);
    if (foundDimensions) {
      if (dimensions && type === 'VP8X') invalid();
      dimensions ??= foundDimensions;
      checkDimensions(foundDimensions[0], foundDimensions[1]);
    }
    if (type === 'VP8X') {
      // Clear ICC, EXIF and XMP presence bits. Retain alpha and animation flags.
      payload[0] = payload[0]! & ~0x2c;
    }
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') sawPixels = true;
    if (allowed.has(type)) chunks.push(webpChunk(type, payload));
    offset = chunkEnd;
  }
  if (offset !== input.length || !sawPixels || !dimensions) invalid();
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function gifSubBlocksEnd(input: Buffer, start: number): number {
  let offset = start;
  while (offset < input.length) {
    const length = input[offset++]!;
    if (length === 0) return offset;
    if (offset + length > input.length) invalid();
    offset += length;
  }
  return invalid();
}

function sanitizeGif(input: Buffer): Buffer {
  const version = input.subarray(0, 6).toString('ascii');
  if ((version !== 'GIF87a' && version !== 'GIF89a') || input.length < 14) invalid();
  const width = input.readUInt16LE(6);
  const height = input.readUInt16LE(8);
  checkDimensions(width, height);
  const out: Buffer[] = [Buffer.from(input.subarray(0, 13))];
  let offset = 13;
  const packed = input[10]!;
  if (packed & 0x80) {
    const tableBytes = 3 * (1 << ((packed & 0x07) + 1));
    if (offset + tableBytes > input.length) invalid();
    out.push(Buffer.from(input.subarray(offset, offset + tableBytes)));
    offset += tableBytes;
  }
  let images = 0;
  let trailer = false;
  while (offset < input.length) {
    const introducer = input[offset]!;
    if (introducer === 0x3b) {
      out.push(Buffer.from([0x3b]));
      trailer = true;
      break; // discard any trailer bytes
    }
    if (introducer === 0x2c) {
      if (offset + 10 > input.length) invalid();
      let dataStart = offset + 10;
      const imagePacked = input[offset + 9]!;
      if (imagePacked & 0x80) dataStart += 3 * (1 << ((imagePacked & 0x07) + 1));
      if (dataStart + 1 > input.length) invalid();
      const end = gifSubBlocksEnd(input, dataStart + 1); // skip LZW minimum code size
      out.push(Buffer.from(input.subarray(offset, end)));
      offset = end;
      images++;
      continue;
    }
    if (introducer !== 0x21 || offset + 2 > input.length) invalid();
    const label = input[offset + 1]!;
    if (label === 0xf9) {
      if (offset + 8 > input.length || input[offset + 2] !== 4 || input[offset + 7] !== 0) invalid();
      out.push(Buffer.from(input.subarray(offset, offset + 8)));
      offset += 8;
      continue;
    }
    if (label === 0xff) {
      const blockLength = input[offset + 2];
      if (blockLength === undefined || offset + 3 + blockLength > input.length) invalid();
      const appId = input.subarray(offset + 3, offset + 3 + blockLength).toString('ascii');
      const end = gifSubBlocksEnd(input, offset + 3 + blockLength);
      // Preserve animation looping only, reconstructed canonically so an application extension
      // cannot smuggle extra device metadata alongside the loop count.
      const blocks = input.subarray(offset + 3 + blockLength, end);
      if (blockLength === 11 && (appId === 'NETSCAPE2.0' || appId === 'ANIMEXTS1.0') &&
          blocks.length === 5 && blocks[0] === 3 && blocks[1] === 1 && blocks[4] === 0) {
        out.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'), Buffer.from(blocks));
      }
      offset = end;
      continue;
    }
    // Comment, plain-text and unknown extension blocks are non-visual and may contain arbitrary
    // frontend/device identifiers. All use GIF data sub-block framing after their fixed header;
    // plain text has a 12-byte header block which is covered by the generic first-block skip.
    const firstLength = input[offset + 2];
    if (firstLength === undefined || offset + 3 + firstLength > input.length) invalid();
    offset = gifSubBlocksEnd(input, offset + 3 + firstLength);
  }
  if (!trailer || images === 0) invalid();
  return Buffer.concat(out);
}

export function sanitizeImageMetadata(data: Buffer, mime: string): Buffer {
  if (mime === 'image/png') return sanitizePng(data);
  if (mime === 'image/jpeg') return sanitizeJpeg(data);
  if (mime === 'image/webp') return sanitizeWebp(data);
  if (mime === 'image/gif') return sanitizeGif(data);
  throw new Error('unsupported artifact mime');
}
