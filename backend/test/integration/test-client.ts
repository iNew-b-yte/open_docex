// A small WebSocket test client for the integration tests: it speaks the open_docex protocol
// with the shared codec, keeps every server message, and waits for messages by predicate. It is
// a protocol driver, not a sync client: it never rebases anything, so tests send explicit
// `baseRev`s where they want concurrency.
//
// Waiting is done with `waitFor` from `test/wait-for.ts` only (load tolerance): there are no
// fixed sleeps and no time assertions.
import WebSocket from 'ws';
import { newClientId, type ClientId, type Epoch } from '@open-docex/shared/ids';
import {
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type AckMsg,
  type ClientMessage,
  type ErrorMsg,
  type LoadStartMsg,
  type ServerMessage,
} from '@open-docex/shared/protocol';
import { waitFor } from '../wait-for.js';

/** What a finished load looked like. */
export interface Loaded {
  start: LoadStartMsg;
  chunks: unknown[];
  /** The `load-chunk` messages as sent (`{ seq, data }`), for `assembleText`. */
  chunkMessages: Array<{ seq: number; data: unknown }>;
  doneRev: number;
  /** All chunk data as one JSON string, for `toContain` checks on the document text. */
  json: string;
}

/** How a connection ended. */
export interface CloseInfo {
  code: number;
  reason: string;
}

/** A message of type `T`. */
export type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** A predicate for `waitFor` that narrows to one message type. */
export const isType =
  <T extends ServerMessage['type']>(type: T) =>
  (m: ServerMessage): m is Of<T> =>
    m.type === type;

/** A connected client. */
export class TestClient {
  readonly ws: WebSocket;
  readonly clientId: ClientId;
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<CloseInfo>;
  /** Set when the socket has closed. */
  closeInfo: CloseInfo | undefined;
  /** The epoch of the latest `load-start`. */
  epoch: Epoch | undefined;
  /** The rev this client knows: from `load-done`, `ack` and `remote` (never moves back on an ack). */
  rev = 0;
  #clientSeq = 0;

