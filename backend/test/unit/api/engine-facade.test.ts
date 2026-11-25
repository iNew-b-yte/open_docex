// EngineFacade and AuditRelay (LLD Part 2 §2.6, §2.7, §6.2): the call-rejection table by engine
// state, argument checks in main, `sessions.close`, `shareInfo`, `audit.enable` and shutdown.
import { OpenDocexError } from '@open-docex/shared/errors';
import { asDocumentId } from '@open-docex/shared/ids';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_BUFFER_MAX, AuditRelay, EngineFacade, type CreateDocumentInput } from '../../../src/api/engine-facade.js';
import type { AuditEvent, EngineEventMap } from '../../../src/api/events.js';
import type { ResolvedEngineOptions } from '../../../src/api/options.js';
import { TypedEmitter } from '../../../src/api/typed-emitter.js';
import type { EngineChannel } from '../../../src/channel/engine-channel.js';
import type { ApiMethod } from '../../../src/channel/messages.js';
import type { Supervisor } from '../../../src/supervisor/supervisor.js';
import { connect, gatewayOptions, RecordingLogger, startGateway, until, type GatewayHarness } from '../gateway/helpers.js';

/** A channel whose `call`s are recorded and answered from `answers`. */
class ApiChannel implements EngineChannel {
  readonly calls: Array<{ method: string; args: unknown }> = [];
  readonly requests: Array<{ type: string; body: unknown; timeoutMs: number | undefined }> = [];
  answers: Partial<Record<ApiMethod, (args: unknown) => unknown>> = {};
  shutdownError: Error | undefined;
  /** When set, `request('shutdown')` waits for it. */
  shutdownGate: Promise<void> | undefined;

  post(): void {}
  call(method: ApiMethod, args: unknown): Promise<never> {
    this.calls.push({ method, args });
    const answer = this.answers[method];
    return Promise.resolve(answer === undefined ? undefined : answer(args)) as Promise<never>;
  }
  request(type: string, body: unknown, timeoutMs?: number): Promise<never> {
    this.requests.push({ type, body, timeoutMs });
    const gate = this.shutdownGate ?? Promise.resolve();
    return gate.then(() => (this.shutdownError === undefined ? (undefined as never) : Promise.reject(this.shutdownError)));
  }
  onEvent(): () => void {
    return () => undefined;
  }
  onHook(): void {}
  /** The calls to `method`, so an `audit.enable` assertion ignores other traffic. */
  of(method: ApiMethod): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
}

const doc = asDocumentId('doc1');
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Made {
  facade: EngineFacade;
  channel: ApiChannel;
  emitter: TypedEmitter<EngineEventMap>;
  logger: RecordingLogger;
  gw: GatewayHarness;
  relay: AuditRelay;
  supervisor: { stop: ReturnType<typeof vi.fn> };
  inProcess: { close: ReturnType<typeof vi.fn> };
}

let gw: GatewayHarness | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

async function make(over: Partial<ResolvedEngineOptions> = {}, o: { worker?: boolean } = {}): Promise<Made> {
  gw = await startGateway({ authorize: () => ({ userId: 'u', access: 'edit', document: { ref: 'a', format: 'docx' } }), ...over });
  const logger = new RecordingLogger();
  const emitter = new TypedEmitter<EngineEventMap>(logger);
  const channel = new ApiChannel();
  const relay = new AuditRelay(emitter, logger);
  const supervisor = { stop: vi.fn(() => Promise.resolve()) };
  const inProcess = { close: vi.fn() };
  const facade = new EngineFacade({
    opts: gatewayOptions(over),
    gateway: gw.gateway,
    channel,
    emitter,
    logger,
    relay,
    ...(o.worker === true ? { supervisor: supervisor as unknown as Supervisor } : { inProcess: inProcess as never }),
  });
  return { facade, channel, emitter, logger, gw, relay, supervisor, inProcess };
}

const engineEvent = (state: 'started' | 'restarting' | 'failed') => ({ state, at: 1 });

/** Every public call that reaches the Core, with valid arguments. */
function coreCalls(f: EngineFacade): Array<[string, () => Promise<unknown>]> {
  const create: CreateDocumentInput = { kind: 'text', format: 'docx', name: 'n', target: 'storage' };
  return [
    ['documents.create', () => f.documents.create(create)],
    ['documents.allowUnsupportedEdit', () => f.documents.allowUnsupportedEdit(doc)],
    ['recovery.list', () => f.recovery.list()],
    ['recovery.retry', () => f.recovery.retry(doc)],
    ['recovery.readLocalCopy', () => f.recovery.readLocalCopy(doc)],
    ['recovery.resolve', () => f.recovery.resolve(doc, 'discard-local')],
    ['shareInfo', () => f.shareInfo(doc)],
  ];
}

