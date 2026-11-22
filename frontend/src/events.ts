/**
 * Mount events and the typed emitter behind `MountHandle.on` (LLD Part 3 §2.1).
 *
 * @module
 */
import type { NoticeMsg, UnsupportedFinding } from '@open-docex/shared/protocol';
import type { ErrorCode } from '@open-docex/shared/errors';
import type { DocumentKind } from './options.js';

/**
 * An error as the adopter sees it, through `hooks.onError` and the `error` event. It never
 * carries a token, URL or server detail (LLD Part 3 §15).
 */
export interface ClientError {
  code: ErrorCode;
  retryable: boolean;
  /** The sanitized catalogue message (HLD §11.1). */
  message: string;
  /** True when the session stopped and shows the error screen (LLD Part 3 §16). */
  terminal: boolean;
}

/** Load progress while a document's chunks arrive (LLD Part 3 §5). */
export interface LoadProgress {
  chunksReceived: number;
  bytesReceived: number;
  totalChunks?: number;
}

/** The session's status snapshot (LLD Part 3 §2.1). */
export interface SessionStatus {
  connection: 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed';
  load: 'idle' | 'loading' | 'ready';
  access: 'edit' | 'view' | null;
  readOnlyReason: null | 'view' | 'unsupported' | 'server' | 'restoring';
  sync: 'synced' | 'pending' | 'busy' | 'restoring';
  storage: 'normal' | 'local' | 'pending' | 'conflict';
}

/** Payload of the `ready` event. */
export interface ReadyEvent {
  kind: DocumentKind;
  access: 'edit' | 'view';
  readOnly: boolean;
  unsupported: readonly UnsupportedFinding[];
}

/** Payload of the `sync` event. `pendingCount > 0` means unconfirmed changes exist (L-14). */
export interface SyncEvent {
  pendingCount: number;
  confirmedRev: number;
}

/** Every event a mounted editor emits, keyed by name (LLD Part 3 §2.1). */
export interface MountEvents {
  status: SessionStatus;
  'load-progress': LoadProgress;
  ready: ReadyEvent;
  sync: SyncEvent;
  notice: NoticeMsg;
  error: ClientError;
  destroyed: undefined;
}

/** A listener for one event. */
export type Listener<T> = (payload: T) => void;

/**
 * A small typed event emitter. A listener that throws doesn't stop the others; its error is
 * re-thrown on a microtask so it still reaches the page's error reporting.
 */
export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Adds a listener. Returns a function that removes it; calling that twice is harmless. */
  on<E extends keyof Events>(event: E, fn: Listener<Events[E]>): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    // A wrapper, so the same function added twice gets two independent subscriptions.
    const entry: Listener<Events[E]> = (payload) => fn(payload);
    set.add(entry);
    return () => {
      const current = this.#listeners.get(event);
      if (current === undefined) return;
      current.delete(entry);
      if (current.size === 0) this.#listeners.delete(event);
    };
  }

  /** Calls every listener of `event` with `payload`, in the order they were added. */
  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    for (const fn of [...set] as Listener<Events[E]>[]) {
      try {
        fn(payload);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  /** The number of listeners currently registered, over all events. */
  get listenerCount(): number {
    let n = 0;
    for (const set of this.#listeners.values()) n += set.size;
    return n;
  }

  /** Removes every listener. */
  clear(): void {
    this.#listeners.clear();
  }
}
