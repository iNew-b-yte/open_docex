// Smoke test, main mode (LLD Part 2 §2.5, §4, §7; V1-19 acceptance): `createEngine` with the
// real Gateway, Core, persistence, flush, recovery, audit and queue, `LocalFsStorage` as the
// adopter storage, and real WebSocket clients editing a blank document. Only the codec is a fake
// (one paragraph per line of UTF-8); `engine-main-mode.lo.test.ts` runs the same flow with real
// LibreOffice. The full end-to-end suite is V1-20.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineWith, type EngineInternals } from '../../src/api/create-engine.js';
import type { AuditEvent, StorageEvent } from '../../src/api/events.js';
import type { Engine } from '../../src/api/engine-facade.js';
import type { AuthorizeContext, AuthorizeResult, EngineOptions, WorkerConfig } from '../../src/api/options.js';
import { LocalFsStorage } from '../../src/storage/local-fs-storage.js';
import type { StorageAdapter, StorageRef } from '../../src/storage/storage-adapter.js';
import { FakeStorage } from '../../test-kit/storage/fake-storage.js';
import { ins } from '../unit/core/harness.js';
import { TextFileCodec } from '../unit/core/wiring-fakes.js';
import { TestClient } from './test-client.js';

const PLACEHOLDER_MODULE = fileURLToPath(import.meta.url);

const roots: string[] = [];
const engines: Engine[] = [];
const servers: Server[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const e of engines.splice(0)) await e.shutdown({ timeoutMs: 3000 });
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

interface Env {
  root: string;
  dataDir: string;
  storageRoot: string;
  storage: StorageAdapter;
  /** documentId → storage ref, read by `authorize`. */
  refs: Map<string, StorageRef>;
}

async function env(storage?: (root: string) => StorageAdapter): Promise<Env> {
  const root = await mkdtemp(path.join(tmpdir(), 'odx-smoke-'));
  roots.push(root);
  const storageRoot = path.join(root, 'storage');
  await mkdir(storageRoot);
  return { root, dataDir: path.join(root, 'data'), storageRoot, storage: storage?.(storageRoot) ?? new LocalFsStorage({ root: storageRoot }), refs: new Map() };
}

interface Running {
  engine: Engine;
  server: Server;
  codec: TextFileCodec;
  /** `ws://…/open-docex?doc=<id>`. */
  url(documentId: string): string;
}

/** `Authorization: Bearer <access>:<userId>`; no header is 401. */
function authorizeFrom(e: Env) {
  return (ctx: AuthorizeContext): AuthorizeResult | { deny: 401 } | null => {
    const header = ctx.request.headers.authorization;
    if (header === undefined) return { deny: 401 };
    const [access, userId] = header.replace('Bearer ', '').split(':');
    const ref = e.refs.get(ctx.documentId);
    if (ref === undefined || (access !== 'edit' && access !== 'view') || userId === undefined) return null;
    return { userId, access, document: { ref, format: 'docx' } };
  };
}

async function boot(
  e: Env,
  o: { options?: Partial<EngineOptions>; config?: WorkerConfig; codec?: TextFileCodec } = {},
): Promise<Running> {
  const codec = o.codec ?? new TextFileCodec();
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const internals: EngineInternals = {
    core: {
      codec: () => codec,
      importModule: () => Promise.resolve({ default: { dataDir: e.dataDir, storage: e.storage, ...o.config } }),
    },
  };
  const engine = await createEngineWith(
    { mode: 'main', workerConfigModule: PLACEHOLDER_MODULE, http: { server }, authorize: authorizeFrom(e), ...o.options },
    internals,
  );
  engines.push(engine);
  return { engine, server, codec, url: (id) => `ws://127.0.0.1:${port}/open-docex?doc=${encodeURIComponent(id)}` };
}

async function connect(r: Running, documentId: string, as: string): Promise<TestClient> {
  const c = await TestClient.open(r.url(documentId), { headers: { authorization: `Bearer ${as}` } });
  clients.push(c);
  return c;
}

/** Creates a blank document through the engine and registers it under `documentId`. */
async function blank(e: Env, r: Running, documentId = 'blank-1'): Promise<StorageRef> {
  const { ref } = await r.engine.documents.create({ kind: 'text', format: 'docx', name: 'Blank', target: 'storage' });
  e.refs.set(documentId, ref);
  return ref;
}

async function storedText(e: Env, ref: StorageRef): Promise<string> {
  const read = await e.storage.read(ref, { signal: new AbortController().signal, maxBytes: 1024 * 1024 });
  return new TextDecoder().decode(read?.bytes ?? new Uint8Array());
}