describe('EngineFacade call rejection by engine state (LLD §2.6)', () => {
  it('forwards every call to the Core while running', async () => {
    const m = await make();
    m.channel.answers['documents.info'] = () => ({ documentId: doc, loaded: false });
    expect(m.facade.state).toBe('running');
    for (const [, call] of coreCalls(m.facade)) await call();
    expect(m.channel.calls.map((c) => c.method).filter((x) => x !== 'audit.enable')).toEqual([
      'documents.create',
      'documents.allowUnsupportedEdit',
      'recovery.list',
      'recovery.retry',
      'recovery.readLocalCopy',
      'recovery.resolve',
      'documents.info',
    ]);
  });

  it.each([
    ['restarting', 'ENGINE_RESTARTING'],
    ['failed', 'ENGINE_FAILED'],
  ] as const)('rejects at once with the right code while %s, without calling the Core', async (state, code) => {
    const m = await make();
    m.emitter.emit('engine', engineEvent(state));
    expect(m.facade.state).toBe(state);
    m.channel.calls.length = 0;
    for (const [name, call] of coreCalls(m.facade)) {
      await expect(call(), name).rejects.toMatchObject({ code });
    }
    expect(m.channel.calls).toEqual([]);
  });

  it('marks ENGINE_RESTARTING retryable and ENGINE_FAILED not', async () => {
    const m = await make();
    m.emitter.emit('engine', engineEvent('restarting'));
    const err = await m.facade.recovery.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenDocexError);
    expect((err as OpenDocexError).retryable).toBe(true);
    m.emitter.emit('engine', engineEvent('failed'));
    const err2 = await m.facade.recovery.list().catch((e: unknown) => e);
    expect((err2 as OpenDocexError).retryable).toBe(false);
  });

  it('forwards again once the Core started again', async () => {
    const m = await make();
    m.emitter.emit('engine', engineEvent('restarting'));
    m.emitter.emit('engine', engineEvent('started'));
    expect(m.facade.state).toBe('running');
    await expect(m.facade.recovery.list()).resolves.toBeUndefined();
  });

  it('rejects with SESSION_CLOSED once stopped, and ignores later engine events', async () => {
    const m = await make();
    await m.facade.shutdown();
    expect(m.facade.state).toBe('stopped');
    m.emitter.emit('engine', engineEvent('started'));
    expect(m.facade.state).toBe('stopped');
    for (const [name, call] of coreCalls(m.facade)) await expect(call(), name).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });
});

