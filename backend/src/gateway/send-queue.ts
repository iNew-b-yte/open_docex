/**
 * `SendQueue`: the per-connection outgoing FIFO with a high-water mark (LLD Part 2 §4.3,
 * HLD §11.4).
 *
 * `ws.send()` keeps order. The queue counts the bytes that were handed to ws and not yet written
 * out, and closes a connection that falls too far behind with `SESSION_SLOW_CONSUMER`.
 *
 * @module
 */
import { CloseCode } from '@open-docex/shared/protocol';

/** The part of a `ws` WebSocket the queue uses. A fake implements it in tests. */
export interface SendSocket {
  send(data: string | Uint8Array, options: { binary: boolean }, callback: (err?: Error) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

/** The timer part of a clock. */
export interface QueueTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** How long a slow consumer's close waits behind its backlog before the socket is terminated. */
export const SLOW_CONSUMER_TERMINATE_MS = 5000;

/** Options for one {@link SendQueue.push}. */
export interface PushOptions {
  /** Default: true for byte arrays, false for strings. */
  binary?: boolean;
  /** Called once the frame was written out (load pacing, LLD Part 2 §8.5). */
  onWritten?: () => void;
}

const realTimers: QueueTimers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout(h) {
    clearTimeout(h as NodeJS.Timeout);
  },
};

/** The per-connection FIFO. */
export class SendQueue {
  readonly #ws: SendSocket;
  readonly #hwm: number;
  readonly #onOverflow: () => void;
  readonly #timers: QueueTimers;
  #pending = 0;
  #closed = false;
  #terminateTimer: unknown;

  /**
   * @param ws the socket.
   * @param highWaterMarkBytes the most bytes that may wait for the socket.
   * @param onOverflow called once, after the slow-consumer close was started.
   * @param timers used for the terminate timer. Default: real, `unref()`'d timers.
   */
  constructor(ws: SendSocket, highWaterMarkBytes: number, onOverflow: () => void, timers: QueueTimers = realTimers) {
    this.#ws = ws;
    this.#hwm = highWaterMarkBytes;
    this.#onOverflow = onOverflow;
    this.#timers = timers;
  }

  /** Bytes handed to ws and not yet written out. */
  get pendingBytes(): number {
    return this.#pending;
  }

  /** True once the queue stopped accepting frames. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Queues one frame. Returns false once the queue is closed, or when this frame overflowed the
   * high-water mark (the connection is then closed with `SESSION_SLOW_CONSUMER`).
   *
   * A single frame larger than the mark is accepted when nothing else is waiting: one large
   * `asset` is not a slow consumer (LLD choice; the literal rule would make every such frame
   * fatal).
   */
  push(data: string | Uint8Array, o: PushOptions = {}): boolean {
    if (this.#closed) return false;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (this.#pending > 0 && this.#pending + size > this.#hwm) {
      this.#overflow();
      return false;
    }
    this.#pending += size;
    try {
      this.#ws.send(data, { binary: o.binary ?? typeof data !== 'string' }, (err) => {
        this.#pending -= size;
        if (err === undefined || err === null) o.onWritten?.();
      });
    } catch {
      this.#pending -= size;
      return false;
    }
    return true;
  }

  /** Stops accepting frames and cancels the terminate timer. Call when the socket is gone. */
  close(): void {
    this.#closed = true;
    if (this.#terminateTimer !== undefined) {
      this.#timers.clearTimeout(this.#terminateTimer);
      this.#terminateTimer = undefined;
    }
  }

  #overflow(): void {
    this.#closed = true;
    try {
      this.#ws.close(CloseCode.SLOW_CONSUMER, 'SESSION_SLOW_CONSUMER');
    } catch {
      // The socket is already going away.
    }
    // The close frame waits behind the backlog, and ws's own closeTimeout is 30 s.
    this.#terminateTimer = this.#timers.setTimeout(() => {
      this.#terminateTimer = undefined;
      try {
        this.#ws.terminate();
      } catch {
        // Nothing left to do.
      }
    }, SLOW_CONSUMER_TERMINATE_MS);
    this.#onOverflow();
  }
}
