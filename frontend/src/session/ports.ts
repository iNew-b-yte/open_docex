/**
 * The ports `DocumentSession` talks to (LLD Part 3 §3, §6, §7.1). Internal.
 *
 * The session owns the connection and the load. The document kind supplies the rest through a
 * {@link DocumentBinding}: the chunk assembler, the sync client and the editor. V1-32
 * (`TextSyncClient`) and V1-36 (the text binding) implement these; V2 adds the sheet binding.
 *
 * @module
 */
import type { ClientId } from '@open-docex/shared/ids';
import type { ErrorCode } from '@open-docex/shared/errors';
import type {
  AckMsg,
  AssetGetMsg,
  AssetMsg,
  AssetPutMsg,
  ErrorMsg,
  LoadStartMsg,
  RemoteMsg,
  SubmitMsg,
} from '@open-docex/shared/protocol';
import type { SessionStatus, SyncEvent } from '../events.js';
import type { Assembler, LoadInfo } from '../load/ChunkLoader.js';

/** Why the editor is read-only (LLD Part 3 §2.1 `SessionStatus.readOnlyReason`). */
export type ReadOnlyReason = Exclude<SessionStatus['readOnlyReason'], null>;

/**
 * The sync client as the session sees it: the methods of `TextSyncClient` (LLD Part 3 §7.1)
 * that the §3 routing table calls. `Orphans` is the sync client's own rescue record (§6.2); the
 * session only carries it from `exportOrphans` to `restoreOrphans`.
 */
export interface SessionSync<Orphans = unknown> {
  start(p: { epoch: string; rev: number; readOnly: boolean }): void;
  onRemote(m: RemoteMsg): void;
  onAck(m: AckMsg): void;
  /** An `ErrorMsg` with `clientSeq`. The sync client applies the §16 policy itself. */
  onSubmitError(m: ErrorMsg): void;
  onDisconnected(): void;
  /** Called right after `hello { resume }` was sent (§6.1). */
  onReconnected(): void;
  setReadOnly(ro: boolean, reason: ReadOnlyReason): void;
  exportOrphans(): Orphans | null;
  restoreOrphans(o: Orphans | null, load: { epoch: string; rev: number }): void;
  /** `{ epoch, rev: confirmedRev }`, or null before the first load. */
  resumeInfo(): { epoch: string; rev: number } | null;
  destroy(): void;
}

/** A key of `labels.restore`. */
export type RestoreNoticeKey = 'discarded' | 'partialLoss' | 'lost';

/** What the session gives a binding (and through it, the sync client). */
export interface BindingContext {
  readonly clientId: ClientId;
  /**
   * Sends a submission, or an `asset-put` / `asset-get` for the `AssetCache` (S-39). False when
   * no socket is open; the caller keeps its state.
   */
  send(m: SubmitMsg | AssetPutMsg | AssetGetMsg): boolean;
  /** True while the socket is open (the `AssetCache`'s `connected`). */
  connected(): boolean;
  /** Shows a restore notice (a key of `labels.restore`, S-37). */
  notify(n: RestoreNoticeKey): void;
  /** Reports an error the sync client found itself (S-37), for example `SESSION_RESYNC_REQUIRED`. */
  reportError(code: ErrorCode): void;
  /** The sync client's activity: `busy` or `restoring` show in `SessionStatus.sync` (S-37). */
  activity(a: 'idle' | 'busy' | 'restoring'): void;
  /** The sync client's `emit(SyncEvent)` (LLD Part 3 §7.1). */
  emitSync(e: SyncEvent): void;
  /** The sync client's `reload(reason, discard)`: reload the document, dropping pending changes when `discard`. */
  reload(reason: string, discard: boolean): void;
}

/** One document kind's editor, sync client and assembler. */
export interface DocumentBinding<S = unknown> {
  readonly assembler: Assembler<S>;
  readonly sync: SessionSync;
  /**
   * At `load-done`: creates the editor, or replaces its state on a reload (LLD Part 3 §3).
   * Called before `sync.start`.
   */
  show(snapshot: S, load: LoadInfo): void;
  /** Called with every `load-start`, before its chunks (for limits such as `maxAssetBytes`). */
  onLoadStart?(m: LoadStartMsg): void;
  /** The element `EditorHost` gives the session (§3), or null when it unmounts. */
  attach?(el: HTMLElement | null): void;
  /** `asset` messages, and `error`s that carry `reqId` (§0 R-10). */
  onAsset?(m: AssetMsg | ErrorMsg): void;
  /** A 1009 close: fail the asset upload that was in flight with `DOCUMENT_TOO_LARGE` (§4). */
  failAssetUpload?(): void;
  /** Destroys the editor and revokes blob URLs. The session destroys `sync` first. */
  destroy(): void;
}

/** Creates the binding for a load's kind. Called once, at the first `load-start`. */
export type CreateBinding = (ctx: BindingContext) => DocumentBinding;
