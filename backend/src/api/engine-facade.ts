/**
 * The public `Engine` and its implementation (LLD Part 2 §2.6, §2.7).
 *
 * `EngineFacade` is main-process code: it forwards the admin API to the Core over the
 * `EngineChannel`, runs `sessions.close` on the Gateway's session table, and owns the engine
 * state that decides what a call does while the Core is restarting, failed or stopped.
 *
 * @module
 */
import { CloseCode } from '@open-docex/shared/protocol';
import type { DocKind, FileFormat } from '@open-docex/shared/protocol';
import { asDocumentId, type DocumentId } from '@open-docex/shared/ids';
import type { LocalCopy, RecoveryEntry, RecoveryResolution } from '../core/core-entry.js';
import type { EngineChannel } from '../channel/engine-channel.js';
import type { ApiMethod } from '../channel/messages.js';
import type { InProcessEngineChannel } from '../channel/in-process-engine-channel.js';
import { engineError } from '../errors/engine-error.js';
import type { EngineState, Gateway } from '../gateway/gateway.js';
import type { SessionFilter } from '../gateway/session-table.js';
import type { Logger } from '../log/logger.js';
import type { StorageRef } from '../storage/storage-adapter.js';
import type { Supervisor } from '../supervisor/supervisor.js';
import type { AuditEvent, EngineEventMap } from './events.js';
import type { HttpServerLike, ResolvedEngineOptions } from './options.js';
import type { TypedEmitter } from './typed-emitter.js';

export type { EngineState } from '../gateway/gateway.js';
export type { SessionFilter } from '../gateway/session-table.js';
export type { LocalCopy, RecoveryEntry, RecoveryResolution } from '../core/core-entry.js';

/** What `engine.documents.create` takes (LLD Part 2 §2.6). */
export interface CreateDocumentInput {
  kind: DocKind;
  format: FileFormat;
  /** A display name. Adapters must not trust it as a path. */
  name: string;
  /** `'local'` keeps the document in the built-in local storage even when an adopter storage is set. */
  target: 'storage' | 'local';
}

/** What `engine.shareInfo` returns (LLD §0 L-9). */
export interface ShareInfo {
  documentId: DocumentId;
  /** True while the Core has the document in memory. */
  loaded: boolean;
  kind?: DocKind;
  /** Connected sessions by access. */
  sessions: { edit: number; view: number };
}

/** The engine's public surface (LLD Part 2 §2.6). */
export interface Engine {
  readonly state: EngineState;
  /** Adds one `upgrade` listener to `server`. Several servers are allowed. */
  attach(server: HttpServerLike): void;
  /** Subscribes to an engine event and returns the unsubscribe function. */
  on<E extends keyof EngineEventMap>(event: E, fn: (p: EngineEventMap[E]) => void): () => void;
  off<E extends keyof EngineEventMap>(event: E, fn: (p: EngineEventMap[E]) => void): void;
  documents: {
    /** Creates a blank document in storage and returns its ref. */
    create(input: CreateDocumentInput): Promise<{ ref: StorageRef }>;
    /** Lets users edit a document that opened read-only because of unsupported content. */
    allowUnsupportedEdit(documentId: DocumentId): Promise<void>;
  };
  recovery: {
    list(): Promise<RecoveryEntry[]>;
    retry(documentId: DocumentId): Promise<RecoveryEntry>;
    readLocalCopy(documentId: DocumentId): Promise<LocalCopy>;
    resolve(documentId: DocumentId, resolution: RecoveryResolution): Promise<RecoveryEntry>;
  };
  sessions: {
    /** Closes the matching sessions with `SESSION_CLOSED` and returns how many. */
    close(filter: SessionFilter): number;
  };
  shareInfo(documentId: DocumentId): Promise<ShareInfo>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * The narrowed argument and result types of each API method (LLD §0.5 S-34 leaves
 * `ApiArgs`/`ApiResult` as `unknown` in `channel/messages.ts`; the facade narrows them here).
 */
interface ApiTypes {
  'documents.create': { args: CreateDocumentInput; result: { ref: StorageRef } };
  'documents.allowUnsupportedEdit': { args: { documentId: DocumentId }; result: void };
  'documents.info': { args: { documentId: DocumentId }; result: { documentId: DocumentId; loaded: boolean; kind?: DocKind } };
  'recovery.list': { args: Record<string, never>; result: RecoveryEntry[] };
  'recovery.retry': { args: { documentId: DocumentId }; result: RecoveryEntry };
  'recovery.readLocalCopy': { args: { documentId: DocumentId }; result: LocalCopy };
  'recovery.resolve': { args: { documentId: DocumentId; resolution: RecoveryResolution }; result: RecoveryEntry };
  'audit.enable': { args: { enabled: boolean }; result: void };
}

/** The most audit events held while no `audit` listener exists (see {@link AuditRelay}). */
export const AUDIT_BUFFER_MAX = 10_000;

/**
 * Hands audit events to `audit` listeners. The Core replays pending events at boot (PO-17), before
 * an adopter can have called `engine.on('audit')`, so events that arrive while no listener exists
 * are kept (up to {@link AUDIT_BUFFER_MAX}) and delivered to the first listener (LLD choice).
 */
export class AuditRelay {
  readonly #emitter: TypedEmitter<EngineEventMap>;
  readonly #logger: Logger;
  #buffer: AuditEvent[] = [];
  #warned = false;

