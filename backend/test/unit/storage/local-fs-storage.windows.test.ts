// LocalFsStorage.write and the Windows rename retry (LLD §0.5 S-50).
// Found by CI run 45606138640: a flush failed with EPERM while the integration rig read the storage
// file every 10 ms, the document went to LOCAL and its retry came a minute later.
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameReplacing } from '../../../src/persistence/atomic-file.js';
import { LocalFsStorage } from '../../../src/storage/local-fs-storage.js';

vi.mock('../../../src/persistence/atomic-file.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/persistence/atomic-file.js')>();
  return { ...real, renameReplacing: vi.fn(real.renameReplacing) };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-lfs-win-'));
  vi.mocked(renameReplacing).mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalFsStorage.write', () => {
  it('replaces the target through renameReplacing, the shared Windows retry (S-50)', async () => {
    await writeFile(path.join(dir, 'doc.docx'), 'one');
    const storage = new LocalFsStorage({ root: dir });
    const signal = new AbortController().signal;
    const version = (await storage.stat('doc.docx', { signal }))?.version ?? null;
    const r = await storage.write('doc.docx', new TextEncoder().encode('two'), { expectedVersion: version, signal });
    expect(r.ok).toBe(true);
    expect(await readFile(path.join(dir, 'doc.docx'), 'utf8')).toBe('two');
    expect(renameReplacing).toHaveBeenCalledTimes(1);
    // LocalFsStorage resolves the real path (on Windows runners tmpdir() is an 8.3 short name such as
    // C:\Users\RUNNER~1, and the real path is C:\Users\runneradmin), so compare with that.
    expect(vi.mocked(renameReplacing).mock.calls[0]?.[1]).toBe(path.join(await realpath(dir), 'doc.docx'));
  });
});

// Opt-in stress test (OPEN_DOCEX_STRESS=1, Windows): real readers polling the target. Without the
// retry, 2 readers at 10 ms failed 1 to 4 writes in 6 s on a Windows machine; with it, 0 in 3 runs.
// It is off by default because under the load of a full parallel test run some blocks outlast the
// retry budget (500 ms), so it is a measurement, not a stable assertion.
describe.skipIf(process.platform !== 'win32' || process.env['OPEN_DOCEX_STRESS'] !== '1')('LocalFsStorage.write with concurrent readers (Windows, stress)', () => {
  it('does not fail with EPERM while 2 readers poll the file every 10 ms', async () => {
    const file = path.join(dir, 'doc.docx');
    await writeFile(file, 'one');
    const storage = new LocalFsStorage({ root: dir });
    const signal = new AbortController().signal;

    let stop = false;
    // Half the readers use readFile, half LocalFsStorage.read, which keeps a handle open across
    // several steps: the plain readFile readers alone did not reproduce the failure.
    const readers = Array.from({ length: 2 }, async (_, i) => {
      while (!stop) {
        if (i % 2 === 0) await readFile(file).catch(() => undefined);
        else await storage.read('doc.docx', { signal, maxBytes: 1 << 20 }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 10));
      }
    });

    let version = (await storage.stat('doc.docx', { signal }))?.version ?? null;
    const failures: string[] = [];
    let writes = 0;
    const end = Date.now() + 6000;
    try {
      while (Date.now() < end) {
        try {
          const r = await storage.write('doc.docx', new TextEncoder().encode(`text ${String(writes)}`), { expectedVersion: version, signal });
          if (!r.ok) throw new Error('unexpected conflict');
          version = r.version;
          writes += 1;
        } catch (e) {
          failures.push(String((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message));
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      stop = true;
      await Promise.all(readers);
    }
    expect(writes).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  }, 30_000);
});
