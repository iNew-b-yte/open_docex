// Gateway (LLD Part 2 §4, HLD §6, §10, §14) on a real http server with real `ws` clients and a fake
// EngineChannel standing in for the Core. The Core side is covered by the integration smoke tests.
import { OpenDocexError } from '@open-docex/shared/errors';
import type { ClientId, Epoch } from '@open-docex/shared/ids';
import { CloseCode, WS_SUBPROTOCOL } from '@open-docex/shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizeContext, AuthorizeResult, Session } from '../../../src/api/options.js';
import { FakeClock, flush } from '../supervisor/helpers.js';
import { connect, sendEvent, startGateway, until, type GatewayHarness } from './helpers.js';

const OK: AuthorizeResult = { userId: 'alice', access: 'edit', document: { ref: 'doc1.docx', format: 'docx' } };
const CID = 'AAAAAAAAAAAAAAAAAAAAAA' as ClientId;
const EPOCH = 'BBBBBBBBBBBBBBBBBBBBBB' as Epoch;

const hello = (): string => JSON.stringify({ type: 'hello', protocol: 1, clientId: CID });
const submit = (clientSeq: number): string =>
  JSON.stringify({ type: 'submit', clientId: CID, clientSeq, epoch: EPOCH, baseRev: 0, ops: [{ stepType: 'x' }] });
const text = (b: Uint8Array): string => Buffer.from(b).toString('utf8');

let harness: GatewayHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(...args: Parameters<typeof startGateway>): Promise<GatewayHarness> {
  harness = await startGateway(...args);
  return harness;
}

/** Opens a session and waits until the Gateway told the Core about it. */
async function open(h: GatewayHarness, url?: string) {
  const c = connect(h.url(url));
  expect(await c.status).toBe(101);
  await until(() => h.channel.of('join').length > 0);
  const join = h.channel.of('join').at(-1);
  if (join === undefined) throw new Error('no join');
  return { c, sessionId: join.sessionId };
}

