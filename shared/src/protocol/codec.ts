/**
 * Message validation, encode and decode (LLD Part 1 §5.1, §5.3, §5.4).
 *
 * - Text frames carry a UTF-8 JSON object with a string `type`.
 * - Binary frames ({@link writeBinaryFrame}) carry `asset-put` and `upload-chunk` (C→S) and an
 *   `asset` with bytes (S→C). An `asset` without bytes is a text frame (LLD §0 R-10).
 * - A binary-only type in a text frame, or a text type in a binary frame, is invalid.
 * - An unknown `type` is ignored (HLD §9).
 *
 * Decoders are pure and never throw: every failure is a `{ kind: 'invalid' }` result carrying
 * `PROTOCOL_INVALID_MESSAGE`.
 *
 * @module
 */
import { isErrorCode } from '../errors/catalogue.js';
import { OpenDocexError } from '../errors/index.js';
import { asDocumentId, isAssetId, isClientId, isEpoch, type DocumentId } from '../ids/index.js';
import { decodeUtf8, readBinaryFrame, writeBinaryFrame } from './frames.js';
import type {
  Annotation,
  ClientMessage,
  ConversionNotice,
  NoticeMsg,
  ServerMessage,
  UnsupportedFinding,
} from './messages.js';
import { isPlainObject, v, ValidationError, type Check } from './validate.js';

/** The result of decoding one frame. */
export type DecodeResult<M> =
  | { kind: 'message'; message: M }
  | { kind: 'ignored'; type: string }
  | { kind: 'invalid'; error: OpenDocexError };

const MAX = Number.MAX_SAFE_INTEGER;
/** Largest `upload-chunk` payload: 256 KiB (LLD Part 1 §5.2). */
const MAX_UPLOAD_CHUNK_BYTES = 262_144;
/** Largest `upload-start.name`, in characters (LLD Part 1 §5.3). */
const MAX_UPLOAD_NAME = 255;
/** Largest `UnsupportedFinding.where` (LLD Part 1 §5.2). */
const MAX_WHERE = 20;
/** An annotation ID: the {@link newRandomId} format. */
const ANNOTATION_ID = /^[A-Za-z0-9_-]{22}$/;

// --- field checks ----------------------------------------------------------------------------

const rev = v.int(0, MAX);
const clientSeq = v.int(1, MAX);
const reqId = v.int(0, MAX);
const count = v.int(0, MAX);
const text = v.str(MAX);
const clientId = v.is(isClientId, 'expected a client ID');
const epoch = v.is(isEpoch, 'expected an epoch');
const assetId = v.is(isAssetId, 'expected an asset ID');
const annotationId = v.str(22, ANNOTATION_ID);
const assetMime = v.lit('image/png', 'image/jpeg', 'image/gif');
/** `ops`: 1…MAX plain objects; deep op validation is `OtType.validateOps` in the Core. */
const ops = v.arr(v.plain(), { min: 1, max: MAX });

const documentId: Check<DocumentId> = (x, path) => {
  if (typeof x !== 'string') throw new ValidationError(path, 'expected a document ID');
  try {
    return asDocumentId(x);
  } catch {
    throw new ValidationError(path, 'expected a document ID');
  }
};

const unsupportedFinding: Check<UnsupportedFinding> = v.obj(
  {
    feature: v.lit(
      'tracked-changes',
      'comments',
      'footnotes',
      'fields',
      'text-boxes',
      'equations',
      'charts',
      'multiple-page-styles',
      'first-page-header',
      'odd-even-header',
      'conditional-formatting',
      'data-validation',
      'pivot-tables',
      'sheet-images',
      'cell-comments',
      'other',
    ),
    count,
  },
  { where: v.arr(text, { max: MAX_WHERE }), detail: text },
);

const conversionNotice: Check<ConversionNotice> = v.obj(
  { feature: v.lit('image-to-png'), count },
  { where: v.arr(text, { max: MAX }) },
);

const annotation: Check<Annotation> = v.obj(
  {
    id: annotationId,
    kind: v.lit('bookmark', 'note'),
    body: text,
    authorId: text,
    createdAt: text,
    updatedAt: text,
    resolved: v.bool(),
  },
  { replyTo: annotationId },
);

const annotationInput = v.obj(
  { id: annotationId, kind: v.lit('bookmark', 'note'), body: text, resolved: v.bool() },
  { replyTo: annotationId },
);

