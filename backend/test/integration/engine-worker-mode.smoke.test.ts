// Smoke test, worker mode (LLD Part 2 §5, §7; V1-19 acceptance): `createEngine` forks a real Core
// process, a real WebSocket client edits a blank document, and killing the Core makes every client
// receive close code 4001.
//
// The child runs compiled JavaScript, so this needs `npm run build` (or `tsc -b`) first and is
// skipped when `backend/dist` is missing. The Core is the real one with a fake codec
// (`fixtures/fake-codec-core.mjs`), so no LibreOffice is needed. `engine-worker-mode.lo.test.ts`
// runs the unmodified compiled Core with real LibreOffice.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineWith } from '../../src/api/create-engine.js';
import { ins } from '../unit/core/harness.js';
import { fixtures, haveDist, plainFork, WorkerHarness } from './worker-harness.js';

const FAKE_CORE = path.join(fixtures, 'fake-codec-core.mjs');

const h = new WorkerHarness();
afterEach(() => h.cleanup());

describe.skipIf(!haveDist)('createEngine in worker mode (forked compiled Core)', () => {
  it('boots a real Core process, edits a blank document, and saves it on shutdown', async () => {
    const t = await h.start({ coreEntry: FAKE_CORE });
    expect(t.engine.state).toBe('running');
    const { ref } = await t.engine.documents.create({ kind: 'text', format: 'docx', name: 'Blank', target: 'storage' });
    t.refs.set('doc-1', ref as string);

    const alice = await t.connect('doc-1', 'alice');
    const load = await alice.hello();
    expect(load.start).toMatchObject({ kind: 'text', access: 'edit', rev: 0 });
    expect((await alice.submit([ins(2, 'Hi')])).rev).toBe(1);
    const bob = await t.connect('doc-1', 'bob');
    expect((await bob.hello()).json).toContain('Hi');
    expect(await t.engine.shareInfo('doc-1' as never)).toEqual({
      documentId: 'doc-1',
      loaded: true,
      kind: 'text',
      sessions: { edit: 2, view: 0 },
    });

    await t.engine.shutdown({ timeoutMs: 8000 });
    expect(t.engine.state).toBe('stopped');
    expect((await alice.closed).code).toBe(1001);
    expect(await readFile(path.join(t.storageRoot, ref as string), 'utf8')).toBe('Hi');
  }, 30_000);

  it('rejects createEngine with the Core boot error (a wrong data folder gives CONFIG_DATA_DIR_UNWRITABLE)', async () => {
    const root = await h.tempDir();
    const file = path.join(root, 'a-file');
    await writeFile(file, 'x');
    const env = { ...process.env, ODX_SMOKE_DATA_DIR: path.join(file, 'sub'), ODX_SMOKE_STORAGE_ROOT: root };
    const { server } = await h.server();
    const err = await createEngineWith(
      { mode: 'worker', workerConfigModule: path.join(fixtures, 'worker-config.mjs'), http: { server }, authorize: () => null },
      { supervisor: { coreEntryPath: FAKE_CORE, fork: plainFork(env) } },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'CONFIG_DATA_DIR_UNWRITABLE' });
    expect(server.listenerCount('upgrade')).toBe(0);
  }, 30_000);

  it('killing the Core closes every client with 4001, answers 503 while it restarts, and recovers', async () => {
    const t = await h.start({ coreEntry: FAKE_CORE, supervisor: { backoffMs: [1500], heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 5000 } });
    const { ref } = await t.engine.documents.create({ kind: 'text', format: 'docx', name: 'Blank', target: 'storage' });
    t.refs.set('doc-1', ref as string);
    const alice = await t.connect('doc-1', 'alice');
    await alice.hello();
    const bob = await t.connect('doc-1', 'bob');
    await bob.hello();
    await alice.submit([ins(2, 'persisted')]);

    // A frame the Gateway forwards untouched; the test Core exits when it sees it.
    alice.ws.send('{"type":"crash-core"}');
    const [a, b] = await Promise.all([alice.closed, bob.closed]);
    expect(a).toEqual({ code: 4001, reason: 'ENGINE_RESTARTING' });
    expect(b).toEqual({ code: 4001, reason: 'ENGINE_RESTARTING' });
    expect(alice.messages.some((m) => m.type === 'notice' && m.notice === 'engine-restarting')).toBe(true);
    expect(t.states.map((s) => s.state)).toContain('restarting');

    // While the Core is down (the 1.5 s backoff has not passed): calls reject, upgrades get 503.
    expect(t.engine.state).toBe('restarting');
    await expect(t.engine.recovery.list()).rejects.toMatchObject({ code: 'ENGINE_RESTARTING', retryable: true });
    await expect(t.connect('doc-1', 'carol')).rejects.toThrow('HTTP 503');

    // The Core comes back, and the clients can reconnect and see their data.
    await expect.poll(() => t.engine.state, { timeout: 20_000 }).toBe('running');
    expect(t.states.map((s) => s.state)).toEqual(['restarting', 'started']);
    const again = await t.connect('doc-1', 'alice');
    const reloaded = await again.hello();
    expect(reloaded.json).toContain('persisted');
    expect(reloaded.start.rev).toBe(1);
  }, 60_000);
});