  constructor(emitter: TypedEmitter<EngineEventMap>, logger: Logger) {
    this.#emitter = emitter;
    this.#logger = logger;
  }

  /** The Core sent an audit event. */
  sink = (e: AuditEvent): void => {
    if (this.#emitter.listenerCount('audit') > 0) {
      this.#emitter.emit('audit', e);
    } else if (this.#buffer.length < AUDIT_BUFFER_MAX) {
      this.#buffer.push(e);
    } else if (!this.#warned) {
      this.#warned = true;
      this.#logger.warn('Audit events are being dropped: no audit listener, and the buffer is full.');
    }
  };

  /** Delivers the buffered events to the listeners. Call after a listener was added. */
  drain(): void {
    if (this.#emitter.listenerCount('audit') === 0) return;
    const buffered = this.#buffer;
    this.#buffer = [];
    this.#warned = false;
    for (const e of buffered) this.#emitter.emit('audit', e);
  }
}

/** What `EngineFacade` is built from. `create-engine.ts` assembles it. */
export interface EngineFacadeDeps {
  opts: ResolvedEngineOptions;
  gateway: Gateway;
  channel: EngineChannel;
  emitter: TypedEmitter<EngineEventMap>;
  logger: Logger;
  relay: AuditRelay;
  /** Present in `mode: 'worker'`. */
  supervisor?: Supervisor;
  /** Present in `mode: 'main'`: closed at shutdown. */
  inProcess?: InProcessEngineChannel;
}

const SHUTDOWN_MARGIN_MS = 500;

/** The implementation of {@link Engine}. */
export class EngineFacade implements Engine {
  readonly documents: Engine['documents'];
  readonly recovery: Engine['recovery'];
  readonly sessions: Engine['sessions'];
  readonly #d: EngineFacadeDeps;
  #state: EngineState = 'running';
  /** What this side believes the Core's audit emitter is set to. A (re)booted Core starts enabled (S-40). */
  #coreAudit = true;
  #stopping: Promise<void> | undefined;

