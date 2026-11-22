import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloseCode, WS_SUBPROTOCOL, type ErrorMsg } from '@open-docex/shared/protocol';
import type { DocumentId } from '@open-docex/shared/ids';
import { backoffDelay, fullJitter } from '../../src/net/backoff.js';
import { classifyClose, type CloseInfo } from '../../src/net/closeCodes.js';
import { Connection, type ConnectionDeps, type ConnState } from '../../src/net/Connection.js';
import type { AuthOption } from '../../src/options.js';
import { socketFactory } from './fake-socket.js';

const err = (code: ErrorMsg['code'], retryable: boolean, extra: Partial<ErrorMsg> = {}): ErrorMsg => ({
  type: 'error',
  code,
  retryable,
  message: 'x',
  ...extra,
});

describe('backoff (full jitter)', () => {
  it('stays within [0, min(max, base·2^attempt))', () => {
    expect(fullJitter(500, 30_000, 0, () => 0.999)).toBeCloseTo(499.5);
    expect(fullJitter(500, 30_000, 3, () => 0.5)).toBe(2000);
    expect(fullJitter(500, 30_000, 10, () => 0.999)).toBeCloseTo(29_970);
    expect(fullJitter(500, 30_000, 5000, () => 1 - Number.EPSILON)).toBeLessThan(30_000);
    expect(fullJitter(500, 30_000, 4, () => 0)).toBe(0);
  });

  it('respects minDelayMs', () => {
    const s = { baseDelayMs: 500, maxDelayMs: 30_000 };
    expect(backoffDelay(0, s, 5000, () => 0.5)).toBe(5000);
    expect(backoffDelay(6, s, 1000, () => 0.5)).toBe(15_000); // 500·64 capped at 30 000
    expect(backoffDelay(0, s, undefined, () => 0.5)).toBe(250);
  });

  it('jitters: different random draws give different delays', () => {
    const s = { baseDelayMs: 500, maxDelayMs: 30_000 };
    const seq = [0.1, 0.9];
    const a = backoffDelay(2, s, undefined, () => seq[0]!);
    const b = backoffDelay(2, s, undefined, () => seq[1]!);
    expect(a).not.toBe(b);
  });
});

describe('classifyClose (LLD Part 3 §4 table)', () => {
  const info = (code: number, extra: Partial<CloseInfo> = {}): CloseInfo => ({ code, reason: '', everOpened: true, ...extra });

  it.each([
    [1000, { action: 'terminal' }, 'SESSION_CLOSED'],
    [1001, { action: 'reconnect' }, undefined],
    [1006, { action: 'reconnect' }, undefined],
    [1008, { action: 'terminal' }, 'ACCESS_DENIED'],
    [1009, { action: 'reconnect' }, undefined],
    [1011, { action: 'reconnect' }, undefined],
    [1012, { action: 'reconnect' }, undefined],
    [1013, { action: 'reconnect', minDelayMs: 5000 }, undefined],
    [CloseCode.ENGINE_RESTARTING, { action: 'reconnect', minDelayMs: 1000 }, undefined],
    [CloseCode.ENGINE_UNAVAILABLE, { action: 'reconnect' }, undefined],
    [CloseCode.SLOW_CONSUMER, { action: 'reconnect' }, undefined],
    [4999, { action: 'reconnect' }, undefined],
  ])('close %i without lastError', (code, decision, errorCode) => {
    const c = classifyClose(info(code), 'live');
    expect(c.decision).toEqual(decision);
    expect(c.error?.code).toBe(errorCode);
  });

  it('1009 fails the in-flight asset upload', () => {
    expect(classifyClose(info(1009), 'live').failAsset).toBe(true);
  });

  it('lastError wins (C-8)', () => {
    expect(classifyClose(info(4004, { lastError: err('SESSION_SLOW_CONSUMER', true) }), 'live')).toMatchObject({
      decision: { action: 'reload' },
    });
    expect(classifyClose(info(4002, { lastError: err('ENGINE_UNAVAILABLE', false) }), 'live')).toMatchObject({
      decision: { action: 'terminal' },
      error: { code: 'ENGINE_UNAVAILABLE' },
    });
    expect(classifyClose(info(4008, { lastError: err('STORAGE_READ_FAILED', true) }), 'loading').decision).toEqual({
      action: 'reconnect',
    });
    expect(classifyClose(info(4001, { lastError: err('ENGINE_RESTARTING', true) }), 'live').decision).toEqual({
      action: 'reconnect',
      minDelayMs: 1000,
    });
    expect(
      classifyClose(info(1006, { lastError: err('ACCESS_DENIED', false, { clientSeq: 3 }) }), 'live'),
    ).toMatchObject({ decision: { action: 'reload' }, discard: true });
  });

  it('a lastError that does not end the connection gives way to the table', () => {
    expect(classifyClose(info(1000, { lastError: err('STORAGE_WRITE_FAILED', true) }), 'live')).toMatchObject({
      decision: { action: 'terminal' },
      error: { code: 'SESSION_CLOSED' },
    });
  });
});

