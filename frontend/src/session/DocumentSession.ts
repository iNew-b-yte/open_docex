/**
 * `DocumentSession`: the client orchestrator (LLD Part 3 §3). Internal.
 *
 * It owns the {@link Connection}, the {@link ChunkLoader} and the status snapshot, and holds the
 * kind's {@link DocumentBinding} (sync client and editor). It routes server messages by phase
 * and applies the error policy (§16, §0 L-12). It fits `mount`'s `MountSession` seam.
 *
 * Reading of §0 over §3: a `resync` is followed by a full load on the same socket, and no new
 * `hello` is sent (R-9, N3). The session therefore exports orphans and waits for `load-start`
 * instead of reconnecting.
 *
 * @module
 */
import type { Epoch } from '@open-docex/shared/ids';
import {
  PROTOCOL_VERSION,
  type ErrorMsg,
  type HelloMsg,
  type LoadStartMsg,
  type NoticeMsg,
  type ServerMessage,
} from '@open-docex/shared/protocol';
import { ERROR_CATALOGUE, type ErrorCode } from '@open-docex/shared/errors';
import {
  connectAttemptsExhausted,
  policyFor,
  toClientErrorEvent,
  type PolicyInput,
  type SessionPhase,
} from '../errors/policy.js';
import type { ClientError, LoadProgress, ReadyEvent, SessionStatus, SyncEvent } from '../events.js';
import type { MountContext, MountSession } from '../mount.js';
import { ChunkLoader } from '../load/ChunkLoader.js';
import type { RandomSource } from '../net/backoff.js';
import { classifyClose, toPolicyInput, type CloseDecision, type CloseInfo } from '../net/closeCodes.js';
import { Connection, type ConnState, type OnlineTarget, type WebSocketFactory } from '../net/Connection.js';
import type { CreateBinding, DocumentBinding, ReadOnlyReason } from './ports.js';

/** What `DocumentSession` needs besides the mount context. */
export interface SessionDeps {
  /** Creates the binding for the document kind (V1-36 supplies the text one). */
  createBinding: CreateBinding;
  /** Injected in tests. */
  createSocket?: WebSocketFactory;
  /** Injected in tests. */
  random?: RandomSource;
  /** Injected in tests. */
  onlineTarget?: OnlineTarget | null;
}

/** The immutable snapshot React reads through `useSyncExternalStore` (LLD Part 3 §2.2). */
export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly status: SessionStatus;
  /** Progress of the current load, or null when none is running. */
  readonly progress: LoadProgress | null;
  /** The error the `ErrorScreen` shows while `phase === 'terminal'`. */
  readonly error: ClientError | null;
  /** The last `ready` payload, or null before the first load. */
  readonly ready: ReadyEvent | null;
}

const INITIAL_STATUS: SessionStatus = Object.freeze({
  connection: 'connecting',
  load: 'idle',
  access: null,
  readOnlyReason: null,
  sync: 'synced',
  storage: 'normal',
} as const);

/** PROTOCOL_INVALID_MESSAGE twice in a row → terminal (LLD Part 3 §3, §16). */
const MAX_PROTOCOL_FAILURES = 2;

const catalogueInput = (code: ErrorCode): PolicyInput => ({ code, retryable: ERROR_CATALOGUE[code].retryable });

/** The client orchestrator (LLD Part 3 §3). */
export class DocumentSession implements MountSession {
  readonly #ctx: MountContext;
  readonly #createBinding: CreateBinding;
  readonly #connection: Connection;
  readonly #listeners = new Set<() => void>();

  #phase: SessionPhase = 'init';
  #status: SessionStatus = INITIAL_STATUS;
  #progress: LoadProgress | null = null;
  #error: ClientError | null = null;
  #ready: ReadyEvent | null = null;
  #snapshot: SessionSnapshot;

  #binding: DocumentBinding | null = null;
  #loader: ChunkLoader<unknown> | null = null;
  #editorEl: HTMLElement | null = null;
  /** True once a load has finished and the sync client started. */
  #loaded = false;
  /** The sync client is connected (between `start`/`onReconnected` and `onDisconnected`). */
  #syncConnected = false;
  /** The next connect must load the document in full: no `resume` (§3). */
  #reloadPending = false;
  /** A `resync` arrived; its full load follows on the same socket (R-9). */
  #resyncing = false;
  /** `hello` carried `resume`; the first remote, ack or notice means it was accepted. */
  #resuming = false;
  #orphans: { value: unknown } | null = null;
  /** L-12: connect attempts in a row that never opened. */
  #failedInARow = 0;
  #protocolFailures = 0;
  #everOpened = false;
  /** Bumped by every reload, so a `load-done` interrupted by one stops. */
  #reloadGen = 0;

