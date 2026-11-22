// One contract suite for both EngineChannel transports (LLD Part 2 §6.5 tests): ordering,
// call/result, error rebuilding, rejection on unbind, hooks and reply correlation.
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, OpenDocexError } from '@open-docex/shared/errors';
import type { CoreChannelSide, EngineChannel } from '../../../src/channel/engine-channel.js';
import { InProcessEngineChannel } from '../../../src/channel/in-process-engine-channel.js';
import { IpcCoreChannelSide, IpcEngineChannel, type CorePort } from '../../../src/channel/ipc-engine-channel.js';
import type { CoreEvent, CoreRequest } from '../../../src/channel/messages.js';
import { engineError } from '../../../src/errors/engine-error.js';
import type { Logger } from '../../../src/log/logger.js';

interface Harness {
  main: EngineChannel;
  core: CoreChannelSide;
  /** Unbind (IPC) or close (in-process) with `reason`. */
  cut(reason: OpenDocexError): void;
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const rec = (m: string): void => {
    lines.push(m);
  };
  return { logger: { debug: rec, info: rec, warn: rec, error: rec }, lines };
}

/** An IPC pair over an in-memory link that structured-clones each message, as advanced serialization does. */
function ipcHarness(logger?: Logger): Harness {
  const coreInbox = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send(msg: CoreRequest, cb: (err: Error | null) => void): boolean {
      const copy = structuredClone(msg);
      setImmediate(() => {
        coreInbox.emit('message', copy);
        cb(null);
      });
      return true;
    },
  });
  const port: CorePort = {
    send(msg, cb) {
      const copy = structuredClone(msg);
      setImmediate(() => {
        child.emit('message', copy);
        cb(null);
      });
      return true;
    },
    on: (event, listener) => coreInbox.on(event, listener),
  };
  const main = new IpcEngineChannel(logger ? { logger } : {});
  main.bind(child as unknown as ChildProcess);
  const core = new IpcCoreChannelSide(port);
  return { main, core, cut: (r) => main.unbind(r) };
}

function inProcessHarness(logger?: Logger): Harness {
  const [main, core] = InProcessEngineChannel.pair(logger ? { logger } : {});
  return { main, core, cut: (r) => main.close(r) };
}

/** A tiny Core: answers init, ping, frame and call; `hold` keeps calls unanswered. */
function serve(core: CoreChannelSide, o: { hold?: boolean } = {}): CoreRequest[] {
  const seen: CoreRequest[] = [];
  core.onRequest((m) => {
    seen.push(m);
    switch (m.type) {
      case 'init':
        core.emit({ type: 'ready', id: m.id, pid: 42, boot: { documents: 1, recovering: 0, dirty: 0, queueBacklog: 0 } });
        return;
      case 'ping':
        core.emit({ type: 'pong', seq: m.seq });
        return;
      case 'frame':
        core.emit({ type: 'send', frames: [{ sessionIds: [m.sessionId], data: m.data, binary: m.binary }] });
        return;
      case 'call': {
        if (o.hold) return;
        const args = m.args as { fail?: boolean };
        if (args.fail) {
          core.emit({
            type: 'result',
            id: m.id,
            ok: false,
            error: { code: 'DOCUMENT_NOT_FOUND', message: 'no such doc', documentId: 'd1', causeMessage: 'ENOENT' },
          });
        } else core.emit({ type: 'result', id: m.id, ok: true, value: { echo: m.args } });
        return;
      }
      case 'shutdown':
        core.emit({ type: 'result', id: m.id, ok: true, value: undefined });
        return;
      default:
    }
  });
  return seen;
}

function nextEvents(main: EngineChannel, n: number): Promise<CoreEvent[]> {
  return new Promise((resolve) => {
    const got: CoreEvent[] = [];
    const off = main.onEvent((ev) => {
      got.push(ev);
      if (got.length === n) {
        off();
        resolve(got);
      }
    });
  });
}

const transports: [string, (logger?: Logger) => Harness][] = [
  ['IpcEngineChannel', ipcHarness],
  ['InProcessEngineChannel', inProcessHarness],
];

