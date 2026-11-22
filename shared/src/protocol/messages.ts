/**
 * Every WebSocket message of the open_docex protocol, with exact fields (HLD §9,
 * LLD Part 1 §5.2, §0 R-3, R-4, R-5, R-10, R-12, R-13).
 *
 * The upload family is V4 and the annotation family is V5; both are defined here so the
 * contract is complete from V1.
 *
 * @module
 */
import type { ClientErrorPayload } from '../errors/index.js';
import type { ClientId, DocumentId, Epoch } from '../ids/index.js';

/** The protocol version a client sends in `hello.protocol`. */
export const PROTOCOL_VERSION = 1 as const;
/** The `Sec-WebSocket-Protocol` the client offers first and the Gateway selects (LLD §0 R-12). */
export const WS_SUBPROTOCOL = 'open-docex.v1' as const;
/** The connect-URL query parameter that carries the document ID (HLD §10.1, LLD §0 R-12). */
export const DOC_QUERY_PARAM = 'doc' as const;

/** The two document kinds. */
export type DocKind = 'text' | 'sheet';
/** A session's access level. */
export type Access = 'edit' | 'view';
/** The image types an asset may have (PO-24). */
export type AssetMime = 'image/png' | 'image/jpeg' | 'image/gif';
/** The office file formats open_docex reads and writes. */
export type FileFormat = 'docx' | 'odt' | 'xlsx' | 'ods';

/** The submission envelope (HLD §8.3, LLD Part 1 §6). `ops` are validated deeply by the Core. */
export interface SubmitEnvelope<O = unknown> {
  clientId: ClientId;
  /** ≥ 1; see LLD Part 1 §6 R9. */
  clientSeq: number;
  epoch: Epoch;
  /** ≥ 0; see LLD Part 1 §6 R4. */
  baseRev: number;
  ops: O[];
}

/** A document feature open_docex cannot edit; its presence opens the file read-only (PO-13). */
export type UnsupportedFeature =
  | 'tracked-changes'
  | 'comments'
  | 'footnotes'
  | 'fields'
  | 'text-boxes'
  | 'equations'
  | 'charts'
  | 'multiple-page-styles'
  | 'first-page-header'
  | 'odd-even-header'
  | 'conditional-formatting'
  | 'data-validation'
  | 'pivot-tables'
  | 'sheet-images'
  | 'cell-comments'
  | 'other';

/** One kind of unsupported content found on import (LLD §0 R-15). */
export interface UnsupportedFinding {
  feature: UnsupportedFeature;
  count: number;
  /** At most 20 human-readable locations. */
  where?: string[];
  detail?: string;
}

/** Content converted on import, for example EMF images saved as PNG (PO-22, LLD §0 R-3). */
export interface ConversionNotice {
  feature: 'image-to-png';
  count: number;
  where?: string[];
}

// ---------------------------------------------------------------------------------------------
// Client → server

/** The first client frame. The server binds `clientId` to the session. */
export interface HelloMsg {
  type: 'hello';
  protocol: number;
  clientId: ClientId;
  resume?: { epoch: Epoch; rev: number };
}
/** A batch of ops (LLD Part 1 §6). */
export interface SubmitMsg<O = unknown> extends SubmitEnvelope<O> {
  type: 'submit';
}
/** Uploads an image asset. Binary frame only. Answered by an {@link AssetMsg} without `bytes`. */
export interface AssetPutMsg {
  type: 'asset-put';
  reqId: number;
  mime: AssetMime;
  bytes: Uint8Array;
}
/** Requests an asset. Answered by a binary-frame {@link AssetMsg} with `bytes`. */
export interface AssetGetMsg {
  type: 'asset-get';
  reqId: number;
  assetId: string;
}
/** Client heartbeat (HLD §13). The server echoes `n` in a {@link PongMsg} (LLD §0 R-5). */
export interface PingMsg {
  type: 'ping';
  n: number;
}
/** Starts a file upload [V4]. `name` is at most 255 characters. */
export interface UploadStartMsg {
  type: 'upload-start';
  reqId: number;
  name: string;
  format: FileFormat;
  size: number;
}
/** One upload chunk of at most 256 KiB, `seq` from 0 [V4]. Binary frame only. */
export interface UploadChunkMsg {
  type: 'upload-chunk';
  reqId: number;
  seq: number;
  bytes: Uint8Array;
}
/** Ends a file upload [V4]. */
export interface UploadEndMsg {
  type: 'upload-end';
  reqId: number;
}
/** Lists the document's annotations [V5]. */
export interface AnnotationListMsg {
  type: 'annotation-list';
  reqId: number;
}
/** Creates or updates an annotation [V5]. */
export interface AnnotationPutMsg {
  type: 'annotation-put';
  reqId: number;
  annotation: AnnotationInput;
}
/** Deletes an annotation [V5]. */
export interface AnnotationDeleteMsg {
  type: 'annotation-delete';
  reqId: number;
  id: string;
}

