// Test doubles for the Gateway tests: a recording EngineChannel, a recording logger, a real
// http server with a real `ws` client, and a resolved-options builder.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { OpenDocexError } from '@open-docex/shared/errors';
import { decodeServerMessage, type ServerMessage } from '@open-docex/shared/protocol';
import type { EngineEventMap } from '../../../src/api/events.js';
import type { ResolvedEngineOptions } from '../../../src/api/options.js';
import { TypedEmitter } from '../../../src/api/typed-emitter.js';
import type { EngineChannel } from '../../../src/channel/engine-channel.js';
import type { CoreEvent, CoreRequest } from '../../../src/channel/messages.js';
import { Gateway, type EngineState } from '../../../src/gateway/gateway.js';
import type { Logger, LogFields } from '../../../src/log/logger.js';
import { realClock, type Clock } from '../../../src/supervisor/supervisor.js';
import { DEFAULT_SUPERVISOR } from '../supervisor/helpers.js';

/** An EngineChannel that records `post`s and lets the test play the Core's events. */
export class FakeChannel implements EngineChannel {
  readonly posted: CoreRequest[] = [];
  readonly #handlers = new Set<(ev: CoreEvent) => void>();

  post(msg: CoreRequest): void {
    this.posted.push(msg);
  }
  call(): Promise<never> {
    return Promise.reject(new Error('FakeChannel.call is not used by the Gateway tests'));
  }
  request(): Promise<never> {
    return Promise.reject(new Error('FakeChannel.request is not used by the Gateway tests'));
  }
  onEvent(handler: (ev: CoreEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  onHook(): void {}

  /** Plays one Core event into the Gateway. */
  emit(ev: CoreEvent): void {
    for (const h of [...this.#handlers]) h(ev);
  }
  of<T extends CoreRequest['type']>(type: T): Array<Extract<CoreRequest, { type: T }>> {
    return this.posted.filter((m) => m.type === type) as Array<Extract<CoreRequest, { type: T }>>;
  }
  get handlerCount(): number {
    return this.#handlers.size;
  }
}

/** A logger that keeps every line, so a test can search it for secrets. */
export class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  #push(level: string, m: string, f?: LogFields): void {
    this.lines.push(`${level} ${m} ${f === undefined ? '' : JSON.stringify(f)}`);
  }
  debug(m: string, f?: LogFields): void {
    this.#push('debug', m, f);
  }
  info(m: string, f?: LogFields): void {
    this.#push('info', m, f);
  }
  warn(m: string, f?: LogFields): void {
    this.#push('warn', m, f);
  }
  error(m: string, f?: LogFields): void {
    this.#push('error', m, f);
  }
}

/** Resolved engine options for a Gateway test; `over` replaces top-level fields. */
export function gatewayOptions(over: Partial<ResolvedEngineOptions> = {}): ResolvedEngineOptions {
  return {
    mode: 'main',
    workerConfigModule: '/abs/worker.mjs',
    http: { path: '/open-docex' },
    authorize: () => null,
    supervisor: DEFAULT_SUPERVISOR,
    send: { highWaterMarkBytes: 8 * 1024 * 1024 },
    ws: { maxPayloadBytes: 1024 * 1024, pingIntervalMs: 30_000, helloTimeoutMs: 30_000 },
    logger: new RecordingLogger(),
    logLevel: 'debug',
    ...over,
  };
}

export interface GatewayHarness {
  server: Server;
  gateway: Gateway;
  channel: FakeChannel;
  errors: OpenDocexError[];
  logger: RecordingLogger;
  /** The engine state the Gateway sees. */
  setState(s: EngineState): void;
  url(path?: string): string;
  close(): Promise<void>;
}

/** Starts a Gateway on a real http server (port 0) with a fake channel. */
export async function startGateway(
  over: Partial<ResolvedEngineOptions> = {},
  o: { clock?: Clock; nextBackoffMs?: number; state?: EngineState; recordErrors?: boolean } = {},
): Promise<GatewayHarness> {
  const logger = new RecordingLogger();
  const opts = gatewayOptions({ logger, ...over });
  const emitter = new TypedEmitter<EngineEventMap>(logger);
  const errors: OpenDocexError[] = [];
  // Without a listener the emitter logs the event, which lets a test read what ends up in the log.
  if (o.recordErrors !== false) emitter.on('error', (e) => errors.push(e));
  const gateway = new Gateway(opts, emitter, logger, o.clock ?? realClock);
  const channel = new FakeChannel();
  let state: EngineState = o.state ?? 'running';
  gateway.bind(channel, () => state, () => o.nextBackoffMs ?? 0);
  const server = createServer();
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    gateway,
    channel,
    errors,
    logger,
    setState: (s) => {
      state = s;
    },
    url: (path = '/open-docex?doc=doc1') => `ws://127.0.0.1:${port}${path}`,
    async close() {
      gateway.closeAll(1001, 'test over');
      gateway.detach();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A connected (or failed) test client. */
export interface Client {
  ws: WebSocket;
  /** Every frame received, in order. */
  frames: Array<{ data: Buffer; binary: boolean }>;
  /** Text frames decoded as server messages. */
  messages(): ServerMessage[];
  /** Resolves with the close code and reason. */
  closed: Promise<{ code: number; reason: string }>;
  /** The HTTP status when the upgrade was refused; resolves on `open` with 101. */
  status: Promise<number>;
}

/** Opens a client. It never rejects: a refusal shows up in `status`. */
export function connect(url: string, protocols?: string[], headers?: Record<string, string>, extra: WebSocket.ClientOptions = {}): Client {
  const ws = new WebSocket(url, protocols, { headers: headers ?? {}, ...extra });
  const frames: Client['frames'] = [];
  ws.on('message', (data: Buffer, binary: boolean) => frames.push({ data, binary }));
  const status = new Promise<number>((resolve) => {
    ws.on('open', () => resolve(101));
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on('error', () => resolve(0));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString('utf8') }));
  });
  return {
    ws,
    frames,
    closed,
    status,
    messages() {
      return frames.flatMap((f) => {
        if (f.binary) return [];
        const r = decodeServerMessage(f.data.toString('utf8'));
        return r.kind === 'message' ? [r.message] : [];
      });
    },
  };
}

/** Polls until `cond()` is true. */
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The Core's `send` event for one text frame to some sessions. */
export function sendEvent(sessionIds: string[], data: string | Uint8Array, token?: number): CoreEvent {
  return {
    type: 'send',
    frames: [{ sessionIds, data, binary: typeof data !== 'string', ...(token !== undefined ? { token } : {}) }],
  };
}
