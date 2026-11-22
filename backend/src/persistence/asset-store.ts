/**
 * `AssetStore`: content-addressed images per document (LLD Part 2 §10.5, HLD CL-8, §14).
 *
 * An asset is stored at `assets/<sha256hex>`. The MIME type is sniffed from the magic bytes on
 * both `put` and `get`, so no type is stored and none is trusted from the client. Allowed types
 * are the shared `AssetMime` set: PNG, JPEG and GIF (§0 PO-24). Assets are not garbage
 * collected before V6.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetMime } from '@open-docex/shared/protocol';
import { isAssetId } from '@open-docex/shared/ids';
import { engineError } from '../errors/engine-error.js';
import { writeFileAtomic } from './atomic-file.js';
import { assetsDir, DIR_MODE } from './layout.js';

export type { AssetMime };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function startsWith(b: Uint8Array, sig: readonly number[]): boolean {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}

/** Returns the MIME type from `bytes`' magic number, or `null` when it is not allowed. */
export function sniffAssetMime(bytes: Uint8Array): AssetMime | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif';
  return null;
}

/** Stores and serves a document's images. */
export class AssetStore {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  /** The document's asset folder, passed to codec threads. */
  dir(docKey: string): string {
    return assetsDir(this.#dataDir, docKey);
  }

  /**
   * Stores `bytes` and returns their ID (SHA-256 hex) and sniffed MIME type. Idempotent: an
   * existing asset is not rewritten. The write is atomic.
   *
   * @throws {OpenDocexError} `PROTOCOL_OP_REJECTED` when the bytes are not PNG, JPEG or GIF.
   */
  async put(docKey: string, bytes: Uint8Array): Promise<{ id: string; mime: AssetMime }> {
    const mime = sniffAssetMime(bytes);
    if (mime === null) throw engineError('PROTOCOL_OP_REJECTED', { message: 'Unsupported image type.' });
    const id = createHash('sha256').update(bytes).digest('hex');
    const dir = this.dir(docKey);
    const file = path.join(dir, id);
    try {
      await access(file);
      return { id, mime };
    } catch {
      // not stored yet
    }
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await writeFileAtomic(file, bytes);
    return { id, mime };
  }

  /**
   * Returns the asset, or `null` when `id` is not a 64-character lowercase hex string, is not
   * stored for this document, or no longer sniffs as an allowed type.
   */
  async get(docKey: string, id: string): Promise<{ bytes: Uint8Array; mime: AssetMime } | null> {
    if (!isAssetId(id)) return null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path.join(this.dir(docKey), id)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const mime = sniffAssetMime(bytes);
    return mime === null ? null : { bytes, mime };
  }
}