  constructor(ctx: MountContext, deps: SessionDeps) {
    this.#ctx = ctx;
    this.#createBinding = deps.createBinding;
    const o = ctx.options;
    this.#connection = new Connection({
      url: o.url,
      documentId: o.documentId,
      auth: o.auth,
      heartbeat: o.heartbeat,
      reconnect: o.reconnect,
      onOpen: () => this.#onOpen(),
      onMessage: (m, bytes) => this.#onMessage(m, bytes),
      onDecodeError: () => this.#protocolFailure(),
      onClosed: (info) => this.#onClosed(info),
      onState: (s) => this.#onConnState(s),
      ...(deps.createSocket !== undefined ? { createSocket: deps.createSocket } : {}),
      ...(deps.random !== undefined ? { random: deps.random } : {}),
      ...(deps.onlineTarget !== undefined ? { onlineTarget: deps.onlineTarget } : {}),
    });
    this.#snapshot = this.#makeSnapshot();
  }

  // --- public ---------------------------------------------------------------------------------

  /** The current phase. */
  get phase(): SessionPhase {
    return this.#phase;
  }

  /** Subscribes to snapshot changes. Returns an unsubscribe function. */
  readonly subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  /** The current immutable snapshot; replaced on every change. */
  readonly getSnapshot = (): SessionSnapshot => this.#snapshot;

  /** Opens the connection (`init` → `connecting`). */
  start(): void {
    if (this.#phase !== 'init') return;
    this.#setPhase('connecting');
    this.#connection.start();
  }

  /**
   * "Reload"/"Retry" on the error screen (§3, L-12): resets the counters and reconnects fresh,
   * keeping the orphans. Does nothing unless `terminal`.
   */
  retry(): void {
    if (this.#phase !== 'terminal') return;
    this.#failedInARow = 0;
    this.#protocolFailures = 0;
    this.#error = null;
    if (this.#loaded) this.#reloadPending = true;
    this.#setPhase('connecting');
    this.#connection.retry();
  }

  /** `EditorHost` gives the editor element from `useLayoutEffect`, or null on unmount. */
  attachEditor(el: HTMLElement | null): void {
    this.#editorEl = el;
    this.#binding?.attach?.(el);
  }

  /** Closes the socket with 1000, stops the sync client and destroys the editor. Idempotent. */
  destroy(): void {
    if (this.#phase === 'destroyed') return;
    this.#phase = 'destroyed';
    this.#connection.close();
    this.#loader?.reset();
    const binding = this.#binding;
    this.#binding = null;
    if (binding !== null) {
      try {
        binding.sync.destroy();
      } finally {
        binding.destroy();
      }
    }
    this.#update({ connection: 'closed' });
    this.#listeners.clear();
  }

  // --- connection events ----------------------------------------------------------------------

  #onConnState(s: ConnState): void {
    const map: Record<ConnState, SessionStatus['connection']> = {
      idle: 'connecting',
      connecting: this.#everOpened ? 'reconnecting' : 'connecting',
      open: 'open',
      waiting: 'reconnecting',
      terminal: 'failed',
      destroyed: 'closed',
    };
    if (this.#phase === 'destroyed') return;
    this.#update({ connection: map[s] });
  }

  #onOpen(): void {
    this.#everOpened = true;
    this.#failedInARow = 0;
    const resume = this.#loaded && !this.#reloadPending ? this.#binding?.sync.resumeInfo() ?? null : null;
    const hello: HelloMsg = { type: 'hello', protocol: PROTOCOL_VERSION, clientId: this.#ctx.clientId };
    if (resume !== null) hello.resume = { epoch: resume.epoch as Epoch, rev: resume.rev };
    this.#resuming = resume !== null;
    this.#resyncing = false;
    this.#setPhase('handshake');
    this.#connection.send(hello);
    if (resume !== null && this.#binding !== null) {
      this.#syncConnected = true;
      this.#binding.sync.onReconnected();
    }
  }

  #onClosed(info: CloseInfo): CloseDecision {
    if (this.#phase === 'destroyed') return { action: 'terminal' };
    this.#disconnectSync();
    if (this.#loader?.active === true) {
      // An interrupted load must start over: the next hello carries no resume.
      this.#loader.reset();
      this.#reloadPending = true;
    }
    if (!info.everOpened) {
      this.#failedInARow++;
      if (connectAttemptsExhausted(this.#failedInARow)) {
        this.#enterTerminal(catalogueInput('CLIENT_CONNECT_FAILED'));
        return { action: 'terminal' };
      }
    }
    if (this.#resyncing) {
      // A close after `resync` is part of the reload: reconnect (with backoff) and load in full.
      this.#resyncing = false;
      this.#reloadPending = true;
      this.#setPhase('connecting');
      return { action: 'reconnect' };
    }
    const c = classifyClose(info, this.#phase);
    if (c.failAsset === true) this.#binding?.failAssetUpload?.();
    switch (c.decision.action) {
      case 'terminal':
        this.#enterTerminal(c.error ?? catalogueInput('SESSION_CLOSED'));
        return c.decision;
      case 'reload':
        if (c.error?.code === 'PROTOCOL_INVALID_MESSAGE' && ++this.#protocolFailures >= MAX_PROTOCOL_FAILURES) {
          this.#enterTerminal(c.error);
          return { action: 'terminal' };
        }
        this.#prepareReload(c.discard === true);
        return c.decision;
      case 'reconnect':
        this.#setPhase('connecting');
        return c.decision;
    }
  }

  // --- messages -------------------------------------------------------------------------------

  #onMessage(msg: ServerMessage, bytes: number): void {
    if (this.#phase === 'destroyed' || this.#phase === 'terminal') return;
    switch (msg.type) {
      case 'load-start':
        return this.#onLoadStart(msg);
      case 'load-chunk':
        if (this.#phase !== 'loading' || this.#loader === null) return this.#protocolFailure();
        try {
          this.#loader.onChunk(msg, bytes);
        } catch {
          return this.#protocolFailure();
        }
        return;
      case 'load-done':
        return this.#onLoadDone(msg.rev);
      case 'remote':
        if (this.#phase === 'loading') {
          this.#loader?.bufferRemote(msg);
          return;
        }
        if (this.#isLiveOrResuming()) {
          this.#acceptResume();
          this.#binding?.sync.onRemote(msg);
        }
        return;
      case 'ack':
        if (this.#isLiveOrResuming()) {
          this.#acceptResume();
          this.#binding?.sync.onAck(msg);
        }
        return;
      case 'notice':
        if (this.#isLiveOrResuming()) this.#acceptResume();
        this.#onNotice(msg);
        return;
      case 'error':
        return this.#onError(msg);
      case 'resync':
        return this.#onResync();
      case 'asset':
        this.#binding?.onAsset?.(msg);
        return;
      default:
        // upload-* (V4) and annotation-* (V5) have no handler in V1.
        return;
    }
  }

  #isLiveOrResuming(): boolean {
    return this.#phase === 'live' || (this.#phase === 'handshake' && this.#resuming);
  }

  /** The first remote, ack or notice after `hello { resume }` means the resume was accepted. */
  #acceptResume(): void {
    if (this.#phase === 'handshake') this.#enterLive();
  }

  #onLoadStart(msg: LoadStartMsg): void {
    if (msg.kind !== this.#ctx.options.kind) {
      // An adopter integration error (LLD choice, §3).
      this.#enterTerminal(catalogueInput('CONFIG_INVALID'));
      return;
    }
    this.#captureOrphans(false);
    this.#disconnectSync();
    this.#resuming = false;
    this.#resyncing = false;
    if (this.#binding === null) {
      this.#binding = this.#createBinding({
        clientId: this.#ctx.clientId,
        send: (m) => this.#connection.send(m),
        emitSync: (e) => this.#onSync(e),
        reload: (_reason, discard) => this.#reloadNow(discard),
      });
      if (this.#editorEl !== null) this.#binding.attach?.(this.#editorEl);
    }
    this.#loader ??= new ChunkLoader(this.#binding.assembler, (p) => this.#onProgress(p));
    this.#setPhase('loading');
    this.#update({ load: 'loading', access: msg.access });
    this.#loader.begin(msg);
  }

  #onLoadDone(rev: number): void {
    const loader = this.#loader;
    const binding = this.#binding;
    if (this.#phase !== 'loading' || loader === null || binding === null) return this.#protocolFailure();
    let result;
    try {
      result = loader.finish({ type: 'load-done', rev });
    } catch {
      // A seq/rev mismatch or chunk data `assemble` rejects.
      return this.#protocolFailure();
    }
    const info = loader.info;
    if (info === null) return this.#protocolFailure();
    const gen = this.#reloadGen;
    const readOnly = info.readOnly || info.access === 'view';
    binding.show(result.snapshot, info);
    binding.sync.start({ epoch: result.epoch, rev: result.rev, readOnly });
    this.#syncConnected = true;
    this.#loaded = true;
    for (const m of result.buffered) {
      if (gen !== this.#reloadGen || this.#phase !== 'loading') return;
      binding.sync.onRemote(m);
    }
    if (gen !== this.#reloadGen || this.#phase !== 'loading') return;
    const orphans = this.#orphans;
    this.#orphans = null;
    binding.sync.restoreOrphans(orphans?.value ?? null, { epoch: result.epoch, rev: result.rev });
    if (gen !== this.#reloadGen || this.#phase !== 'loading') return;
    this.#reloadPending = false;
    this.#progress = null;
    const reason: ReadOnlyReason | null =
      info.access === 'view' ? 'view' : info.readOnly ? (info.unsupported.length > 0 ? 'unsupported' : 'server') : null;
    this.#enterLive({ load: 'ready', access: info.access, readOnlyReason: reason });
    this.#ready = { kind: info.kind, access: info.access, readOnly, unsupported: info.unsupported };
    this.#publish();
    this.#ctx.emitter.emit('ready', this.#ready);
  }

  #onNotice(msg: NoticeMsg): void {
    if (msg.notice === 'storage') {
      this.#update({ storage: msg.state });
    } else if (msg.notice === 'read-only') {
      const view = this.#status.access === 'view';
      const reason: ReadOnlyReason = view ? 'view' : 'unsupported';
      const ro = view || msg.readOnly;
      if (this.#loaded && this.#binding !== null) this.#binding.sync.setReadOnly(ro, reason);
      this.#update({ readOnlyReason: ro ? reason : null });
    } else {
      this.#update({ connection: 'reconnecting' });
    }
    this.#ctx.emitter.emit('notice', msg);
  }

  /**
   * An `ErrorMsg`. A submit error goes to the sync client and an asset error to the binding.
   * A connection-level error that ends the connection (reconnect or reload) waits for the
   * server's close, where it is `lastError` (C-8); a terminal one stops at once.
   */
  #onError(msg: ErrorMsg): void {
    const input = toPolicyInput(msg);
    const policy = policyFor(input, this.#phase);
    if (policy === 'terminal' && msg.clientSeq === undefined && msg.reqId === undefined) {
      this.#enterTerminal(input);
      return;
    }
    this.#ctx.emitter.emit('error', toClientErrorEvent(input, policy));
    if (msg.clientSeq !== undefined) {
      if (this.#isLiveOrResuming() && this.#loaded) this.#binding?.sync.onSubmitError(msg);
      return;
    }
    if (msg.reqId !== undefined) {
      this.#binding?.onAsset?.(msg);
      return;
    }
    if (policy === 'notice') {
      if (msg.code === 'STORAGE_LOCAL_MODE') this.#update({ storage: 'local' });
      else if (msg.code === 'STORAGE_PENDING') this.#update({ storage: 'pending' });
      else if (msg.code === 'STORAGE_CONFLICT') this.#update({ storage: 'conflict' });
    } else if (policy === 'read-only') {
      const reason: ReadOnlyReason = msg.code === 'DOCUMENT_UNSUPPORTED_CONTENT' ? 'unsupported' : 'server';
      if (this.#loaded) this.#binding?.sync.setReadOnly(true, reason);
      this.#update({ readOnlyReason: reason });
    }
  }

  /** `resync`: export orphans and wait for the full load on this socket (R-9). */
  #onResync(): void {
    this.#captureOrphans(false);
    this.#disconnectSync();
    this.#loader?.reset();
    this.#reloadGen++;
    this.#reloadPending = true;
    this.#resyncing = true;
    this.#resuming = false;
    this.#setPhase('handshake');
  }

  /** A frame that failed to decode, or a broken load: PROTOCOL_INVALID_MESSAGE → reload (§3). */
  #protocolFailure(): void {
    if (this.#phase === 'destroyed' || this.#phase === 'terminal') return;
    const input = catalogueInput('PROTOCOL_INVALID_MESSAGE');
    if (++this.#protocolFailures >= MAX_PROTOCOL_FAILURES) {
      this.#enterTerminal(input);
      return;
    }
    this.#ctx.emitter.emit('error', toClientErrorEvent(input, 'reload'));
    this.#reloadNow(false);
  }

  // --- reload and terminal --------------------------------------------------------------------

  /** Records the orphans once per reload. `discard` drops them. */
  #captureOrphans(discard: boolean): void {
    if (this.#orphans !== null) {
      if (discard) this.#orphans = { value: null };
      return;
    }
    if (!this.#loaded || this.#binding === null) return;
    this.#orphans = { value: discard ? null : this.#binding.sync.exportOrphans() };
  }

  #disconnectSync(): void {
    if (!this.#syncConnected) return;
    this.#syncConnected = false;
    this.#binding?.sync.onDisconnected();
  }

  #prepareReload(discard: boolean): void {
    this.#captureOrphans(discard);
    this.#disconnectSync();
    this.#loader?.reset();
    this.#reloadGen++;
    this.#reloadPending = true;
    this.#resyncing = false;
    this.#resuming = false;
    this.#setPhase('connecting');
  }

  /** A reload decided by the policy or the sync client: close with 1000, reconnect at once, no resume. */
  #reloadNow(discard: boolean): void {
    if (this.#phase === 'destroyed' || this.#phase === 'terminal') return;
    this.#prepareReload(discard);
    this.#connection.closeAndReconnect(false);
  }

  /** Stops: closes the socket, keeps the orphans for `retry()`, shows the error screen. */
  #enterTerminal(input: PolicyInput): void {
    this.#captureOrphans(false);
    this.#disconnectSync();
    this.#loader?.reset();
    this.#reloadGen++;
    this.#resyncing = false;
    this.#resuming = false;
    this.#progress = null;
    const err = toClientErrorEvent(input, 'terminal');
    this.#error = err;
    this.#setPhase('terminal');
    this.#connection.terminate();
    this.#update({ connection: 'failed' });
    this.#ctx.emitter.emit('error', err);
  }

  #enterLive(patch: Partial<SessionStatus> = {}): void {
    this.#resuming = false;
    this.#protocolFailures = 0;
    this.#connection.resetBackoff();
    this.#phase = 'live';
    this.#update(patch);
  }

  // --- status ---------------------------------------------------------------------------------

  #onSync(e: SyncEvent): void {
    this.#update({ sync: e.pendingCount > 0 ? 'pending' : 'synced' });
    this.#ctx.emitter.emit('sync', e);
  }

  #onProgress(p: LoadProgress): void {
    this.#progress = p;
    this.#publish();
    this.#ctx.emitter.emit('load-progress', p);
  }

  #setPhase(p: SessionPhase): void {
    if (this.#phase === p) return;
    this.#phase = p;
    this.#publish();
  }

  /** Applies a status patch; emits `status` when anything changed. */
  #update(patch: Partial<SessionStatus>): void {
    const next: SessionStatus = { ...this.#status, ...patch };
    const changed = (Object.keys(next) as (keyof SessionStatus)[]).some((k) => next[k] !== this.#status[k]);
    if (changed) {
      this.#status = Object.freeze(next);
      this.#ctx.emitter.emit('status', this.#status);
    }
    this.#publish();
  }

  #makeSnapshot(): SessionSnapshot {
    return Object.freeze({
      phase: this.#phase,
      status: this.#status,
      progress: this.#progress,
      error: this.#error,
      ready: this.#ready,
    });
  }

  #publish(): void {
    const s = this.#snapshot;
    if (
      s.phase === this.#phase &&
      s.status === this.#status &&
      s.progress === this.#progress &&
      s.error === this.#error &&
      s.ready === this.#ready
    ) {
      return;
    }
    this.#snapshot = this.#makeSnapshot();
    for (const fn of [...this.#listeners]) fn();
  }
}