describe('EngineFacade argument checks (before any Core call)', () => {
  const create = (over: Record<string, unknown>) => ({ kind: 'text', format: 'docx', name: 'n', target: 'storage', ...over }) as never;

  it.each([
    ['a kind that does not match the format', { kind: 'sheet', format: 'docx' }],
    ['a text kind with a sheet format', { kind: 'text', format: 'xlsx' }],
    ['an unknown format', { format: 'pdf' }],
    ['an unknown kind', { kind: 'slides' }],
    ['an empty name', { name: '' }],
    ['a missing name', { name: undefined }],
    ['an unknown target', { target: 'cloud' }],
  ])('documents.create rejects %s with CONFIG_INVALID', async (_name, over) => {
    const m = await make();
    m.channel.calls.length = 0;
    await expect(m.facade.documents.create(create(over))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(m.channel.calls).toEqual([]);
  });

  it('documents.create rejects a non-object', async () => {
    const m = await make();
    await expect(m.facade.documents.create(null as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('rejects an invalid document id with CONFIG_INVALID', async () => {
    const m = await make();
    m.channel.calls.length = 0;
    for (const bad of ['', 'a\u0001b', 'x'.repeat(1025), 5, undefined]) {
      await expect(m.facade.recovery.retry(bad as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      await expect(m.facade.shareInfo(bad as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
    expect(m.channel.calls).toEqual([]);
  });

  it('recovery.resolve accepts the three resolutions and rejects others', async () => {
    const m = await make();
    for (const ok of ['overwrite-storage', 'discard-local', 'mark-resolved'] as const) {
      await m.facade.recovery.resolve(doc, ok);
    }
    expect(m.channel.of('recovery.resolve')).toEqual([
      { documentId: doc, resolution: 'overwrite-storage' },
      { documentId: doc, resolution: 'discard-local' },
      { documentId: doc, resolution: 'mark-resolved' },
    ]);
    await expect(m.facade.recovery.resolve(doc, 'delete' as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('sessions.close needs at least one field and checks their types (synchronously)', async () => {
    const m = await make();
    expect(() => m.facade.sessions.close({})).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error);
    expect(() => m.facade.sessions.close(null as never)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error);
    expect(() => m.facade.sessions.close({ userId: 5 } as never)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error);
    expect(() => m.facade.sessions.close({ documentId: '' as never })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error);
  });
});

describe('EngineFacade results', () => {
  it('returns what the Core answered', async () => {
    const m = await make();
    m.channel.answers['documents.create'] = () => ({ ref: 'new.docx' });
    m.channel.answers['recovery.list'] = () => [{ documentId: doc, state: 'LOCAL' }];
    await expect(m.facade.documents.create({ kind: 'text', format: 'docx', name: 'x', target: 'storage' })).resolves.toEqual({ ref: 'new.docx' });
    await expect(m.facade.recovery.list()).resolves.toEqual([{ documentId: doc, state: 'LOCAL' }]);
  });

  it('passes a Core error through unchanged', async () => {
    const m = await make();
    const boom = new OpenDocexError('DOCUMENT_NOT_FOUND', undefined, { documentId: 'doc1' });
    m.channel.call = () => Promise.reject(boom);
    await expect(m.facade.recovery.retry(doc)).rejects.toBe(boom);
  });

  it('shareInfo combines the Core answer with live session counts', async () => {
    const m = await make();
    m.channel.answers['documents.info'] = () => ({ documentId: 'doc1', loaded: true, kind: 'text' });
    const edit = connect(m.gw.url('/open-docex?doc=doc1'));
    expect(await edit.status).toBe(101);
    await until(() => m.gw.channel.of('join').length === 1);
    expect(await m.facade.shareInfo(doc)).toEqual({ documentId: 'doc1', loaded: true, kind: 'text', sessions: { edit: 1, view: 0 } });
    m.channel.answers['documents.info'] = () => ({ documentId: 'doc2', loaded: false });
    expect(await m.facade.shareInfo(asDocumentId('doc2'))).toEqual({ documentId: 'doc2', loaded: false, sessions: { edit: 0, view: 0 } });
  });

  it('sessions.close closes only the matching sessions and returns the number', async () => {
    let user = 'alice';
    const m = await make({ authorize: () => ({ userId: user, access: 'edit', document: { ref: 'a', format: 'docx' } }) });
    const a = connect(m.gw.url());
    await a.status;
    user = 'bob';
    const b = connect(m.gw.url());
    await b.status;
    await until(() => m.gw.channel.of('join').length === 2);
    expect(m.facade.sessions.close({ userId: 'alice' })).toBe(1);
    expect(await a.closed).toEqual({ code: 4005, reason: 'SESSION_CLOSED' });
    expect(b.ws.readyState).toBe(b.ws.OPEN);
    expect(m.facade.sessions.close({ userId: 'alice' })).toBe(0);
    expect(m.facade.sessions.close({ documentId: doc })).toBe(1);
    expect((await b.closed).code).toBe(4005);
  });
});

describe('EngineFacade events and audit.enable (LLD §6.2)', () => {
  it('on() returns an unsubscribe function and off() removes a listener', async () => {
    const m = await make();
    const seen: string[] = [];
    const fn = (e: { state: string }): void => void seen.push(e.state);
    const unsub = m.facade.on('engine', fn);
    m.emitter.emit('engine', engineEvent('restarting'));
    unsub();
    m.emitter.emit('engine', engineEvent('started'));
    expect(seen).toEqual(['restarting']);
    m.facade.on('engine', fn);
    m.facade.off('engine', fn);
    m.emitter.emit('engine', engineEvent('restarting'));
    expect(seen).toEqual(['restarting']);
  });

  it('turns audit off at construction, on with the first listener and off with the last', async () => {
    const m = await make();
    await tick();
    expect(m.channel.of('audit.enable')).toEqual([{ enabled: false }]);
    const off1 = m.facade.on('audit', () => undefined);
    const off2 = m.facade.on('audit', () => undefined);
    await tick();
    expect(m.channel.of('audit.enable')).toEqual([{ enabled: false }, { enabled: true }]);
    off1();
    await tick();
    expect(m.channel.of('audit.enable')).toHaveLength(2); // one listener left
    off2();
    await tick();
    expect(m.channel.of('audit.enable')).toEqual([{ enabled: false }, { enabled: true }, { enabled: false }]);
  });

  it('syncs audit.enable again when the Core started again (a fresh Core starts enabled)', async () => {
    const m = await make();
    await tick();
    m.channel.calls.length = 0;
    m.emitter.emit('engine', engineEvent('restarting'));
    m.emitter.emit('engine', engineEvent('started'));
    await tick();
    expect(m.channel.of('audit.enable')).toEqual([{ enabled: false }]);
  });

  it('does not call audit.enable while the Core is not running', async () => {
    const m = await make();
    await tick();
    m.emitter.emit('engine', engineEvent('restarting'));
    m.channel.calls.length = 0;
    m.facade.on('audit', () => undefined);
    await tick();
    expect(m.channel.of('audit.enable')).toEqual([]);
  });

  it('survives an audit.enable that could not be delivered', async () => {
    const m = await make();
    m.channel.call = () => Promise.reject(new Error('gone'));
    m.facade.on('audit', () => undefined);
    await tick();
    expect(m.logger.lines.join('\n')).toContain('audit.enable was not delivered');
  });
});

describe('AuditRelay', () => {
  const ev = (rev: number): AuditEvent => ({ documentId: doc, rev }) as unknown as AuditEvent;

  function relay() {
    const logger = new RecordingLogger();
    const emitter = new TypedEmitter<EngineEventMap>(logger);
    return { logger, emitter, relay: new AuditRelay(emitter, logger) };
  }

  it('delivers straight to listeners', () => {
    const { emitter, relay: r } = relay();
    const seen: number[] = [];
    emitter.on('audit', (e) => seen.push(e.rev));
    r.sink(ev(1));
    r.sink(ev(2));
    expect(seen).toEqual([1, 2]);
  });

  it('keeps events that arrive before a listener and delivers them in order on drain', () => {
    const { emitter, relay: r } = relay();
    r.sink(ev(1));
    r.sink(ev(2));
    const seen: number[] = [];
    emitter.on('audit', (e) => seen.push(e.rev));
    expect(seen).toEqual([]);
    r.drain();
    expect(seen).toEqual([1, 2]);
    r.drain();
    expect(seen).toEqual([1, 2]);
    r.sink(ev(3));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('does nothing on drain while there is still no listener', () => {
    const { emitter, relay: r } = relay();
    r.sink(ev(1));
    r.drain();
    const seen: number[] = [];
    emitter.on('audit', (e) => seen.push(e.rev));
    r.drain();
    expect(seen).toEqual([1]);
  });

  it('stops keeping events at the cap, and warns once', () => {
    const { emitter, relay: r, logger } = relay();
    for (let i = 0; i < AUDIT_BUFFER_MAX + 5; i++) r.sink(ev(i));
    expect(logger.lines.filter((l) => l.includes('dropped'))).toHaveLength(1);
    const seen: number[] = [];
    emitter.on('audit', (e) => seen.push(e.rev));
    r.drain();
    expect(seen).toHaveLength(AUDIT_BUFFER_MAX);
    expect(seen[0]).toBe(0);
  });
});

describe('EngineFacade shutdown (LLD §2.6, §4.4)', () => {
  it('stops accepting, closes the sessions, shuts the Core down, then detaches', async () => {
    const m = await make();
    let release: () => void = () => undefined;
    m.channel.shutdownGate = new Promise<void>((r) => (release = r));
    const c = connect(m.gw.url());
    await c.status;
    await until(() => m.gw.channel.of('join').length === 1);
    const done = m.facade.shutdown({ timeoutMs: 4000 });
    expect(m.facade.state).toBe('stopping');
    // The Core is still stopping: new upgrades get 503, and the listener is still attached.
    expect(await connect(m.gw.url()).status).toBe(503);
    expect(m.gw.server.listenerCount('upgrade')).toBe(1);
    release();
    await done;
    expect(await c.closed).toEqual({ code: 4005, reason: 'SESSION_CLOSED' });
    expect(m.channel.requests).toEqual([{ type: 'shutdown', body: { timeoutMs: 3500 }, timeoutMs: 4000 }]);
    expect(m.inProcess.close).toHaveBeenCalledTimes(1);
    expect(m.gw.server.listenerCount('upgrade')).toBe(0);
    expect(m.facade.state).toBe('stopped');
    expect(m.gw.channel.of('leave').map((l) => l.reason)).toEqual(['shutdown']);
  });

  it('uses the Supervisor in worker mode, with the configured timeout by default', async () => {
    const m = await make({}, { worker: true });
    await m.facade.shutdown();
    expect(m.supervisor.stop).toHaveBeenCalledWith(10_000);
    expect(m.channel.requests).toEqual([]);
  });

  it('returns the same promise when called twice', async () => {
    const m = await make();
    const a = m.facade.shutdown();
    const b = m.facade.shutdown();
    expect(a).toBe(b);
    await a;
    expect(m.channel.requests).toHaveLength(1);
  });

  it('still finishes when the Core does not stop cleanly', async () => {
    const m = await make();
    m.channel.shutdownError = new Error('timed out');
    await expect(m.facade.shutdown()).resolves.toBeUndefined();
    expect(m.facade.state).toBe('stopped');
    expect(m.gw.server.listenerCount('upgrade')).toBe(0);
    expect(m.logger.lines.join('\n')).toContain('did not stop cleanly');
  });

  it('attach() adds an upgrade listener to another server', async () => {
    const m = await make();
    const { createServer } = await import('node:http');
    const other = createServer();
    m.facade.attach(other);
    expect(other.listenerCount('upgrade')).toBe(1);
    await m.facade.shutdown();
    expect(other.listenerCount('upgrade')).toBe(0);
  });
});
