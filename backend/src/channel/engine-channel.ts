/**
 * The EngineChannel bridge (LLD Part 2 §6.1, §6.3): one API between main and the Core over two
 * transports, child-process IPC (`ipc-engine-channel.ts`) and in-process
 * (`in-process-engine-channel.ts`). This module holds the interfaces and the transport-neutral
 * correlation logic both transports share.
 *
 * @module
 */
import type { OpenDocexError } from '@open-docex/shared/errors';
import { engineError } from '../errors/engine-error.js';
import { noopLogger, type Logger } from '../log/logger.js';
import type {
  ApiArgs,
  ApiMethod,
  ApiResult,
  CoreEvent,
  CoreRequest,
  HookName,
  RequestBody,
  RequestResult,
  RequestType,
} from './messages.js';
import { fromWire, isWireError, toWire } from './wire-error.js';

/** The main side (A) of the channel. */
export interface EngineChannel {
  /** Fire-and-forget, FIFO. */
  post(msg: CoreRequest): void;
  /** Calls an engine API method in the Core. No timeout of its own (LLD Part 2 §6.3). */
  call<M extends ApiMethod>(method: M, args: ApiArgs[M]): Promise<ApiResult[M]>;
  /** `init` (answered by `ready`) or `shutdown`, with an optional timeout. */
  request<T extends RequestType>(type: T, body: RequestBody[T], timeoutMs?: number): Promise<RequestResult[T]>;
  /**
   * Adds a handler for Core events and returns a function that removes it. Replies the channel
   * correlates itself (`ready`, `result` and `hook`) are not delivered here.
   */
  onEvent(handler: (ev: CoreEvent) => void): () => void;
  /** Sets the handler for Core → main hooks (V4). */
  onHook(handler: (name: HookName, args: unknown) => Promise<unknown>): void;
}

/** The Core side (B) of the channel. */
export interface CoreChannelSide {
  /** Sets the handler for main → Core messages. `hook-result` is consumed by the channel. */
  onRequest(handler: (msg: CoreRequest) => void): void;
  emit(ev: CoreEvent): void;
  /** Resolves when the transport has room for more messages (LLD Part 2 §6.4). */
  whenWritable(): Promise<void>;
  /** Calls a main-side hook (V4). */
  hook(name: HookName, args: unknown): Promise<unknown>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: OpenDocexError): void;
  timer?: unknown;
}

/** The timer part of a Clock (LLD Part 2 conventions). */
export interface ChannelTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers, `unref()`'d so they never keep the process alive. */
export const realChannelTimers: ChannelTimers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** Options shared by both transports. */
export interface ChannelOptions {
  logger?: Logger;
  timers?: ChannelTimers;
}

/**
 * Correlation of `init`/`shutdown`/`call` with their replies, event fan-out and hook dispatch,
 * independent of the transport. A transport implements {@link MainChannelBase.transmit} and feeds
 * every Core message to {@link MainChannelBase.receive}.
 */
export abstract class MainChannelBase implements EngineChannel {
  protected readonly logger: Logger;
  readonly #timers: ChannelTimers;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #handlers = new Set<(ev: CoreEvent) => void>();
  #hook: ((name: HookName, args: unknown) => Promise<unknown>) | undefined;

  constructor(o: ChannelOptions = {}) {
    this.logger = o.logger ?? noopLogger;
    this.#timers = o.timers ?? realChannelTimers;
  }

  /** Sends one message over the transport. Throws an `OpenDocexError` when it cannot. */
  protected abstract transmit(msg: CoreRequest): void;

  /** The error a call or request fails with when the transport cannot send now. */
  protected abstract unavailable(): OpenDocexError;

