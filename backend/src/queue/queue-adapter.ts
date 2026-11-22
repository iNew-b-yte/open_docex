/**
 * The incoming-queue port (LLD Part 2 §9.1). The Core enqueues every accepted `submit`
 * here and consumes it per document. V1 ships {@link MemoryQueue}; Redis Streams and Kafka
 * adapters follow in V3 against the same contract.
 *
 * Contract for every adapter:
 * - Deliveries for one document are serial and in FIFO order. Item n+1 is delivered only
 *   after item n's `ack()`.
 * - Depth counts an item from `enqueue` until its `ack`, including the item being processed.
 * - `QUEUE_FULL` is retryable (HLD §11.4): the client keeps the change pending and retries
 *   with backoff.
 *
 * @module
 */
import type { DocumentId } from '@open-docex/shared/ids';
import type { SubmitEnvelope } from '@open-docex/shared/protocol';

/** One submitted envelope waiting for its document's FIFO processing loop. */
export interface QueueItem {
  documentId: DocumentId;
  /** The sending session, or `null` when it is no longer known (for example after redelivery). */
  sessionId: string | null;
  userId: string;
  access: 'edit' | 'view';
  /** Clock time (ms) at which the Core accepted the envelope. */
  receivedAt: number;
  envelope: SubmitEnvelope;
}

/** One delivery of a {@link QueueItem} to its document's consumer. */
export interface QueueDelivery {
  item: QueueItem;
  /** `true` when the item may have been delivered before (durable adapters, after a crash). */
  redelivered: boolean;
  /** Removes the item from the queue. Calling it more than once has no further effect. */
  ack(): Promise<void>;
}

/** The outcome of {@link QueueAdapter.enqueue}. Both failure codes are retryable. */
export type EnqueueResult = { ok: true } | { ok: false; code: 'QUEUE_FULL' | 'QUEUE_UNAVAILABLE' };

/** The consumer callback for one document. The next item is delivered only after this item's `ack()`. */
export type DeliverFn = (d: QueueDelivery) => Promise<void>;

/** A running consumer, returned by {@link QueueAdapter.consume}. */
export interface QueueConsumer {
  /** Stops delivering to this consumer. Resolves once no delivery is in progress. */
  stop(): Promise<void>;
}

/** Hooks the Core passes to {@link QueueAdapter.start}. */
export interface QueueHooks {
  /** A document has queued items but no consumer (durable adapters, after a restart). */
  onBacklog(documentId: DocumentId): void;
}

/** The queue port. Every adapter honours the contract in this module's description. */
export interface QueueAdapter {
  readonly kind: 'memory' | 'redis' | 'kafka';
  /** Connects (V3 adapters) and reports any backlog through `hooks.onBacklog`. */
  start(hooks: QueueHooks): Promise<void>;
  /** Adds an item to its document's queue, or reports why it could not. */
  enqueue(item: QueueItem): Promise<EnqueueResult>;
  /** Attaches the single consumer for `documentId`. One consumer per document. */
  consume(documentId: DocumentId, deliver: DeliverFn): QueueConsumer;
  /** Items enqueued for `documentId` and not yet acked, including the one being processed. */
  depth(documentId: DocumentId): number;
  /** Stops every consumer and releases the adapter's resources. */
  close(): Promise<void>;
}
