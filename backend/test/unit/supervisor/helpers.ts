// Test doubles for the Supervisor: a fake clock, a fake child process and resolved options.
import { EventEmitter } from 'node:events';
import type { ChildProcess, ForkOptions } from 'node:child_process';
import type { ResolvedEngineOptions, ResolvedSupervisorOptions } from '../../../src/api/options.js';
import type { CoreEvent, CoreRequest } from '../../../src/channel/messages.js';
import type { Clock } from '../../../src/supervisor/supervisor.js';
import { noopLogger } from '../../../src/log/logger.js';

/** A manual clock: timers fire only in {@link FakeClock.advance}. */
export class FakeClock implements Clock {
  #now = 0;
  #seq = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Moves time forward by `ms`, firing due timers in order and flushing async work after each. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.#timers) if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) next = e;
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].fn();
      await flush();
    }
    this.#now = end;
    await flush();
  }
}

/** Lets pending promise callbacks and setImmediate work run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

export interface ChildScript {
  /** How the fake answers init. Default `ready`. */
  init?: 'ready' | 'error' | 'silent' | 'exit';
  /** Whether it answers ping. Default true. */
  pong?: boolean;
  /** Whether it answers shutdown (and then exits). Default true. */
  shutdown?: boolean;
}

/** A fake forked Core speaking the §6.2 messages. */
export class FakeChild extends EventEmitter {
  connected = true;
  readonly pid: number;
  readonly received: CoreRequest[] = [];
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  exited = false;
  readonly #script: ChildScript;

  constructor(pid: number, script: ChildScript) {
    super();
    this.pid = pid;
    this.#script = script;
  }

  send(msg: CoreRequest, cb?: (err: Error | null) => void): boolean {
    this.received.push(msg);
    setImmediate(() => {
      cb?.(null);
      this.#react(msg);
    });
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    this.exit(null, 'SIGKILL');
    return true;
  }

  /** Simulates the process ending. */
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.connected = false;
    setImmediate(() => this.emit('exit', code, signal));
  }

  /** Delivers a Core → main message. */
  reply(ev: CoreEvent): void {
    this.emit('message', ev);
  }

  #react(msg: CoreRequest): void {
    if (this.exited) return;
    const s = this.#script;
    switch (msg.type) {
      case 'init':
        if ((s.init ?? 'ready') === 'ready') {
          this.reply({ type: 'ready', id: msg.id, pid: this.pid, boot: { documents: 0, recovering: 0, dirty: 0, queueBacklog: 0 } });
        } else if (s.init === 'error') {
          this.reply({ type: 'result', id: msg.id, ok: false, error: { code: 'CONFIG_INVALID', message: 'storage: bad' } });
        } else if (s.init === 'exit') {
          this.exit(1);
        }
        return;
      case 'ping':
        if (s.pong ?? true) this.reply({ type: 'pong', seq: msg.seq });
        return;
      case 'shutdown':
        if (s.shutdown ?? true) {
          this.reply({ type: 'result', id: msg.id, ok: true, value: undefined });
          this.exit(0);
        }
        return;
      default:
    }
  }
}

/** A fork function that hands out {@link FakeChild}ren, each scripted by `next()`. */
export function fakeFork(next: () => ChildScript = () => ({})): {
  fork: (p: string, a: readonly string[], o: ForkOptions) => ChildProcess;
  children: FakeChild[];
  calls: { path: string; options: ForkOptions }[];
} {
  const children: FakeChild[] = [];
  const calls: { path: string; options: ForkOptions }[] = [];
  return {
    children,
    calls,
    fork(path, _args, options) {
      calls.push({ path, options });
      const c = new FakeChild(1000 + children.length, next());
      children.push(c);
      return c as unknown as ChildProcess;
    },
  };
}

export const DEFAULT_SUPERVISOR: ResolvedSupervisorOptions = {
  heartbeatIntervalMs: 5000,
  heartbeatTimeoutMs: 15000,
  backoffMs: [1000, 2000, 4000, 8000, 16000],
  maxRestarts: 5,
  restartWindowMs: 600_000,
  bootTimeoutMs: 60_000,
  shutdownTimeoutMs: 10_000,
};

export function resolvedOptions(supervisor: Partial<ResolvedSupervisorOptions> = {}): ResolvedEngineOptions {
  return {
    mode: 'worker',
    workerConfigModule: '/abs/worker.mjs',
    http: { path: '/open-docex' },
    authorize: () => null,
    supervisor: { ...DEFAULT_SUPERVISOR, ...supervisor },
    send: { highWaterMarkBytes: 8 * 1024 * 1024 },
    ws: { maxPayloadBytes: 16 * 1024 * 1024, pingIntervalMs: 30_000, helloTimeoutMs: 30_000 },
    logger: noopLogger,
    logLevel: 'info',
  };
}
