// Short-lived, local artifact store used to bridge image bytes between the phone and the
// native CLI. Bytes never leave through a backend HTTP client: the only HTTP surface is the
// authenticated phone gateway, and adapters receive an ordinary private local file path.
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ArtifactRef } from '../adapters/types';
import { createPrivateRuntimeSubdirectory, ensurePrivateDirectory } from '../util/private-file';
import { sanitizeImageMetadata } from './sanitize';

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_STORE_BYTES = 256 * 1024 * 1024;
export const MAX_ARTIFACT_STORE_ITEMS = 512;
export const SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type SupportedImageMime = typeof SUPPORTED_IMAGE_MIMES[number];

export interface StoredArtifact {
  ref: ArtifactRef;
  path: string;
}

const EXTENSION: Record<SupportedImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function isSupportedMime(value: string): value is SupportedImageMime {
  return (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(value);
}

function hasExpectedMagic(data: Buffer, mime: SupportedImageMime): boolean {
  if (mime === 'image/png') {
    return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === 'image/gif') {
    const header = data.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

function safeName(value: string | undefined, mime: SupportedImageMime): string {
  const original = basename((value ?? '').replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 160);
  const fallback = 'image' + EXTENSION[mime];
  if (!original || original === '.' || original === '..') return fallback;
  return extname(original) ? original : original + EXTENSION[mime];
}

export class ArtifactStore {
  private readonly root: string;
  private readonly items = new Map<string, StoredArtifact>();
  private disposed = false;
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly maxItems: number;

  constructor(root?: string, limits: { maxBytes?: number; maxItems?: number } = {}) {
    // A neutral prefix avoids adding product/remote-control markers to CLI-visible paths.
    this.root = root ?? createPrivateRuntimeSubdirectory('.tmp-');
    if (root) ensurePrivateDirectory(root);
    this.maxBytes = limits.maxBytes ?? MAX_ARTIFACT_STORE_BYTES;
    this.maxItems = limits.maxItems ?? MAX_ARTIFACT_STORE_ITEMS;
  }

  put(data: Buffer, mimeValue: string, name?: string): StoredArtifact {
    if (this.disposed) throw new Error('artifact store disposed');
    if (!isSupportedMime(mimeValue)) throw new Error('unsupported artifact mime');
    if (data.length === 0 || data.length > MAX_ARTIFACT_BYTES) throw new Error('artifact size is invalid');
    if (!hasExpectedMagic(data, mimeValue)) throw new Error('artifact content does not match mime');
    // Enforce at the backend trust boundary rather than relying on a particular Android build.
    // Never fall back to original bytes: malformed metadata containers fail closed.
    const sanitized = sanitizeImageMetadata(data, mimeValue);
    if (sanitized.length === 0 || sanitized.length > MAX_ARTIFACT_BYTES || !hasExpectedMagic(sanitized, mimeValue)) {
      throw new Error('sanitized artifact is invalid');
    }
    // Bound aggregate disk use as well as individual requests. Artifacts are intentionally
    // short-lived and the whole private store is released on a normal daemon restart.
    if (this.items.size >= this.maxItems || this.totalBytes + sanitized.length > this.maxBytes) {
      throw new Error('artifact store capacity reached');
    }

    const artifactId = randomUUID();
    const path = join(this.root, artifactId + EXTENSION[mimeValue]);
    writeFileSync(path, sanitized, { flag: 'wx', mode: 0o600 });
    const ref: ArtifactRef = {
      artifactId,
      name: safeName(name, mimeValue),
      mime: mimeValue,
      size: sanitized.length,
      sha256: createHash('sha256').update(sanitized).digest('hex'),
      createdAt: new Date().toISOString(),
    };
    const stored = { ref, path };
    this.items.set(artifactId, stored);
    this.totalBytes += sanitized.length;
    return stored;
  }

  putBase64(base64: string, mime: string, name?: string): StoredArtifact {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      throw new Error('invalid artifact base64');
    }
    const data = Buffer.from(base64, 'base64');
    // A canonical round trip prevents Buffer.from()'s permissive decoder accepting junk.
    if (data.toString('base64') !== base64) throw new Error('invalid artifact base64');
    return this.put(data, mime, name);
  }

  get(artifactId: string): StoredArtifact | undefined {
    return this.items.get(artifactId);
  }

  resolveAll(ids: readonly string[]): StoredArtifact[] {
    if (ids.length > 4) throw new Error('too many attachments');
    const seen = new Set<string>();
    return ids.map((id) => {
      if (!/^[0-9a-f-]{36}$/i.test(id) || seen.has(id)) throw new Error('invalid artifact id');
      seen.add(id);
      const value = this.items.get(id);
      if (!value) throw new Error('artifact not found');
      return value;
    });
  }

  read(artifactId: string): Buffer | undefined {
    const value = this.items.get(artifactId);
    return value ? readFileSync(value.path) : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.items.clear();
    this.totalBytes = 0;
    rmSync(this.root, { recursive: true, force: true });
  }
}
