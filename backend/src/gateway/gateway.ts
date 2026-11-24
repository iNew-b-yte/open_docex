/**
 * The Gateway (LLD Part 2 §4, HLD §6, §10, §14), main process.
 *
 * - handles the HTTP `upgrade` and calls `authorize` before `handleUpgrade`
 * - keeps the session table and a send queue per connection
 * - forwards raw frames to the Core without parsing them (HLD §16). With `canSubmit` set, text
 *   frames are decoded so that `submit` can be gated; that cost is the price of the hook
 * - applies close codes, including 4001 when the Core restarts
 * - enforces the `asset-put` size limit through the WebSocket `maxPayload` (LLD Part 2 §8.4, S-36)
 *
 * Nothing here logs request headers, cookies, query strings or tokens: only the configured path,
 * session ids and document ids.
 *
 * @module
 */
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { OpenDocexError, toClientError } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import { CloseCode, decodeClientMessage, encodeMessage } from '@open-docex/shared/protocol';
import type { EngineEventMap } from '../api/events.js';
import type { AuthorizeResult, HttpServerLike, ResolvedEngineOptions } from '../api/options.js';
import type { TypedEmitter } from '../api/typed-emitter.js';
import type { EngineChannel } from '../channel/engine-channel.js';
import type { CoreEvent, LeaveReason } from '../channel/messages.js';
import { engineError } from '../errors/engine-error.js';
import type { Logger } from '../log/logger.js';
import type { Clock, SupervisorGateway } from '../supervisor/supervisor.js';
import { SendQueue, SLOW_CONSUMER_TERMINATE_MS } from './send-queue.js';
import { SessionTable, type GatewaySession, type SessionFilter } from './session-table.js';
import { hasDeny, isValidAuthorizeResult, isValidDenial, parseUpgrade, rejectSocket } from './upgrade.js';

/** The engine's lifecycle states (LLD Part 2 §2.6). */
export type EngineState = 'starting' | 'running' | 'restarting' | 'failed' | 'stopping' | 'stopped';

/** A close reason must fit in 123 bytes of UTF-8 (RFC 6455 §5.5). We only use error-code names. */
function reasonOf(reason: string): string {
  return Buffer.byteLength(reason) <= 123 ? reason : reason.slice(0, 100);
}

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** The WebSocket gateway of one engine. */
export class Gateway implements SupervisorGateway {
  readonly #opts: ResolvedEngineOptions;
  readonly #emitter: TypedEmitter<EngineEventMap>;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #wss: WebSocketServer;
  readonly #table = new SessionTable();
  readonly #listeners = new Map<HttpServerLike, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>();
  #channel: EngineChannel | undefined;
  #state: () => EngineState = () => 'starting';
  #nextBackoffMs: () => number = () => 0;
  #unsubscribe: (() => void) | undefined;
  #pingTimer: unknown;
  #stopping = false;

