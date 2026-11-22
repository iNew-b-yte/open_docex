/**
 * The in-memory {@link QueueAdapter} (LLD Part 2 §9.2), the V1 default.
 *
 * - Bounded per document and globally (HLD §11.4); over either bound, `enqueue` returns
 *   `QUEUE_FULL`, which is retryable.
 * - Items are lost in a crash, by design [A2]. Clients resend them, and dedupe drops the
 *   ones already committed.
 * - If a delivery returns without acking its item, that document's pump stops. It resumes
 *   when the item is acked, or the consumer's `stop()` drains the document (the instance's
 *   `fault()`, LLD Part 2 §8.4).
 *
 * @module
 */
import type { DocumentId } from '@open-docex/shared/ids';
import { engineError } from '../errors/engine-error.js';
import type {
  DeliverFn,
  EnqueueResult,
  QueueAdapter,
  QueueConsumer,
  QueueHooks,
  QueueItem,
} from './queue-adapter.js';

/**
 * `WorkerConfig.queue` for the memory adapter (LLD Part 2 §2.3). Defaults (HLD §11.4):
 * `perDocument` 1,000 envelopes, `global` 50,000 envelopes.
 */
export interface MemoryQueueConfig {
  type: 'memory';
  perDocument?: number;
  global?: number;
}

/** Resolved {@link MemoryQueue} bounds, in envelopes. */
export interface MemoryQueueOptions {
  perDocument: number;
  global: number;
}

/** A growable ring buffer with O(1) push, peek and shift. */
class RingDeque<T> {
  private buf: (T | undefined)[] = new Array<T | undefined>(16);
  private head = 0;
  private len = 0;

  get length(): number {
    return this.len;
  }

  push(v: T): void {
    if (this.len === this.buf.length) this.grow();
    this.buf[(this.head + this.len) % this.buf.length] = v;
    this.len++;
  }

  /** The oldest item, or `undefined` when empty. */
  peek(): T | undefined {
    return this.len === 0 ? undefined : this.buf[this.head];
  }

  shift(): T | undefined {
    if (this.len === 0) return undefined;
    const v = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.buf.length;
    this.len--;
    return v;
  }

  clear(): void {
    this.buf = new Array<T | undefined>(16);
    this.head = 0;
    this.len = 0;
  }

  private grow(): void {
    const next = new Array<T | undefined>(this.buf.length * 2);
    for (let i = 0; i < this.len; i++) next[i] = this.buf[(this.head + i) % this.buf.length];
    this.buf = next;
    this.head = 0;
  }
}

interface Consumer {
  deliver: DeliverFn;
  stop(): Promise<void>;
}

interface DocQueue {
  readonly documentId: DocumentId;
  readonly buf: RingDeque<QueueItem>;
  /** The attached consumer; at most one per document. */
  consumer: Consumer | undefined;
  /** A pump loop is running. */
  pumping: boolean;
  /** A pump is scheduled for the next microtask. */
  scheduled: boolean;
  /** The head item was delivered and its delivery returned without an ack. */
  awaitingAck: boolean;
  /** Bumped when the queue is drained, so that stale acks have no effect. */
  gen: number;
  /** The running pump loop, if any. */
  inflight: Promise<void> | undefined;
}

/**
 * The V1 in-memory queue. Deliveries for one document are serial and FIFO; documents are
 * pumped independently, so a slow consumer does not block other documents.
 */
export class MemoryQueue implements QueueAdapter {
  readonly kind = 'memory' as const;
  private readonly docs = new Map<DocumentId, DocQueue>();
  private globalDepth = 0;
  private closed = false;

  constructor(private readonly o: MemoryQueueOptions) {}

  /** No connection and no backlog: memory items do not survive a restart, so `onBacklog` is never called. */
  start(hooks: QueueHooks): Promise<void> {
    void hooks;
    return Promise.resolve();
  }

  /** Returns `QUEUE_FULL` over either bound, and `QUEUE_UNAVAILABLE` after `close()`. */
  enqueue(item: QueueItem): Promise<EnqueueResult> {
    if (this.closed) return Promise.resolve({ ok: false, code: 'QUEUE_UNAVAILABLE' });
    const q = this.docs.get(item.documentId);
    if (this.globalDepth >= this.o.global || (q?.buf.length ?? 0) >= this.o.perDocument) {
      return Promise.resolve({ ok: false, code: 'QUEUE_FULL' });
    }
    const dq = q ?? this.create(item.documentId);
    dq.buf.push(item);
    this.globalDepth++;
    this.schedulePump(dq);
    return Promise.resolve({ ok: true });
  }