describe.each(transports)('EngineChannel contract: %s', (_name, make) => {
  it('delivers posts asynchronously and in FIFO order, bytes intact', async () => {
    const h = make();
    serve(h.core);
    const events = nextEvents(h.main, 50);
    for (let i = 0; i < 50; i++) h.main.post({ type: 'frame', sessionId: `s${i}`, data: new Uint8Array([i, 255]), binary: true });
    const got = await events;
    expect(got.map((e) => (e.type === 'send' ? e.frames[0]?.sessionIds[0] : null))).toEqual(
      Array.from({ length: 50 }, (_, i) => `s${i}`),
    );
    const last = got[49];
    expect(last?.type === 'send' && last.frames[0]?.data).toEqual(new Uint8Array([49, 255]));
  });

  it('never delivers synchronously inside post', () => {
    const h = make();
    const seen = serve(h.core);
    h.main.post({ type: 'ping', seq: 1 });
    expect(seen).toEqual([]);
  });

  it('resolves init with the ready payload', async () => {
    const h = make();
    serve(h.core);
    await expect(h.main.request('init', { workerConfigModule: '/w.js', logLevel: 'info' })).resolves.toEqual({
      pid: 42,
      boot: { documents: 1, recovering: 0, dirty: 0, queueBacklog: 0 },
    });
  });

  it('correlates concurrent calls with their results', async () => {
    const h = make();
    serve(h.core);
    const [a, b] = await Promise.all([h.main.call('documents.info', { n: 1 }), h.main.call('recovery.list', { n: 2 })]);
    expect(a).toEqual({ echo: { n: 1 } });
    expect(b).toEqual({ echo: { n: 2 } });
  });

  it('rebuilds a WireError result with catalogue fields', async () => {
    const h = make();
    serve(h.core);
    const err: unknown = await h.main.call('documents.info', { fail: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenDocexError);
    const e = err as OpenDocexError;
    expect(e.code).toBe('DOCUMENT_NOT_FOUND');
    expect(e.retryable).toBe(ERROR_CATALOGUE.DOCUMENT_NOT_FOUND.retryable);
    expect(e.remediation).toBe(ERROR_CATALOGUE.DOCUMENT_NOT_FOUND.remediation);
    expect(e.documentId).toBe('d1');
    expect(e.cause).toBe('ENOENT');
  });

  it('rejects everything pending when cut, and rejects later calls', async () => {
    const h = make();
    serve(h.core, { hold: true });
    const p1 = h.main.call('documents.info', {});
    const p2 = h.main.call('audit.enable', { enabled: true });
    await new Promise((r) => setImmediate(r));
    h.cut(engineError('ENGINE_RESTARTING'));
    await expect(p1).rejects.toMatchObject({ code: 'ENGINE_RESTARTING' });
    await expect(p2).rejects.toMatchObject({ code: 'ENGINE_RESTARTING' });
    await expect(h.main.call('documents.info', {})).rejects.toBeInstanceOf(OpenDocexError);
  });

  it('times out a request that is never answered', async () => {
    const h = make();
    h.core.onRequest(() => {});
    await expect(h.main.request('shutdown', { timeoutMs: 1 }, 20)).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
  });

  it('logs and drops a result with an unknown id', async () => {
    const { logger, lines } = recordingLogger();
    const h = make(logger);
    const delivered: CoreEvent[] = [];
    h.main.onEvent((e) => delivered.push(e));
    h.core.emit({ type: 'result', id: 999, ok: true, value: 1 });
    h.core.emit({ type: 'pong', seq: 7 });
    await nextEvents(h.main, 1);
    expect(lines.some((l) => l.includes('unknown id 999'))).toBe(true);
    expect(delivered).toEqual([{ type: 'pong', seq: 7 }]);
  });

  it('runs a hook in main and returns its result to the Core', async () => {
    const h = make();
    h.core.onRequest(() => {});
    h.main.onHook((name, args) => Promise.resolve({ name, args }));
    await expect(h.core.hook('onUploaded', { x: 1 })).resolves.toEqual({ name: 'onUploaded', args: { x: 1 } });
    h.main.onHook(() => Promise.reject(engineError('DOCUMENT_TOO_LARGE')));
    await expect(h.core.hook('onUploaded', {})).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });
});

describe('IpcCoreChannelSide flow control (LLD Part 2 §6.4)', () => {
  it('waits at 1024 in flight and resumes below 512', async () => {
    const callbacks: ((err: Error | null) => void)[] = [];
    const port: CorePort = {
      send(_m, cb) {
        callbacks.push(cb);
        return true;
      },
      on: () => undefined,
    };
    const core = new IpcCoreChannelSide(port);
    for (let i = 0; i < 1023; i++) core.emit({ type: 'pong', seq: i });
    let resolved = false;
    await core.whenWritable();
    core.emit({ type: 'pong', seq: 1023 });
    expect(core.inFlight).toBe(1024);
    const waiting = core.whenWritable().then(() => {
      resolved = true;
    });
    const fire = (n: number): void => {
      for (let i = 0; i < n; i++) callbacks.shift()?.(null);
    };
    fire(512); // 512 in flight: not below the low-water mark yet
    await Promise.resolve();
    expect(resolved).toBe(false);
    await expect(Promise.race([core.whenWritable().then(() => 'ready'), Promise.resolve('blocked')])).resolves.toBe('blocked');
    fire(1); // 511
    await waiting;
    expect(resolved).toBe(true);
    expect(core.inFlight).toBe(511);
    await core.whenWritable();
  });

  it('reports a failed send and still frees its slot', () => {
    const errors: Error[] = [];
    const port: CorePort = {
      send(_m, cb) {
        cb(new Error('channel closed'));
        return false;
      },
      on: () => undefined,
    };
    const core = new IpcCoreChannelSide(port, (e) => errors.push(e));
    core.emit({ type: 'pong', seq: 1 });
    expect(errors.map((e) => e.message)).toEqual(['channel closed']);
    expect(core.inFlight).toBe(0);
  });
});