  constructor(opts: ResolvedEngineOptions, emitter: TypedEmitter<EngineEventMap>, logger: Logger, clock: Clock) {
    this.#opts = opts;
    this.#emitter = emitter;
    this.#logger = logger;
    this.#clock = clock;
    // `maxPayload` is set explicitly because ws's own default is 100 MiB. `perMessageDeflate:
    // false` saves CPU in main and rules out decompression bombs. `clientTracking: false`: the
    // session table tracks clients.
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: opts.ws.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  /**
   * Connects the Gateway to the channel and the engine state. Core events `send` and `close`
   * are handled from now on, and the dead-connection ping starts.
   *
   * @param nextBackoffMs the delay of the next Core restart, for `Retry-After` (default 0).
   */
  bind(channel: EngineChannel, state: () => EngineState, nextBackoffMs?: () => number): void {
    this.#unsubscribe?.();
    this.#channel = channel;
    this.#state = state;
    if (nextBackoffMs !== undefined) this.#nextBackoffMs = nextBackoffMs;
    this.#unsubscribe = channel.onEvent((ev) => this.#onCoreEvent(ev));
    this.#schedulePing();
  }

  /** Adds an `upgrade` listener to `server` (one per server; attaching twice does nothing). */
  attach(server: HttpServerLike): void {
    if (this.#listeners.has(server)) return;
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      void this.#onUpgrade(req, socket, head);
    };
    this.#listeners.set(server, listener);
    server.on('upgrade', listener);
  }

  /** Live session counts of one document. */
  countSessions(documentId: DocumentId): { edit: number; view: number } {
    return this.#table.count(documentId);
  }

  /** Closes the sessions matching `filter` (`engine.sessions.close`). Returns how many. */
  closeSessions(filter: SessionFilter, code: number, reason: string): number {
    const matched = this.#table.match(filter);
    for (const s of matched) this.#drop(s, code, reason, 'admin');
    return matched.length;
  }

  /**
   * The Core went down (LLD Part 2 §4.4): every session is closed with 4001 (`restarting`, after
   * a best-effort `engine-restarting` notice) or 4002 (`failed`). The table is cleared. New
   * upgrades get HTTP 503 until the Core runs again.
   */
  onCoreDown(reason: 'restarting' | 'failed'): void {
    const code = reason === 'restarting' ? CloseCode.ENGINE_RESTARTING : CloseCode.ENGINE_UNAVAILABLE;
    const name = reason === 'restarting' ? 'ENGINE_RESTARTING' : 'ENGINE_UNAVAILABLE';
    const notice = encodeMessage({ type: 'notice', notice: 'engine-restarting' });
    for (const s of this.#table.all()) {
      if (reason === 'restarting') s.send.push(notice);
      this.#closeSocket(s, code, name);
    }
    this.#table.clear();
  }

  /** Makes new upgrades answer HTTP 503. */
  stopAccepting(): void {
    this.#stopping = true;
  }

  /** Closes every session and tells the Core they left (`shutdown`). */
  closeAll(code: number, reason: string): void {
    for (const s of this.#table.all()) this.#drop(s, code, reason, 'shutdown');
  }

  /** Removes the `upgrade` listeners, stops the ping and closes the WebSocket server. */
  detach(): void {
    for (const [server, listener] of this.#listeners) server.off('upgrade', listener);
    this.#listeners.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#pingTimer !== undefined) this.#clock.clearTimeout(this.#pingTimer);
    this.#pingTimer = undefined;
    for (const s of this.#table.all()) this.#clearTimers(s);
    this.#table.clear();
    this.#wss.close();
  }

  // --- upgrade (LLD Part 2 §4.2) ----------------------------------------------------------------

  async #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const parsed = parseUpgrade(req, this.#opts.http.path);
    if (parsed.kind === 'other') return; // not ours: other 'upgrade' listeners handle it
    const onSocketError = (): void => {
      this.#logger.debug('Upgrade socket error.');
    };
    socket.on('error', onSocketError);
    try {
      if (this.#stopping || this.#state() === 'starting' || this.#state() === 'restarting') {
        this.#reject503(socket);
        return;
      }
      if (parsed.kind === 'bad-request') {
        rejectSocket(socket, 400);
        return;
      }
      const { url, documentId } = parsed;
      let result: unknown;
      try {
        result = await this.#opts.authorize({ request: req, url, documentId, purpose: 'document' });
      } catch (err) {
        this.#emitter.emit('error', engineError('ACCESS_DENIED', { message: 'authorize threw.', documentId, cause: err }));
        rejectSocket(socket, 500);
        return;
      }
      if (result === null) {
        rejectSocket(socket, 403);
        return;
      }
      if (hasDeny(result)) {
        if (isValidDenial(result)) {
          rejectSocket(socket, result.deny);
        } else {
          this.#emitter.emit('error', engineError('CONFIG_INVALID', { message: 'authorize returned an invalid { deny } value.', documentId }));
          rejectSocket(socket, 500);
        }
        return;
      }
      if (!isValidAuthorizeResult(result)) {
        this.#emitter.emit('error', engineError('CONFIG_INVALID', { message: 'authorize returned a malformed result.', documentId }));
        rejectSocket(socket, 500);
        return;
      }
      if (socket.destroyed) return; // the client left during the async authorize
      const state = this.#state();
      if (this.#stopping || (state !== 'running' && state !== 'failed')) {
        this.#reject503(socket);
        return;
      }
      if (state === 'failed') {
        // A browser WebSocket cannot read an HTTP status, so the client sees ENGINE_UNAVAILABLE
        // only as a close code (HLD §10.5).
        this.#wss.handleUpgrade(req, socket, head, (ws) => {
          socket.off('error', onSocketError);
          ws.on('error', () => undefined);
          ws.close(CloseCode.ENGINE_UNAVAILABLE, 'ENGINE_UNAVAILABLE');
        });
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        socket.off('error', onSocketError);
        this.#openSession(ws, documentId, result);
      });
    } catch (err) {
      this.#logger.error('Upgrade failed.', { code: OpenDocexError.is(err) ? err.code : 'UNKNOWN' });
      rejectSocket(socket, 500);
    }
  }

