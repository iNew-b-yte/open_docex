/**
 * Atomic file replacement (LLD Part 2 §10.1).
 *
 * `writeFileAtomic` writes a temporary sibling, makes its data durable, then renames it over
 * the target, so a reader sees either the old file or the new one, never a partial file.
 *
 * Platform differences:
 * - **POSIX:** `rename` replaces the target atomically. The parent folder is then fsynced so
 *   the rename itself survives an OS crash.
 * - **Windows:** Node's `rename` uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which
 *   replaces the target but can fail with `EPERM`, `EBUSY` or `EACCES` while another process
 *   (often antivirus or an indexer) holds the target open. The rename is retried up to 3 times,
 *   50 ms apart. A folder cannot be opened for fsync on Windows, so that step is skipped; NTFS
 *   journals the rename's metadata itself.
 *
 * @module
 */
import { randomBytes } from 'node:crypto';
import { open, rename as fsRename, unlink } from 'node:fs/promises';
import path from 'node:path';

const FILE_MODE = 0o600;
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 50;
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Seams for tests. Production code never passes these. */
export interface AtomicFileDeps {
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
  delay?: (ms: number) => Promise<void>;
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Replaces `target` with `data` atomically:
 * 1. writes `<target>.tmp-<rand>` with flag `'wx'` and mode 0o600;
 * 2. `datasync`s and closes it;
 * 3. renames it over `target` (retried on Windows, see the module comment);
 * 4. on POSIX, fsyncs the parent folder.
 *
 * On failure the temporary file is removed (best effort) and the error is rethrown unchanged.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  deps: AtomicFileDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const doRename = deps.rename ?? fsRename;
  const delay = deps.delay ?? defaultDelay;
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const fh = await open(tmp, 'wx', FILE_MODE);
    try {
      await fh.writeFile(data);
      await fh.datasync();
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await doRename(tmp, target);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (platform !== 'win32' || attempt >= RENAME_RETRIES || !RETRYABLE_RENAME.has(code)) throw err;
        await delay(RENAME_RETRY_MS);
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fsyncDir(path.dirname(target), platform);
}

/**
 * Fsyncs a folder so that entries created, renamed or removed in it survive an OS crash.
 * A no-op on Windows, which cannot open a folder for this.
 */
export async function fsyncDir(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
