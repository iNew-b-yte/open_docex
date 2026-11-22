import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { OpenDocexError } from '@open-docex/shared/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataDirLock, type LockInfo } from '../../../src/persistence/data-dir-lock.js';
import { lockPath } from '../../../src/persistence/layout.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const errno = (code: string): Error => Object.assign(new Error(code), { code });
const readLock = async (): Promise<LockInfo> => JSON.parse(await readFile(lockPath(dir), 'utf8')) as LockInfo;
const writeLock = (info: LockInfo): Promise<void> => writeFile(lockPath(dir), JSON.stringify(info));

async function codeAndMessage(p: Promise<unknown>): Promise<[string, string]> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OpenDocexError);
  return [(err as OpenDocexError).code, (err as OpenDocexError).message];
}

describe('DataDirLock', () => {
  it('writes {pid, hostname, startedAt} and rejects a second engine, naming the holder pid', async () => {
    const first = new DataDirLock(dir, { now: () => 123 });
    await first.acquire();
    expect(first.held).toBe(true);
    expect(await readLock()).toEqual({ pid: process.pid, hostname: hostname(), startedAt: 123 });

    const second = new DataDirLock(dir);
    const [code, message] = await codeAndMessage(second.acquire());
    expect(code).toBe('CONFIG_DATA_DIR_UNWRITABLE');
    expect(message).toContain(`pid ${process.pid}`);
    expect(second.held).toBe(false);

    await first.release();
    await second.acquire(); // free again
    expect(second.held).toBe(true);
    await second.release();
  });

  it('replaces a stale LOCK from this host whose process is gone (ESRCH)', async () => {
    await writeLock({ pid: 999_999, hostname: hostname(), startedAt: 1 });
    const lock = new DataDirLock(dir, {
      now: () => 7,
      probe: (pid) => {
        if (pid === 999_999) throw errno('ESRCH');
      },
    });
    await lock.acquire();
    expect(await readLock()).toMatchObject({ pid: process.pid, startedAt: 7 });
  });

  it('refuses a LOCK whose process is alive but not signalable (EPERM)', async () => {
    await writeLock({ pid: 4, hostname: hostname(), startedAt: 1 });
    const lock = new DataDirLock(dir, { probe: () => { throw errno('EPERM'); } });
    expect((await codeAndMessage(lock.acquire()))[0]).toBe('CONFIG_DATA_DIR_UNWRITABLE');
  });

  it('refuses a LOCK from another host, even if the pid is unknown here', async () => {
    await writeLock({ pid: 999_999, hostname: `${hostname()}-other`, startedAt: 1 });
    const lock = new DataDirLock(dir, { probe: () => { throw errno('ESRCH'); } });
    const [code, message] = await codeAndMessage(lock.acquire());
    expect(code).toBe('CONFIG_DATA_DIR_UNWRITABLE');
    expect(message).toContain('pid 999999');
  });

  it('refuses an unreadable LOCK and leaves it in place', async () => {
    await writeFile(lockPath(dir), '{"pid":');
    const lock = new DataDirLock(dir, { probe: () => { throw errno('ESRCH'); } });
    expect((await codeAndMessage(lock.acquire()))[0]).toBe('CONFIG_DATA_DIR_UNWRITABLE');
    expect(await readFile(lockPath(dir), 'utf8')).toBe('{"pid":');
  });

  it('release removes only its own LOCK', async () => {
    const lock = new DataDirLock(dir, { now: () => 1 });
    await lock.acquire();
    await writeLock({ pid: process.pid, hostname: hostname(), startedAt: 2 }); // someone else's now
    await lock.release();
    expect(await readLock()).toMatchObject({ startedAt: 2 });
  });

  it('fails with CONFIG_DATA_DIR_UNWRITABLE when the folder does not exist', async () => {
    const lock = new DataDirLock(path.join(dir, 'missing'));
    expect((await codeAndMessage(lock.acquire()))[0]).toBe('CONFIG_DATA_DIR_UNWRITABLE');
  });
});
