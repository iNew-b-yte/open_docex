// The worker-mode smoke flow with real LibreOffice (V1-19 acceptance): the unmodified compiled
// Core is forked, boots its real `CodecPool` worker threads, probes LibreOffice, imports and
// exports through the real mapper. Needs OPEN_DOCEX_LO_TESTS=1 and a build (`npm run build`).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ins } from '../unit/core/harness.js';
import { dist, haveDist, WorkerHarness } from './worker-harness.js';

const LO = process.env['OPEN_DOCEX_LO_TESTS'] === '1';

const h = new WorkerHarness();
afterEach(() => h.cleanup());

describe.skipIf(!LO || !haveDist)('createEngine in worker mode with the compiled Core and real LibreOffice', () => {
  it('boots, edits a blank document through a real client, and saves a real .docx', async () => {
    const t = await h.start({ coreEntry: path.join(dist, 'core', 'core-entry.js'), supervisor: { bootTimeoutMs: 120_000 } });
    expect(t.engine.state).toBe('running');
    const { ref } = await t.engine.documents.create({ kind: 'text', format: 'docx', name: 'Blank', target: 'storage' });
    t.refs.set('doc-1', ref as string);

    const alice = await t.connect('doc-1', 'alice');
    const load = await alice.hello();
    expect(load.start).toMatchObject({ kind: 'text', access: 'edit', rev: 0 });
    expect((await alice.submit([ins(2, 'Worker LO')])).rev).toBe(1);

    await t.engine.shutdown({ timeoutMs: 60_000 });
    expect(t.engine.state).toBe('stopped');
    const saved = await readFile(path.join(t.storageRoot, ref as string));
    expect([...saved.subarray(0, 2)]).toEqual([0x50, 0x4b]); // PK: a real docx package

    // A second engine on the same folders opens the saved file and sees the edit.
    const again = await h.start({ coreEntry: path.join(dist, 'core', 'core-entry.js'), supervisor: { bootTimeoutMs: 120_000 }, env: { ODX_SMOKE_DATA_DIR: t.dataDir, ODX_SMOKE_STORAGE_ROOT: t.storageRoot } });
    again.refs.set('doc-1', ref as string);
    const bob = await again.connect('doc-1', 'bob');
    expect((await bob.hello()).json).toContain('Worker LO');
  }, 360_000);
});