const noticeStorage = v.obj({ type: v.lit('notice'), notice: v.lit('storage'), state: v.lit('normal', 'local', 'pending') });
const noticeReadOnly = v.obj({
  type: v.lit('notice'),
  notice: v.lit('read-only'),
  readOnly: v.bool(),
  reason: v.lit('unsupported-content'),
});
const noticeEngine = v.obj({ type: v.lit('notice'), notice: v.lit('engine-restarting') });

const notice: Check<NoticeMsg> = (x, path) => {
  if (!isPlainObject(x)) throw new ValidationError(path, 'expected an object');
  switch (x['notice']) {
    case 'storage':
      return noticeStorage(x, path);
    case 'read-only':
      return noticeReadOnly(x, path);
    case 'engine-restarting':
      return noticeEngine(x, path);
    default:
      throw new ValidationError(`${path}.notice`, 'unexpected value');
  }
};

// --- message tables --------------------------------------------------------------------------

type Table<M> = Readonly<Record<string, Check<M>>>;

function table<M>(entries: Record<string, Check<M>>): Table<M> {
  return Object.assign(Object.create(null) as Record<string, Check<M>>, entries);
}

function lookup<M>(t: Table<M>, type: string): Check<M> | undefined {
  return Object.prototype.hasOwnProperty.call(t, type) ? t[type] : undefined;
}

/** Client messages sent in text frames. */
const CLIENT_TEXT: Table<ClientMessage> = table<ClientMessage>({
  hello: v.obj(
    { type: v.lit('hello'), protocol: v.int(0, MAX), clientId },
    { resume: v.obj({ epoch, rev }) },
  ),
  submit: v.obj({ type: v.lit('submit'), clientId, clientSeq, epoch, baseRev: rev, ops }),
  'asset-get': v.obj({ type: v.lit('asset-get'), reqId, assetId }),
  ping: v.obj({ type: v.lit('ping'), n: v.int(0, MAX) }),
  'upload-start': v.obj({
    type: v.lit('upload-start'),
    reqId,
    name: v.str(MAX_UPLOAD_NAME),
    format: v.lit('docx', 'odt', 'xlsx', 'ods'),
    size: count,
  }),
  'upload-end': v.obj({ type: v.lit('upload-end'), reqId }),
  'annotation-list': v.obj({ type: v.lit('annotation-list'), reqId }),
  'annotation-put': v.obj({ type: v.lit('annotation-put'), reqId, annotation: annotationInput }),
  'annotation-delete': v.obj({ type: v.lit('annotation-delete'), reqId, id: annotationId }),
});

/** Client messages sent in binary frames. */
const CLIENT_BINARY: Table<ClientMessage> = table<ClientMessage>({
  'asset-put': v.obj({ type: v.lit('asset-put'), reqId, mime: assetMime, bytes: v.bytes(MAX) }),
  'upload-chunk': v.obj({
    type: v.lit('upload-chunk'),
    reqId,
    seq: rev,
    bytes: v.bytes(MAX_UPLOAD_CHUNK_BYTES),
  }),
});

/** Server messages sent in text frames. */
const SERVER_TEXT: Table<ServerMessage> = table<ServerMessage>({
  'load-start': v.obj(
    {
      type: v.lit('load-start'),
      epoch,
      rev,
      kind: v.lit('text', 'sheet'),
      access: v.lit('edit', 'view'),
      readOnly: v.bool(),
    },
    {
      unsupported: v.arr(unsupportedFinding, { max: MAX }),
      ackedClientSeq: clientSeq,
      totalChunks: count,
      limits: v.obj({}, { maxAssetBytes: count }),
      conversions: v.arr(conversionNotice, { max: MAX }),
    },
  ),
  'load-chunk': v.obj({ type: v.lit('load-chunk'), seq: rev, data: v.plain() }),
  'load-done': v.obj({ type: v.lit('load-done'), rev }),
  ack: v.obj(
    { type: v.lit('ack'), clientSeq, rev },
    { committed: v.arr(v.plain(), { max: MAX }) },
  ),
  remote: v.obj({ type: v.lit('remote'), fromRev: rev, ops, clientId }),
  error: v.obj(
    {
      type: v.lit('error'),
      code: v.is(isErrorCode, 'expected an error code'),
      retryable: v.bool(),
      message: text,
    },
    { clientSeq, reqId },
  ),
  resync: v.obj({ type: v.lit('resync'), reason: v.lit('epoch-changed', 'history-unavailable', 'inconsistent') }),
  notice,
  asset: v.obj({ type: v.lit('asset'), reqId, assetId, mime: assetMime, size: count }),
  pong: v.obj({ type: v.lit('pong'), n: v.int(0, MAX) }),
  'upload-ack': v.obj({ type: v.lit('upload-ack'), reqId, receivedBytes: count }),
  'upload-done': v.obj({ type: v.lit('upload-done'), reqId, documentId }),
  'annotation-result': v.obj({
    type: v.lit('annotation-result'),
    reqId,
    annotations: v.arr(annotation, { max: MAX }),
  }),
  'annotation-changed': v.obj(
    { type: v.lit('annotation-changed') },
    { annotation, deletedId: annotationId },
  ),
});

