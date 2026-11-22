/**
 * Typed seams between the Core and modules built by other tasks (LLD Part 2 §7, §8).
 *
 * Each interface here is the minimal surface the Core calls. The real modules implement them:
 * - {@link CodecSeam}: `CodecService` (V1-14, LLD Part 2 §14.1)
 * - {@link FlushSeam}: `FlushScheduler` (V1-16, §12)
 * - {@link RecoverySeam}: `RecoveryManager` (V1-16, §13)
 * - {@link AuditSink}: `AuditEmitter` (V1-17, §15)
 * - {@link CoreSink} and {@link CoreChannelPort}: the Core side of the `EngineChannel` (V1-18, §6)
 *
 * Tests fake every one of them.
 *
 * @module
 */
import type { OpenDocexError } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import type { ConversionNotice, DocKind, FileFormat, UnsupportedFinding } from '@open-docex/shared/protocol';
import type { AuditEvent, DocumentEvent } from '../api/events.js';
import type { LogFields, LogLevel } from '../log/logger.js';
import type { TimerClock } from '../persistence/journal.js';
import type { StorageRef } from '../storage/storage-adapter.js';

/** The injectable clock (LLD Part 2 conventions): wall time plus timers. */
export interface Clock extends TimerClock {
  /** Epoch milliseconds. */
  now(): number;
}

/** The real clock. Timers are `unref()`'d so they never keep the process alive. */
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

// --- codec (V1-14) ---------------------------------------------------------------------------

/**
 * The result of {@link CodecSeam.import} (LLD Part 2 §14.1 `ImportResult`). `conversions` is
 * the PO-22 notice carried to `load-start` (§0 R-3); the §14.1 interface does not list it yet.
 */
export interface CodecImportResult {
  kind: DocKind;
  /** Input for `ot.deserializeSnapshot`. */
  snapshot: unknown;
  findings: UnsupportedFinding[];
  assetIds: string[];
  conversions?: ConversionNotice[];
}

/** What the Core needs from `CodecService` (LLD Part 2 §14.1). */
export interface CodecSeam {
  import(i: { bytes: Uint8Array; format: FileFormat; assetDir: string }): Promise<CodecImportResult>;
  /** Boot step 5. Throws `CONFIG_LIBREOFFICE_NOT_FOUND`. */
  probe(): Promise<void>;
  close(): Promise<void>;
}

// --- flush and recovery (V1-16) --------------------------------------------------------------

/** The view of an instance that the flush scheduler needs. `DocumentInstance` implements it. */
export interface FlushTarget {
  readonly documentId: DocumentId;
  readonly docKey: string;
  readonly kind: DocKind;
  readonly ref: StorageRef;
  readonly format: FileFormat;
  readonly epoch: string;
  currentSnapshot(): { rev: number; model: unknown };
}

/** What the Core needs from `FlushScheduler` (LLD Part 2 §12). */
export interface FlushSeam {
  markDirty(inst: FlushTarget): void;
  flushNow(inst: FlushTarget, o?: { timeoutMs?: number }): Promise<'clean' | 'flushed' | 'skipped' | 'failed'>;
  /** Shutdown, best effort. */
  flushAll(deadline: number): Promise<void>;
}

/** What the Core needs from `RecoveryManager` (LLD Part 2 §13): boot step 8. */
export interface RecoverySeam {
  /** Schedules recovery work. Boot never waits for storage. */
  resumeAfterBoot(): void;
}

// --- audit (V1-17) ---------------------------------------------------------------------------

/** What the Core needs from `AuditEmitter` (LLD Part 2 §15). */
export interface AuditSink {
  emit(e: AuditEvent): void;
}

// --- channel (V1-18) -------------------------------------------------------------------------

/** One outgoing frame for one or more sessions (LLD Part 2 §6.2 `OutFrame`). */
export interface OutFrame {
  sessionIds: string[];
  data: string | Uint8Array;
  binary: boolean;
  /** Set on paced load chunks; the main side answers with a `written` request (§8.5). */
  token?: number;
}

/**
 * Everything the Core sends towards the main process, as typed calls. The channel task (V1-18)
 * maps these to `CoreEvent`s (`send`, `close`, `emit`, `log`) and turns errors into `WireError`s.
 */
export interface CoreSink {
  send(frames: OutFrame[]): void;
  close(sessionIds: string[], code: number, reason: string): void;
  error(err: OpenDocexError): void;
  document(ev: DocumentEvent): void;
  /** IPC backpressure (§6.4). Resolves when the Core may send more. */
  whenWritable(): Promise<void>;
}

/** The session-level `CoreRequest`s the Core handles (LLD Part 2 §6.2). */
export type CoreSessionRequest =
  | {
      type: 'join';
      sessionId: string;
      documentId: DocumentId;
      userId: string;
      access: 'edit' | 'view';
      document: { ref: StorageRef; format: FileFormat };
    }
  | { type: 'frame'; sessionId: string; data: Uint8Array; binary: boolean }
  | { type: 'leave'; sessionId: string; reason: 'client-closed' | 'slow-consumer' | 'admin' | 'shutdown' }
  | { type: 'written'; sessionId: string; token: number };

/** The boot counters in `ready` (LLD Part 2 §6.2 `BootReport`). */
export interface BootReport {
  documents: number;
  recovering: number;
  dirty: number;
  queueBacklog: number;
}

/** The minimal `WireError` shape (LLD Part 2 §6.2). V1-18 owns the real type and `toWire`. */
export interface WireErrorLike {
  code: string;
  message: string;
  documentId?: string;
  instanceId?: string;
  causeMessage?: string;
}

/** The `CoreRequest`s {@link CoreRuntime} reads (a subset of LLD Part 2 §6.2). */
export type CoreRequestLike =
  | CoreSessionRequest
  | { type: 'init'; id: number; workerConfigModule: string; logLevel: LogLevel }
  | { type: 'ping'; seq: number }
  | { type: 'shutdown'; id: number; timeoutMs: number };

/** The `CoreEvent`s {@link CoreRuntime} writes (a subset of LLD Part 2 §6.2). */
export type CoreEventLike =
  | { type: 'ready'; id: number; pid: number; boot: BootReport }
  | { type: 'pong'; seq: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: WireErrorLike }
  | { type: 'send'; frames: OutFrame[] }
  | { type: 'close'; sessionIds: string[]; code: number; reason: string }
  | { type: 'emit'; event: 'error' | 'audit' | 'storage' | 'document'; payload: unknown }
  | { type: 'log'; level: LogLevel; msg: string; fields?: LogFields };

/**
 * The Core side of the `EngineChannel` (LLD Part 2 §6.1 `CoreChannelSide`), reduced to what the
 * runtime uses. V1-18's `CoreChannelSide` is structurally compatible.
 */
export interface CoreChannelPort {
  onRequest(handler: (msg: CoreRequestLike) => void): void;
  emit(ev: CoreEventLike): void;
  whenWritable(): Promise<void>;
}