describe('createEngine in main mode with LocalFsStorage and real WebSocket clients', () => {
  it('two clients edit a blank document and converge, and shutdown saves it to storage', async () => {
    const e = await env();
    const r = await boot(e);
    const ref = await blank(e, r);

    const alice = await connect(r, 'blank-1', 'edit:alice');
    const aLoad = await alice.hello();
    expect(aLoad.start).toMatchObject({ type: 'load-start', kind: 'text', access: 'edit', rev: 0 });
    expect(aLoad.start.unsupported ?? []).toEqual([]);
    const ack1 = await alice.submit([ins(2, 'Hello')]);
    expect(ack1).toMatchObject({ type: 'ack', rev: 1, clientSeq: 1 });

    const bob = await connect(r, 'blank-1', 'edit:bob');
    const bLoad = await bob.hello();
    expect(bLoad.start.rev).toBe(1);
    expect(bLoad.json).toContain('Hello');
    expect(bLoad.start.epoch).toBe(aLoad.start.epoch);

    const ack2 = await bob.submit([ins(7, ' world')]);
    expect(ack2.rev).toBe(2);
    const remote = await alice.waitFor((m): m is Extract<typeof m, { type: 'remote' }> => m.type === 'remote');
    expect(remote.clientId).toBe(bob.clientId);
    expect(remote.ops).toEqual([ins(7, ' world')]);

    // shareInfo: the Core's view plus the Gateway's session counts.
    expect(await r.engine.shareInfo('blank-1' as never)).toEqual({
      documentId: 'blank-1',
      loaded: true,
      kind: 'text',
      sessions: { edit: 2, view: 0 },
    });

    await r.engine.shutdown({ timeoutMs: 5000 });
    expect(r.engine.state).toBe('stopped');
    expect(await alice.closed).toEqual({ code: 4005, reason: 'SESSION_CLOSED' });
    expect((await bob.closed).code).toBe(4005);
    // The flush wrote the edited document back through LocalFsStorage.
    expect(await storedText(e, ref)).toBe('Hello world');
    expect(r.server.listenerCount('upgrade')).toBe(0);
  });

  it('refuses unauthorized upgrades: 401 from { deny: 401 }, 403 from null', async () => {
    const e = await env();
    const r = await boot(e);
    await blank(e, r);
    await expect(TestClient.open(r.url('blank-1'))).rejects.toThrow('HTTP 401');
    await expect(TestClient.open(r.url('unknown-doc'), { headers: { authorization: 'Bearer edit:eve' } })).rejects.toThrow('HTTP 403');
    await expect(TestClient.open(r.url(''), { headers: { authorization: 'Bearer edit:eve' } })).rejects.toThrow('HTTP 400');
  });

  it('answers 500 for an authorize that throws and a CONFIG_INVALID error event for a malformed result', async () => {
    const e = await env();
    let mode: 'throw' | 'malformed' = 'throw';
    const r = await boot(e, {
      options: {
        authorize: () => {
          if (mode === 'throw') throw new Error('db down');
          return { userId: 'u', access: 'edit' } as never;
        },
      },
    });
    const errors: string[] = [];
    r.engine.on('error', (err) => errors.push(err.code));
    await expect(TestClient.open(r.url('d'))).rejects.toThrow('HTTP 500');
    mode = 'malformed';
    await expect(TestClient.open(r.url('d'))).rejects.toThrow('HTTP 500');
    expect(errors).toEqual(['ACCESS_DENIED', 'CONFIG_INVALID']);
  });

  it('a view session loads the document but cannot change it', async () => {
    const e = await env();
    const r = await boot(e);
    await blank(e, r);
    const viewer = await connect(r, 'blank-1', 'view:vera');
    const load = await viewer.hello();
    expect(load.start.access).toBe('view');
    viewer.send({ type: 'submit', clientId: viewer.clientId, clientSeq: 1, epoch: load.start.epoch, baseRev: 0, ops: [ins(2, 'nope')] });
    const err = await viewer.waitFor((m): m is Extract<typeof m, { type: 'error' }> => m.type === 'error');
    expect(err).toMatchObject({ code: 'ACCESS_DENIED', clientSeq: 1 });
    expect(viewer.ws.readyState).toBe(viewer.ws.OPEN);
  });

  it('canSubmit gates each submit: a denied one is answered with ACCESS_DENIED and never applied', async () => {
    const e = await env();
    const r = await boot(e, { options: { canSubmit: (s) => s.userId !== 'mallory' } });
    await blank(e, r);
    const mallory = await connect(r, 'blank-1', 'edit:mallory');
    const load = await mallory.hello();
    mallory.send({ type: 'submit', clientId: mallory.clientId, clientSeq: 1, epoch: load.start.epoch, baseRev: 0, ops: [ins(2, 'x')] });
    const err = await mallory.waitFor((m): m is Extract<typeof m, { type: 'error' }> => m.type === 'error');
    expect(err).toMatchObject({ code: 'ACCESS_DENIED', clientSeq: 1 });

    const alice = await connect(r, 'blank-1', 'edit:alice');
    const aLoad = await alice.hello();
    expect(aLoad.start.rev).toBe(0); // mallory's change was never applied
    expect((await alice.submit([ins(2, 'ok')])).rev).toBe(1);
  });

  it('sessions.close({ userId }) closes only that user', async () => {
    const e = await env();
    const r = await boot(e);
    await blank(e, r);
    const alice = await connect(r, 'blank-1', 'edit:alice');
    await alice.hello();
    const bob = await connect(r, 'blank-1', 'edit:bob');
    await bob.hello();
    expect(r.engine.sessions.close({ userId: 'alice' })).toBe(1);
    expect(await alice.closed).toEqual({ code: 4005, reason: 'SESSION_CLOSED' });
    expect(bob.ws.readyState).toBe(bob.ws.OPEN);
    expect(await r.engine.shareInfo('blank-1' as never)).toMatchObject({ sessions: { edit: 1, view: 0 } });
  });

  it('delivers audit events live to a listener, flagged replayed: false', async () => {
    const e = await env();
    const r = await boot(e);
    await blank(e, r);
    const events: AuditEvent[] = [];
    r.engine.on('audit', (a) => events.push(a));
    await r.engine.recovery.list(); // the audit.enable call is ahead of this one in the channel
    const alice = await connect(r, 'blank-1', 'edit:alice');
    await alice.hello();
    await alice.submit([ins(2, 'a')]);
    await alice.submit([ins(3, 'b')]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.map((a) => [a.rev, a.replayed, a.userId])).toEqual([
      [1, false, 'alice'],
      [2, false, 'alice'],
    ]);
  });

  it('replays audit events that were never delivered after a restart, flagged replayed: true, before any session', async () => {
    const e = await env();
    const first = await boot(e);
    const ref = await blank(e, first);
    // No audit listener: the Core sends nothing and does not advance auditEmittedRev.
    const alice = await connect(first, 'blank-1', 'edit:alice');
    await alice.hello();
    await alice.submit([ins(2, 'one')]);
    await alice.submit([ins(5, ' two')]);
    await first.engine.shutdown({ timeoutMs: 5000 });
    expect(await storedText(e, ref)).toBe('one two');

    const second = await boot(e);
    const replayed: AuditEvent[] = [];
    second.engine.on('audit', (a) => replayed.push(a)); // the Core buffered them during boot
    expect(replayed.map((a) => [a.rev, a.replayed, a.sessionId])).toEqual([
      [1, true, null],
      [2, true, null],
    ]);
    // The document comes back from the local copy, with its history.
    const again = await connect(second, 'blank-1', 'edit:alice');
    const load = await again.hello();
    expect(load.start.rev).toBe(2);
    expect(load.json).toContain('one two');
    // Nothing is replayed a third time.
    await second.engine.shutdown({ timeoutMs: 5000 });
    const third = await boot(e);
    const none: AuditEvent[] = [];
    third.engine.on('audit', (a) => none.push(a));
    expect(none).toEqual([]);
  });

  it('keeps editing when storage is down, reports it, and recovers on retry (flush and recovery wiring)', async () => {
    const fake = new FakeStorage();
    const e = await env(() => fake);
    const r = await boot(e, { config: { flush: { quietMs: 1000, maxIntervalMs: 300_000 } } });
    const ref = await blank(e, r);
    const stored: StorageEvent[] = [];
    r.engine.on('storage', (s) => stored.push(s));

    const alice = await connect(r, 'blank-1', 'edit:alice');
    await alice.hello();
    fake.failNext('write', { times: 3 });
    await alice.submit([ins(2, 'kept')]);
    // The quiet period passes, the write fails, and the document goes to LOCAL.
    await expect.poll(() => stored.map((s) => s.state), { timeout: 8000 }).toContain('local');
    const list = await r.engine.recovery.list();
    expect(list).toMatchObject([{ documentId: 'blank-1', state: 'LOCAL', localRev: 1 }]);
    // Editing goes on.
    expect((await alice.submit([ins(6, '!')])).rev).toBe(2);
    expect((await alice.waitFor((m): m is Extract<typeof m, { type: 'notice' }> => m.type === 'notice')).notice).toBe('storage');

    const copy = await r.engine.recovery.readLocalCopy('blank-1' as never);
    expect(new TextDecoder().decode(copy.bytes)).toBe('kept!');
    expect(copy.rev).toBe(2);

    fake.clearFailures();
    const entry = await r.engine.recovery.retry('blank-1' as never);
    expect(entry.state).toBe('NORMAL');
    expect(stored.map((s) => s.state)).toContain('recovered');
    expect(await r.engine.recovery.list()).toEqual([]);
    const read = await fake.read(ref, { signal: new AbortController().signal, maxBytes: 1 << 20 });
    expect(new TextDecoder().decode(read?.bytes)).toBe('kept!');
  }, 30_000);
});