/** Every message a client sends. */
export type ClientMessage =
  | HelloMsg
  | SubmitMsg
  | AssetPutMsg
  | AssetGetMsg
  | PingMsg
  | UploadStartMsg
  | UploadChunkMsg
  | UploadEndMsg
  | AnnotationListMsg
  | AnnotationPutMsg
  | AnnotationDeleteMsg;

// ---------------------------------------------------------------------------------------------
// Server → client

/** Starts a full load (LLD Part 1 §6 R12, §0 R-2, R-3). */
export interface LoadStartMsg {
  type: 'load-start';
  epoch: Epoch;
  rev: number;
  kind: DocKind;
  access: Access;
  readOnly: boolean;
  unsupported?: UnsupportedFinding[];
  /** The highest `clientSeq` of `hello.clientId` that the snapshot already contains. */
  ackedClientSeq?: number;
  totalChunks?: number;
  limits?: { maxAssetBytes?: number };
  conversions?: ConversionNotice[];
}
/**
 * One load chunk `{ seq, data }` (LLD Part 1 §7). `data` is a `TextChunkData` or
 * `SheetChunkData` object; the protocol checks only that it is a plain object, and
 * `OtType.assemble` validates it deeply.
 */
export interface LoadChunkMsg {
  type: 'load-chunk';
  seq: number;
  data: unknown;
}
/** Ends a full load. */
export interface LoadDoneMsg {
  type: 'load-done';
  rev: number;
}
/** Confirms a submit (LLD Part 1 §6 R5, R6, R10). */
export interface AckMsg<O = unknown> {
  type: 'ack';
  clientSeq: number;
  rev: number;
  committed?: O[];
}
/** Another client's committed ops (LLD Part 1 §6 R7). */
export interface RemoteMsg<O = unknown> {
  type: 'remote';
  fromRev: number;
  ops: O[];
  clientId: ClientId;
}
/** A sanitized error (HLD §11.1). */
export interface ErrorMsg extends ClientErrorPayload {
  type: 'error';
}
/** The client must reload; a full load follows on the same socket (LLD §0 R-9). */
export interface ResyncMsg {
  type: 'resync';
  reason: 'epoch-changed' | 'history-unavailable' | 'inconsistent';
}
/** A state change the client shows (LLD Part 1 §5.2, §0 R-4). */
export type NoticeMsg =
  | { type: 'notice'; notice: 'storage'; state: 'normal' | 'local' | 'pending' }
  | { type: 'notice'; notice: 'read-only'; readOnly: boolean; reason: 'unsupported-content' }
  | { type: 'notice'; notice: 'engine-restarting' };
/**
 * An asset. With `bytes` it is a binary frame (answer to `asset-get`); without `bytes` it is a
 * text frame confirming an `asset-put` (LLD §0 R-10).
 */
export interface AssetMsg {
  type: 'asset';
  reqId: number;
  assetId: string;
  mime: AssetMime;
  size: number;
  bytes?: Uint8Array;
}
/** Heartbeat answer, echoing `ping.n`. */
export interface PongMsg {
  type: 'pong';
  n: number;
}
/** Sent after the server persists an upload chunk [V4]. */
export interface UploadAckMsg {
  type: 'upload-ack';
  reqId: number;
  receivedBytes: number;
}
/** The upload's result from the `onUploaded` hook [V4]. */
export interface UploadDoneMsg {
  type: 'upload-done';
  reqId: number;
  documentId: DocumentId;
}
/** A bookmark or note on a text document [V5, PO-27]. Timestamps are ISO 8601 UTC. */
export interface Annotation {
  id: string;
  kind: 'bookmark' | 'note';
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  replyTo?: string;
}
/** The client-supplied part of an {@link Annotation} [V5]. */
export type AnnotationInput = Pick<Annotation, 'id' | 'kind' | 'body' | 'resolved'> & { replyTo?: string };
/** A list of annotations, for example the answer to `annotation-list` [V5]. */
export interface AnnotationResultMsg {
  type: 'annotation-result';
  reqId: number;
  annotations: Annotation[];
}
/** Broadcast to the document's other sessions when an annotation changes [V5]. Carries exactly one of `annotation` or `deletedId`. */
export interface AnnotationChangedMsg {
  type: 'annotation-changed';
  annotation?: Annotation;
  deletedId?: string;
}

/** Every message a server sends. */
export type ServerMessage =
  | LoadStartMsg
  | LoadChunkMsg
  | LoadDoneMsg
  | AckMsg
  | RemoteMsg
  | ErrorMsg
  | ResyncMsg
  | NoticeMsg
  | AssetMsg
  | PongMsg
  | UploadAckMsg
  | UploadDoneMsg
  | AnnotationResultMsg
  | AnnotationChangedMsg;
