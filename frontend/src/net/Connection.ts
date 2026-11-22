/**
 * `Connection`: one browser WebSocket at a time (LLD Part 3 §4).
 *
 * It places auth on the upgrade, runs the heartbeat, reconnects with backoff and reports closes.
 * It never interprets document messages: the session (`DocumentSession`) does, and it decides
 * what a close means through `onClosed`.
 *
 * Security (HLD §14, LLD Part 3 §15): the token is never logged or stored, and `CloseInfo`
 * never carries the URL.
 *
 * @module
 */
import {
  decodeServerMessage,
  DOC_QUERY_PARAM,
  encodeMessage,
  WS_SUBPROTOCOL,
  type ClientMessage,
  type ErrorMsg,
  type ServerMessage,
} from '@open-docex/shared/protocol';
import type { DocumentId } from '@open-docex/shared/ids';
import type { AuthOption } from '../options.js';
import { backoffDelay, type RandomSource } from './backoff.js';
import type { CloseDecision, CloseInfo } from './closeCodes.js';

export type { CloseDecision, CloseInfo } from './closeCodes.js';

/** The connection's state (LLD Part 3 §4). */
export type ConnState = 'idle' | 'connecting' | 'open' | 'waiting' | 'terminal' | 'destroyed';

/** The part of the browser `WebSocket` that `Connection` uses. Tests inject a fake. */
export interface WebSocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Creates a socket. The default is `new WebSocket(url, protocols)`. */
export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike;

/** Where `Connection` listens for the `online` event. The default is `globalThis`. */
export type OnlineTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** What `Connection` needs (LLD Part 3 §4). */
export interface ConnectionDeps {
  url: string;
  documentId: DocumentId;
  auth: AuthOption;
  heartbeat: { intervalMs: number; timeoutMs: number };
  reconnect: { baseDelayMs: number; maxDelayMs: number };
  /** The socket reached `open`. */
  onOpen(): void;
  /**
   * A decoded message other than `pong`. `frameBytes` is the raw frame's byte length, for load
   * progress (LLD Part 3 §5).
   */
  onMessage(msg: ServerMessage, frameBytes: number): void;
  /** A frame that failed to decode. `e` is a sanitized `PROTOCOL_INVALID_MESSAGE` error. */
  onDecodeError(e: unknown): void;
  /** A close the client did not start. The session applies the §16 policy. */
  onClosed(info: CloseInfo): CloseDecision;
  onState(s: ConnState): void;
  /** Injected in tests. */
  createSocket?: WebSocketFactory;
  /** Injected in tests, for seeded backoff. */
  random?: RandomSource;
  /** Injected in tests. */
  onlineTarget?: OnlineTarget | null;
}

/** The close code for a normal close (`destroy()`, reload). */
const NORMAL_CLOSE = 1000;
/** The code a dead link or a failed connect is reported with (LLD Part 3 §4, L12). */
const ABNORMAL_CLOSE = 1006;

const defaultFactory: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

/** Byte length of a string in UTF-8, without encoding it. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * Owns one WebSocket at a time (LLD Part 3 §4).
 *
 * Every socket has a generation number. Events from a socket that is no longer current are
 * ignored, so a late `close` from a replaced socket never reaches the session.
 */
