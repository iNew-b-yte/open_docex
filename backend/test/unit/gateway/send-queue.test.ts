// SendQueue (LLD Part 2 §4.3, HLD §11.4): accounting, order and the slow-consumer close, against a
// fake socket and a manual clock.
import { CloseCode } from '@open-docex/shared/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SendQueue, SLOW_CONSUMER_TERMINATE_MS, type SendSocket } from '../../../src/gateway/send-queue.js';
import { FakeClock } from '../supervisor/helpers.js';

/** A socket whose writes complete only when the test says so. */
class FakeSocket implements SendSocket {
  readonly sent: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  readonly callbacks: Array<(err?: Error) => void> = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  terminated = 0;
  throwOnSend = false;

  send(data: string | Uint8Array, options: { binary: boolean }, callback: (err?: Error) => void): void {
    if (this.throwOnSend) throw new Error('not open');
    this.sent.push({ data, binary: options.binary });
    this.callbacks.push(callback);
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
  terminate(): void {
    this.terminated++;
  }
  /** Completes the oldest write. */
  flushOne(err?: Error): void {
    this.callbacks.shift()?.(err);
  }
}

function make(hwm: number) {
  const ws = new FakeSocket();
  const clock = new FakeClock();
  const overflow = vi.fn();
  const q = new SendQueue(ws, hwm, overflow, clock);
  return { ws, clock, overflow, q };
}

describe('SendQueue', () => {
  it('hands frames to the socket in order, with the right binary flag', () => {
    const { ws, q } = make(1000);
    expect(q.push('a')).toBe(true);
    expect(q.push(new Uint8Array([1, 2]))).toBe(true);
    expect(q.push('b', { binary: true })).toBe(true);
    expect(ws.sent.map((s) => [typeof s.data === 'string' ? s.data : [...s.data], s.binary])).toEqual([
      ['a', false],
      [[1, 2], true],
      ['b', true],
    ]);
  });

  it('counts UTF-8 bytes, not characters, and shrinks pendingBytes when a write completes', () => {
    const { ws, q } = make(1000);
    q.push('ü'); // 2 bytes
    q.push(new Uint8Array(10));
    expect(q.pendingBytes).toBe(12);
    ws.flushOne();
    expect(q.pendingBytes).toBe(10);
    ws.flushOne();
    expect(q.pendingBytes).toBe(0);
  });

  it('calls onWritten once per frame, after the write, and not for a failed write', () => {
    const { ws, q } = make(1000);
    const ok = vi.fn();
    const failed = vi.fn();
    q.push('a', { onWritten: ok });
    q.push('b', { onWritten: failed });
    ws.flushOne();
    expect(ok).toHaveBeenCalledTimes(1);
    ws.flushOne(new Error('socket closed'));
    expect(failed).not.toHaveBeenCalled();
    expect(q.pendingBytes).toBe(0);
  });

  it('accepts a frame that lands exactly on the high-water mark', () => {
    const { q, overflow } = make(10);
    expect(q.push(new Uint8Array(4))).toBe(true);
    expect(q.push(new Uint8Array(6))).toBe(true);
    expect(overflow).not.toHaveBeenCalled();
    expect(q.closed).toBe(false);
  });

  it('closes with SESSION_SLOW_CONSUMER when the backlog would pass the mark', () => {
    const { ws, q, overflow } = make(10);
    q.push(new Uint8Array(6));
    expect(q.push(new Uint8Array(5))).toBe(false);
    expect(ws.closes).toEqual([{ code: CloseCode.SLOW_CONSUMER, reason: 'SESSION_SLOW_CONSUMER' }]);
    expect(CloseCode.SLOW_CONSUMER).toBe(4004);
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(q.closed).toBe(true);
    // The overflowing frame was not sent, and nothing more is accepted.
    expect(ws.sent).toHaveLength(1);
    expect(q.push('late')).toBe(false);
    expect(ws.sent).toHaveLength(1);
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it('terminates the socket after 5 s when the close handshake does not finish', async () => {
    const { ws, q, clock } = make(10);
    q.push(new Uint8Array(6));
    q.push(new Uint8Array(6));
    expect(SLOW_CONSUMER_TERMINATE_MS).toBe(5000);
    await clock.advance(4999);
    expect(ws.terminated).toBe(0);
    await clock.advance(1);
    expect(ws.terminated).toBe(1);
  });

  it('does not terminate when close() ran first (the socket closed by itself)', async () => {
    const { ws, q, clock } = make(10);
    q.push(new Uint8Array(6));
    q.push(new Uint8Array(6));
    q.close();
    await clock.advance(10_000);
    expect(ws.terminated).toBe(0);
  });

  it('lets one frame over the mark through when nothing else is waiting (a large asset is not a slow consumer)', () => {
    const { ws, q, overflow } = make(10);
    expect(q.push(new Uint8Array(100))).toBe(true);
    expect(overflow).not.toHaveBeenCalled();
    // ... but anything behind it overflows.
    expect(q.push('x')).toBe(false);
    expect(ws.closes).toHaveLength(1);
  });

  it('stops accepting after close()', () => {
    const { ws, q } = make(100);
    q.close();
    expect(q.push('a')).toBe(false);
    expect(ws.sent).toHaveLength(0);
    expect(ws.closes).toHaveLength(0);
  });

  it('treats a socket that throws on send as a failed push without leaking pending bytes', () => {
    const { ws, q } = make(100);
    ws.throwOnSend = true;
    expect(q.push('abc')).toBe(false);
    expect(q.pendingBytes).toBe(0);
  });
});
