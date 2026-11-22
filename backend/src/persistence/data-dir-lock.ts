/**
 * `DataDirLock`: one Core per data folder (LLD Part 2 §7 boot step 3, §20).
 *
 * `acquire` creates `<dataDir>/LOCK` with flag `'wx'`, holding `{pid, hostname, startedAt}`.
 * An existing LOCK is stale only when it names this host and `process.kill(pid, 0)` throws
 * `ESRCH`; a stale LOCK is replaced. Any other existing LOCK, including one that does not
 * parse, refuses the second engine, because two Cores on one data folder would corrupt the
 * journals.
 *
 * Platform note: `process.kill(pid, 0)` works on Windows too (it checks that the process
 * exists without signalling it). `'wx'` maps to `O_CREAT | O_EXCL` on POSIX and `CREATE_NEW`
 * on Windows; both fail with `EEXIST` atomically. Two engines in one process share a pid, so
 * the second one is refused as well.
 *
 * @module
 */
import { hostname as osHostname } from 'node:os';
import { open, readFile, unlink } from 'node:fs/promises';
import { engineError } from '../errors/engine-error.js';
import { FILE_MODE, lockPath } from './layout.js';

/** The contents of `LOCK`. */
export interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: number;
}

/** Seams for tests. */
export interface DataDirLockDeps {
  now?: () => number;
  pid?: number;
  hostname?: string;
  /** `process.kill(pid, 0)`. */
  probe?: (pid: number) => void;
}

/** Holds the data folder's LOCK. */
export class DataDirLock {
  readonly #file: string;
  readonly #info: LockInfo;
  readonly #probe: (pid: number) => void;
  #held = false;

  constructor(dataDir: string, deps: DataDirLockDeps = {}) {
    this.#file = lockPath(dataDir);
    this.#info = {
      pid: deps.pid ?? process.pid,
      hostname: deps.hostname ?? osHostname(),
      startedAt: (deps.now ?? Date.now)(),
    };
    this.#probe = deps.probe ?? ((pid) => process.kill(pid, 0));
  }

  /** True while this instance holds the LOCK. */
  get held(): boolean {
    return this.#held;
  }

  /**
   * Takes the LOCK, replacing a stale one.
   *
   * @throws {OpenDocexError} `CONFIG_DATA_DIR_UNWRITABLE` when another live engine holds it
   *   (the message names its pid), when it cannot be read, or when it cannot be created.
   */
  async acquire(): Promise<void> {
    if (this.#held) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.#tryCreate()) {
        this.#held = true;
        return;
      }
      const holder = await this.#readHolder();
      if (holder === null) {
        throw engineError('CONFIG_DATA_DIR_UNWRITABLE', {
          message: 'The data folder LOCK is unreadable; another engine may be using it. Remove LOCK only if none is.',
        });
      }
      if (!this.#isStale(holder)) {
        throw engineError('CONFIG_DATA_DIR_UNWRITABLE', {
          message: `The data folder is in use by another engine (pid ${holder.pid}).`,
        });
      }
      // Re-read just before removing, so a LOCK another engine has just taken over is not
      // removed. A narrow race remains if two engines replace the same stale LOCK at once.
      const again = await this.#readHolder();
      if (again?.pid !== holder.pid || again.startedAt !== holder.startedAt) continue;
      await unlink(this.#file).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw wrap(err);
      });
    }
    throw engineError('CONFIG_DATA_DIR_UNWRITABLE', { message: 'The data folder LOCK could not be taken.' });
  }

  /** Removes the LOCK if this instance holds it and it still names this instance. */
  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    const holder = await this.#readHolder();
    if (holder?.pid === this.#info.pid && holder.startedAt === this.#info.startedAt) {
      await unlink(this.#file).catch(() => undefined);
    }
  }

  async #tryCreate(): Promise<boolean> {
    try {
      const fh = await open(this.#file, 'wx', FILE_MODE);
      try {
        await fh.writeFile(JSON.stringify(this.#info));
        await fh.datasync();
      } finally {
        await fh.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw wrap(err);
    }
  }

  async #readHolder(): Promise<LockInfo | null> {
    try {
      const x: unknown = JSON.parse(await readFile(this.#file, 'utf8'));
      if (typeof x !== 'object' || x === null) return null;
      const o = x as Record<string, unknown>;
      if (!Number.isSafeInteger(o['pid']) || typeof o['hostname'] !== 'string' || typeof o['startedAt'] !== 'number') {
        return null;
      }
      return { pid: o['pid'] as number, hostname: o['hostname'], startedAt: o['startedAt'] };
    } catch {
      return null;
    }
  }

  #isStale(holder: LockInfo): boolean {
    if (holder.hostname !== this.#info.hostname) return false;
    try {
      this.#probe(holder.pid);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
}

function wrap(err: unknown): Error {
  return engineError('CONFIG_DATA_DIR_UNWRITABLE', { message: 'The data folder LOCK could not be written.', cause: err });
}
