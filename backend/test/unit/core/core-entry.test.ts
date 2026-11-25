// The Core entry's wiring (LLD Part 2 §7, §0 S-36, S-38, S-40, S-43): the real FlushScheduler,
// RecoveryManager, AuditEmitter, MemoryQueue and storage router over an in-process channel, with a
// fake codec. The engine API calls (`documents.*`, `recovery.*`, `audit.enable`) are answered here.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asDocumentId, type Epoch } from '@open-docex/shared/ids';
import {
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type LoadStartMsg,
  type ServerMessage,
} from '@open-docex/shared/protocol';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { waitFor } from '../../wait-for.js';
import type { AuditEvent } from '../../../src/api/events.js';
import { AuditEmitter } from '../../../src/audit/audit-emitter.js';
import { InProcessEngineChannel } from '../../../src/channel/in-process-engine-channel.js';
import {
  createCoreWiring,
  parseCreateArgs,
  type LocalCopy,
  type RecoveryEntry,
  type RecoveryResolution,
} from '../../../src/core/core-entry.js';
import { CoreRuntime } from '../../../src/core/core-runtime.js';
import { engineError } from '../../../src/errors/engine-error.js';
import { FlushScheduler } from '../../../src/flush/flush-scheduler.js';
import { RecoveryManager } from '../../../src/recovery/recovery-manager.js';
import { LocalFsStorage } from '../../../src/storage/local-fs-storage.js';
import { isLocalRef } from '../../../src/storage/storage-router.js';
import { FakeStorage } from '../../../test-kit/storage/fake-storage.js';
import { cid, ins } from './harness.js';
import { TextFileCodec } from './wiring-fakes.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(o: { storage?: FakeStorage } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'odx-entry-'));
  dirs.push(dataDir);
  const codec = new TextFileCodec();
  const audits: AuditEvent[] = [];
  const wiring = createCoreWiring({
    codec: () => codec,
    importModule: () => Promise.resolve({ default: { dataDir, ...(o.storage !== undefined ? { storage: o.storage } : {}) } }),
  });
  const [main, coreSide] = InProcessEngineChannel.pair();
  main.onEvent((ev) => {
    if (ev.type === 'emit' && ev.event === 'audit') audits.push(ev.payload as AuditEvent);
  });
  const runtime = new CoreRuntime(wiring.wrap(coreSide), { services: wiring.services });
  const boot = (): Promise<unknown> => runtime.boot({ workerConfigModule: path.resolve('worker-config.mjs'), logLevel: 'error' });
  return { dataDir, codec, main, runtime, boot, audits };
}

describe('parseCreateArgs', () => {
  const ok = { kind: 'text', format: 'docx', name: 'Report', target: 'storage' };

  it('accepts the valid combinations', () => {
    expect(parseCreateArgs(ok)).toEqual(ok);
    expect(parseCreateArgs({ ...ok, format: 'odt', target: 'local' })).toEqual({ ...ok, format: 'odt', target: 'local' });
    expect(parseCreateArgs({ kind: 'sheet', format: 'xlsx', name: 'S', target: 'storage' }).kind).toBe('sheet');
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['an unknown kind', { ...ok, kind: 'slides' }],
    ['an unknown format', { ...ok, format: 'pdf' }],
    ['a kind that does not match the format', { ...ok, kind: 'sheet' }],
    ['a sheet format for a text kind', { ...ok, format: 'ods' }],
    ['an empty name', { ...ok, name: '' }],
    ['a numeric name', { ...ok, name: 3 }],
    ['an unknown target', { ...ok, target: 'cloud' }],
  ])('rejects %s with CONFIG_INVALID', (_name, args) => {
    expect(() => parseCreateArgs(args)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error);
  });
});