describe('Gateway upgrade: authorize and the reject matrix', () => {
  it('passes the request, the URL, the document id and purpose "document" to authorize', async () => {
    let seen: AuthorizeContext | undefined;
    const h = await start({
      authorize: (ctx) => {
        seen = ctx;
        return OK;
      },
    });
    const c = connect(h.url('/open-docex?doc=my%20doc&x=1'), undefined, { 'x-test': 'yes' });
    expect(await c.status).toBe(101);
    expect(seen?.purpose).toBe('document');
    expect(seen?.documentId).toBe('my doc');
    expect(seen?.url.searchParams.get('x')).toBe('1');
    expect(seen?.request.headers['x-test']).toBe('yes');
  });

  it('refuses with 403 when authorize returns null, and never reaches the Core', async () => {
    const h = await start({ authorize: () => null });
    expect(await connect(h.url()).status).toBe(403);
    expect(h.channel.posted).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it.each([401, 403] as const)('refuses with %i for { deny: %i }', async (status) => {
    const h = await start({ authorize: () => ({ deny: status }) });
    expect(await connect(h.url()).status).toBe(status);
    expect(h.errors).toEqual([]);
  });

  it('accepts an async authorize', async () => {
    const h = await start({ authorize: () => Promise.resolve(OK) });
    expect(await connect(h.url()).status).toBe(101);
  });

  it.each([
    ['a deny that is not 401 or 403', () => ({ deny: 500 })],
    ['a string deny', () => ({ deny: '401' })],
    ['undefined', () => undefined as never],
    ['an unknown access', () => ({ ...OK, access: 'admin' }) as never],
    ['a missing userId', () => ({ access: 'edit', document: OK.document }) as never],
    ['an unknown format', () => ({ ...OK, document: { ref: 'x', format: 'pdf' } }) as never],
    ['a rejected promise value that is not a result', () => Promise.resolve('yes') as never],
  ])('answers 500 and emits CONFIG_INVALID for %s', async (_name, authorize) => {
    const h = await start({ authorize: authorize as never });
    expect(await connect(h.url()).status).toBe(500);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(OpenDocexError);
    expect(h.errors[0]?.code).toBe('CONFIG_INVALID');
    expect(h.channel.posted).toEqual([]);
  });

  it('answers 500 and emits ACCESS_DENIED with the adopter error as cause when authorize throws', async () => {
    const boom = new Error('adopter bug');
    const h = await start({
      authorize: () => {
        throw boom;
      },
    });
    expect(await connect(h.url()).status).toBe(500);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('ACCESS_DENIED');
    expect(h.errors[0]?.cause).toBe(boom);
  });

  it('answers 500 for an async authorize that rejects', async () => {
    const h = await start({ authorize: () => Promise.reject(new Error('db down')) });
    expect(await connect(h.url()).status).toBe(500);
    expect(h.errors[0]?.code).toBe('ACCESS_DENIED');
  });

  it.each([
    ['no doc', '/open-docex'],
    ['an empty doc', '/open-docex?doc='],
    ['a control character', '/open-docex?doc=a%01b'],
    ['an overlong doc', `/open-docex?doc=${'d'.repeat(513)}`],
  ])('answers 400 without calling authorize: %s', async (_name, path) => {
    const authorize = vi.fn(() => OK);
    const h = await start({ authorize });
    expect(await connect(h.url(path)).status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('answers 503 with Retry-After while the Core restarts, before calling authorize', async () => {
    const authorize = vi.fn(() => OK);
    const h = await start({ authorize }, { state: 'restarting', nextBackoffMs: 2500 });
    const retryAfter = new Promise<string | undefined>((resolve) => {
      const ws = connect(h.url()).ws;
      ws.on('unexpected-response', (_req, res) => resolve(res.headers['retry-after']));
    });
    expect(await retryAfter).toBe('3');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('uses a Retry-After of at least 1 second', async () => {
    const h = await start({}, { state: 'starting', nextBackoffMs: 0 });
    const retryAfter = new Promise<string | undefined>((resolve) => {
      connect(h.url()).ws.on('unexpected-response', (_req, res) => resolve(res.headers['retry-after']));
    });
    expect(await retryAfter).toBe('1');
  });

  it('answers 503 when the state turned to restarting while authorize was running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const h = await start({
      authorize: async () => {
        await gate;
        return OK;
      },
    });
    const c = connect(h.url());
    await until(() => h.server.listenerCount('upgrade') > 0);
    await new Promise((r) => setTimeout(r, 30));
    h.setState('restarting');
    release();
    expect(await c.status).toBe(503);
    expect(h.channel.of('join')).toEqual([]);
  });

  it('answers 503 after stopAccepting()', async () => {
    const h = await start({ authorize: () => OK });
    h.gateway.stopAccepting();
    expect(await connect(h.url()).status).toBe(503);
  });

  it('in FAILED, authorizes first: an unauthenticated caller gets 403, an authorized one a 4002 close', async () => {
    let allow = false;
    const h = await start({ authorize: () => (allow ? OK : null) }, { state: 'failed' });
    expect(await connect(h.url()).status).toBe(403);
    allow = true;
    const c = connect(h.url());
    expect(await c.status).toBe(101);
    expect(await c.closed).toEqual({ code: CloseCode.ENGINE_UNAVAILABLE, reason: 'ENGINE_UNAVAILABLE' });
    expect(h.channel.of('join')).toEqual([]);
  });

  it('creates no session when the client left during authorize', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const h = await start({
      authorize: async () => {
        await gate;
        return OK;
      },
    });
    const c = connect(h.url());
    await new Promise((r) => setTimeout(r, 30));
    c.ws.terminate();
    await new Promise((r) => setTimeout(r, 30));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.channel.of('join')).toEqual([]);
    expect(h.gateway.countSessions('doc1' as never)).toEqual({ edit: 0, view: 0 });
  });

  it('leaves upgrades for other paths to other listeners', async () => {
    const authorize = vi.fn(() => OK);
    const h = await start({ authorize });
    const other: string[] = [];
    h.server.on('upgrade', (req, socket) => {
      if (req.url?.startsWith('/elsewhere')) {
        other.push(req.url);
        socket.write('HTTP/1.1 418 I\'m a teapot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
      }
    });
    expect(await connect(h.url('/elsewhere?doc=doc1')).status).toBe(418);
    expect(other).toEqual(['/elsewhere?doc=doc1']);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('selects only the open-docex subprotocol, whatever the order, and never echoes a token', async () => {
    const h = await start({ authorize: () => OK });
    const a = connect(h.url(), [WS_SUBPROTOCOL, 'tok-secret']);
    expect(await a.status).toBe(101);
    expect(a.ws.protocol).toBe(WS_SUBPROTOCOL);
    const b = connect(h.url(), ['tok-secret', WS_SUBPROTOCOL]);
    expect(await b.status).toBe(101);
    expect(b.ws.protocol).toBe(WS_SUBPROTOCOL);
    const c = connect(h.url(), ['tok-secret']);
    expect(await c.status).toBe(0); // the client refuses a server that selects none
  });

  it('does not negotiate permessage-deflate, whatever the client offers (no decompression bombs, no CPU in main)', async () => {
    const h = await start({ authorize: () => OK });
    const c = connect(h.url(), undefined, undefined, { perMessageDeflate: true });
    expect(await c.status).toBe(101);
    expect(c.ws.extensions).toBe('');
  });

  it('never logs tokens, headers or the query string', async () => {
    const authorizeThrows = vi.fn(() => {
      throw new Error('boom SECRET-IN-ERROR');
    });
    const h = await start({ authorize: authorizeThrows }, { recordErrors: false });
    await connect(h.url('/open-docex?doc=doc1&token=SECRET-QUERY'), ['SECRET-PROTO'], {
      authorization: 'Bearer SECRET-HEADER',
      cookie: 'sid=SECRET-COOKIE',
    }).status;
    await connect(h.url('/open-docex?doc=&token=SECRET-QUERY')).status;
    expect(h.logger.lines.join('\n')).not.toMatch(/SECRET/);
  });
});

describe('Gateway session: join, leave and forwarding', () => {
  it('posts join with the session and document, and leave when the client closes', async () => {
    const h = await start({ authorize: () => ({ ...OK, access: 'view', userId: 'bob' }) });
    const { c, sessionId } = await open(h);
    expect(h.channel.of('join')).toEqual([
      { type: 'join', sessionId, documentId: 'doc1', userId: 'bob', access: 'view', document: OK.document },
    ]);
    expect(h.gateway.countSessions('doc1' as never)).toEqual({ edit: 0, view: 1 });
    c.ws.close(1000);
    await c.closed;
    await until(() => h.channel.of('leave').length > 0);
    expect(h.channel.of('leave')).toEqual([{ type: 'leave', sessionId, reason: 'client-closed' }]);
    expect(h.gateway.countSessions('doc1' as never)).toEqual({ edit: 0, view: 0 });
  });

  it('forwards frames to the Core byte for byte, without parsing them', async () => {
    const h = await start({ authorize: () => OK });
    const { c, sessionId } = await open(h);
    const inputs = ['not json at all {', '{"type":"submit"', hello(), '{"type":"from-the-future","x":[1,2,3]}', ''];
    for (const t of inputs) c.ws.send(t);
    const bin = new Uint8Array([0xd0, 1, 0, 0, 0, 2, 123, 125, 255, 0]);
    c.ws.send(bin);
    await until(() => h.channel.of('frame').length === inputs.length + 1);
    const frames = h.channel.of('frame');
    expect(frames.map((f) => f.sessionId)).toEqual(Array(inputs.length + 1).fill(sessionId));
    expect(frames.slice(0, inputs.length).map((f) => [text(f.data), f.binary])).toEqual(inputs.map((t) => [t, false]));
    expect(frames[inputs.length]?.binary).toBe(true);
    expect([...(frames[inputs.length]?.data ?? [])]).toEqual([...bin]);
  });

  it('delivers the Core\'s send events to the right sessions, in order', async () => {
    const h = await start({ authorize: () => OK });
    const one = await open(h);
    const two = await open(h);
    h.channel.emit(sendEvent([one.sessionId], 'a'));
    h.channel.emit(sendEvent([one.sessionId, two.sessionId], 'b'));
    h.channel.emit(sendEvent([two.sessionId], new Uint8Array([7, 8, 9])));
    h.channel.emit(sendEvent(['unknown-session'], 'ignored'));
    await until(() => one.c.frames.length === 2 && two.c.frames.length === 2);
    expect(one.c.frames.map((f) => text(f.data))).toEqual(['a', 'b']);
    expect(two.c.frames.map((f) => [f.binary, [...f.data]])).toEqual([
      [false, [...Buffer.from('b')]],
      [true, [7, 8, 9]],
    ]);
  });

  it('answers a frame that carries a token with `written` once it left the socket', async () => {
    const h = await start({ authorize: () => OK });
    const { c, sessionId } = await open(h);
    h.channel.emit(sendEvent([sessionId], 'chunk', 41));
    h.channel.emit(sendEvent([sessionId], 'no token'));
    await until(() => h.channel.of('written').length === 1);
    expect(h.channel.of('written')).toEqual([{ type: 'written', sessionId, token: 41 }]);
    expect(c.frames.length).toBeGreaterThan(0);
  });

  it('closes a session the Core asks to close, and tells the Core it left', async () => {
    const h = await start({ authorize: () => OK });
    const { c, sessionId } = await open(h);
    h.channel.emit({ type: 'close', sessionIds: [sessionId], code: CloseCode.DOCUMENT_FAULTED, reason: 'DOCUMENT_FAULTED' });
    expect(await c.closed).toEqual({ code: 4006, reason: 'DOCUMENT_FAULTED' });
    expect(h.channel.of('leave').map((l) => l.sessionId)).toEqual([sessionId]);
  });

  it('keeps a session in the table only until it is gone (no frames reach the Core afterwards)', async () => {
    const h = await start({ authorize: () => OK });
    const { c } = await open(h);
    c.ws.close(1000);
    await c.closed;
    await until(() => h.channel.of('leave').length === 1);
    expect(h.gateway.countSessions('doc1' as never)).toEqual({ edit: 0, view: 0 });
  });
});

describe('Gateway limits', () => {
  it('closes with 1009 a frame over maxPayload (the asset-put size limit) and never forwards it', async () => {
    const h = await start({ authorize: () => OK, ws: { maxPayloadBytes: 1000, pingIntervalMs: 30_000, helloTimeoutMs: 30_000 } });
    const { c } = await open(h);
    c.ws.send(hello());
    c.ws.send(new Uint8Array(2000));
    expect((await c.closed).code).toBe(1009);
    expect(h.channel.of('frame').map((f) => f.binary)).toEqual([false]);
    await until(() => h.channel.of('leave').length === 1);
  });

  it('accepts a frame exactly at maxPayload', async () => {
    const h = await start({ authorize: () => OK, ws: { maxPayloadBytes: 1000, pingIntervalMs: 30_000, helloTimeoutMs: 30_000 } });
    const { c } = await open(h);
    c.ws.send(new Uint8Array(1000));
    await until(() => h.channel.of('frame').length === 1);
    expect(h.channel.of('frame')[0]?.data.byteLength).toBe(1000);
  });

  it('closes a client that never sends a first frame with PROTOCOL_INVALID_MESSAGE (4007)', async () => {
    const h = await start({ authorize: () => OK, ws: { maxPayloadBytes: 1000, pingIntervalMs: 30_000, helloTimeoutMs: 60 } });
    const { c } = await open(h);
    expect(await c.closed).toEqual({ code: 4007, reason: 'PROTOCOL_INVALID_MESSAGE' });
    expect(c.messages()).toMatchObject([{ type: 'error', code: 'PROTOCOL_INVALID_MESSAGE' }]);
    expect(h.channel.of('leave')).toHaveLength(1);
  });

  it('keeps a client that sent a first frame in time', async () => {
    const h = await start({ authorize: () => OK, ws: { maxPayloadBytes: 1000, pingIntervalMs: 30_000, helloTimeoutMs: 60 } });
    const { c } = await open(h);
    c.ws.send(hello());
    await new Promise((r) => setTimeout(r, 200));
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });
});

describe('Gateway slow consumer (HLD §11.4)', () => {
  it('closes with SESSION_SLOW_CONSUMER (4004) when the backlog passes the high-water mark', async () => {
    const h = await start({ authorize: () => OK, send: { highWaterMarkBytes: 100 } });
    const { c, sessionId } = await open(h);
    // Both frames arrive in one turn, so the first is still unwritten when the second is queued.
    h.channel.emit({
      type: 'send',
      frames: [
        { sessionIds: [sessionId], data: 'x'.repeat(80), binary: false },
        { sessionIds: [sessionId], data: 'y'.repeat(80), binary: false },
      ],
    });
    expect(await c.closed).toEqual({ code: 4004, reason: 'SESSION_SLOW_CONSUMER' });
    await until(() => h.channel.of('leave').length > 0);
    // The ws 'close' event that follows must not post a second leave.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.channel.of('leave')).toEqual([{ type: 'leave', sessionId, reason: 'slow-consumer' }]);
    expect(h.gateway.countSessions('doc1' as never)).toEqual({ edit: 0, view: 0 });
    // The queue is closed: later frames for the session are dropped quietly.
    h.channel.emit(sendEvent([sessionId], 'late'));
  });

  it('does not close a consumer that keeps up', async () => {
    const h = await start({ authorize: () => OK, send: { highWaterMarkBytes: 100 } });
    const { c, sessionId } = await open(h);
    for (let i = 0; i < 20; i++) {
      h.channel.emit(sendEvent([sessionId], 'z'.repeat(60)));
      await until(() => c.frames.length === i + 1);
    }
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });
});

describe('Gateway canSubmit (LLD §4.3)', () => {
  it('does not call canSubmit or parse frames when it is not configured', async () => {
    const h = await start({ authorize: () => OK });
    const { c } = await open(h);
    c.ws.send(submit(1));
    await until(() => h.channel.of('frame').length === 1);
    expect(h.errors).toEqual([]);
  });

  it('answers a denied submit with ACCESS_DENIED and its clientSeq, and does not forward it', async () => {
    const canSubmit = vi.fn(() => false);
    const h = await start({ authorize: () => OK, canSubmit });
    const { c } = await open(h);
    c.ws.send(submit(7));
    await until(() => c.frames.length === 1);
    expect(c.messages()).toEqual([
      { type: 'error', code: 'ACCESS_DENIED', retryable: false, message: expect.any(String) as string, clientSeq: 7 },
    ]);
    expect(h.channel.of('frame')).toEqual([]);
    // The connection stays open.
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });

  it('forwards an allowed submit unchanged', async () => {
    const h = await start({ authorize: () => OK, canSubmit: () => true });
    const { c } = await open(h);
    c.ws.send(submit(1));
    await until(() => h.channel.of('frame').length === 1);
    expect(text(h.channel.of('frame')[0]?.data ?? new Uint8Array())).toBe(submit(1));
    expect(c.frames).toEqual([]);
  });

  it('accepts an async canSubmit and treats anything but true as a denial', async () => {
    let answer: unknown = true;
    const h = await start({ authorize: () => OK, canSubmit: (() => Promise.resolve(answer)) as never });
    const { c } = await open(h);
    c.ws.send(submit(1));
    await until(() => h.channel.of('frame').length === 1);
    for (const bad of [false, undefined, 'yes', 1, null]) {
      answer = bad;
      c.ws.send(submit(2));
    }
    await until(() => c.messages().length === 5);
    expect(h.channel.of('frame')).toHaveLength(1);
  });

  it('treats a throwing canSubmit as a denial and emits an ACCESS_DENIED error with the cause', async () => {
    const boom = new Error('policy service down');
    const h = await start({
      authorize: () => OK,
      canSubmit: () => {
        throw boom;
      },
    });
    const { c } = await open(h);
    c.ws.send(submit(3));
    await until(() => c.frames.length === 1);
    expect(c.messages()[0]).toMatchObject({ type: 'error', code: 'ACCESS_DENIED', clientSeq: 3 });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('ACCESS_DENIED');
    expect(h.errors[0]?.cause).toBe(boom);
    expect(h.channel.of('frame')).toEqual([]);
  });

  it('hands canSubmit a read-only session view without the socket', async () => {
    const seen: Session[] = [];
    const h = await start({
      authorize: () => ({ ...OK, userId: 'carol', access: 'view' }),
      canSubmit: (s) => {
        seen.push(s);
        return true;
      },
    });
    const { c, sessionId } = await open(h);
    c.ws.send(submit(1));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ id: sessionId, documentId: 'doc1', userId: 'carol', access: 'view', openedAt: expect.any(Number) as number });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.keys(seen[0] ?? {})).not.toContain('ws');
  });

  it('gates only submit: other messages, undecodable text and binary frames pass without a call', async () => {
    const canSubmit = vi.fn(() => false);
    const h = await start({ authorize: () => OK, canSubmit });
    const { c } = await open(h);
    const ping = JSON.stringify({ type: 'ping', n: 1 });
    c.ws.send(hello());
    c.ws.send(ping);
    c.ws.send('}{ not json');
    c.ws.send(JSON.stringify({ type: 'submit', clientSeq: 'bad' })); // invalid submit: the Core reports it
    c.ws.send(new Uint8Array([0xd0, 1, 2]));
    await until(() => h.channel.of('frame').length === 5);
    expect(canSubmit).not.toHaveBeenCalled();
    expect(h.channel.of('frame').map((f) => f.binary)).toEqual([false, false, false, false, true]);
  });

  it('keeps per-session frame order while canSubmit awaits', async () => {
    const delays = [80, 0, 30];
    let call = 0;
    const h = await start({
      authorize: () => OK,
      canSubmit: async () => {
        await new Promise((r) => setTimeout(r, delays[call++] ?? 0));
        return true;
      },
    });
    const { c } = await open(h);
    const ping = JSON.stringify({ type: 'ping', n: 9 });
    c.ws.send(submit(1)); // slow
    c.ws.send(ping); //      would overtake without the chain
    c.ws.send(submit(2));
    c.ws.send(ping);
    await until(() => h.channel.of('frame').length === 4);
    expect(h.channel.of('frame').map((f) => text(f.data))).toEqual([submit(1), ping, submit(2), ping]);
  });

  it('drops a frame whose session left while canSubmit was awaiting', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const h = await start({
      authorize: () => OK,
      canSubmit: async () => {
        await gate;
        return true;
      },
    });
    const { c } = await open(h);
    c.ws.send(submit(1));
    await new Promise((r) => setTimeout(r, 30));
    c.ws.close(1000);
    await c.closed;
    await until(() => h.channel.of('leave').length === 1);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.channel.of('frame')).toEqual([]);
  });

  it("does not let one session's slow canSubmit delay another session", async () => {
    let user = 'alice';
    const h = await start({
      authorize: () => ({ ...OK, userId: user }),
      canSubmit: async (s) => {
        if (s.userId === 'alice') await new Promise((r) => setTimeout(r, 200));
        return true;
      },
    });
    const alice = await open(h);
    user = 'bob';
    const bob = await open(h);
    alice.c.ws.send(submit(1));
    bob.c.ws.send(submit(2));
    await until(() => h.channel.of('frame').length === 2);
    expect(h.channel.of('frame').map((f) => f.sessionId)).toEqual([bob.sessionId, alice.sessionId]);
  });
});