  #reject503(socket: Duplex): void {
    rejectSocket(socket, 503, { 'Retry-After': Math.max(1, Math.ceil(this.#nextBackoffMs() / 1000)) });
  }

  // --- session open, inbound and outbound (LLD Part 2 §4.3) --------------------------------------

  #openSession(ws: WebSocket, documentId: DocumentId, r: AuthorizeResult): void {
    const channel = this.#channel;
    if (channel === undefined) {
      ws.close(CloseCode.ENGINE_UNAVAILABLE, 'ENGINE_UNAVAILABLE');
      return;
    }
    const id = randomUUID();
    const openedAt = this.#clock.now();
    const view = Object.freeze({ id, documentId, userId: r.userId, access: r.access, openedAt });
    // `s` is read only when the queue overflows, which is after this function returned.
    const send = new SendQueue(ws, this.#opts.send.highWaterMarkBytes, () => this.#onOverflow(s), this.#clock);
    const s: GatewaySession = {
      ...view,
      view,
      ws,
      send,
      inbound: Promise.resolve(),
      alive: true,
    };
    this.#table.add(s);
    // The Core starts loading now.
    channel.post({ type: 'join', sessionId: id, documentId, userId: r.userId, access: r.access, document: r.document });
    s.helloTimer = this.#clock.setTimeout(() => {
      s.helloTimer = undefined;
      this.#drop(s, CloseCode.PROTOCOL_ERROR, 'PROTOCOL_INVALID_MESSAGE', 'client-closed');
    }, this.#opts.ws.helloTimeoutMs);
    ws.on('message', (data: RawData, isBinary: boolean) => this.#onInbound(s, data, isBinary));
    ws.on('pong', () => {
      s.alive = true;
    });
    // ws emits 'error' for protocol violations, for example a frame over maxPayload (it closes
    // with 1009 itself). Without a listener that would crash the adopter's process.
    ws.on('error', () => {
      this.#logger.debug('Session socket error.', { sessionId: id });
    });
    ws.on('close', () => {
      this.#clearTimers(s);
      s.send.close();
      if (this.#table.remove(s)) this.#channel?.post({ type: 'leave', sessionId: id, reason: 'client-closed' });
    });
    this.#logger.debug('Session opened.', { sessionId: id, documentId });
  }

  #onInbound(s: GatewaySession, data: RawData, isBinary: boolean): void {
    if (s.helloTimer !== undefined) {
      this.#clock.clearTimeout(s.helloTimer);
      s.helloTimer = undefined; // the Core enforces that hello comes first
    }
    s.alive = true;
    const bytes = toBytes(data);
    const canSubmit = this.#opts.canSubmit;
    if (canSubmit === undefined) {
      this.#forward(s, bytes, isBinary);
      return;
    }
    // Keeps per-session order while canSubmit awaits: every frame goes through the chain.
    s.inbound = s.inbound
      .then(async () => {
        if (!isBinary) {
          const decoded = decodeClientMessage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
          // On a decode failure the frame is forwarded unchanged; the Core reports the error.
          if (decoded.kind === 'message' && decoded.message.type === 'submit') {
            const clientSeq = decoded.message.clientSeq;
            if (!(await this.#maySubmit(canSubmit, s))) {
              s.send.push(encodeMessage({ type: 'error', ...toClientError(engineError('ACCESS_DENIED'), { clientSeq }) }));
              return;
            }
          }
        }
        this.#forward(s, bytes, isBinary);
      })
      .catch((err: unknown) => {
        this.#logger.error('Inbound frame handling failed.', { sessionId: s.id, code: OpenDocexError.is(err) ? err.code : 'UNKNOWN' });
      });
  }

  /** A throw or a non-`true` answer counts as false; a throw also emits `error(ACCESS_DENIED)`. */
  async #maySubmit(canSubmit: NonNullable<ResolvedEngineOptions['canSubmit']>, s: GatewaySession): Promise<boolean> {
    try {
      return (await canSubmit(s.view)) === true;
    } catch (err) {
      this.#emitter.emit('error', engineError('ACCESS_DENIED', { message: 'canSubmit threw.', documentId: s.documentId, cause: err }));
      return false;
    }
  }

  #forward(s: GatewaySession, data: Uint8Array, binary: boolean): void {
    if (this.#table.get(s.id) !== s) return; // the session left while canSubmit was awaiting
    this.#channel?.post({ type: 'frame', sessionId: s.id, data, binary });
  }

  #onCoreEvent(ev: CoreEvent): void {
    if (ev.type === 'send') {
      for (const f of ev.frames) {
        for (const id of f.sessionIds) {
          const s = this.#table.get(id);
          if (s === undefined) continue;
          const token = f.token;
          const opts = token === undefined ? { binary: f.binary } : { binary: f.binary, onWritten: () => this.#channel?.post({ type: 'written', sessionId: id, token }) };
          s.send.push(f.data, opts);
        }
      }
    } else if (ev.type === 'close') {
      for (const id of ev.sessionIds) {
        const s = this.#table.get(id);
        if (s !== undefined) this.#drop(s, ev.code, ev.reason, 'admin');
      }
    }
  }

  // --- closing ---------------------------------------------------------------------------------

  /** Removes `s` from the table, tells the Core it left, and closes its socket. */
  #drop(s: GatewaySession, code: number, reason: string, leave: LeaveReason): void {
    if (this.#table.remove(s)) this.#channel?.post({ type: 'leave', sessionId: s.id, reason: leave });
    this.#closeSocket(s, code, reason);
  }

  #closeSocket(s: GatewaySession, code: number, reason: string): void {
    if (s.helloTimer !== undefined) {
      this.#clock.clearTimeout(s.helloTimer);
      s.helloTimer = undefined;
    }
    try {
      s.ws.close(code, reasonOf(reason));
    } catch {
      // The socket is already going away.
    }
    s.send.close();
    // The close frame waits behind the backlog, and ws's own closeTimeout is 30 s.
    if (s.closeTimer === undefined) {
      s.closeTimer = this.#clock.setTimeout(() => {
        s.closeTimer = undefined;
        try {
          s.ws.terminate();
        } catch {
          // Nothing left to do.
        }
      }, SLOW_CONSUMER_TERMINATE_MS);
    }
  }

