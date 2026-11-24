/**
 * Session records and frame dispatch (LLD Part 2 §8.1).
 *
 * The {@link SessionDispatcher} handles the session-level `CoreRequest`s (`join`, `frame`,
 * `leave`, `written`). Frames of one session are handled one at a time, in arrival order, so a
 * `hello` is always handled before the `submit`s behind it, even while the document loads.
 *
 * @module
 */
import { OpenDocexError, toClientError } from '@open-docex/shared/errors';
import type { ClientId, DocumentId } from '@open-docex/shared/ids';
import { CloseCode, closeCodeFor, decodeClientMessage, encodeMessage } from '@open-docex/shared/protocol';
import type { ClientMessage, FileFormat, ServerMessage } from '@open-docex/shared/protocol';
import { engineError } from '../errors/engine-error.js';
import type { Logger } from '../log/logger.js';
import type { StorageRef } from '../storage/storage-adapter.js';
import type { CoreSessionRequest, CoreSink } from './seams.js';

/** One client session as the Core sees it (§8.1). */
export interface SessionRecord {
  sessionId: string;
  documentId: DocumentId;
  userId: string;
  access: 'edit' | 'view';
  /** Bound at `hello` (R8). */
  clientId?: ClientId;
  state: 'joined' | 'loading' | 'live' | 'closed';
}

/** Sends one message to one session through `sink`. */
export function sendTo(sink: CoreSink, sessionId: string, msg: ServerMessage): void {
  const data = encodeMessage(msg);
  sink.send([{ sessionIds: [sessionId], data, binary: typeof data !== 'string' }]);
}

/** Sends a sanitized `error` to one session. */
export function sendError(sink: CoreSink, sessionId: string, err: unknown, ctx?: { clientSeq?: number; reqId?: number }): void {
  sendTo(sink, sessionId, { type: 'error', ...toClientError(err, ctx) });
}

/**
 * The close code for a failed load: `closeCodeFor` (§0 R-16, which wins over §8.4's fixed
 * `DOCUMENT_FAULTED`), falling back to `DOCUMENT_FAULTED` for codes without one.
 */
export function loadCloseCode(err: unknown): number {
  return (OpenDocexError.is(err) ? closeCodeFor(err.code) : undefined) ?? CloseCode.DOCUMENT_FAULTED;
}

/** What the dispatcher needs from a document instance. `DocumentInstance` implements it. */
export interface SessionHost {
  addSession(r: SessionRecord): void;
  removeSession(sessionId: string): void;
  handleMessage(r: SessionRecord, msg: ClientMessage): Promise<void>;
  onWritten(sessionId: string, token: number): void;
}

/** What the dispatcher needs from the registry. */
export interface SessionHostSource {
  getOrLoad(id: DocumentId, doc: { ref: StorageRef; format: FileFormat }): Promise<SessionHost>;
}

interface Entry {
  record: SessionRecord;
  host: Promise<SessionHost | null>;
  /** The tail of this session's frame chain. */
  chain: Promise<void>;
}

/** Routes session requests to document instances (§8.1). */
export class SessionDispatcher {
  readonly #sessions = new Map<string, Entry>();
  readonly #registry: SessionHostSource;
  readonly #sink: CoreSink;
  readonly #logger: Logger;

  constructor(d: { registry: SessionHostSource; sink: CoreSink; logger: Logger }) {
    this.#registry = d.registry;
    this.#sink = d.sink;
    this.#logger = d.logger;
  }

  /** The record of a session, if it is open. */
  get(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId)?.record;
  }

  /** Handles one session request. Never throws. */
  handle(req: CoreSessionRequest): void {
    switch (req.type) {
      case 'join':
        this.join(req);
        return;
      case 'frame':
        this.frame(req.sessionId, req.data, req.binary);
        return;
      case 'leave':
        this.leave(req.sessionId);
        return;
      case 'written':
        void this.#sessions.get(req.sessionId)?.host.then((h) => h?.onWritten(req.sessionId, req.token));
        return;
    }
  }

  /** `join`: creates the record, then `registry.getOrLoad`. A load failure closes the session. */
  join(req: Extract<CoreSessionRequest, { type: 'join' }>): void {
    if (this.#sessions.has(req.sessionId)) {
      this.#logger.warn('Duplicate join ignored.', { sessionId: req.sessionId });
      return;
    }
    const record: SessionRecord = {
      sessionId: req.sessionId,
      documentId: req.documentId,
      userId: req.userId,
      access: req.access,
      state: 'joined',
    };
    const host = this.#registry.getOrLoad(req.documentId, req.document).then(
      (h) => {
        if (record.state === 'closed') return null;
        h.addSession(record);
        return h;
      },
      (err: unknown) => {
        if (record.state !== 'closed') {
          record.state = 'closed';
          this.#sessions.delete(record.sessionId);
          sendError(this.#sink, record.sessionId, err);
          this.#sink.close([record.sessionId], loadCloseCode(err), 'load failed');
        }
        return null;
      },
    );
    this.#sessions.set(req.sessionId, { record, host, chain: Promise.resolve() });
  }

  /** `leave`: idempotent. Removes the session from its instance. */
  leave(sessionId: string): void {
    const e = this.#sessions.get(sessionId);
    if (e === undefined) return;
    this.#sessions.delete(sessionId);
    e.record.state = 'closed';
    void e.host.then((h) => h?.removeSession(sessionId));
  }

  /** `frame`: decode, check `hello` comes first, route. Frames of one session run in order. */
  frame(sessionId: string, data: Uint8Array, binary: boolean): void {
    const e = this.#sessions.get(sessionId);
    if (e === undefined) {
      this.#logger.debug('Frame for an unknown session dropped.', { sessionId });
      return;
    }
    e.chain = e.chain.then(async () => {
      const host = await e.host;
      if (host === null || e.record.state === 'closed') return;
      await this.#dispatch(e.record, host, data, binary);
    }).catch((err: unknown) => {
      // A bug in a handler: log and report it; the session and the Core keep running.
      this.#logger.error('Frame handler failed.', { sessionId, code: OpenDocexError.is(err) ? err.code : 'UNKNOWN' });
    });
  }

  /** Resolves once every frame received so far has been handled (for shutdown and tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((e) => e.chain));
  }

  async #dispatch(r: SessionRecord, host: SessionHost, data: Uint8Array, binary: boolean): Promise<void> {
    let decoded;
    if (binary) {
      decoded = decodeClientMessage(data);
    } else {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        sendError(this.#sink, r.sessionId, engineError('PROTOCOL_INVALID_MESSAGE'));
        return;
      }
      decoded = decodeClientMessage(text);
    }
    if (decoded.kind === 'invalid') {
      sendError(this.#sink, r.sessionId, decoded.error);
      return;
    }
    if (decoded.kind === 'ignored') return; // unknown type (HLD §9)
    const msg = decoded.message;
    if (msg.type !== 'hello' && r.clientId === undefined) {
      sendError(this.#sink, r.sessionId, engineError('PROTOCOL_INVALID_MESSAGE', { message: 'hello must come first.' }));
      return;
    }
    await host.handleMessage(r, msg);
  }
}
