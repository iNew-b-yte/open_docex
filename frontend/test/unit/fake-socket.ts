/**
 * A fake browser WebSocket for the client net and session tests. It records what the client
 * sends and lets the test play the server.
 */
import { encodeMessage, type ClientMessage, type ServerMessage } from '@open-docex/shared/protocol';
import type { WebSocketFactory, WebSocketLike } from '../../src/net/Connection.js';

export class FakeWebSocket implements WebSocketLike {
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: { code: number | undefined } | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[] | undefined,
  ) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith ??= { code };
  }

  /** The decoded JSON messages the client sent. */
  get messages(): ClientMessage[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as ClientMessage);
  }

  // --- the server side ---

  open(): void {
    this.onopen?.({});
  }

  receive(msg: ServerMessage): void {
    const data = encodeMessage(msg);
    this.onmessage?.({ data: typeof data === 'string' ? data : data.buffer });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code: number, reason = ''): void {
    this.onclose?.({ code, reason });
  }

  /** A failed opening handshake: the browser reports 1006 without `open` (L12). */
  reject(): void {
    this.onerror?.({});
    this.onclose?.({ code: 1006, reason: '' });
  }
}

/** A factory that records every socket it creates. */
export function socketFactory(): { create: WebSocketFactory; sockets: FakeWebSocket[]; last(): FakeWebSocket } {
  const sockets: FakeWebSocket[] = [];
  return {
    sockets,
    create: (url, protocols) => {
      const ws = new FakeWebSocket(url, protocols);
      sockets.push(ws);
      return ws;
    },
    last: () => {
      const ws = sockets.at(-1);
      if (ws === undefined) throw new Error('no socket yet');
      return ws;
    },
  };
}
