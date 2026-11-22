/**
 * `LocalFsStorage`: the built-in {@link StorageAdapter} over a local folder (LLD Part 2 §11.2,
 * HLD §14 path traversal).
 *
 * A ref is a relative path with `/` separators, confined to `root`. Every rejected ref fails
 * with `DOCUMENT_NOT_FOUND` and a generic message; the reason is logged only, and the ref
 * itself is never logged.
 *
 * Versions are `${mtimeNs}:${size}`. `write` stages a temporary file in the target's folder,
 * checks the version, then renames over the target. The gap between that check and the
 * rename is not atomic: only an outside editor writing the same file can race it.
 *
 * Parent folders of a ref are not created: writing into a missing folder fails with
 * `STORAGE_WRITE_FAILED`.
 *
 * @module
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import type { FileFormat } from '@open-docex/shared/protocol';
import { engineError } from '../errors/engine-error.js';
import { noopLogger, type Logger } from '../log/logger.js';
import type {
  StorageAdapter,
  StorageCreateInput,
  StorageReadResult,
  StorageRef,
  StorageStat,
  StorageVersion,
  StorageWriteResult,
} from './storage-adapter.js';

/** Options for {@link LocalFsStorage}. */
export interface LocalFsStorageOptions {
  /** The folder every ref is confined to. It must exist. */
  root: string;
  /** Receives the reason a ref was rejected. Defaults to a no-op logger. */
  logger?: Logger;
}

const MAX_REF_LENGTH = 1024;
const MAX_NAME_LENGTH = 100;
const FILE_MODE = 0o600;
const CREATE_ATTEMPTS = 3;
const FORMATS: ReadonlySet<FileFormat> = new Set<FileFormat>(['docx', 'odt', 'xlsx', 'ods']);

/** Windows reserved device names, with or without an extension (LLD Part 2 §11.2 step 2). */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** A drive letter such as `C:` at the start of a ref. */
const DRIVE_LETTER = /^[a-z]:/i;
/** C0 control characters and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
/** Characters `create` keeps from a display name (LLD Part 2 §11.2). */
const NAME_DISALLOWED = /[^\p{L}\p{N} ._-]/gu;

const IS_WINDOWS = process.platform === 'win32';

/** Thrown internally for a rejected ref; mapped to `DOCUMENT_NOT_FOUND`. */
class RefRejected extends Error {}

