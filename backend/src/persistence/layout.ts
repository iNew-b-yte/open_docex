/**
 * The data folder layout (LLD Part 2 §10.1, HLD §14 path traversal).
 *
 * Every per-document path is derived from a `docKey`, the lowercase hex SHA-256 of the UTF-8
 * document ID. Raw document IDs, refs or asset IDs never become path segments: each path
 * builder checks its key or ID against a strict hex pattern first.
 *
 * ```
 * <dataDir>/
 *   LOCK  LAYOUT
 *   docs/<k0k1>/<docKey>/{meta.json, snapshot.json, journal/, assets/}
 *   local-storage/  tmp/
 * ```
 *
 * @module
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentId } from '@open-docex/shared/ids';
import { OpenDocexError } from '@open-docex/shared/errors';
import { engineError } from '../errors/engine-error.js';
import { writeFileAtomic } from './atomic-file.js';

/** The layout version this code writes and reads (the `LAYOUT` file). */
export const LAYOUT_VERSION = 1;
/** Folder mode on POSIX (LLD Part 2 §20). Windows ignores it. */
export const DIR_MODE = 0o700;
/** File mode on POSIX (LLD Part 2 §20). Windows ignores it. */
export const FILE_MODE = 0o600;

const HEX64 = /^[0-9a-f]{64}$/;

/** Returns the `docKey` of a document: `sha256hex(utf8(documentId))`. */
export function docKeyOf(documentId: DocumentId): string {
  return createHash('sha256').update(documentId, 'utf8').digest('hex');
}

/** True when `x` is a well-formed `docKey` (64 lowercase hex characters). */
export function isDocKey(x: unknown): x is string {
  return typeof x === 'string' && HEX64.test(x);
}

/**
 * Throws unless `docKey` is well formed. Every path builder calls this, so a raw string can
 * never reach the file system.
 *
 * @throws {Error} a programming error, not an engine error: callers only pass `docKeyOf` output.
 */
export function assertDocKey(docKey: string): void {
  if (!isDocKey(docKey)) throw new TypeError('Invalid docKey: expected 64 lowercase hex characters.');
}

/** `<dataDir>/LOCK` (§7 boot step 3). */
export function lockPath(dataDir: string): string {
  return path.join(dataDir, 'LOCK');
}

/** `<dataDir>/LAYOUT`. */
export function layoutPath(dataDir: string): string {
  return path.join(dataDir, 'LAYOUT');
}

/** `<dataDir>/docs`. */
export function docsRoot(dataDir: string): string {
  return path.join(dataDir, 'docs');
}

/** `<dataDir>/local-storage`, the default `LocalFsStorage` root. */
export function localStorageRoot(dataDir: string): string {
  return path.join(dataDir, 'local-storage');
}

/** `<dataDir>/tmp`, emptied at boot. */
export function tmpRoot(dataDir: string): string {
  return path.join(dataDir, 'tmp');
}

/** `<dataDir>/docs/<k0k1>/<docKey>`. */
export function docDir(dataDir: string, docKey: string): string {
  assertDocKey(docKey);
  return path.join(docsRoot(dataDir), docKey.slice(0, 2), docKey);
}

/** `<docDir>/meta.json`. */
export function metaPath(dataDir: string, docKey: string): string {
  return path.join(docDir(dataDir, docKey), 'meta.json');
}

/** `<docDir>/snapshot.json`. */
export function snapshotPath(dataDir: string, docKey: string): string {
  return path.join(docDir(dataDir, docKey), 'snapshot.json');
}

/** `<docDir>/journal`. */
export function journalDir(dataDir: string, docKey: string): string {
  return path.join(docDir(dataDir, docKey), 'journal');
}

/** `<docDir>/assets`. */
export function assetsDir(dataDir: string, docKey: string): string {
  return path.join(docDir(dataDir, docKey), 'assets');
}

/**
 * Boot step 2 (LLD Part 2 §7) plus the `LAYOUT` check: creates the data folder and its fixed
 * subfolders (0o700 on POSIX), writes `LAYOUT` when missing, refuses a newer layout, and
 * probes writability with a write, `datasync` and unlink in `tmp/`.
 *
 * @throws {OpenDocexError} `CONFIG_DATA_DIR_UNWRITABLE` on any failure, or when `LAYOUT` holds
 *   a value other than a known version.
 */
export async function ensureLayout(dataDir: string): Promise<void> {
  try {
    for (const dir of [dataDir, docsRoot(dataDir), localStorageRoot(dataDir), tmpRoot(dataDir)]) {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
    }
    await checkLayoutFile(dataDir);
    const probe = path.join(tmpRoot(dataDir), `.probe-${randomBytes(8).toString('hex')}`);
    const fh = await open(probe, 'wx', FILE_MODE);
    try {
      await fh.write('probe');
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await unlink(probe);
  } catch (err) {
    if (err instanceof OpenDocexError) throw err;
    throw engineError('CONFIG_DATA_DIR_UNWRITABLE', { message: 'The data folder is not writable.', cause: err });
  }
}

async function checkLayoutFile(dataDir: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(layoutPath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFileAtomic(layoutPath(dataDir), String(LAYOUT_VERSION));
    return;
  }
  const text = raw.trim();
  const version = /^\d+$/.test(text) ? Number(text) : NaN;
  if (version === LAYOUT_VERSION) return;
  if (version > LAYOUT_VERSION) {
    throw engineError('CONFIG_DATA_DIR_UNWRITABLE', {
      message: `The data folder was written by a newer version (LAYOUT ${version}).`,
    });
  }
  throw engineError('CONFIG_DATA_DIR_UNWRITABLE', { message: 'The data folder has an unreadable LAYOUT file.' });
}

/**
 * Boot step 4 (LLD Part 2 §7): removes everything inside `tmp/`, keeping the folder itself.
 */
export async function emptyTmp(dataDir: string): Promise<void> {
  const root = tmpRoot(dataDir);
  await mkdir(root, { recursive: true, mode: DIR_MODE });
  for (const name of await readdir(root)) {
    await rm(path.join(root, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