  private constructor(ws: WebSocket, clientId: ClientId) {
    this.ws = ws;
    this.clientId = clientId;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const r = decodeServerMessage(isBinary ? new Uint8Array(data) : data.toString('utf8'));
      if (r.kind !== 'message') return;
      const m = r.message;
      this.messages.push(m);
      if (m.type === 'load-start') {
        this.epoch = m.epoch;
        // Like a real client, carry on after the highest clientSeq the server already holds.
        if (m.ackedClientSeq !== undefined) this.#clientSeq = Math.max(this.#clientSeq, m.ackedClientSeq);
      } else if (m.type === 'load-done') this.rev = m.rev;
      else if (m.type === 'ack') this.rev = Math.max(this.rev, m.rev);
      else if (m.type === 'remote') this.rev = Math.max(this.rev, m.fromRev + m.ops.length);
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code: number, reason: Buffer) => {
        this.closeInfo = { code, reason: reason.toString('utf8') };
        resolve(this.closeInfo);
      });
    });
  }

  /**
   * Opens a connection; rejects with the HTTP status when the upgrade is refused. `clientId`
   * reuses a client's identity on a new socket, as a reconnecting browser does.
   */
  static open(
    url: string,
    o: { protocols?: string[]; headers?: Record<string, string>; clientId?: ClientId } = {},
  ): Promise<TestClient> {
    const ws = new WebSocket(url, o.protocols ?? [WS_SUBPROTOCOL], { headers: o.headers ?? {} });
    const client = new TestClient(ws, o.clientId ?? newClientId());
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error(`upgrade refused: HTTP ${res.statusCode ?? 0}`));
      });
      ws.once('error', reject);
    });
  }

  /** Sends one protocol message. */
  send(msg: ClientMessage): void {
    this.ws.send(encodeMessage(msg));
  }

  /** The number of messages so far: a point to wait from (`waitFor(pred, { from })`). */
  mark(): number {
    return this.messages.length;
  }

  /**
   * Resolves with the first message that satisfies `pred`, from the start or from `o.from`
   * (see {@link mark}). Fails with the list of message types it did see.
   */
  async waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage) => m is T, o?: number | { from?: number }): Promise<T>;
  async waitFor(pred: (m: ServerMessage) => boolean, o?: number | { from?: number }): Promise<ServerMessage>;
  async waitFor(pred: (m: ServerMessage) => boolean, o?: number | { from?: number }): Promise<ServerMessage> {
    const from = typeof o === 'object' ? (o.from ?? 0) : 0;
    return waitFor(() => {
      const found = this.messages.slice(from).find(pred);
      if (found === undefined) throw new Error(`no matching message yet; got ${this.messages.slice(from).map((m) => m.type).join(',')}`);
      return found;
    });
  }

  /** Every message after `from` that satisfies `pred`. */
  all<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, from = 0): T[] {
    return this.messages.slice(from).filter(pred);
  }

  /** Waits for the socket to close and returns how. */
  async whenClosed(): Promise<CloseInfo> {
    return waitFor(() => {
      if (this.closeInfo === undefined) throw new Error('the socket is still open');
      return this.closeInfo;
    });
  }

  /** Sends `hello` (with `resume` when given) and does not wait. */
  sendHello(resume?: { epoch: Epoch; rev: number }): void {
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: this.clientId, ...(resume !== undefined ? { resume } : {}) });
  }

  /** Sends `hello` and waits for the whole load. */
  async hello(): Promise<Loaded> {
    const from = this.mark();
    this.sendHello();
    return this.loadedSince(from);
  }

  /** The first complete load (`load-start` … `load-done`) after message index `from`. */
  async loadedSince(from: number): Promise<Loaded> {
    const done = await this.waitFor(isType('load-done'), { from });
    const slice = this.messages.slice(from, this.messages.indexOf(done) + 1);
    const start = slice.find(isType('load-start'));
    if (start === undefined) throw new Error('load-done without a load-start');
    const chunkMessages = slice.flatMap((m) => (m.type === 'load-chunk' ? [{ seq: m.seq, data: m.data }] : []));
    const chunks = chunkMessages.map((c) => c.data);
    return { start, chunks, chunkMessages, doneRev: done.rev, json: JSON.stringify(chunks) };
  }

  /**
   * Sends a `submit` without waiting. `clientSeq`, `baseRev` and `epoch` default to the next
   * sequence number, the rev this client knows and its epoch. Returns the `clientSeq` used.
   */
  sendSubmit(ops: unknown[], o: { clientSeq?: number; baseRev?: number; epoch?: Epoch } = {}): number {
    const epoch = o.epoch ?? this.epoch;
    if (epoch === undefined) throw new Error('hello() first');
    const clientSeq = o.clientSeq ?? ++this.#clientSeq;
    if (o.clientSeq !== undefined) this.#clientSeq = Math.max(this.#clientSeq, o.clientSeq);
    this.send({ type: 'submit', clientId: this.clientId, clientSeq, epoch, baseRev: o.baseRev ?? this.rev, ops });
    return clientSeq;
  }

  /** The `ack` for `clientSeq` after message index `from`. */
  ackFor(clientSeq: number, from = 0): Promise<AckMsg> {
    return this.waitFor((m): m is AckMsg => m.type === 'ack' && m.clientSeq === clientSeq, { from });
  }

  /** The `error` for `clientSeq` after message index `from`. */
  errorFor(clientSeq: number, from = 0): Promise<ErrorMsg> {
    return this.waitFor((m): m is ErrorMsg => m.type === 'error' && m.clientSeq === clientSeq, { from });
  }

  /** Submits `ops` on top of the client's current rev and waits for the ack. */
  async submit(ops: unknown[]): Promise<AckMsg> {
    const from = this.mark();
    const clientSeq = this.sendSubmit(ops);
    return this.ackFor(clientSeq, from);
  }

  /** Closes the socket and waits for the close. */
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    } else {
      this.ws.close(1000);
    }
    await this.whenClosed();
  }
}
