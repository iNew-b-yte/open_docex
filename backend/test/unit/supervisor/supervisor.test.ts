// Supervisor state machine (LLD Part 2 §5) with a fake clock and fake children.
import { describe, expect, it } from 'vitest';
import type { OpenDocexError } from '@open-docex/shared/errors';
import type { EngineEventMap, EngineStateEvent } from '../../../src/api/events.js';
import type { ResolvedSupervisorOptions } from '../../../src/api/options.js';
import { TypedEmitter } from '../../../src/api/typed-emitter.js';
import { noopLogger } from '../../../src/log/logger.js';
import { Supervisor, type SupervisorGateway } from '../../../src/supervisor/supervisor.js';
import { FakeClock, fakeFork, flush, resolvedOptions, type ChildScript } from './helpers.js';

function setup(o: { supervisor?: Partial<ResolvedSupervisorOptions>; script?: (n: number) => ChildScript } = {}) {
  const clock = new FakeClock();
  let n = 0;
  const forks = fakeFork(() => o.script?.(n++) ?? {});
  const down: ('restarting' | 'failed')[] = [];
  const gateway: SupervisorGateway = { onCoreDown: (r) => down.push(r) };
  const emitter = new TypedEmitter<EngineEventMap>(noopLogger);
  const engine: EngineStateEvent[] = [];
  const fatal: OpenDocexError[] = [];
  emitter.on('engine', (e) => engine.push(e));
  emitter.on('fatal', (e) => fatal.push(e));
  const sup = new Supervisor(resolvedOptions(o.supervisor), gateway, emitter, noopLogger, clock, {
    fork: forks.fork,
    coreEntryPath: '/core-entry.js',
  });
  return { clock, forks, down, engine, fatal, sup };
}

/** Starts the supervisor; the fake child answers init by itself. */
async function started(o: Parameters<typeof setup>[0] = {}) {
  const t = setup(o);
  await t.sup.start();
  return t;
}

describe('Supervisor start', () => {
  it('forks the Core with advanced serialization and resolves on ready', async () => {
    const t = await started();
    expect(t.sup.state).toBe('RUNNING');
    expect(t.forks.calls).toHaveLength(1);
    const call = t.forks.calls[0];
    expect(call?.path).toBe('/core-entry.js');
    expect(call?.options).toMatchObject({ serialization: 'advanced', windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    expect(call?.options.execArgv?.some((a) => a.startsWith('--inspect'))).toBe(false);
    expect(t.forks.children[0]?.received[0]).toMatchObject({ type: 'init', workerConfigModule: '/abs/worker.mjs', logLevel: 'info' });
    expect(t.engine).toEqual([{ state: 'started', at: 0 }]);
  });

  it('rejects with the boot error, kills the child and stops (no retry)', async () => {
    const t = setup({ script: () => ({ init: 'error' }) });
    await expect(t.sup.start()).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: 'storage: bad' });
    expect(t.sup.state).toBe('STOPPED');
    expect(t.forks.children[0]?.kills).toEqual(['SIGKILL']);
    await t.clock.advance(60_000);
    expect(t.forks.calls).toHaveLength(1);
  });

  it('rejects on a boot timeout', async () => {
    const t = setup({ script: () => ({ init: 'silent' }) });
    const p = t.sup.start().catch((e: unknown) => e);
    await flush();
    await t.clock.advance(60_000);
    expect(await p).toMatchObject({ code: 'ENGINE_FAILED' });
    expect(t.sup.state).toBe('STOPPED');
    expect(t.forks.children[0]?.kills).toEqual(['SIGKILL']);
  });

  it('rejects when the child exits during the first boot', async () => {
    const t = setup({ script: () => ({ init: 'exit' }) });
    await expect(t.sup.start()).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    expect(t.sup.state).toBe('STOPPED');
    expect(t.down).toEqual([]);
    expect(t.forks.calls).toHaveLength(1);
  });
});

describe('Supervisor heartbeat', () => {
  it('pings every interval and keeps a responsive Core', async () => {
    const t = await started();
    await t.clock.advance(60_000);
    const pings = t.forks.children[0]?.received.filter((m) => m.type === 'ping') ?? [];
    expect(pings.map((p) => (p.type === 'ping' ? p.seq : 0))).toEqual([...Array(12).keys()].map((i) => i + 1));
    expect(t.forks.children[0]?.kills).toEqual([]);
    expect(t.sup.state).toBe('RUNNING');
  });

  it('kills a Core silent for longer than heartbeatTimeoutMs, then restarts it', async () => {
    const t = await started({ script: (n) => (n === 0 ? { pong: false } : {}) });
    await t.clock.advance(15_000);
    expect(t.forks.children[0]?.kills).toEqual([]); // 15 s silent is not more than the timeout
    await t.clock.advance(5_000); // tick at 20 s: 20 s > 15 s
    expect(t.forks.children[0]?.kills).toEqual(['SIGKILL']);
    expect(t.sup.state).toBe('RESTARTING');
    expect(t.down).toEqual(['restarting']);
    await t.clock.advance(1000);
    expect(t.sup.state).toBe('RUNNING');
    expect(t.forks.calls).toHaveLength(2);
  });
});

