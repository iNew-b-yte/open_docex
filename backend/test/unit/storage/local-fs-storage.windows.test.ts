// Windows only (S-50): LocalFsStorage.write must survive readers polling the target file.
// Found by CI run 45606138640: a flush failed with EPERM while the integration rig read the
// storage file every 10 ms, the document went to LOCAL and its retry came a minute later.
// Before the fix, readers at 10 ms failed a few percent of writes on a Windows machine.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsStorage } from '../../../src/storage/local-fs-storage.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-lfs-win-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('LocalFsStorage.write with concurrent readers (Windows)', () => {
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