describe('createCoreWiring: the engine API', () => {
  it('answers API calls only after boot', async () => {
    const t = await setup();
    await expect(t.main.call('recovery.list', {})).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    await t.boot();
    await expect(t.main.call('recovery.list', {})).resolves.toEqual([]);
    await t.runtime.shutdown(1000);
  });

  it('documents.create exports the empty snapshot through the codec and creates it in the built-in local storage', async () => {
    const t = await setup();
    await t.boot();
    const made = (await t.main.call('documents.create', { kind: 'text', format: 'docx', name: 'Blank', target: 'storage' })) as {
      ref: string;
    };
    expect(typeof made.ref).toBe('string');
    expect(t.codec.exports).toEqual(['']);
    const local = new LocalFsStorage({ root: path.join(t.dataDir, 'local-storage') });
    const read = await local.read(made.ref, { signal: new AbortController().signal, maxBytes: 1024 });
    expect(read?.bytes.byteLength).toBe(0);
    await t.runtime.shutdown(1000);
  });

  it('documents.create with an adopter storage: target "storage" uses it, target "local" gives a { $local } ref', async () => {
    const storage = new FakeStorage();
    const t = await setup({ storage });
    await t.boot();
    const a = (await t.main.call('documents.create', { kind: 'text', format: 'docx', name: 'A', target: 'storage' })) as { ref: unknown };
    expect(isLocalRef(a.ref)).toBe(false);
    expect(storage.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    const b = (await t.main.call('documents.create', { kind: 'text', format: 'odt', name: 'B', target: 'local' })) as { ref: unknown };
    expect(isLocalRef(b.ref)).toBe(true);
    expect(storage.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    await t.runtime.shutdown(1000);
  });

  it('documents.create rejects a bad argument with CONFIG_INVALID, and a sheet until V2', async () => {
    const t = await setup();
    await t.boot();
    await expect(t.main.call('documents.create', { kind: 'text', format: 'xlsx', name: 'x', target: 'storage' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(t.main.call('documents.create', { kind: 'sheet', format: 'xlsx', name: 'x', target: 'storage' })).rejects.toMatchObject({
      code: 'DOCUMENT_UNSUPPORTED_CONTENT',
    });
    await t.runtime.shutdown(1000);
  });

  it('documents.create passes the codec error through, and creates nothing', async () => {
    const storage = new FakeStorage();
    const t = await setup({ storage });
    await t.boot();
    t.codec.exportError = engineError('CONVERSION_TIMEOUT');
    await expect(t.main.call('documents.create', { kind: 'text', format: 'docx', name: 'x', target: 'storage' })).rejects.toMatchObject({
      code: 'CONVERSION_TIMEOUT',
    });
    expect(storage.calls).toEqual([]);
    await t.runtime.shutdown(1000);
  });

  it('documents.create reports a failing storage as STORAGE_WRITE_FAILED', async () => {
    const storage = new FakeStorage();
    const t = await setup({ storage });
    await t.boot();
    storage.failNext('create');
    await expect(t.main.call('documents.create', { kind: 'text', format: 'docx', name: 'x', target: 'storage' })).rejects.toMatchObject({
      code: 'STORAGE_WRITE_FAILED',
    });
    await t.runtime.shutdown(1000);
  });

  it('documents.info and documents.allowUnsupportedEdit for an unknown document', async () => {
    const t = await setup();
    await t.boot();
    expect(await t.main.call('documents.info', { documentId: 'nope' })).toEqual({ documentId: 'nope', loaded: false });
    await expect(t.main.call('documents.allowUnsupportedEdit', { documentId: 'nope' })).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
    await expect(t.main.call('documents.info', { documentId: 5 })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(t.main.call('documents.info', { documentId: '' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await t.runtime.shutdown(1000);
  });

  it('recovery.resolve checks the resolution; recovery.list starts empty', async () => {
    const t = await setup();
    await t.boot();
    await expect(t.main.call('recovery.resolve', { documentId: 'd', resolution: 'delete' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(t.main.call('recovery.resolve', { documentId: 'd' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(t.main.call('recovery.list', {})).resolves.toEqual([]);
    await t.runtime.shutdown(1000);
  });

  it('audit.enable checks its argument and switches the emitter', async () => {
    const t = await setup();
    const setEnabled = vi.spyOn(AuditEmitter.prototype, 'setEnabled');
    await t.boot();
    setEnabled.mockClear();
    await expect(t.main.call('audit.enable', { enabled: 'yes' } as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(setEnabled).not.toHaveBeenCalled();
    await t.main.call('audit.enable', { enabled: false });
    await t.main.call('audit.enable', { enabled: true });
    expect(setEnabled.mock.calls).toEqual([[false], [true]]);
    await t.runtime.shutdown(1000);
  });

  it('rejects an unknown method with CONFIG_INVALID', async () => {
    const t = await setup();
    await t.boot();
    await expect(t.main.call('documents.delete' as never, {} as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await t.runtime.shutdown(1000);
  });
});

describe('createCoreWiring: boot and shutdown wiring (S-38, S-40)', () => {
  it('enables the audit emitter and replays before boot finishes, in that order', async () => {
    const t = await setup();
    const order: string[] = [];
    vi.spyOn(AuditEmitter.prototype, 'setEnabled').mockImplementation(function (this: AuditEmitter, on: boolean) {
      order.push(`setEnabled:${on}`);
    });
    vi.spyOn(AuditEmitter.prototype, 'replayAll').mockImplementation(() => {
      order.push('replayAll');
      return Promise.resolve(0);
    });
    await t.boot();
    order.push('boot done');
    expect(order).toEqual(['setEnabled:true', 'replayAll', 'boot done']);
    await t.runtime.shutdown(1000);
  });

  it('does not block boot when the audit replay fails', async () => {
    const t = await setup();
    vi.spyOn(AuditEmitter.prototype, 'replayAll').mockRejectedValue(new Error('corrupt journal'));
    await expect(t.boot()).resolves.toBeDefined();
    await t.runtime.shutdown(1000);
  });

  it('shutdown flushes the audit emitter, closes recovery and closes the codec', async () => {
    const t = await setup();
    const flush = vi.spyOn(AuditEmitter.prototype, 'flush');
    const close = vi.spyOn(RecoveryManager.prototype, 'close');
    await t.boot();
    expect(t.codec.closed).toBe(false);
    await t.runtime.shutdown(1000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(t.codec.closed).toBe(true);
  });

  it('shutdown still closes recovery and flushes audit when the scheduler flush fails', async () => {
    const t = await setup();
    vi.spyOn(FlushScheduler.prototype, 'flushAll').mockRejectedValue(new Error('storage down'));
    const flush = vi.spyOn(AuditEmitter.prototype, 'flush');
    const close = vi.spyOn(RecoveryManager.prototype, 'close');
    await t.boot();
    await t.runtime.shutdown(1000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(t.codec.closed).toBe(true);
  });

  it('forwards a failed storage write from the scheduler (built first) to the recovery manager (built second)', async () => {
    const storage = new FakeStorage();
    const t = await setup({ storage });
    const onWriteFailed = vi.spyOn(RecoveryManager.prototype, 'onWriteFailed').mockResolvedValue(undefined);
    await t.boot();
    storage.setFile('d.docx', new TextEncoder().encode('hello'));
    const frames: ServerMessage[] = [];
    t.main.onEvent((ev) => {
      if (ev.type !== 'send') return;
      for (const f of ev.frames) {
        const r = decodeServerMessage(f.data);
        if (r.kind === 'message') frames.push(r.message);
      }
    });
    const send = (m: ClientMessage): void =>
      t.main.post({ type: 'frame', sessionId: 's1', data: new TextEncoder().encode(encodeMessage(m) as string), binary: false });
    t.main.post({ type: 'join', sessionId: 's1', documentId: asDocumentId('d.docx'), userId: 'u', access: 'edit', document: { ref: 'd.docx', format: 'docx' } });
    send({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: cid('c1') });
    await waitFor(() => expect(frames.some((m) => m.type === 'load-done')).toBe(true));
    const start = frames.find((m): m is LoadStartMsg => m.type === 'load-start');
    send({ type: 'submit', clientId: cid('c1'), clientSeq: 1, epoch: start?.epoch as Epoch, baseRev: start?.rev ?? 0, ops: [ins(2, 'X')] });
    await waitFor(() => expect(frames.some((m) => m.type === 'ack')).toBe(true));
    // The shutdown flush writes the dirty document; the write fails.
    storage.failNext('write');
    await t.runtime.shutdown(2000);
    expect(onWriteFailed).toHaveBeenCalledTimes(1);
    expect(onWriteFailed.mock.calls[0]?.[0]).toMatchObject({ documentId: 'd.docx' });
  });
});

describe('re-exports (S-38)', () => {
  it('re-exports RecoveryEntry, RecoveryResolution and LocalCopy from core-entry', () => {
    expectTypeOf<RecoveryResolution>().toEqualTypeOf<'overwrite-storage' | 'discard-local' | 'mark-resolved'>();
    expectTypeOf<LocalCopy>().toHaveProperty('bytes');
    expectTypeOf<RecoveryEntry>().toHaveProperty('documentId');
    expectTypeOf<RecoveryEntry['state']>().toEqualTypeOf<'NORMAL' | 'LOCAL' | 'CHECK' | 'PENDING' | 'CONFLICT'>();
  });
});