describe('Supervisor restarts', () => {
  it('restarts after 1/2/4/8/16 s and reaches FAILED on the 6th crash in 10 minutes', async () => {
    const t = await started();
    const delays: number[] = [];
    for (let crash = 1; crash <= 5; crash++) {
      const child = t.forks.children.at(-1);
      child?.exit(1);
      await flush();
      expect(t.sup.state).toBe('RESTARTING');
      const ev = t.engine.at(-1);
      expect(ev).toMatchObject({ state: 'restarting', restartCount: crash, exit: { code: 1, signal: null } });
      delays.push(ev?.delayMs ?? -1);
      await t.clock.advance((ev?.delayMs ?? 0) - 1);
      expect(t.forks.calls).toHaveLength(crash); // not yet
      await t.clock.advance(1);
      expect(t.forks.calls).toHaveLength(crash + 1);
      expect(t.sup.state).toBe('RUNNING');
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);

    t.forks.children.at(-1)?.exit(1);
    await flush();
    expect(t.sup.state).toBe('FAILED');
    expect(t.fatal.map((e) => e.code)).toEqual(['ENGINE_FAILED']);
    expect(t.engine.at(-1)).toMatchObject({ state: 'failed', error: { code: 'ENGINE_FAILED' } });
    expect(t.down).toEqual(['restarting', 'restarting', 'restarting', 'restarting', 'restarting', 'restarting', 'failed']);
    await t.clock.advance(3_600_000);
    expect(t.forks.calls).toHaveLength(6);
  });

  it('prunes restarts older than the window, which resets the backoff', async () => {
    const t = await started();
    for (let i = 0; i < 4; i++) {
      t.forks.children.at(-1)?.exit(1);
      await flush();
      await t.clock.advance(t.engine.at(-1)?.delayMs ?? 0);
    }
    expect(t.sup.nextBackoffMs).toBe(16000);
    await t.clock.advance(600_000);
    expect(t.sup.nextBackoffMs).toBe(1000);
    t.forks.children.at(-1)?.exit(1);
    await flush();
    expect(t.engine.at(-1)).toMatchObject({ state: 'restarting', delayMs: 1000, restartCount: 1 });
  });

  it('uses the last backoff entry when restarts outnumber it', async () => {
    const t = await started({ supervisor: { backoffMs: [10, 20], maxRestarts: 4 } });
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      t.forks.children.at(-1)?.exit(1);
      await flush();
      delays.push(t.engine.at(-1)?.delayMs ?? -1);
      await t.clock.advance(t.engine.at(-1)?.delayMs ?? 0);
    }
    expect(delays).toEqual([10, 20, 20, 20]);
  });

  it('rejects pending calls with ENGINE_RESTARTING when the child is gone', async () => {
    const t = await started();
    const p = t.sup.channel.call('documents.info', {});
    await flush();
    t.forks.children[0]?.exit(1);
    await expect(p).rejects.toMatchObject({ code: 'ENGINE_RESTARTING' });
  });

  it("handles 'error' followed by 'exit' as one crash", async () => {
    const t = await started();
    const child = t.forks.children[0];
    child?.emit('error', new Error('spawn failed'));
    child?.emit('exit', 1, null);
    await flush();
    expect(t.engine.filter((e) => e.state === 'restarting')).toHaveLength(1);
    expect(t.down).toEqual(['restarting']);
  });

  it('kills a restarted Core that fails to boot, and restarts again', async () => {
    const t = await started({ script: (n) => (n === 1 ? { init: 'error' } : {}) });
    t.forks.children[0]?.exit(1);
    await flush();
    await t.clock.advance(1000);
    expect(t.forks.children[1]?.kills).toEqual(['SIGKILL']);
    expect(t.engine.at(-1)).toMatchObject({ state: 'restarting', delayMs: 2000, restartCount: 2 });
    await t.clock.advance(2000);
    expect(t.sup.state).toBe('RUNNING');
  });
});

describe('Supervisor stop', () => {
  it('asks the Core to shut down and waits for it to exit', async () => {
    const t = await started();
    const p = t.sup.stop(10_000);
    expect(t.sup.state).toBe('STOPPING');
    await flush();
    await p;
    const child = t.forks.children[0];
    expect(child?.received.at(-1)).toMatchObject({ type: 'shutdown', timeoutMs: 9500 });
    expect(child?.kills).toEqual([]);
    expect(t.sup.state).toBe('STOPPED');
    expect(t.down).toEqual([]);
    await t.clock.advance(60_000);
    expect(t.forks.calls).toHaveLength(1);
  });

  it('kills a Core that does not answer shutdown', async () => {
    const t = await started({ script: () => ({ shutdown: false }) });
    const p = t.sup.stop(2000);
    await flush();
    await t.clock.advance(2000); // shutdown request times out
    await t.clock.advance(1000); // exit wait
    await p;
    expect(t.forks.children[0]?.kills).toEqual(['SIGKILL']);
    expect(t.sup.state).toBe('STOPPED');
  });

  it('cancels a pending restart', async () => {
    const t = await started();
    t.forks.children[0]?.exit(1);
    await flush();
    expect(t.sup.state).toBe('RESTARTING');
    await t.sup.stop(1000);
    expect(t.sup.state).toBe('STOPPED');
    await t.clock.advance(60_000);
    expect(t.forks.calls).toHaveLength(1);
  });

  it('stops from FAILED', async () => {
    const t = await started({ supervisor: { maxRestarts: 0 } });
    t.forks.children[0]?.exit(1);
    await flush();
    expect(t.sup.state).toBe('FAILED');
    await t.sup.stop(1000);
    expect(t.sup.state).toBe('STOPPED');
  });
});