/** The adapter's version string for a file. */
function versionOf(st: BigIntStats): StorageVersion {
  return `${st.mtimeNs}:${st.size}`;
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/** True for errors that mean "there is no file at this path". */
function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

/**
 * Keeps only letters, digits, space, `.`, `_` and `-` from `name`, at most 100 characters
 * (LLD Part 2 §11.2).
 */
export function sanitizeName(name: string): string {
  return Array.from(name.replace(NAME_DISALLOWED, '')).slice(0, MAX_NAME_LENGTH).join('');
}

/**
 * Checks the syntactic rules for a ref (LLD Part 2 §11.2 steps 1–2) and returns the reason it
 * is rejected, or `null` when it passes. Confinement against the real root is checked
 * separately.
 *
 * Besides `\0`, every control character is rejected, and `:` is rejected anywhere, so that a
 * ref can't name an NTFS alternate data stream (LLD gap-fill, safest reading).
 */
export function refSyntaxError(ref: unknown): string | null {
  if (typeof ref !== 'string') return 'not a string';
  if (ref.length < 1 || ref.length > MAX_REF_LENGTH) return 'bad length';
  if (CONTROL_CHAR.test(ref)) return 'control character';
  if (ref.includes('\\')) return 'backslash';
  if (DRIVE_LETTER.test(ref)) return 'drive letter';
  if (ref.includes(':')) return 'colon';
  if (path.posix.isAbsolute(ref) || path.win32.isAbsolute(ref)) return 'absolute';
  for (const segment of ref.split('/')) {
    if (segment === '..') return 'parent segment';
    if (RESERVED_SEGMENT.test(segment)) return 'reserved name';
  }
  return null;
}

/**
 * Whether `rel` (from `path.relative(root, target)`) leaves the root or names the root itself.
 * "Starts with `..`" (LLD Part 2 §11.2 step 4) is read as a leading `..` segment, so a file
 * named `..x` inside the root is allowed.
 */
function escapesRoot(rel: string): boolean {
  return rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** The built-in local-filesystem storage adapter (LLD Part 2 §11.2). */
export class LocalFsStorage implements StorageAdapter {
  readonly #root: string;
  readonly #logger: Logger;
  #rootReal: Promise<string> | undefined;

  constructor(o: LocalFsStorageOptions) {
    if (typeof o.root !== 'string' || o.root.length === 0) {
      throw engineError('CONFIG_INVALID', { message: 'LocalFsStorage needs a root folder.' });
    }
    this.#root = path.resolve(o.root);
    this.#logger = o.logger ?? noopLogger;
  }

  async read(ref: StorageRef, o: { signal: AbortSignal; maxBytes: number }): Promise<StorageReadResult | null> {
    return this.#guard('STORAGE_READ_FAILED', async () => {
      o.signal.throwIfAborted();
      const abs = await this.resolveRef(ref);
      o.signal.throwIfAborted();
      let fh: FileHandle;
      try {
        fh = await open(abs, fsConstants.O_RDONLY);
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
      try {
        const st = await fh.stat({ bigint: true });
        if (!st.isFile()) return null;
        if (st.size > BigInt(o.maxBytes)) throw engineError('DOCUMENT_TOO_LARGE');
        const size = Number(st.size);
        // One byte more than allowed, to notice a file that grew after the stat.
        const buf = Buffer.alloc(Math.min(size, o.maxBytes) + 1);
        let len = 0;
        while (len < buf.length) {
          o.signal.throwIfAborted();
          const { bytesRead } = await fh.read(buf, len, buf.length - len, len);
          if (bytesRead === 0) break;
          len += bytesRead;
        }
        if (len > o.maxBytes) throw engineError('DOCUMENT_TOO_LARGE');
        const after = await fh.stat({ bigint: true });
        return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, len), version: versionOf(after) };
      } finally {
        await fh.close();
      }
    });
  }

  async stat(ref: StorageRef, o: { signal: AbortSignal }): Promise<StorageStat | null> {
    return this.#guard('STORAGE_READ_FAILED', async () => {
      o.signal.throwIfAborted();
      const abs = await this.resolveRef(ref);
      o.signal.throwIfAborted();
      const st = await statOrNull(abs);
      if (st === null) return null;
      return { version: versionOf(st), size: Number(st.size) };
    });
  }

  async write(
    ref: StorageRef,
    bytes: Uint8Array,
    o: { expectedVersion: StorageVersion | null; signal: AbortSignal },
  ): Promise<StorageWriteResult> {
    return this.#guard('STORAGE_WRITE_FAILED', async () => {
      o.signal.throwIfAborted();
      const abs = await this.resolveRef(ref);
      const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(8).toString('hex')}.tmp`);
      let renamed = false;
      try {
        // 1. Stage the bytes next to the target and make them durable.
        await writeDurable(tmp, bytes);
        o.signal.throwIfAborted();
        // 2. Compare the target's current version with the expected one.
        const current = await statOrNull(abs);
        const currentVersion = current === null ? null : versionOf(current);
        if (currentVersion !== o.expectedVersion) {
          return currentVersion === null
            ? { ok: false, reason: 'conflict' }
            : { ok: false, reason: 'conflict', currentVersion };
        }
        // 3. Replace the target.
        await rename(tmp, abs);
        renamed = true;
        const after = await stat(abs, { bigint: true });
        return { ok: true, version: versionOf(after) };
      } finally {
        if (!renamed) await unlink(tmp).catch(() => undefined);
      }
    });
  }

  async create(input: StorageCreateInput, o: { signal: AbortSignal }): Promise<{ ref: string; version: StorageVersion }> {
    return this.#guard('STORAGE_WRITE_FAILED', async () => {
      o.signal.throwIfAborted();
      if (!FORMATS.has(input.format)) {
        throw engineError('STORAGE_WRITE_FAILED', { message: 'LocalFsStorage.create got an unknown format.' });
      }
      const base = sanitizeName(typeof input.name === 'string' ? input.name : '');
      for (let attempt = 1; ; attempt++) {
        const ref = `${base}-${randomBytes(4).toString('hex')}.${input.format}`;
        const abs = await this.resolveRef(ref);
        try {
          await writeDurable(abs, input.bytes);
        } catch (err) {
          if (errnoCode(err) === 'EEXIST' && attempt < CREATE_ATTEMPTS) continue;
          throw err;
        }
        const st = await stat(abs, { bigint: true });
        return { ref, version: versionOf(st) };
      }
    });
  }

  /**
   * Resolves `ref` to an absolute path inside the root, following LLD Part 2 §11.2 steps 1–4.
   * The returned path has symlinks in its existing part resolved. Rejects with
   * `DOCUMENT_NOT_FOUND` when the ref is malformed or leaves the root.
   */
  async resolveRef(ref: StorageRef): Promise<string> {
    try {
      const syntax = refSyntaxError(ref);
      if (syntax !== null || typeof ref !== 'string') throw new RefRejected(syntax ?? 'not a string');
      const rootReal = await this.#realRoot();
      const abs = path.resolve(rootReal, ref);
      if (escapesRoot(relative(rootReal, abs))) throw new RefRejected('outside root');
      const real = await realpathOfNearest(abs);
      if (escapesRoot(relative(rootReal, real))) throw new RefRejected('outside root after realpath');
      return real;
    } catch (err) {
      if (!(err instanceof RefRejected)) throw err;
      this.#logger.warn(`LocalFsStorage rejected a ref: ${err.message}.`, { code: 'DOCUMENT_NOT_FOUND' });
      throw engineError('DOCUMENT_NOT_FOUND');
    }
  }

  #realRoot(): Promise<string> {
    if (this.#rootReal === undefined) {
      const lookup = realpath(this.#root);
      this.#rootReal = lookup;
      // A failed lookup (for example a root that doesn't exist yet) is retried on the next call.
      lookup.catch(() => {
        if (this.#rootReal === lookup) this.#rootReal = undefined;
      });
    }
    return this.#rootReal;
  }

  /** Runs `fn`, passing `OpenDocexError`s through and wrapping anything else in `code`. */
  async #guard<T>(code: ErrorCode, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OpenDocexError) throw err;
      throw engineError(code, { cause: err });
    }
  }
}

/** `path.relative`, compared case-insensitively on Windows. */
function relative(from: string, to: string): string {
  return IS_WINDOWS ? path.relative(from.toLowerCase(), to.toLowerCase()) : path.relative(from, to);
}

/** `realpath` of the nearest existing ancestor of `abs`, with the missing remainder appended. */
async function realpathOfNearest(abs: string): Promise<string> {
  const rest: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** `stat` of a regular file, or `null` when there is none. */
async function statOrNull(abs: string): Promise<BigIntStats | null> {
  try {
    const st = await stat(abs, { bigint: true });
    return st.isFile() ? st : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Writes `bytes` to a new file (flag `'wx'`, mode 0o600) and `datasync`s it. If anything fails
 * after the file was created, the partial file is removed.
 */
async function writeDurable(abs: string, bytes: Uint8Array): Promise<void> {
  const fh = await open(abs, 'wx', FILE_MODE);
  try {
    await fh.writeFile(bytes);
    await fh.datasync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlink(abs).catch(() => undefined);
    throw err;
  }
  await fh.close();
}
