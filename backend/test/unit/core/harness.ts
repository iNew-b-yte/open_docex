/**
 * Fakes and a harness for the Core unit tests (V1-15). The codec, flush scheduler, audit
 * emitter and channel sink are fakes; persistence, the memory queue and the dispatcher are real.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OpenDocexError } from '@open-docex/shared/errors';
import { asDocumentId, type ClientId, type DocumentId, type Epoch } from '@open-docex/shared/ids';
import {
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type FileFormat,
  type ServerMessage,
  type UnsupportedFinding,
} from '@open-docex/shared/protocol';
import { textSchema } from '@open-docex/shared/text';
import { vi } from 'vitest';
import type { AuditEvent, DocumentEvent } from '../../../src/api/events.js';
import type { WorkerConfig } from '../../../src/api/options.js';
import { resolveWorkerConfig } from '../../../src/api/validate-options.js';
import type { OutFrame } from '../../../src/channel/messages.js';
import type { CoreDeps } from '../../../src/core/document-instance.js';
import { DocumentInstanceFactory } from '../../../src/core/instance-factory.js';
import { DocumentRegistry } from '../../../src/core/registry.js';
import type { CodecImportResult, CodecSeam, CoreSink, FlushSeam, FlushTarget } from '../../../src/core/seams.js';
import { SessionDispatcher } from '../../../src/core/session-record.js';
import { noopLogger } from '../../../src/log/logger.js';
import { AssetStore } from '../../../src/persistence/asset-store.js';
import { Journal } from '../../../src/persistence/journal.js';
import { MetaStore } from '../../../src/persistence/meta-store.js';
import { SnapshotStore } from '../../../src/persistence/snapshot-store.js';
import { MemoryQueue } from '../../../src/queue/memory-queue.js';
import type { QueueAdapter } from '../../../src/queue/queue-adapter.js';
import { FakeStorage } from '../../../test-kit/storage/fake-storage.js';

/**
 * A readable test name as a well-formed client ID or epoch (22 base64url characters). Strings
 * that already have that length pass through, so real epochs are unchanged.
 */
export function cid(name: string): ClientId {
  return (name.length === 22 ? name : name.padEnd(22, '_')) as ClientId;
}

/** A text op that inserts `text` at `pos`. */
export function ins(pos: number, text: string): Record<string, unknown> {
  return { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } };
}

/** The page attributes every fake document uses. */
const PAGE = resolveWorkerConfig({}).blankDocument.page;

/** The snapshot JSON of a document with one paragraph per line of `text`. */
export function docJson(text: string): unknown {
  const paras = text.split('\n').map((t) => textSchema.node('paragraph', null, t === '' ? [] : [textSchema.text(t)]));
  const { size, orientation, margins } = PAGE;
  return textSchema.node('doc', { size, orientation, margins }, [textSchema.node('body', null, paras)]).toJSON();
}

/** The plain text of a model (paragraphs joined by `\n`). */
export function textOf(model: unknown): string {
  const doc = model as { child(i: number): { forEach(f: (n: { textContent: string }) => void): void } };
  const out: string[] = [];
  doc.child(0).forEach((p) => out.push(p.textContent));
  return out.join('\n');
}

/**
 * A fake codec: the storage bytes are UTF-8 text, one paragraph per line. Text starting with
 * `UNSUPPORTED` reports a `comments` finding.
 */
export class FakeCodec implements CodecSeam {
  imports = 0;
  probeError: unknown = null;

  import(i: { bytes: Uint8Array; format: FileFormat; assetDir: string }): Promise<CodecImportResult> {
    this.imports++;
    const text = new TextDecoder().decode(i.bytes);
    const findings: UnsupportedFinding[] = text.startsWith('UNSUPPORTED') ? [{ feature: 'comments', count: 1 }] : [];
    return Promise.resolve({ kind: 'text', snapshot: docJson(text), findings, assetIds: [] });
  }