  constructor(d: EngineFacadeDeps) {
    this.#d = d;
    // The Supervisor emits `engine` events; they drive the state (LLD Part 2 §2.6).
    d.emitter.on('engine', (ev) => {
      if (this.#state === 'stopping' || this.#state === 'stopped') return;
      if (ev.state === 'started') {
        this.#state = 'running';
        this.#coreAudit = true; // a fresh Core replays and starts with audit enabled
        this.#syncAudit();
      } else {
        this.#state = ev.state;
      }
    });
    this.documents = {
      create: (input) => this.#call('documents.create', () => checkCreate(input)),
      allowUnsupportedEdit: (documentId) => this.#call('documents.allowUnsupportedEdit', () => ({ documentId: id(documentId) })),
    };
    this.recovery = {
      list: () => this.#call('recovery.list', () => ({})),
      retry: (documentId) => this.#call('recovery.retry', () => ({ documentId: id(documentId) })),
      readLocalCopy: (documentId) => this.#call('recovery.readLocalCopy', () => ({ documentId: id(documentId) })),
      resolve: (documentId, resolution) => this.#call('recovery.resolve', () => ({ documentId: id(documentId), resolution: checkResolution(resolution) })),
    };
    this.sessions = {
      close: (filter) => {
        const f = checkFilter(filter);
        return this.#d.gateway.closeSessions(f, CloseCode.SESSION_CLOSED, 'SESSION_CLOSED');
      },
    };
    // Boot replayed audit events with audit enabled; with no listener, turn it off now.
    this.#syncAudit();
  }

  get state(): EngineState {
    return this.#state;
  }

  attach(server: HttpServerLike): void {
    this.#d.gateway.attach(server);
  }

  on<E extends keyof EngineEventMap>(event: E, fn: (p: EngineEventMap[E]) => void): () => void {
    const off = this.#d.emitter.on(event, fn);
    if (event === 'audit') this.#auditListenersChanged();
    return () => {
      off();
      if (event === 'audit') this.#auditListenersChanged();
    };
  }

  off<E extends keyof EngineEventMap>(event: E, fn: (p: EngineEventMap[E]) => void): void {
    this.#d.emitter.off(event, fn);
    if (event === 'audit') this.#auditListenersChanged();
  }

  async shareInfo(documentId: DocumentId): Promise<ShareInfo> {
    const documentIdChecked = id(documentId);
    const info = await this.#call('documents.info', () => ({ documentId: documentIdChecked }));
    const out: ShareInfo = { documentId: documentIdChecked, loaded: info.loaded, sessions: this.#d.gateway.countSessions(documentIdChecked) };
    if (info.kind !== undefined) out.kind = info.kind;
    return out;
  }

  /**
   * Stops accepting upgrades, closes every session with `SESSION_CLOSED`, shuts the Core down and
   * removes the `upgrade` listeners (LLD Part 2 §4.4). Calling it again returns the same promise.
   */
  shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    this.#stopping ??= this.#shutdown(options.timeoutMs ?? this.#d.opts.supervisor.shutdownTimeoutMs);
    return this.#stopping;
  }

  async #shutdown(timeoutMs: number): Promise<void> {
    const { gateway, supervisor, channel, inProcess, logger } = this.#d;
    this.#state = 'stopping';
    gateway.stopAccepting();
    // Part 1 §5.5 wins over Part 2 §4.4 (LLD §0 R-16): shutdown is 1001, so clients reconnect with resume.
    gateway.closeAll(CloseCode.GOING_AWAY, 'GOING_AWAY');
    try {
      if (supervisor !== undefined) {
        await supervisor.stop(timeoutMs);
      } else {
        await channel.request('shutdown', { timeoutMs: Math.max(0, timeoutMs - SHUTDOWN_MARGIN_MS) }, timeoutMs);
        inProcess?.close(engineError('ENGINE_UNAVAILABLE', { message: 'The engine stopped.' }));
      }
    } catch (err) {
      logger.warn('Engine shutdown: the Core did not stop cleanly.');
      void err;
    } finally {
      gateway.detach();
      this.#state = 'stopped';
    }
  }

  /** Forwards one API call to the Core, or rejects according to the engine state (LLD §2.6). */
  #call<M extends ApiMethod & keyof ApiTypes>(method: M, makeArgs: () => ApiTypes[M]['args']): Promise<ApiTypes[M]['result']> {
    let args: ApiTypes[M]['args'];
    try {
      args = makeArgs();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : engineError('CONFIG_INVALID'));
    }
    switch (this.#state) {
      case 'restarting':
        return Promise.reject(engineError('ENGINE_RESTARTING'));
      case 'failed':
        return Promise.reject(engineError('ENGINE_FAILED'));
      case 'stopping':
      case 'stopped':
        return Promise.reject(engineError('SESSION_CLOSED', { message: 'The engine is shut down.' }));
      case 'starting':
        return Promise.reject(engineError('ENGINE_UNAVAILABLE', { message: 'The engine is starting.' }));
      case 'running':
        break;
    }
    return this.#d.channel.call(method, args as never) as Promise<ApiTypes[M]['result']>;
  }

