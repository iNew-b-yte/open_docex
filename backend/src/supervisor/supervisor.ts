/**
 * The Supervisor (LLD Part 2 §5, HLD §11.3, §12): in `mode: 'worker'` it forks the Core, watches
 * it with a heartbeat, restarts it with backoff after a crash, and gives up (FAILED) after too
 * many restarts inside the restart window.
 *
 * Platform note: on Windows there are no POSIX signals. `kill('SIGKILL')` terminates the child
 * forcefully (TerminateProcess), and the reported exit `signal` may differ from Linux. The state
 * machine never branches on the exit code or signal; it only passes them on in `engine` events.
 *
 * @module
 */
import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OpenDocexError } from '@open-docex/shared/errors';
import type { EngineEventMap, EngineStateEvent } from '../api/events.js';
import type { ResolvedEngineOptions } from '../api/options.js';
import type { TypedEmitter } from '../api/typed-emitter.js';
import { IpcEngineChannel } from '../channel/ipc-engine-channel.js';
import type { CoreEvent } from '../channel/messages.js';
import { engineError } from '../errors/engine-error.js';
import type { Logger } from '../log/logger.js';

/** The Supervisor's states (HLD §11.3). */
export type SupervisorState = 'STARTING' | 'RUNNING' | 'RESTARTING' | 'FAILED' | 'STOPPING' | 'STOPPED';

/** Injectable time (LLD Part 2 conventions). Real timers are `unref()`'d. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real clock, with `unref()`'d timers. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * The part of the Gateway the Supervisor drives. The Gateway (a later task) implements it; it is
 * declared here so the Supervisor does not depend on the Gateway module.
 */
export interface SupervisorGateway {
  /** The Core went down: close sessions with `ENGINE_RESTARTING`, or refuse upgrades once `failed`. */
  onCoreDown(reason: 'restarting' | 'failed'): void;
}

/** Forks the Core. Replaceable in tests. */
export type ForkFn = (modulePath: string, args: readonly string[], options: ForkOptions) => ChildProcess;

/** Test seams; production passes none. */
export interface SupervisorDeps {
  /** Default: `child_process.fork`. */
  fork?: ForkFn;
  /** Default: `../core/core-entry.js` next to this module. */
  coreEntryPath?: string;
}

/** The fork options of LLD Part 2 §5. */
export function coreForkOptions(): ForkOptions {
  return {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: process.execArgv.filter((a) => !a.startsWith('--inspect')),
    env: process.env,
    windowsHide: true,
  };
}

/** How long a graceful stop waits for the child to exit before killing it (LLD Part 2 §5). */
const STOP_EXIT_WAIT_MS = 1000;
/** How much of the stop budget the Core gets for its own shutdown (LLD Part 2 §5). */
const SHUTDOWN_MARGIN_MS = 500;

interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export class Supervisor {
  readonly channel: IpcEngineChannel;
  readonly #opts: ResolvedEngineOptions;
  readonly #gateway: SupervisorGateway;
  readonly #emitter: TypedEmitter<EngineEventMap>;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #fork: ForkFn;
  readonly #entry: string;

  #state: SupervisorState = 'STOPPED';
  #child: ChildProcess | undefined;
  #firstStart = true;
  #restarts: number[] = [];
  #lastPong = 0;
  #pingSeq = 0;
  #heartbeat: unknown;
  #restartTimer: unknown;
  #exitWaiters: (() => void)[] = [];
  #started = false;

  constructor(
    opts: ResolvedEngineOptions,
    gateway: SupervisorGateway,
    emitter: TypedEmitter<EngineEventMap>,
    logger: Logger,
    clock: Clock = realClock,
    deps: SupervisorDeps = {},
  ) {
    this.#opts = opts;
    this.#gateway = gateway;
    this.#emitter = emitter;
    this.#logger = logger;
    this.#clock = clock;
    this.#fork = deps.fork ?? ((p, a, o) => nodeFork(p, [...a], o));
    this.#entry = deps.coreEntryPath ?? fileURLToPath(new URL('../core/core-entry.js', import.meta.url));
    this.channel = new IpcEngineChannel({ logger, timers: clock });
    this.channel.onEvent((ev) => this.#onEvent(ev));
  }

  get state(): SupervisorState {
    return this.#state;
  }

  /** The delay the next restart would use, given the restarts still inside the window. */
  get nextBackoffMs(): number {
    const backoff = this.#opts.supervisor.backoffMs;
    const recent = this.#pruned(this.#clock.now()).length;
    return backoff[Math.min(recent, backoff.length - 1)] ?? 0;
  }

  /**
   * Forks the Core and resolves on its first `ready`. Rejects with the first boot error, a boot
   * timeout or an early exit; there is no retry at the first start (LLD Part 2 §5).
   */
  async start(): Promise<void> {
    if (this.#started) throw engineError('CONFIG_INVALID', { message: 'Supervisor.start() may be called only once.' });
    this.#started = true;
    this.#firstStart = true;
    await this.#boot();
  }

  /** Graceful stop (LLD Part 2 §5): ask the Core to shut down, wait, then kill if needed. */
  async stop(timeoutMs: number): Promise<void> {
    if (this.#state === 'STOPPED' || this.#state === 'STOPPING') return;
    this.#state = 'STOPPING';
    this.#stopHeartbeat();
    if (this.#restartTimer !== undefined) {
      this.#clock.clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const child = this.#child;
    if (child !== undefined) {
      try {
        await this.channel.request('shutdown', { timeoutMs: Math.max(0, timeoutMs - SHUTDOWN_MARGIN_MS) }, timeoutMs);
      } catch (err) {
        this.#logger.warn('Core shutdown request failed: ' + errMessage(err), { code: codeOf(err) });
      }
      if (this.#child === child && !(await this.#waitForExit(STOP_EXIT_WAIT_MS))) {
        this.#kill(child);
      }
      this.#releaseChild(child);
      this.channel.unbind(engineError('ENGINE_RESTARTING', { message: 'The engine stopped.' }));
    }
    this.#state = 'STOPPED';
  }

  // ---- boot -------------------------------------------------------------------------------

  async #boot(): Promise<void> {
    this.#state = 'STARTING';
    const first = this.#firstStart;
    let child: ChildProcess;
    try {
      child = this.#fork(this.#entry, [], coreForkOptions());
    } catch (err) {
      const e = engineError('ENGINE_FAILED', { message: 'Forking the Core failed: ' + errMessage(err), cause: err });
      if (first) {
        this.#state = 'STOPPED';
        throw e;
      }
      this.#onChildGone(undefined, { code: null, signal: null });
      return;
    }
    this.#child = child;
    child.once('exit', (code, signal) => this.#onChildGone(child, { code, signal }));
    child.once('error', (err) => {
      this.#logger.error('Core process error: ' + err.message);
      this.#onChildGone(child, { code: null, signal: null });
    });
    this.channel.bind(child);

    const { workerConfigModule, logLevel, supervisor } = this.#opts;
    try {
      const ready = await this.channel.request('init', { workerConfigModule, logLevel }, supervisor.bootTimeoutMs);
      if (this.#child !== child || this.#state !== 'STARTING') return; // gone or stopping meanwhile
      this.#firstStart = false;
      this.#state = 'RUNNING';
      this.#lastPong = this.#clock.now();
      this.#startHeartbeat();
      this.#logger.info('Core started.', { pid: ready.pid, count: ready.boot.documents });
      this.#emitEngine({ state: 'started', at: this.#clock.now() });
    } catch (err) {
      if (first) {
        // First start: no retry. Kill the child and reject start() with the first boot error.
        const e = this.#bootError(err);
        if (this.#child === child) {
          this.#releaseChild(child);
          this.#kill(child);
          this.channel.unbind(engineError('ENGINE_RESTARTING'));
        }
        if (this.#state === 'STARTING') this.#state = 'STOPPED';
        throw e;
      }
      // After a restart: a boot error or timeout ends this child; its exit runs "child gone".
      if (this.#child === child && this.#state === 'STARTING') {
        this.#logger.error('Core failed to boot after a restart: ' + errMessage(err), { code: codeOf(err) });
        this.#kill(child);
      }
    }
  }

  /** The error start() rejects with. An exit during boot unbinds the channel with ENGINE_RESTARTING; report it as such. */
  #bootError(err: unknown): OpenDocexError {
    if (isOdx(err) && err.code !== 'ENGINE_RESTARTING') return err;
    return engineError('ENGINE_FAILED', { message: 'The Core exited during boot.', cause: err });
  }

  // ---- child gone -------------------------------------------------------------------------

  /** Idempotent per child: 'exit' may not follow 'error', and both call this. */
  #onChildGone(child: ChildProcess | undefined, exit: ExitInfo): void {
    if (child !== undefined) {
      if (this.#child !== child) return;
      this.#releaseChild(child);
    }
    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    for (const w of waiters) w();

    // STOPPING: stop() finishes the job. STARTING on first start: #boot rejects start().
    if (this.#state === 'STOPPING' || this.#state === 'STOPPED' || this.#state === 'FAILED') return;
    if (this.#state === 'STARTING' && this.#firstStart) {
      this.channel.unbind(engineError('ENGINE_RESTARTING', { message: 'The Core exited during boot.' }));
      return;
    }

    this.#stopHeartbeat();
    this.channel.unbind(engineError('ENGINE_RESTARTING'));
    this.#gateway.onCoreDown('restarting');
    const now = this.#clock.now();
    this.#restarts = this.#pruned(now);
    const { maxRestarts, backoffMs } = this.#opts.supervisor;
    const exitInfo = { code: exit.code, signal: exit.signal };

    if (this.#restarts.length >= maxRestarts) {
      this.#state = 'FAILED';
      this.#gateway.onCoreDown('failed');
      const fatal = engineError('ENGINE_FAILED', {
        message: `The Core crashed ${this.#restarts.length + 1} times within ${this.#opts.supervisor.restartWindowMs} ms.`,
      });
      this.#logger.error('Core FAILED: restart limit reached.', { code: 'ENGINE_FAILED', count: this.#restarts.length });
      this.#emitter.emit('fatal', fatal);
      this.#emitEngine({ state: 'failed', at: now, exit: exitInfo, error: fatal });
      return;
    }

    const delayMs = backoffMs[Math.min(this.#restarts.length, backoffMs.length - 1)] ?? 0;
    this.#restarts.push(now);
    this.#state = 'RESTARTING';
    this.#logger.warn('Core exited; restarting.', { durationMs: delayMs, attempt: this.#restarts.length });
    this.#emitEngine({ state: 'restarting', at: now, delayMs, restartCount: this.#restarts.length, exit: exitInfo });
    this.#restartTimer = this.#clock.setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#state !== 'RESTARTING') return;
      void this.#boot();
    }, delayMs);
  }

  #pruned(now: number): number[] {
    const windowMs = this.#opts.supervisor.restartWindowMs;
    return this.#restarts.filter((t) => now - t < windowMs);
  }

  // ---- heartbeat --------------------------------------------------------------------------

  #onEvent(ev: CoreEvent): void {
    if (ev.type === 'pong' && this.#state === 'RUNNING') this.#lastPong = this.#clock.now();
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeat = this.#clock.setTimeout(() => this.#tick(), this.#opts.supervisor.heartbeatIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) this.#clock.clearTimeout(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #tick(): void {
    this.#heartbeat = undefined;
    const child = this.#child;
    if (this.#state !== 'RUNNING' || child === undefined) return;
    const silentMs = this.#clock.now() - this.#lastPong;
    if (silentMs > this.#opts.supervisor.heartbeatTimeoutMs) {
      this.#logger.error('Core heartbeat timed out; killing it.', { durationMs: silentMs, pid: child.pid ?? null });
      this.#kill(child); // the exit then runs "child gone"
    } else {
      this.channel.post({ type: 'ping', seq: ++this.#pingSeq });
    }
    // Keep ticking until "child gone" stops the heartbeat, so a kill that does not take is retried.
    this.#startHeartbeat();
  }

  // ---- helpers ----------------------------------------------------------------------------

  #kill(child: ChildProcess): void {
    try {
      child.kill('SIGKILL');
    } catch (err) {
      this.#logger.warn('Killing the Core failed: ' + errMessage(err));
    }
  }

  /** Forgets `child` as the current child (its listeners stay; they check identity). */
  #releaseChild(child: ChildProcess): void {
    if (this.#child === child) this.#child = undefined;
  }

  /** Resolves true when the current child exits within `ms`, false on timeout. */
  #waitForExit(ms: number): Promise<boolean> {
    if (this.#child === undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = this.#clock.setTimeout(() => {
        this.#exitWaiters = this.#exitWaiters.filter((w) => w !== onExit);
        resolve(false);
      }, ms);
      const onExit = (): void => {
        this.#clock.clearTimeout(timer);
        resolve(true);
      };
      this.#exitWaiters.push(onExit);
    });
  }

  #emitEngine(ev: EngineStateEvent): void {
    this.#emitter.emit('engine', ev);
  }
}

function isOdx(x: unknown): x is OpenDocexError {
  return x instanceof OpenDocexError;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string | undefined {
  return isOdx(err) ? err.code : undefined;
}