  /** The number of requests and calls awaiting a reply. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  post(msg: CoreRequest): void {
    try {
      this.transmit(msg);
    } catch {
      this.logger.debug('Dropped a message to the Core: the channel is not connected.');
    }
  }

  call<M extends ApiMethod>(method: M, args: ApiArgs[M]): Promise<ApiResult[M]> {
    return this.#send<ApiResult[M]>((id) => ({ type: 'call', id, method, args }), undefined);
  }

  request<T extends RequestType>(type: T, body: RequestBody[T], timeoutMs?: number): Promise<RequestResult[T]> {
    return this.#send<RequestResult[T]>(
      (id) => (type === 'init' ? { type: 'init', id, ...(body as RequestBody['init']) } : { type: 'shutdown', id, ...(body as RequestBody['shutdown']) }),
      timeoutMs === undefined ? undefined : { ms: timeoutMs, what: type },
    );
  }

  onEvent(handler: (ev: CoreEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  onHook(handler: (name: HookName, args: unknown) => Promise<unknown>): void {
    this.#hook = handler;
  }

  /** Rejects every pending request and call with `reason` (LLD Part 2 §6.3). */
  protected rejectAll(reason: OpenDocexError): void {
    const all = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of all) {
      if (p.timer !== undefined) this.#timers.clearTimeout(p.timer);
      p.reject(reason);
    }
  }

  /** Handles one message from the Core. */
  protected receive(ev: CoreEvent): void {
    switch (ev.type) {
      case 'ready':
        this.#settle(ev.id, (p) => p.resolve({ pid: ev.pid, boot: ev.boot }));
        return;
      case 'result':
        this.#settle(ev.id, (p) => {
          if (ev.ok) p.resolve(ev.value);
          else p.reject(isWireError(ev.error) ? fromWire(ev.error) : engineError('DOCUMENT_FAULTED', { message: 'The Core sent a malformed error.' }));
        });
        return;
      case 'hook':
        this.#runHook(ev.id, ev.name, ev.args);
        return;
      default:
        for (const h of [...this.#handlers]) {
          try {
            h(ev);
          } catch (err) {
            this.logger.error('An EngineChannel event handler threw: ' + (err instanceof Error ? err.message : String(err)));
          }
        }
    }
  }

  #send<R>(build: (id: number) => CoreRequest, timeout: { ms: number; what: string } | undefined): Promise<R> {
    const id = this.#nextId++;
    return new Promise<R>((resolve, reject) => {
      const p: Pending = { resolve: resolve, reject };
      this.#pending.set(id, p);
      if (timeout !== undefined) {
        p.timer = this.#timers.setTimeout(() => {
          if (this.#pending.get(id) !== p) return;
          this.#pending.delete(id);
          reject(engineError('ENGINE_FAILED', { message: `The Core did not answer "${timeout.what}" within ${timeout.ms} ms.` }));
        }, timeout.ms);
      }
      try {
        this.transmit(build(id));
      } catch {
        this.#pending.delete(id);
        if (p.timer !== undefined) this.#timers.clearTimeout(p.timer);
        reject(this.unavailable());
      }
    });
  }

  #settle(id: number, fn: (p: Pending) => void): void {
    const p = this.#pending.get(id);
    if (p === undefined) {
      this.logger.warn(`Dropped a Core reply with unknown id ${id}.`);
      return;
    }
    this.#pending.delete(id);
    if (p.timer !== undefined) this.#timers.clearTimeout(p.timer);
    fn(p);
  }

  #runHook(id: number, name: HookName, args: unknown): void {
    const hook = this.#hook;
    const done = (msg: CoreRequest): void => this.post(msg);
    if (hook === undefined) {
      done({ type: 'hook-result', id, ok: false, error: { code: 'CONFIG_INVALID', message: `No handler for hook "${name}".` } });
      return;
    }
    // V4 plumbing: a hook failure that is not an OpenDocexError is reported as DOCUMENT_FAULTED,
    // because the only hook (`onUploaded`) runs for one document's upload.
    // Starting from a resolved promise turns a synchronous throw into a rejection.
    Promise.resolve()
      .then(() => hook(name, args))
      .then(
      (value) => done({ type: 'hook-result', id, ok: true, value }),
      (err: unknown) => done({ type: 'hook-result', id, ok: false, error: toWire(err, { where: 'instance' }) }),
    );
  }
}

/**
 * The Core side's correlation of `hook` calls, independent of the transport. A transport
 * implements {@link CoreSideBase.transmit} and feeds every main message to
 * {@link CoreSideBase.receive}.
 */
export abstract class CoreSideBase implements CoreChannelSide {
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #handler: ((msg: CoreRequest) => void) | undefined;
  readonly #queued: CoreRequest[] = [];

  protected abstract transmit(ev: CoreEvent): void;
  abstract whenWritable(): Promise<void>;

  /** Sets the request handler. Messages that arrived before it was set are delivered to it first. */
  onRequest(handler: (msg: CoreRequest) => void): void {
    this.#handler = handler;
    const queued = this.#queued.splice(0);
    for (const m of queued) handler(m);
  }

  emit(ev: CoreEvent): void {
    this.transmit(ev);
  }

  hook(name: HookName, args: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.transmit({ type: 'hook', id, name, args });
    });
  }

  /** Handles one message from main. */
  protected receive(msg: CoreRequest): void {
    if (msg.type === 'hook-result') {
      const p = this.#pending.get(msg.id);
      if (p === undefined) return;
      this.#pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(fromWire(msg.error));
      return;
    }
    if (this.#handler === undefined) this.#queued.push(msg);
    else this.#handler(msg);
  }
}