export class Connection {
  readonly #deps: ConnectionDeps;
  readonly #createSocket: WebSocketFactory;
  readonly #random: RandomSource;
  readonly #onlineTarget: OnlineTarget | null;
  #state: ConnState = 'idle';
  #ws: WebSocketLike | null = null;
  #gen = 0;
  #everOpened = false;
  /** Failed attempts since the last reset, for backoff. */
  #attempt = 0;
  #lastError: ErrorMsg | undefined;
  #lastInbound = 0;
  #pingSentAt: number | null = null;
  #pingN = 0;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #waitTimer: ReturnType<typeof setTimeout> | undefined;
  #onlineListening = false;
  readonly #onOnline = (): void => {
    if (this.#state === 'waiting') this.#connectNow();
  };

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
    this.#createSocket = deps.createSocket ?? defaultFactory;
    this.#random = deps.random ?? Math.random;
    this.#onlineTarget =
      deps.onlineTarget !== undefined
        ? deps.onlineTarget
        : typeof globalThis.addEventListener === 'function'
          ? globalThis
          : null;
  }

  /** The current state. */
  get state(): ConnState {
    return this.#state;
  }

  /** The socket's `bufferedAmount`, or 0 without a socket (upload throttling, V4). */
  get bufferedAmount(): number {
    return this.#ws?.bufferedAmount ?? 0;
  }

  /** Opens the first socket. Does nothing unless the connection is `idle`. */
  start(): void {
    if (this.#state !== 'idle') return;
    this.#connectNow();
  }

  /**
   * Sends a message. Returns false when no socket is open; the caller keeps its state.
   *
   * @throws {OpenDocexError} `PROTOCOL_INVALID_MESSAGE` from `encodeMessage` for an oversized
   *   binary header.
   */
  send(msg: ClientMessage): boolean {
    if (this.#state !== 'open' || this.#ws === null) return false;
    this.#ws.send(encodeMessage(msg));
    return true;
  }

  /**
   * Closes the socket with 1000 and opens a new one at once, for a reload. `fresh` also resets
   * the backoff count. The old socket's close is not reported.
   */
  closeAndReconnect(fresh: boolean): void {
    if (this.#state === 'destroyed') return;
    if (fresh) this.#attempt = 0;
    this.#dropSocket(NORMAL_CLOSE);
    this.#connectNow();
  }

  /** Reconnects from `terminal`, with backoff reset. Does nothing in any other state. */
  retry(): void {
    if (this.#state !== 'terminal') return;
    this.#attempt = 0;
    this.#connectNow();
  }

  /**
   * Stops: closes the socket with 1000 and clears timers, then waits in `terminal` for
   * {@link retry}. Used when the session itself decides to stop. Addition to the LLD's
   * declared API, which has no other way into `terminal`.
   */
  terminate(): void {
    if (this.#state === 'destroyed') return;
    this.#dropSocket(NORMAL_CLOSE);
    this.#setState('terminal');
  }

  /**
   * Resets the backoff count. The session calls it once it reaches `live` (LLD Part 3 §4:
   * "attempt ← 0 once the session reaches live"). Addition to the LLD's declared API.
   */
  resetBackoff(): void {
    this.#attempt = 0;
  }

  /** Destroys: `ws.close(1000)` and every timer cleared. Calling it again does nothing. */
  close(): void {
    if (this.#state === 'destroyed') return;
    this.#dropSocket(NORMAL_CLOSE);
    this.#setState('destroyed');
  }

  // --- internals ------------------------------------------------------------------------------

  #setState(s: ConnState): void {
    if (this.#state === s) return;
    this.#state = s;
    this.#deps.onState(s);
  }

  #clearTimers(): void {
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    if (this.#waitTimer !== undefined) clearTimeout(this.#waitTimer);
    this.#heartbeatTimer = undefined;
    this.#waitTimer = undefined;
    if (this.#onlineListening) {
      this.#onlineTarget?.removeEventListener('online', this.#onOnline);
      this.#onlineListening = false;
    }
  }

  /** Invalidates the current socket, detaches it and closes it with `code` (or no code). */
  #dropSocket(code: number | undefined): void {
    this.#gen++;
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    this.#lastError = undefined;
    this.#pingSentAt = null;
    if (ws === null) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      if (code === undefined) ws.close();
      else ws.close(code);
    } catch {
      // A socket that can't be closed is already gone.
    }
  }

  #connectNow(): void {
    this.#clearTimers();
    this.#setState('connecting');
    void this.#open(++this.#gen);
  }

  async #open(gen: number): Promise<void> {
    const { url, documentId, auth } = this.#deps;
    let target: string;
    let protocols: string[] | undefined;
    try {
      const u = new URL(url);
      u.searchParams.set(DOC_QUERY_PARAM, documentId);
      // `getToken` runs on every connect so the adopter can refresh tokens (LLD choice).
      if (auth.type === 'query') u.searchParams.set(auth.param, await auth.getToken());
      if (auth.type === 'subprotocol') protocols = [WS_SUBPROTOCOL, await auth.getToken()];
      target = u.toString();
    } catch {
      // A failing `getToken` counts as a failed attempt. Its error is not reported: it may
      // hold adopter secrets.
      if (gen === this.#gen) this.#closed(gen, ABNORMAL_CLOSE, '', false);
      return;
    }
    if (gen !== this.#gen || this.#state !== 'connecting') return;
    let ws: WebSocketLike;
    try {
      ws = protocols === undefined ? this.#createSocket(target) : this.#createSocket(target, protocols);
    } catch {
      this.#closed(gen, ABNORMAL_CLOSE, '', false);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    this.#everOpened = false;
    this.#lastError = undefined;
    ws.onopen = () => {
      if (gen === this.#gen) this.#opened();
    };
    ws.onmessage = (ev) => {
      if (gen === this.#gen) this.#message(ev.data);
    };
    ws.onclose = (ev) => {
      if (gen === this.#gen) this.#closed(gen, ev.code, ev.reason, this.#everOpened);
    };
    ws.onerror = () => {
      // The browser always follows `error` with `close`.
    };
  }

  #opened(): void {
    this.#everOpened = true;
    this.#lastInbound = Date.now();
    this.#pingSentAt = null;
    this.#setState('open');
    this.#scheduleHeartbeat();
    this.#deps.onOpen();
  }

  #message(data: unknown): void {
    this.#lastInbound = Date.now();
    this.#pingSentAt = null;
    let frame: string | Uint8Array;
    let bytes: number;
    if (typeof data === 'string') {
      frame = data;
      bytes = utf8Length(data);
    } else if (data instanceof ArrayBuffer) {
      frame = new Uint8Array(data);
      bytes = frame.byteLength;
    } else if (data instanceof Uint8Array) {
      frame = data;
      bytes = data.byteLength;
    } else {
      this.#lastError = undefined;
      this.#deps.onDecodeError(new TypeError('Unsupported WebSocket frame.'));
      return;
    }
    const r = decodeServerMessage(frame);
    if (r.kind === 'ignored') return; // an unknown type is ignored (HLD §9)
    if (r.kind === 'invalid') {
      this.#lastError = undefined;
      this.#deps.onDecodeError(r.error);
      return;
    }
    const msg = r.message;
    this.#lastError = msg.type === 'error' ? msg : undefined;
    if (msg.type === 'pong') return; // the heartbeat answer stays internal
    this.#deps.onMessage(msg, bytes);
  }

  /** Arms the heartbeat for the next moment something is due. */
  #scheduleHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    const { intervalMs, timeoutMs } = this.#deps.heartbeat;
    const due = this.#pingSentAt !== null ? this.#pingSentAt + timeoutMs : this.#lastInbound + intervalMs;
    this.#heartbeatTimer = setTimeout(() => this.#heartbeatTick(), Math.max(0, due - Date.now()));
  }

  /**
   * Sends a `ping` only after `intervalMs` without inbound traffic. With no inbound within
   * `timeoutMs` of the ping, the link is dead: the socket is closed and reported as 1006 at
   * once, without waiting for the browser.
   */
  #heartbeatTick(): void {
    this.#heartbeatTimer = undefined;
    if (this.#state !== 'open' || this.#ws === null) return;
    const now = Date.now();
    const { intervalMs, timeoutMs } = this.#deps.heartbeat;
    if (this.#pingSentAt !== null) {
      if (now - this.#pingSentAt >= timeoutMs) {
        // `#closed` detaches the socket, calls `ws.close()` and reports 1006 now.
        this.#closed(this.#gen, ABNORMAL_CLOSE, '', true, true);
        return;
      }
    } else if (now - this.#lastInbound >= intervalMs) {
      this.send({ type: 'ping', n: ++this.#pingN });
      this.#pingSentAt = now;
    }
    this.#scheduleHeartbeat();
  }

  /** `deadLink`: the client closed the socket itself, so no `lastError` is reported. */
  #closed(gen: number, code: number, reason: string, everOpened: boolean, deadLink = false): void {
    const lastError = deadLink ? undefined : this.#lastError;
    this.#dropSocket(undefined);
    const info: CloseInfo = lastError === undefined ? { code, reason, everOpened } : { code, reason, everOpened, lastError };
    const decision = this.#deps.onClosed(info);
    // The session may have changed course from inside `onClosed` (destroy, terminate, retry).
    if (this.#gen !== gen + 1 || this.#state === 'destroyed' || this.#state === 'terminal') return;
    if (decision.action === 'terminal') {
      this.#setState('terminal');
    } else if (decision.action === 'reload') {
      this.#connectNow();
    } else {
      this.#wait(decision.minDelayMs);
    }
  }

  #wait(minDelayMs: number | undefined): void {
    const delay = backoffDelay(this.#attempt, this.#deps.reconnect, minDelayMs, this.#random);
    this.#attempt++;
    this.#setState('waiting');
    this.#waitTimer = setTimeout(() => {
      this.#waitTimer = undefined;
      if (this.#state === 'waiting') this.#connectNow();
    }, delay);
    if (this.#onlineTarget !== null) {
      this.#onlineTarget.addEventListener('online', this.#onOnline);
      this.#onlineListening = true;
    }
  }
}