  /** The send queue overflowed (the queue already started the close): the Core drops the session. */
  #onOverflow(s: GatewaySession): void {
    if (s.helloTimer !== undefined) {
      this.#clock.clearTimeout(s.helloTimer);
      s.helloTimer = undefined;
    }
    if (this.#table.remove(s)) this.#channel?.post({ type: 'leave', sessionId: s.id, reason: 'slow-consumer' });
  }

  #clearTimers(s: GatewaySession): void {
    if (s.helloTimer !== undefined) this.#clock.clearTimeout(s.helloTimer);
    if (s.closeTimer !== undefined) this.#clock.clearTimeout(s.closeTimer);
    s.helloTimer = undefined;
    s.closeTimer = undefined;
  }

  // --- dead-connection ping --------------------------------------------------------------------

  #schedulePing(): void {
    if (this.#pingTimer !== undefined) this.#clock.clearTimeout(this.#pingTimer);
    this.#pingTimer = this.#clock.setTimeout(() => {
      this.#pingTimer = undefined;
      for (const s of this.#table.all()) {
        if (!s.alive) {
          s.ws.terminate();
        } else {
          s.alive = false;
          try {
            s.ws.ping();
          } catch {
            // The socket is closing; its 'close' event cleans up.
          }
        }
      }
      if (this.#unsubscribe !== undefined) this.#schedulePing();
    }, this.#opts.ws.pingIntervalMs);
  }
}