describe('Gateway when the Core goes down (LLD §4.4, HLD §10.5)', () => {
  it('restarting: every client gets an engine-restarting notice, then close code 4001, and the table is cleared', async () => {
    const h = await start({ authorize: () => OK });
    const one = await open(h);
    const two = await open(h);
    h.setState('restarting');
    h.gateway.onCoreDown('restarting');
    const [c1, c2] = await Promise.all([one.c.closed, two.c.closed]);
    expect(c1).toEqual({ code: 4001, reason: 'ENGINE_RESTARTING' });
    expect(c2).toEqual({ code: 4001, reason: 'ENGINE_RESTARTING' });
    expect(one.c.messages()).toEqual([{ type: 'notice', notice: 'engine-restarting' }]);
    expect(h.gateway.countSessions('doc1' as never)).toEqual({ edit: 0, view: 0 });
    // The Core is gone, so nothing is told about the leaving sessions.
    expect(h.channel.of('leave')).toEqual([]);
    // New upgrades wait for the Core.
    expect(await connect(h.url()).status).toBe(503);
  });

  it('failed: every client gets close code 4002 (no restarting notice)', async () => {
    const h = await start({ authorize: () => OK });
    const one = await open(h);
    h.setState('failed');
    h.gateway.onCoreDown('failed');
    expect(await one.c.closed).toEqual({ code: 4002, reason: 'ENGINE_UNAVAILABLE' });
    expect(one.c.messages()).toEqual([]);
  });
});

