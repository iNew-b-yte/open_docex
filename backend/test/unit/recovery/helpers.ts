/**
 * Test doubles for the flush scheduler and the recovery manager (V1-16): a manual clock, a
 * fake export codec, fake instances and registry, and a meta builder.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asDocumentId, type DocumentId } from '@open-docex/shared/ids';
import { decodeServerMessage, type DocKind, type FileFormat, type ServerMessage } from '@open-docex/shared/protocol';
import { TextOtType } from '@open-docex/shared/text';
import type { OutFrame } from '../../../src/channel/messages.js';
import type { WireError } from '../../../src/channel/messages.js';
import type { Clock } from '../../../src/core/seams.js';
import type { CodecExport } from '../../../src/flush/storage-io.js';
import { docKeyOf } from '../../../src/persistence/layout.js';
import { MetaStore, type DocumentMeta } from '../../../src/persistence/meta-store.js';
import type { RecoveryRegistry, RecoveryTarget } from '../../../src/recovery/recovery-manager.js';
import type { StorageRef } from '../../../src/storage/storage-adapter.js';
import { docJson, textOf } from '../core/harness.js';

/** A manual clock: timers fire only in {@link FakeClock.advance}. */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  /** Every `setTimeout` call, for timer-churn checks. */
  armed = 0;

  constructor(now = 0) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.armed++;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Pending timers' due times, sorted. */
  get pending(): number[] {
    return [...this.#timers.values()].map((t) => t.at).sort((a, b) => a - b);
  }

  /** Moves time forward by `ms`, firing due timers in order and letting async work run after each. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.#timers) if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) next = e;
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].fn();
      await settle();
    }
    this.#now = end;
    await settle();
  }
}

/** Lets pending promise callbacks and `setImmediate` work run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/** A fresh temporary data folder. */
export function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'odx-v116-'));
}

/** The inverse of the core harness's `FakeCodec`: the model's paragraphs as UTF-8 lines. */
export class FakeExport implements CodecExport {
  calls = 0;
  /** Makes the next `export` calls throw this. */
  failures: Error[] = [];
  /** When set, each export waits for this promise. */
  gate: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;

  async export(i: { kind: DocKind; format: FileFormat; model: unknown; assetDir: string }): Promise<Uint8Array> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate !== null) await this.gate;
      const f = this.failures.shift();
      if (f !== undefined) throw f;
      return encodeText(textOf(TextOtType.deserializeSnapshot(i.model)));
    } finally {
      this.inFlight--;
    }
  }
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeText(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes);
}

/** A loaded instance as the scheduler and the recovery manager see it. */
export class FakeTarget implements RecoveryTarget {
  readonly docKey: string;
  readonly kind = 'text' as const;
  readonly format: FileFormat = 'docx';
  readonly epoch = 'epoch-fake';
  readonly sessions = new Map<string, unknown>([['s1', {}]]);
  rev = 0;
  model: unknown;
  reloads = 0;
  /** `flushedRev` of every `compactAfterFlush` call. */
  compactions: number[] = [];
  /** What `reloadFromStorage` does; the default writes a NORMAL meta, as the instance does. */
  onReload: (() => Promise<void>) | null = null;

  constructor(
    readonly documentId: DocumentId,
    readonly ref: StorageRef,
    text: string,
  ) {
    this.docKey = docKeyOf(documentId);
    this.model = TextOtType.deserializeSnapshot(docJson(text));
  }

  /** Commits a new model at `rev + 1`. */
  edit(text: string): void {
    this.model = TextOtType.deserializeSnapshot(docJson(text));
    this.rev++;
  }

  currentSnapshot(): { rev: number; model: unknown } {
    return { rev: this.rev, model: this.model };
  }

  compactAfterFlush(flushedRev: number): Promise<void> {
    this.compactions.push(flushedRev);
    return Promise.resolve();
  }

  async reloadFromStorage(): Promise<void> {
    this.reloads++;
    await this.onReload?.();
  }
}

/** A registry over fake targets. `getOrLoad` of an unknown id "loads" `onLoad(id)`. */
export class FakeRegistry implements RecoveryRegistry {
  readonly loaded = new Map<DocumentId, FakeTarget>();
  loads = 0;
  constructor(readonly onLoad: (id: DocumentId) => FakeTarget) {}
  get(id: DocumentId): FakeTarget | undefined {
    return this.loaded.get(id);
  }
  getOrLoad(id: DocumentId): Promise<FakeTarget> {
    let t = this.loaded.get(id);
    if (t === undefined) {
      this.loads++;
      t = this.onLoad(id);
      this.loaded.set(id, t);
    }
    return Promise.resolve(t);
  }
}

/** A NORMAL meta for `id`, with overrides. */
export function makeMeta(id: DocumentId | string, o: Partial<DocumentMeta> = {}): DocumentMeta {
  const documentId = typeof id === 'string' ? asDocumentId(id) : id;
  return {
    schema: 1,
    documentId,
    kind: 'text',
    format: 'docx',
    ref: documentId,
    storageState: 'NORMAL',
    lastKnownVersion: null,
    lastFlushedRev: 0,
    rev: 0,
    auditEmittedRev: 0,
    retryCount: 0,
    nextRetryAt: null,
    localSince: null,
    readOnly: { findings: [], allowedEdit: false },
    lineage: [],
    createdAt: 0,
    updatedAt: 0,
    ...o,
  };
}

/** A MetaStore over a fresh temporary folder, holding `metas`. */
export async function metaStoreWith(dataDir: string, ...metas: DocumentMeta[]): Promise<MetaStore> {
  const store = new MetaStore(dataDir);
  await store.loadAll();
  for (const m of metas) await store.put(m);
  return store;
}

/** Records `send` frames and `emit` events in one ordered log. */
export class Recorder {
  readonly log: string[] = [];
  readonly notices: Array<{ sessionIds: string[]; msg: ServerMessage }> = [];
  readonly events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  /** Called on every send, before it is logged (for example to log the meta state then). */
  beforeSend: (() => void) | null = null;

  readonly sink = {
    send: (frames: OutFrame[]): void => {
      this.beforeSend?.();
      for (const f of frames) {
        const r = decodeServerMessage(f.data);
        if (r.kind !== 'message') throw new Error('undecodable frame');
        this.notices.push({ sessionIds: f.sessionIds, msg: r.message });
        const m = r.message;
        this.log.push(m.type === 'notice' && m.notice === 'storage' ? `notice:${m.state}` : m.type);
      }
    },
  };

  readonly emit = (event: 'error' | 'storage', payload: unknown): void => {
    const p = payload as Record<string, unknown>;
    this.events.push({ event, payload: p });
    this.log.push(event === 'storage' ? `storage:${String(p['state'])}` : `error:${(p as unknown as WireError).code}`);
  };

  storage(): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.event === 'storage').map((e) => e.payload);
  }

  errors(): WireError[] {
    return this.events.filter((e) => e.event === 'error').map((e) => e.payload as unknown as WireError);
  }
}
