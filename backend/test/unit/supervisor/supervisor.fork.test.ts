// Supervisor over real forked test Cores (LLD Part 2 §5 integration tests), with real time and
// shortened settings. The same tests run on Windows and Linux; the assertions never depend on
// the exit signal, which differs between them (Windows has no POSIX signals).
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEventMap, EngineStateEvent } from '../../../src/api/events.js';
import type { ResolvedSupervisorOptions } from '../../../src/api/options.js';
import { TypedEmitter } from '../../../src/api/typed-emitter.js';
import { noopLogger } from '../../../src/log/logger.js';
import { coreForkOptions, realClock, Supervisor } from '../../../src/supervisor/supervisor.js';
import { fork } from 'node:child_process';
import { resolvedOptions } from './helpers.js';

const FAKE_CORE = fileURLToPath(new URL('../channel/fixtures/fake-core.mjs', import.meta.url));
const running: Supervisor[] = [];

function make(supervisor: Partial<ResolvedSupervisorOptions>, mode = 'ok') {
  const emitter = new TypedEmitter<EngineEventMap>(noopLogger);
  const events: EngineStateEvent[] = [];
  emitter.on('engine', (e) => events.push(e));
  const down: string[] = [];
  const sup = new Supervisor(resolvedOptions(supervisor), { onCoreDown: (r) => down.push(r) }, emitter, noopLogger, realClock, {
    coreEntryPath: FAKE_CORE,
    fork: (p, a, o) => fork(p, [...a], { ...o, env: { ...process.env, FAKE_CORE_MODE: mode } }),
  });
  running.push(sup);
  return { sup, events, down };
}

function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (cond()) resolve();
      else if (Date.now() > end) reject(new Error('condition not met in time'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop(1000);
});

describe('Supervisor with a forked Core', () => {
  it('uses the LLD fork options', () => {
    expect(coreForkOptions()).toMatchObject({ serialization: 'advanced', windowsHide: true });
  });

  it('starts, answers calls and stops gracefully', async () => {
    const { sup, events } = make({});
    await sup.start();
    expect(sup.state).toBe('RUNNING');
    await expect(sup.channel.call('documents.info', { bytes: new Uint8Array([7]) })).resolves.toEqual({ bytes: new Uint8Array([7]) });
    await sup.stop(3000);
    expect(sup.state).toBe('STOPPED');
    expect(events.map((e) => e.state)).toEqual(['started']);
  });

  it('rejects start with the boot error of the first start', async () => {
    const { sup } = make({}, 'boot-error');
    await expect(sup.start()).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: 'storage: must be an object' });
    expect(sup.state).toBe('STOPPED');
  });

  it('reaches FAILED on the 6th crash', async () => {
    const { sup, events, down } = make({ backoffMs: [10, 20, 40, 80, 160], restartWindowMs: 600_000 });
    await sup.start();
    for (let crash = 1; crash <= 6; crash++) {
      await until(() => sup.state === 'RUNNING');
      sup.channel.call('documents.info', { crash: true }).catch(() => {});
      await until(() => events.filter((e) => e.state !== 'started').length === crash);
    }
    expect(sup.state).toBe('FAILED');
    expect(events.filter((e) => e.state === 'restarting').map((e) => e.delayMs)).toEqual([10, 20, 40, 80, 160]);
    expect(events.at(-1)).toMatchObject({ state: 'failed', exit: { code: 3 } });
    expect(down.at(-1)).toBe('failed');
  }, 20_000);

  it('kills a busy-looping Core after the heartbeat timeout and restarts it', async () => {
    const { sup, events } = make({ heartbeatIntervalMs: 50, heartbeatTimeoutMs: 300, backoffMs: [10] });
    await sup.start();
    sup.channel.call('documents.info', { busy: true }).catch(() => {});
    await until(() => events.some((e) => e.state === 'restarting'));
    const restart = events.find((e) => e.state === 'restarting');
    // Killed, not exited by itself: Linux reports signal SIGKILL; Windows reports a non-zero code.
    expect(restart?.exit?.signal === 'SIGKILL' || (restart?.exit?.code ?? 0) !== 0).toBe(true);
    await until(() => sup.state === 'RUNNING');
  }, 20_000);
});