describe('Gateway admin close, shutdown and detach', () => {
  it('closes only the matching sessions with SESSION_CLOSED (4005) and returns how many', async () => {
    let user = 'alice';
    const h = await start({ authorize: () => ({ ...OK, userId: user }) });
    const a1 = await open(h);
    const a2 = await open(h);
    user = 'bob';
    const b = await open(h);
    expect(h.gateway.closeSessions({ userId: 'alice' }, CloseCode.SESSION_CLOSED, 'SESSION_CLOSED')).toBe(2);
    expect(await a1.c.closed).toEqual({ code: 4005, reason: 'SESSION_CLOSED' });
    expect(await a2.c.closed).toEqual({ code: 4005, reason: 'SESSION_CLOSED' });
    expect(b.c.ws.readyState).toBe(b.c.ws.OPEN);
    expect(h.channel.of('leave').map((l) => [l.sessionId, l.reason]).sort()).toEqual(
      [a1.sessionId, a2.sessionId].map((id) => [id, 'admin']).sort(),
    );
    expect(h.gateway.countSessions('doc1' as never)).toEqual({ edit: 1, view: 0 });
  });

  it('closes nothing for a filter that matches nothing', async () => {
    const h = await start({ authorize: () => OK });
    await open(h);
    expect(h.gateway.closeSessions({ userId: 'nobody' }, 4005, 'SESSION_CLOSED')).toBe(0);
    expect(h.gateway.closeSessions({}, 4005, 'SESSION_CLOSED')).toBe(0);
  });

  it('closeAll closes every session and tells the Core they left because of shutdown', async () => {
    const h = await start({ authorize: () => OK });
    const one = await open(h);
    h.gateway.closeAll(CloseCode.SESSION_CLOSED, 'SESSION_CLOSED');
    expect((await one.c.closed).code).toBe(4005);
    expect(h.channel.of('leave')).toEqual([{ type: 'leave', sessionId: one.sessionId, reason: 'shutdown' }]);
  });

  it('detach removes the upgrade listener and the channel subscription', async () => {
    const h = await start({ authorize: () => OK });
    expect(h.server.listenerCount('upgrade')).toBe(1);
    expect(h.channel.handlerCount).toBe(1);
    h.gateway.detach();
    expect(h.server.listenerCount('upgrade')).toBe(0);
    expect(h.channel.handlerCount).toBe(0);
  });

  it('attaches to several servers, and once per server', async () => {
    const h = await start({ authorize: () => OK });
    const { createServer } = await import('node:http');
    const second = createServer();
    h.gateway.attach(second);
    h.gateway.attach(second);
    h.gateway.attach(h.server);
    expect(second.listenerCount('upgrade')).toBe(1);
    expect(h.server.listenerCount('upgrade')).toBe(1);
    h.gateway.detach();
    expect(second.listenerCount('upgrade')).toBe(0);
    second.close();
  });
});