  probe(): Promise<void> {
    return this.probeError === null ? Promise.resolve() : Promise.reject(this.probeError as Error);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A fake flush scheduler that records calls. */
export class FakeFlush implements FlushSeam {
  dirty = 0;
  flushed: FlushTarget[] = [];
  markDirty(): void {
    this.dirty++;
  }
  flushNow(inst: FlushTarget): Promise<'clean' | 'flushed' | 'skipped' | 'failed'> {
    this.flushed.push(inst);
    return Promise.resolve('flushed');
  }
  flushAll(): Promise<void> {
    return Promise.resolve();
  }
}

/** One recorded sink call. */
export type SinkEvent =
  | { kind: 'send'; frames: OutFrame[] }
  | { kind: 'close'; sessionIds: string[]; code: number; reason: string }
  | { kind: 'error'; err: OpenDocexError }
  | { kind: 'document'; ev: DocumentEvent };

/** A recording {@link CoreSink}. `order` is shared with the other spies. */
export class RecordingSink implements CoreSink {
  readonly events: SinkEvent[] = [];
  /** Answers paced frames with `written`, like the main side, except for `manualWrite` sessions. */
  onToken: ((sessionId: string, token: number) => void) | null = null;
  readonly manualWrite = new Set<string>();
  constructor(readonly order: string[]) {}
  send(frames: OutFrame[]): void {
    this.events.push({ kind: 'send', frames });
    for (const f of frames) {
      this.order.push(`send:${decode(f).type}`);
      const token = f.token;
      if (token === undefined) continue;
      for (const sid of f.sessionIds) {
        if (!this.manualWrite.has(sid)) setImmediate(() => this.onToken?.(sid, token));
      }
    }
  }
  close(sessionIds: string[], code: number, reason: string): void {
    this.events.push({ kind: 'close', sessionIds, code, reason });
  }
  error(err: OpenDocexError): void {
    this.events.push({ kind: 'error', err });
  }
  document(ev: DocumentEvent): void {
    this.events.push({ kind: 'document', ev });
  }
  whenWritable(): Promise<void> {
    return Promise.resolve();
  }

  /** Every message sent to `sessionId`, in order. */
  messages(sessionId: string): ServerMessage[] {
    const out: ServerMessage[] = [];
    for (const e of this.events) {
      if (e.kind !== 'send') continue;
      for (const f of e.frames) if (f.sessionIds.includes(sessionId)) out.push(decode(f));
    }
    return out;
  }

  /** Messages of one type sent to `sessionId`. */
  of<T extends ServerMessage['type']>(sessionId: string, type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages(sessionId).filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }

  /** Frames with a token, for one session. */
  tokens(sessionId: string): number[] {
    const out: number[] = [];
    for (const e of this.events) {
      if (e.kind !== 'send') continue;
      for (const f of e.frames) if (f.sessionIds.includes(sessionId) && f.token !== undefined) out.push(f.token);
    }
    return out;
  }

  closes(sessionId: string): number[] {
    return this.events.flatMap((e) => (e.kind === 'close' && e.sessionIds.includes(sessionId) ? [e.code] : []));
  }
}

function decode(f: OutFrame): ServerMessage {
  const r = decodeServerMessage(f.data);
  if (r.kind !== 'message') throw new Error(`Undecodable server frame: ${r.kind}`);
  return r.message;
}

/** A queue decorator that records `queue.ack` in `order`. */
function spyQueue(q: QueueAdapter, order: string[]): QueueAdapter {
  return {
    kind: q.kind,
    start: (h) => q.start(h),
    enqueue: (i) => q.enqueue(i),
    consume: (id, deliver) =>
      q.consume(id, (d) =>
        deliver({
          ...d,
          ack: async () => {
            order.push('queue.ack');
            await d.ack();
          },
        }),
      ),
    depth: (id) => q.depth(id),
    close: () => q.close(),
  };
}

/** Options for {@link makeHarness}. */
export interface HarnessOptions {
  config?: WorkerConfig;
  /** Reuse a data folder (for reload tests). */
  dataDir?: string;
  storage?: FakeStorage;
}

/** A Core without the runtime: registry, dispatcher and instances over fakes. */
export async function makeHarness(o: HarnessOptions = {}) {
  const dataDir = o.dataDir ?? (await mkdtemp(path.join(tmpdir(), 'odx-core-')));
  const config = resolveWorkerConfig({ ...o.config, dataDir });
  const order: string[] = [];
  const sink = new RecordingSink(order);
  const storage = o.storage ?? new FakeStorage();
  const codec = new FakeCodec();
  const flush = new FakeFlush();
  const audits: AuditEvent[] = [];
  const meta = new MetaStore(dataDir);
  await meta.loadAll();
  const queue = new MemoryQueue({ perDocument: config.queue.perDocument, global: config.queue.global });
  const deps: CoreDeps = {
    config,
    meta,
    snapshots: new SnapshotStore(dataDir),
    assets: new AssetStore(dataDir),
    router: { route: () => storage },
    codec,
    queue: spyQueue(queue, order),
    flush,
    audit: {
      emit: (e) => {
        order.push('audit');
        audits.push(e);
      },
    },
    sink,
    clock: { now: () => 1_700_000_000_000, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    logger: noopLogger,
  };
  const factory = new DocumentInstanceFactory(deps);
  const registry = new DocumentRegistry({ factory, logger: noopLogger, meta });
  const dispatcher = new SessionDispatcher({ registry, sink, logger: noopLogger });
  sink.onToken = (sessionId, token) => dispatcher.handle({ type: 'written', sessionId, token });
  let n = 0;

  const h = {
    dataDir,
    config,
    order,
    sink,
    storage,
    codec,
    flush,
    audits,
    meta,
    registry,
    dispatcher,
    deps,
    /** Puts a text file in storage and returns its document ID. */
    file(name: string, text: string, version?: string): DocumentId {
      storage.setFile(name, new TextEncoder().encode(text), version);
      return asDocumentId(name);
    },
    join(documentId: DocumentId, access: 'edit' | 'view' = 'edit', format: FileFormat = 'docx', ref?: string): string {
      const sessionId = `s${++n}`;
      dispatcher.join({ type: 'join', sessionId, documentId, userId: `u-${sessionId}`, access, document: { ref: ref ?? documentId, format } });
      return sessionId;
    },
    send(sessionId: string, msg: ClientMessage): void {
      const data = encodeMessage(msg);
      dispatcher.frame(sessionId, typeof data === 'string' ? new TextEncoder().encode(data) : data, typeof data !== 'string');
    },
    hello(sessionId: string, clientId: string, resume?: { epoch: string; rev: number }): void {
      const m: ClientMessage = { type: 'hello', protocol: PROTOCOL_VERSION, clientId: cid(clientId) };
      if (resume !== undefined) m.resume = { epoch: cid(resume.epoch) as string as Epoch, rev: resume.rev };
      h.send(sessionId, m);
    },
    submit(sessionId: string, clientId: string, clientSeq: number, epoch: string, baseRev: number, ops: unknown[]): void {
      h.send(sessionId, { type: 'submit', clientId: cid(clientId), clientSeq, epoch: cid(epoch) as string as Epoch, baseRev, ops });
    },
    /** Joins, says hello and waits until the load is done. Returns the session and its epoch. */
    async open(documentId: DocumentId, clientId: string, access: 'edit' | 'view' = 'edit') {
      const sid = h.join(documentId, access);
      h.hello(sid, clientId);
      await vi.waitFor(() => {
        if (sink.of(sid, 'load-done').length === 0) throw new Error('not loaded');
      });
      const start = sink.of(sid, 'load-start')[0];
      if (start === undefined) throw new Error('no load-start');
      return { sid, epoch: start.epoch as string, rev: start.rev };
    },
    async idle(): Promise<void> {
      await dispatcher.idle();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
    async closeAll(): Promise<void> {
      for (const i of registry.all()) await i.close();
    },
    async dispose(): Promise<void> {
      await h.closeAll();
      await queue.close();
      if (o.dataDir === undefined) await rm(dataDir, { recursive: true, force: true });
    },
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** Spies on `Journal.prototype.append`, recording `journal` in `order` once a write resolves. */
export function spyJournal(order: string[]) {
  const real = Journal.prototype.append;
  let failNext = false;
  const spy = vi.spyOn(Journal.prototype, 'append').mockImplementation(async function (this: Journal, e) {
    if (failNext) {
      failNext = false;
      throw new Error('disk full');
    }
    await real.call(this, e);
    order.push('journal');
  });
  return {
    spy,
    failNext(): void {
      failNext = true;
    },
  };
}
