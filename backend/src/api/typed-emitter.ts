/**
 * A small typed event emitter for the engine's public events (LLD Part 2 §2.7, LLD choice).
 *
 * Unlike Node's `EventEmitter`, it never throws: an `error` event with no listener is
 * logged with `logger.error`, and an exception thrown by a listener is caught and logged.
 * The engine therefore cannot crash the adopter's process through its events.
 *
 * @module
 */
import type { Logger } from '../log/logger.js';

/** An event map: event name → payload type. */
export type EventMap = { [event: string]: unknown };

/** A listener for event `E` of map `M`. */
export type Listener<M extends EventMap, E extends keyof M> = (payload: M[E]) => void;

/** Reads an error code from a payload, if it has one, for the log line. */
function codeOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Reads a message from a thrown value, for the log line. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/** A typed emitter over event map `M` that never throws from {@link TypedEmitter.emit}. */
export class TypedEmitter<M extends EventMap> {
  readonly #listeners = new Map<keyof M, Set<(payload: never) => void>>();
  readonly #logger: Logger;

  /** @param logger receives unhandled `error` events and listener exceptions. */
  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** Adds `fn` for `event` and returns a function that removes it. */
  on<E extends keyof M>(event: E, fn: Listener<M, E>): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  /** Removes `fn` for `event`. Removing a listener that was never added does nothing. */
  off<E extends keyof M>(event: E, fn: Listener<M, E>): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    set.delete(fn);
    if (set.size === 0) this.#listeners.delete(event);
  }

  /** The number of listeners for `event`. */
  listenerCount(event: keyof M): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /**
   * Calls every listener for `event` with `payload`, in the order they were added. Never
   * throws. Returns true when at least one listener was called.
   */
  emit<E extends keyof M>(event: E, payload: M[E]): boolean {
    const set = this.#listeners.get(event);
    if (set === undefined || set.size === 0) {
      if (event === 'error') this.#logUnhandled(payload);
      return false;
    }
    for (const fn of [...set] as Listener<M, E>[]) {
      try {
        fn(payload);
      } catch (err) {
        this.#safeLog(`Engine "${String(event)}" listener threw: ${messageOf(err)}`, codeOf(err));
      }
    }
    return true;
  }

  #logUnhandled(payload: unknown): void {
    this.#safeLog('Unhandled engine error event: ' + messageOf(payload), codeOf(payload));
  }

  #safeLog(msg: string, code: string | undefined): void {
    try {
      if (code === undefined) this.#logger.error(msg);
      else this.#logger.error(msg, { code });
    } catch {
      // The adopter's logger threw; there is nowhere left to report it, and emit must not throw.
    }
  }
}
