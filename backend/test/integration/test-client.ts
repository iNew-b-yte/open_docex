// A small WebSocket test client for the integration smoke tests: it speaks the open_docex protocol
// with the shared codec, keeps every server message, and waits for messages by predicate.
import WebSocket from 'ws';
import { newClientId, type ClientId, type Epoch } from '@open-docex/shared/ids';
import {
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type AckMsg,
  type ClientMessage,
  type LoadStartMsg,
  type ServerMessage,
} from '@open-docex/shared/protocol';

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

/** A connected client. */
export class TestClient {
  readonly ws: WebSocket;
  readonly clientId: ClientId = newClientId();
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  epoch: Epoch | undefined;
  rev = 0;
  #clientSeq = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const r = decodeServerMessage(isBinary ? new Uint8Array(data) : data.toString('utf8'));
      if (r.kind === 'message') this.messages.push(r.message);
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString('utf8') }));
    });
  }

  /** Opens a connection; rejects with the HTTP status when the upgrade is refused. */
  static open(url: string, o: { protocols?: string[]; headers?: Record<string, string> } = {}): Promise<TestClient> {
    const ws = new WebSocket(url, o.protocols ?? [WS_SUBPROTOCOL], { headers: o.headers ?? {} });
    const client = new TestClient(ws);
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
    const data = encodeMessage(msg);
    this.ws.send(data);
  }

  /** Resolves with the first message (from the start, including past ones) that satisfies `pred`. */
  async waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage) => m is T, ms?: number): Promise<T>;
  async waitFor(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  async waitFor(pred: (m: ServerMessage) => boolean, ms = 10_000): Promise<ServerMessage> {
    const end = Date.now() + ms;
    for (;;) {
      const found = this.messages.find(pred);
      if (found !== undefined) return found;
      if (Date.now() > end) throw new Error(`no matching message in time; got ${this.messages.map((m) => m.type).join(',')}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Sends `hello` and waits for the whole load. */
  async hello(): Promise<Loaded> {
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: this.clientId });
    const done = await this.waitFor((m): m is Extract<ServerMessage, { type: 'load-done' }> => m.type === 'load-done');
    const start = this.messages.find((m): m is LoadStartMsg => m.type === 'load-start') as LoadStartMsg;
    const chunks = this.messages.flatMap((m) => (m.type === 'load-chunk' ? [m.data] : []));
    this.epoch = start.epoch;
    this.rev = done.rev;
    const chunkMessages = this.messages.flatMap((m) => (m.type === 'load-chunk' ? [{ seq: m.seq, data: m.data }] : []));
    return { start, chunks, chunkMessages, doneRev: done.rev, json: JSON.stringify(chunks) };
  }

  /** Submits `ops` on top of the client's current rev and waits for the ack. */
  async submit(ops: unknown[]): Promise<AckMsg> {
    if (this.epoch === undefined) throw new Error('hello() first');
    const clientSeq = ++this.#clientSeq;
    this.send({ type: 'submit', clientId: this.clientId, clientSeq, epoch: this.epoch, baseRev: this.rev, ops });
    const ack = await this.waitFor((m): m is AckMsg => m.type === 'ack' && m.clientSeq === clientSeq);
    this.rev = ack.rev;
    return ack;
  }

  /** Closes the socket and waits for the close. */
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close(1000);
    await this.closed;
  }
}
