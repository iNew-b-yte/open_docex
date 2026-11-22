/**
 * The engine's public event types (LLD Part 2 §2.7, §15, HLD §15).
 *
 * `AuditEvent` is defined here and implemented by the AuditEmitter (LLD §0.5 S-22). The
 * emitter itself is {@link TypedEmitter} in `typed-emitter.ts`.
 *
 * These are public option types, so they are a frozen contract (AGENTS.md §2).
 *
 * @module
 */
import type { OpenDocexError } from '@open-docex/shared/errors';
import type { ClientId, DocumentId } from '@open-docex/shared/ids';
import type { DocKind, UnsupportedFinding } from '@open-docex/shared/protocol';

/**
 * One applied (committed) batch of ops (LLD Part 2 §15). Events arrive in FIFO order per
 * document, after the ack and the broadcast.
 *
 * Delivery is at least once (PO-17): after a crash the Core re-emits entries it had not
 * emitted yet, with `replayed: true`. Deduplicate by `(documentId, rev)`.
 */
export interface AuditEvent {
  documentId: DocumentId;
  kind: DocKind;
  /** The revision after this batch. */
  rev: number;
  /** The revision the batch was applied on. */
  fromRev: number;
  /** Epoch milliseconds. */
  at: number;
  userId: string;
  clientId: ClientId;
  clientSeq: number;
  sessionId: string | null;
  /** The applied (committed) ops. */
  ops: readonly unknown[];
  /** True when the event is re-emitted after a crash (PO-17, R-19). */
  replayed: boolean;
}

/** A storage state change for one document (HLD §15, [§4]). */
export interface StorageEvent {
  documentId: DocumentId;
  state: 'local' | 'pending' | 'conflict' | 'recovered';
  /** Epoch milliseconds. */
  at: number;
  retryCount: number;
  nextRetryAt: number | null;
  error?: OpenDocexError;
}

/** An engine lifecycle change (HLD §15). */
export interface EngineStateEvent {
  state: 'started' | 'restarting' | 'failed';
  /** Epoch milliseconds. */
  at: number;
  restartCount?: number;
  delayMs?: number;
  exit?: { code: number | null; signal: string | null };
  error?: OpenDocexError;
}

/** A document lifecycle change (HLD §15). */
export interface DocumentEvent {
  documentId: DocumentId;
  state: 'loaded' | 'faulted' | 'unsupported';
  /** Epoch milliseconds. */
  at: number;
  epoch?: string;
  rev?: number;
  source?: 'storage' | 'local';
  findings?: UnsupportedFinding[];
  error?: OpenDocexError;
}

/**
 * Event name → payload for `engine.on` (LLD Part 2 §2.7). A type alias rather than an
 * interface, so that it satisfies {@link TypedEmitter}'s index-signature constraint.
 */
export type EngineEventMap = {
  error: OpenDocexError;
  fatal: OpenDocexError;
  audit: AuditEvent;
  storage: StorageEvent;
  engine: EngineStateEvent;
  document: DocumentEvent;
};