/** Server messages sent in binary frames. */
const SERVER_BINARY: Table<ServerMessage> = table<ServerMessage>({
  asset: v.obj({
    type: v.lit('asset'),
    reqId,
    assetId,
    mime: assetMime,
    size: count,
    bytes: v.bytes(MAX),
  }),
});

const BINARY_ONLY: ReadonlySet<string> = new Set(['asset-put', 'upload-chunk']);

/**
 * True for a type that is only ever sent in a binary frame: `asset-put` and `upload-chunk`.
 * `asset` is sent in either frame kind (with `bytes` binary, without `bytes` text), so it is
 * not binary-only.
 */
export function isBinaryType(type: string): boolean {
  return BINARY_ONLY.has(type);
}

// --- encode ----------------------------------------------------------------------------------

/**
 * Encodes a message: a binary frame when it has `bytes`, otherwise a JSON string. Does not
 * validate the message.
 *
 * @throws {OpenDocexError} `PROTOCOL_INVALID_MESSAGE` when a binary header is outside
 * 1…65 536 bytes.
 */
export function encodeMessage(msg: ClientMessage | ServerMessage): string | Uint8Array {
  if ('bytes' in msg && msg.bytes instanceof Uint8Array) {
    const { bytes, ...rest } = msg;
    const header = new TextEncoder().encode(JSON.stringify(rest));
    const frame = writeBinaryFrame(header, bytes);
    if (frame === undefined) {
      throw new OpenDocexError('PROTOCOL_INVALID_MESSAGE', 'Binary frame header must be 1 to 65536 bytes.');
    }
    return frame;
  }
  return JSON.stringify(msg);
}

// --- decode ----------------------------------------------------------------------------------

/** Decodes a frame a client sent. Never throws. */
export function decodeClientMessage(data: string | Uint8Array): DecodeResult<ClientMessage> {
  return decode(data, CLIENT_TEXT, CLIENT_BINARY);
}

/** Decodes a frame a server sent. Never throws. */
export function decodeServerMessage(data: string | Uint8Array): DecodeResult<ServerMessage> {
  return decode(data, SERVER_TEXT, SERVER_BINARY);
}

function invalid(detail: string): { kind: 'invalid'; error: OpenDocexError } {
  return { kind: 'invalid', error: new OpenDocexError('PROTOCOL_INVALID_MESSAGE', `Invalid message: ${detail}.`) };
}

function parseObject(json: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return isPlainObject(parsed) && typeof parsed['type'] === 'string' ? parsed : undefined;
}

function run<M>(check: Check<M>, x: unknown): DecodeResult<M> {
  try {
    return { kind: 'message', message: check(x, '$') };
  } catch (e) {
    if (e instanceof ValidationError) return invalid(`${e.path}: ${e.reason}`);
    return invalid('validation failed');
  }
}

function decode<M>(data: string | Uint8Array, textTable: Table<M>, binaryTable: Table<M>): DecodeResult<M> {
  if (typeof data === 'string') {
    const obj = parseObject(data);
    if (obj === undefined) return invalid('not a JSON object with a string type');
    const type = obj['type'] as string;
    if (isBinaryType(type)) return invalid('binary-only type in a text frame');
    const check = lookup(textTable, type);
    return check === undefined ? { kind: 'ignored', type } : run(check, obj);
  }
  if (!(data instanceof Uint8Array)) return invalid('unsupported frame data');
  const parts = readBinaryFrame(data);
  if (parts === undefined) return invalid('malformed binary frame');
  const json = decodeUtf8(parts.header);
  const hdr = json === undefined ? undefined : parseObject(json);
  if (hdr === undefined) return invalid('binary header is not a JSON object with a string type');
  const type = hdr['type'] as string;
  const check = lookup(binaryTable, type);
  if (check === undefined) {
    return lookup(textTable, type) === undefined ? { kind: 'ignored', type } : invalid('text type in a binary frame');
  }
  return run(check, { ...hdr, bytes: parts.payload });
}
