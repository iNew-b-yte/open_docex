/**
 * Types of the text sync client and its ProseMirror plugin (LLD Part 3 §6–§7). Internal.
 *
 * @module
 */
import type { Step } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import type { ErrorCode } from '@open-docex/shared/errors';
import type { ClientId } from '@open-docex/shared/ids';
import type { SubmitMsg } from '@open-docex/shared/protocol';
import type { SyncEvent } from '../events.js';
import type { Labels } from '../labels.js';
import type { RandomSource } from '../net/backoff.js';

/** One local step that the server has not confirmed yet (LLD Part 3 §7.1). */
export interface PendingStep {
  readonly step: Step;
  /** `step.invert(docBefore)`: undoes `step` on the document it produced. */
  readonly inverted: Step;
}

/** The plugin state. `pending` is `[in-flight prefix | buffer]` (LLD Part 3 §7.1). */
export interface SyncPluginState {
  readonly pending: readonly PendingStep[];
  /** How many of the first `pending` steps are in the batch on the wire. */
  readonly inflightCount: number;
  /** View access, unsupported content, server read-only, or restoring (§6.2). */
  readonly readOnly: boolean;
}

/** The meta the sync client puts on its own transactions (LLD Part 3 §7.1). */
export type SyncMeta =
  /** A remote, a correction or a confirmation: replaces `pending`. Its steps are not local. */
  | { kind: 'rebuild'; pending: readonly PendingStep[]; inflightCount: number }
  | { kind: 'set-inflight'; inflightCount: number }
  | { kind: 'read-only'; readOnly: boolean };

/**
 * Why the sync client asks for a reload. The session only logs it; `discard` decides what
 * happens to unconfirmed changes. An `ErrorCode` is the submit error that caused it.
 */
export type ReloadReason =
  /** A `remote` whose `fromRev` is not the confirmed rev: messages were missed. */
  | 'gap'
  /** A `remote` with our own `clientId` while nothing is in flight. */
  | 'own-without-inflight'
  /** A `remote` or `committed` op that does not parse as a step. */
  | 'bad-step'
  /** A `remote`'s steps do not apply to the confirmed document. */
  | 'remote-apply'
  /** An `ack.rev` that does not match the confirmed rev plus the committed count. */
  | 'ack-rev'
  /** An `ack.committed` that does not apply in place of the in-flight steps. */
  | 'correction'
  /** A rescue `ack.committed` that does not apply (§6.2). */
  | 'rescue-apply'
  /** The document became read-only while changes were pending (§0 L-15). */
  | 'read-only'
  | ErrorCode;

/** A notice the sync client asks the UI to show: a key of `labels.restore` (§6.2, §0 PO-16, L-15). */
export type RestoreNotice = keyof Labels['restore'];

/**
 * What the sync client is doing beyond `SyncEvent.pendingCount`, for `SessionStatus.sync`
 * (LLD Part 3 §2.1, §7.3, §16): `busy` while a `QUEUE_FULL` retry is pending, `restoring`
 * during a rescue (§6.2), otherwise `idle`.
 */
export type SyncActivity = 'idle' | 'busy' | 'restoring';

/**
 * Unconfirmed changes carried across a reload (LLD Part 3 §6.2): the session takes them from
 * `exportOrphans` and gives them back to `restoreOrphans` after the next load.
 */
export interface TextOrphans {
  /** The epoch the changes were made in (`E0`). */
  readonly epoch: string;
  /** The confirmed rev `R` that `pending` is based on. */
  readonly baseRev: number;
  /** The `clientSeq` of the batch that was in flight, if any (`s`). */
  readonly inflightSeq?: number;
  /** How many of `pending` were in that batch. */
  readonly inflightCount: number;
  /** In-flight steps then buffered steps, in current local form, all based on `baseRev` (`P`). */
  readonly pending: readonly Step[];
  /**
   * True when these steps were already sent as a rescue that got no answer before the reload.
   * The next load does not try again (§0 PO-16; see `TextSyncClient.restoreOrphans`).
   */
  readonly rescueSent: boolean;
}

/** What `TextSyncClient` needs from its binding (LLD Part 3 §7.1). */
export interface TextSyncDeps {
  /** The editor view. Called only after `start`, when the view exists. */
  view(): EditorView;
  /** Sends a submission. False when no socket is open; the client keeps its state and resends. */
  send(m: SubmitMsg): boolean;
  readonly clientId: ClientId;
  /** The `sync` event (`BindingContext.emitSync`). */
  emit(e: SyncEvent): void;
  /** Reloads the document; `discard` drops unconfirmed changes (`BindingContext.reload`). */
  reload(reason: ReloadReason, discard: boolean): void;
  /** Shows a `labels.restore` notice (LLD Part 3 §6.2 `notify`). */
  notify(n: RestoreNotice): void;
  /**
   * Reports an error the client found itself, with no `ErrorMsg` behind it (LLD Part 3 §6.2
   * `onError`): `SESSION_RESYNC_REQUIRED` when some changes could not be restored.
   */
  onError(code: ErrorCode): void;
  /** Called when the {@link SyncActivity} changes. */
  activity?(a: SyncActivity): void;
  /** The most steps in one batch. Default {@link DEFAULT_MAX_BATCH_STEPS}. */
  readonly maxBatchSteps?: number;
  /** The jitter source for the `QUEUE_FULL` retry. Default `Math.random`. */
  readonly random?: RandomSource;
}

/** LLD Part 3 §7.1: at most 200 steps per batch (LLD choice). */
export const DEFAULT_MAX_BATCH_STEPS = 200;

/** The `QUEUE_FULL` retry backoff (LLD Part 3 §7.3, LLD choice): full jitter, 250 ms base, 10 s cap. */
export const SUBMIT_RETRY_BASE_MS = 250;
export const SUBMIT_RETRY_MAX_MS = 10_000;
