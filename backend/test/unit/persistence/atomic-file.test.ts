import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsyncDir, writeFileAtomic } from '../../../src/persistence/atomic-file.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-atomic-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const busy = (code: string): Error => Object.assign(new Error(code), { code });
const noDelay = (): Promise<void> => Promise.resolve();

describe('writeFileAtomic', () => {
  it('creates and then replaces a file, leaving no temporary file', async () => {
    const file = path.join(dir, 'meta.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, new TextEncoder().encode('two'));
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['meta.json']);
  });

  it.runIf(process.platform !== 'win32')('writes mode 0o600 on POSIX', async () => {
    const file = path.join(dir, 'a');
    await writeFileAtomic(file, 'x');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('on Windows, retries a rename that fails with EPERM, EBUSY or EACCES', async () => {
    const file = path.join(dir, 'f');
    await writeFile(file, 'old');
    const codes = ['EPERM', 'EBUSY', 'EACCES'];
    let calls = 0;
    await writeFileAtomic(file, 'new', {
      platform: 'win32',
      delay: noDelay,
      rename: async (from, to) => {
        const code = codes[calls++];
        if (code !== undefined) throw busy(code);
        await rename(from, to);
      },
    });
    expect(calls).toBe(4);
    expect(await readFile(file, 'utf8')).toBe('new');
  });

  it('on Windows, gives up after 3 retries, keeps the old file and removes the temporary file', async () => {
    const file = path.join(dir, 'f');
    await writeFile(file, 'old');
    let calls = 0;
    const p = writeFileAtomic(file, 'new', {
      platform: 'win32',
      delay: noDelay,
      rename: () => {
        calls++;
        return Promise.reject(busy('EBUSY'));
      },
    });
    await expect(p).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(4);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['f']);
  });

  it('does not retry on POSIX', async () => {
    let calls = 0;
    const p = writeFileAtomic(path.join(dir, 'f'), 'x', {
      platform: 'linux',
      delay: noDelay,
      rename: () => {
        calls++;
        return Promise.reject(busy('EBUSY'));
      },
    });
    await expect(p).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails when the parent folder is missing', async () => {
    await expect(writeFileAtomic(path.join(dir, 'missing', 'f'), 'x')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('fsyncDir', () => {
  it('is a no-op on Windows and syncs a folder elsewhere', async () => {
    await expect(fsyncDir(path.join(dir, 'does-not-exist'), 'win32')).resolves.toBeUndefined();
    if (process.platform !== 'win32') await expect(fsyncDir(dir)).resolves.toBeUndefined();
  });
});