  /**
   * Attaches the single consumer for `documentId`. Throws `QUEUE_UNAVAILABLE` when the
   * document already has a consumer or the queue is closed. `stop()` detaches it, drains
   * the document's queued items (they are dropped, not redelivered) and resolves once the
   * delivery in progress, if any, has returned.
   */
  consume(documentId: DocumentId, deliver: DeliverFn): QueueConsumer {
    if (this.closed) {
      throw engineError('QUEUE_UNAVAILABLE', { message: 'The memory queue is closed', documentId });
    }
    const q = this.docs.get(documentId) ?? this.create(documentId);
    if (q.consumer !== undefined) {
      throw engineError('QUEUE_UNAVAILABLE', {
        message: 'The document already has a queue consumer',
        documentId,
      });
    }
    let stopped: Promise<void> | undefined;
    const consumer: Consumer = {
      deliver,
      stop: () => {
        stopped ??= this.stopConsumer(q, consumer);
        return stopped;
      },
    };
    q.consumer = consumer;
    this.schedulePump(q);
    return { stop: () => consumer.stop() };
  }

  depth(documentId: DocumentId): number {
    return this.docs.get(documentId)?.buf.length ?? 0;
  }

  /** Stops every consumer and drops every queued item. Later `enqueue` calls get `QUEUE_UNAVAILABLE`. */
  async close(): Promise<void> {
    this.closed = true;
    const stops: Promise<void>[] = [];
    for (const q of this.docs.values()) if (q.consumer !== undefined) stops.push(q.consumer.stop());
    await Promise.all(stops);
    for (const q of this.docs.values()) this.drain(q);
    this.docs.clear();
  }

  private create(documentId: DocumentId): DocQueue {
    const q: DocQueue = {
      documentId,
      buf: new RingDeque<QueueItem>(),
      consumer: undefined,
      pumping: false,
      scheduled: false,
      awaitingAck: false,
      gen: 0,
      inflight: undefined,
    };
    this.docs.set(documentId, q);
    return q;
  }

  private async stopConsumer(q: DocQueue, consumer: Consumer): Promise<void> {
    if (q.consumer !== consumer) return;
    q.consumer = undefined;
    this.drain(q);
    await q.inflight;
    if (this.docs.get(q.documentId) === q && q.consumer === undefined && !q.pumping && q.buf.length === 0) {
      this.docs.delete(q.documentId);
    }
  }

  /** Drops every queued item of `q`, including an un-acked one in delivery. */
  private drain(q: DocQueue): void {
    this.globalDepth -= q.buf.length;
    q.buf.clear();
    q.gen++;
    q.awaitingAck = false;
  }

  private schedulePump(q: DocQueue): void {
    if (q.scheduled || q.pumping || q.awaitingAck || q.consumer === undefined || q.buf.length === 0) return;
    q.scheduled = true;
    queueMicrotask(() => {
      q.scheduled = false;
      this.pump(q);
    });
  }

  private pump(q: DocQueue): void {
    const consumer = q.consumer;
    if (q.pumping || q.awaitingAck || consumer === undefined) return;
    q.pumping = true;
    q.inflight = this.run(q, consumer);
  }

  private async run(q: DocQueue, consumer: Consumer): Promise<void> {
    try {
      while (q.consumer === consumer && !q.awaitingAck) {
        const item = q.buf.peek();
        if (item === undefined) break;
        const gen = q.gen;
        let acked = false;
        const ack = (): Promise<void> => {
          if (!acked && q.gen === gen) {
            acked = true;
            q.buf.shift();
            this.globalDepth--;
            if (q.awaitingAck) {
              q.awaitingAck = false;
              this.schedulePump(q);
            }
          }
          return Promise.resolve();
        };
        try {
          await consumer.deliver({ item, redelivered: false, ack });
        } catch {
          // The consumer owns its error handling (LLD Part 2 §8.4). An un-acked item
          // stops the pump below, exactly as a returned delivery without an ack does.
        }
        if (!acked && q.gen === gen) q.awaitingAck = true;
      }
    } finally {
      // Runs synchronously before the loop's promise settles, so an ack arriving right
      // after this point sees `pumping === false` and can schedule the next pump.
      q.pumping = false;
      q.inflight = undefined;
    }
    // A consumer attached while an earlier one was still finishing its delivery.
    this.schedulePump(q);
  }
}