describe('Connection', () => {
  let states: ConnState[];
  let onClosed: ReturnType<typeof vi.fn<ConnectionDeps['onClosed']>>;
  let onMessage: ReturnType<typeof vi.fn<ConnectionDeps['onMessage']>>;
  let onDecodeError: ReturnType<typeof vi.fn<ConnectionDeps['onDecodeError']>>;
  let onOpen: ReturnType<typeof vi.fn<ConnectionDeps['onOpen']>>;
  let online: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
    onClosed = vi.fn<ConnectionDeps['onClosed']>(() => ({ action: 'reconnect' }));
    onMessage = vi.fn<ConnectionDeps['onMessage']>();
    onDecodeError = vi.fn<ConnectionDeps['onDecodeError']>();
    onOpen = vi.fn<ConnectionDeps['onOpen']>();
    online = new EventTarget();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(auth: AuthOption = { type: 'cookie' }, random = () => 0.5) {
    const f = socketFactory();
    const c = new Connection({
      url: 'wss://example.test/odx?x=1',
      documentId: 'doc/1 ü' as DocumentId,
      auth,
      heartbeat: { intervalMs: 25_000, timeoutMs: 10_000 },
      reconnect: { baseDelayMs: 500, maxDelayMs: 30_000 },
      onOpen,
      onMessage,
      onDecodeError,
      onClosed,
      onState: (s) => states.push(s),
      createSocket: f.create,
      random,
      onlineTarget: online,
    });
    return { c, f };
  }

  it('sets the doc param and arraybuffer binary type (cookie auth: no protocols)', () => {
    const { c, f } = make();
    c.start();
    const ws = f.last();
    const u = new URL(ws.url);
    expect(u.searchParams.get('doc')).toBe('doc/1 ü');
    expect(u.searchParams.get('x')).toBe('1');
    expect(ws.protocols).toBeUndefined();
    expect(ws.binaryType).toBe('arraybuffer');
    expect(states).toEqual(['connecting']);
  });

  it("places a query token under the adopter's param name, and calls getToken on every connect", async () => {
    let n = 0;
    const getToken = vi.fn(() => `tok${++n}`);
    const { c, f } = make({ type: 'query', param: 'access_token', getToken });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(new URL(f.last().url).searchParams.get('access_token')).toBe('tok1');
    f.last().open();
    f.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(new URL(f.last().url).searchParams.get('access_token')).toBe('tok2');
  });

  it('offers [WS_SUBPROTOCOL, token] for subprotocol auth', async () => {
    const { c, f } = make({ type: 'subprotocol', getToken: () => Promise.resolve('secret') });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.last().protocols).toEqual([WS_SUBPROTOCOL, 'secret']);
    expect(f.last().url).not.toContain('secret');
  });

  it('a failing getToken counts as a never-opened 1006 and its error is not reported', async () => {
    const { c } = make({ type: 'subprotocol', getToken: () => Promise.reject(new Error('token=abc')) });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onClosed).toHaveBeenCalledWith({ code: 1006, reason: '', everOpened: false });
  });

  it('decodes messages, keeps pong internal, reports frame bytes and decode errors', () => {
    const { c, f } = make();
    c.start();
    const ws = f.last();
    ws.open();
    expect(onOpen).toHaveBeenCalledOnce();
    ws.receive({ type: 'pong', n: 1 });
    expect(onMessage).not.toHaveBeenCalled();
    ws.receive({ type: 'load-done', rev: 3 });
    expect(onMessage).toHaveBeenCalledWith({ type: 'load-done', rev: 3 }, '{"type":"load-done","rev":3}'.length);
    ws.receiveRaw('{"type":"some-future-type"}');
    expect(onMessage).toHaveBeenCalledOnce();
    ws.receiveRaw('not json');
    expect(onDecodeError).toHaveBeenCalledOnce();
  });

  it('send() returns false unless open', () => {
    const { c, f } = make();
    expect(c.send({ type: 'ping', n: 1 })).toBe(false);
    c.start();
    expect(c.send({ type: 'ping', n: 1 })).toBe(false);
    f.last().open();
    expect(c.send({ type: 'ping', n: 1 })).toBe(true);
    expect(f.last().messages).toEqual([{ type: 'ping', n: 1 }]);
  });

  it('sends ping only when idle, and declares a dead link after timeoutMs as 1006', () => {
    const { c, f } = make();
    c.start();
    const ws = f.last();
    ws.open();
    vi.advanceTimersByTime(20_000);
    ws.receive({ type: 'load-done', rev: 1 }); // inbound traffic postpones the ping
    vi.advanceTimersByTime(20_000);
    expect(ws.messages).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(ws.messages).toEqual([{ type: 'ping', n: 1 }]);
    ws.receive({ type: 'pong', n: 1 });
    vi.advanceTimersByTime(24_999);
    expect(ws.messages).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ws.messages).toHaveLength(2);
    vi.advanceTimersByTime(9_999);
    expect(onClosed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClosed).toHaveBeenCalledWith({ code: 1006, reason: '', everOpened: true });
    expect(ws.closedWith).not.toBeNull();
    expect(c.state).toBe('waiting');
  });

  it('reports a server close with lastError and reconnects after a jittered backoff', () => {
    const draws = [0.25, 0.75, 0.5];
    let i = 0;
    const { c, f } = make({ type: 'cookie' }, () => draws[i++ % draws.length]!);
    c.start();
    f.last().open();
    f.last().receive({ type: 'error', code: 'ENGINE_RESTARTING', retryable: true, message: 'x' });
    f.last().serverClose(4001, 'ENGINE_RESTARTING');
    expect(onClosed.mock.calls[0]![0]).toMatchObject({ code: 4001, everOpened: true, lastError: { code: 'ENGINE_RESTARTING' } });
    // attempt 0: random 0.25 × min(30 000, 500) = 125 ms.
    expect(c.state).toBe('waiting');
    vi.advanceTimersByTime(124);
    expect(f.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(f.sockets).toHaveLength(2);
    // attempt 1: random 0.75 × 1000 = 750 ms.
    f.last().reject();
    expect(onClosed.mock.calls[1]![0]).toEqual({ code: 1006, reason: '', everOpened: false });
    vi.advanceTimersByTime(749);
    expect(f.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(f.sockets).toHaveLength(3);
  });

  it('honours minDelayMs, and resetBackoff() restarts at attempt 0', () => {
    onClosed.mockReturnValue({ action: 'reconnect', minDelayMs: 1000 });
    const { c, f } = make();
    c.start();
    f.last().reject();
    vi.advanceTimersByTime(999);
    expect(f.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(f.sockets).toHaveLength(2);
    onClosed.mockReturnValue({ action: 'reconnect' });
    f.last().reject(); // attempt 1: 0.5 × 1000
    c.resetBackoff();
    vi.advanceTimersByTime(500);
    expect(f.sockets).toHaveLength(3);
    f.last().reject(); // attempt 0 again: 0.5 × 500
    vi.advanceTimersByTime(250);
    expect(f.sockets).toHaveLength(4);
  });

  it('the online event short-circuits the wait', () => {
    onClosed.mockReturnValue({ action: 'reconnect', minDelayMs: 60_000 });
    const { c, f } = make();
    c.start();
    f.last().reject();
    expect(c.state).toBe('waiting');
    online.dispatchEvent(new Event('online'));
    expect(f.sockets).toHaveLength(2);
    expect(c.state).toBe('connecting');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminal decision stops; retry() reconnects', () => {
    onClosed.mockReturnValue({ action: 'terminal' });
    const { c, f } = make();
    c.start();
    f.last().reject();
    expect(c.state).toBe('terminal');
    vi.advanceTimersByTime(120_000);
    expect(f.sockets).toHaveLength(1);
    c.retry();
    expect(f.sockets).toHaveLength(2);
    expect(c.state).toBe('connecting');
  });

  it('reload decision and closeAndReconnect reconnect at once; the old close is not reported', () => {
    onClosed.mockReturnValue({ action: 'reload' });
    const { c, f } = make();
    c.start();
    f.last().open();
    f.last().serverClose(4004);
    expect(f.sockets).toHaveLength(2);
    f.last().open();
    const old = f.last();
    c.closeAndReconnect(true);
    expect(old.closedWith).toEqual({ code: 1000 });
    old.serverClose(1000);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(f.sockets).toHaveLength(3);
  });

  it('close() closes with 1000, clears every timer and ignores later events', () => {
    const { c, f } = make();
    c.start();
    f.last().open();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    c.close();
    expect(f.last().closedWith).toEqual({ code: 1000 });
    expect(vi.getTimerCount()).toBe(0);
    expect(c.state).toBe('destroyed');
    f.last().serverClose(1006);
    expect(onClosed).not.toHaveBeenCalled();
    c.close();
    expect(states.filter((s) => s === 'destroyed')).toHaveLength(1);
  });

  it('close() while waiting clears the backoff timer and the online listener', () => {
    const { c, f } = make();
    c.start();
    f.last().reject();
    expect(vi.getTimerCount()).toBe(1);
    c.close();
    expect(vi.getTimerCount()).toBe(0);
    online.dispatchEvent(new Event('online'));
    expect(f.sockets).toHaveLength(1);
  });
});