describe('Gateway dead-connection ping (LLD §4.3)', () => {
  const ws = { maxPayloadBytes: 1000, pingIntervalMs: 1000, helloTimeoutMs: 30_000 };

  it('terminates a client that never answers a ping', async () => {
    const clock = new FakeClock();
    const h = await start({ authorize: () => OK, ws }, { clock });
    const c = connect(h.url(), undefined, undefined, { autoPong: false });
    expect(await c.status).toBe(101);
    let pings = 0;
    c.ws.on('ping', () => pings++);
    await until(() => h.channel.of('join').length === 1);
    await clock.advance(1000); // ping sent, alive = false
    await until(() => pings === 1);
    await clock.advance(1000); // still no pong: terminated
    expect((await c.closed).code).toBe(1006);
  });

  it('keeps a client that answers', async () => {
    const clock = new FakeClock();
    const h = await start({ authorize: () => OK, ws }, { clock });
    const c = connect(h.url());
    expect(await c.status).toBe(101);
    let pings = 0;
    c.ws.on('ping', () => pings++);
    await until(() => h.channel.of('join').length === 1);
    for (let round = 1; round <= 3; round++) {
      await clock.advance(1000);
      await until(() => pings === round);
      await new Promise((r) => setTimeout(r, 40)); // the pong travels back
      await flush();
    }
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });
});

describe('Gateway session ids', () => {
  it('uses a distinct UUID per session', async () => {
    const h = await start({ authorize: () => OK });
    const a = await open(h);
    const b = await open(h);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