  #auditListenersChanged(): void {
    this.#syncAudit();
    this.#d.relay.drain();
  }

  /** `audit.enable` goes to the Core when the first listener is added and the last one removed (§6.2). */
  #syncAudit(): void {
    const want = this.#d.emitter.listenerCount('audit') > 0;
    if (want === this.#coreAudit || this.#state !== 'running') return;
    this.#coreAudit = want;
    this.#d.channel.call('audit.enable', { enabled: want }).catch((err: unknown) => {
      // The Core is restarting or gone; its next boot starts enabled and `started` syncs again.
      this.#coreAudit = !want;
      this.#d.logger.debug('audit.enable was not delivered.', { state: this.#state });
      void err;
    });
  }
}

const FORMATS: ReadonlySet<string> = new Set(['docx', 'odt', 'xlsx', 'ods']);
const TEXT: ReadonlySet<string> = new Set(['docx', 'odt']);

function id(documentId: unknown): DocumentId {
  try {
    return asDocumentId(documentId as string);
  } catch {
    throw engineError('CONFIG_INVALID', { message: 'documentId: expected a document ID (1 to 1,024 characters, no control characters).' });
  }
}

/** Checks `documents.create` input in main, so a mismatch fails before any Core call (LLD §2.6 step 1). */
function checkCreate(input: CreateDocumentInput): CreateDocumentInput {
  const i = input as unknown;
  if (typeof i !== 'object' || i === null) throw engineError('CONFIG_INVALID', { message: 'documents.create: expected an object.' });
  const { kind, format, name, target } = i as Record<string, unknown>;
  if (kind !== 'text' && kind !== 'sheet') throw engineError('CONFIG_INVALID', { message: 'kind: expected "text" or "sheet".' });
  if (typeof format !== 'string' || !FORMATS.has(format)) {
    throw engineError('CONFIG_INVALID', { message: 'format: expected "docx", "odt", "xlsx" or "ods".' });
  }
  if ((kind === 'text') !== TEXT.has(format)) {
    throw engineError('CONFIG_INVALID', { message: `format: "${format}" does not match kind "${kind}".` });
  }
  if (typeof name !== 'string' || name.length === 0) throw engineError('CONFIG_INVALID', { message: 'name: expected a non-empty string.' });
  if (target !== 'storage' && target !== 'local') throw engineError('CONFIG_INVALID', { message: 'target: expected "storage" or "local".' });
  return { kind, format: format as FileFormat, name, target };
}

/** At least one field is required (LLD §2.6); the others must be strings. */
function checkFilter(filter: SessionFilter): SessionFilter {
  const f = filter as unknown;
  if (typeof f !== 'object' || f === null) throw engineError('CONFIG_INVALID', { message: 'sessions.close: expected a filter object.' });
  const { documentId, userId, sessionId } = f as Record<string, unknown>;
  const out: SessionFilter = {};
  if (documentId !== undefined) out.documentId = id(documentId);
  if (userId !== undefined) {
    if (typeof userId !== 'string') throw engineError('CONFIG_INVALID', { message: 'userId: expected a string.' });
    out.userId = userId;
  }
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string') throw engineError('CONFIG_INVALID', { message: 'sessionId: expected a string.' });
    out.sessionId = sessionId;
  }
  if (out.documentId === undefined && out.userId === undefined && out.sessionId === undefined) {
    throw engineError('CONFIG_INVALID', { message: 'sessions.close: give at least one of documentId, userId or sessionId.' });
  }
  return out;
}


function checkResolution(r: unknown): RecoveryResolution {
  if (r !== 'overwrite-storage' && r !== 'discard-local' && r !== 'mark-resolved') {
    throw engineError('CONFIG_INVALID', { message: 'resolution: expected "overwrite-storage", "discard-local" or "mark-resolved".' });
  }
  return r;
}
