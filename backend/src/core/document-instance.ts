/**
 * `DocumentInstance`: one loaded document in the Core (LLD Part 2 §8.4, §8.5, HLD §10–§11).
 *
 * - **Load** picks local state or storage (§8.4 "Choosing the load source") and rebuilds the
 *   model, rev, dedupe table and history.
 * - **Intake** (`onSubmit`) rejects what it can without the queue, then enqueues.
 * - **The FIFO loop** (`#deliver`) processes one envelope at a time in this order:
 *   journal → ack → broadcast → audit → queue ack (N1).
 * - **Fault isolation:** an op-level throw (validate, rebase, apply) rejects only that
 *   envelope. Journal or snapshot I/O failures and broken invariants fault this instance only;
 *   other instances keep running.
 *
 * `rev`, `epoch` and `clientSeq` follow LLD Part 1 §6 (R1–R13), with §0 PO-16 for old-epoch
 * resumes.
 *
 * @module
 */
import { OpenDocexError } from '@open-docex/shared/errors';
import { newEpoch, type DocumentId, type Epoch } from '@open-docex/shared/ids';
import {
  CloseCode,
  closeCodeFor,
  encodeMessage,
  PROTOCOL_VERSION,
  type AssetGetMsg,
  type AssetPutMsg,
  type ClientMessage,
  type ConversionNotice,
  type DocKind,
  type FileFormat,
  type HelloMsg,
  type ResyncMsg,
  type ServerMessage,
  type SubmitMsg,
  type UnsupportedFinding,
} from '@open-docex/shared/protocol';
import type { ResolvedWorkerConfig } from '../api/options.js';
import { engineError } from '../errors/engine-error.js';
import type { Logger } from '../log/logger.js';
import type { AssetStore } from '../persistence/asset-store.js';
import { Journal, type JournalEntry, type JournalSyncTimer } from '../persistence/journal.js';
import { docKeyOf, journalDir } from '../persistence/layout.js';
import type { DocumentMeta, MetaStore } from '../persistence/meta-store.js';
import type { SnapshotFile, SnapshotStore } from '../persistence/snapshot-store.js';
import type { QueueAdapter, QueueConsumer, QueueDelivery } from '../queue/queue-adapter.js';
import { STORAGE_CALL_TIMEOUT_MS, type StorageAdapter, type StorageRef } from '../storage/storage-adapter.js';
import { DedupeTable } from './dedupe-table.js';
import type { KindPolicy } from './kind-policy.js';
import { LoadStreamer } from './load-streamer.js';
import { historyMaxOps, OpHistory } from './op-history.js';
import type { AuditSink, Clock, CodecSeam, CoreSink, FlushSeam, FlushTarget } from './seams.js';
import { sendError, sendTo, type SessionHost, type SessionRecord } from './session-record.js';

/** The instance lifecycle (HLD §11.3). `CLOSED` is an end state (LLD choice). */
export type InstanceState = 'LOADING' | 'ACTIVE' | 'FAULTED' | 'CLOSING' | 'CLOSED';

/** Best-effort flush timeout during `fault()` (§8.4). */
export const FAULT_FLUSH_TIMEOUT_MS = 30_000;
/** `meta.lineage` keeps the last 32 entries (§8.4, V3 §8.6). */
export const LINEAGE_MAX = 32;

/** What every instance needs from the Core (§8.3 `CoreDeps`). */
export interface CoreDeps {
  config: ResolvedWorkerConfig;
  meta: MetaStore;
  snapshots: SnapshotStore;
  assets: AssetStore;
  router: { route(ref: StorageRef): StorageAdapter };
  codec: CodecSeam;
  queue: QueueAdapter;
  flush: FlushSeam;
  audit: AuditSink;
  sink: CoreSink;
  clock: Clock;
  logger: Logger;
  /** Registered journals are `datasync`ed on a timer when `journal.fsync` is `'interval'`. */
  syncTimer?: JournalSyncTimer;
}

/** Per-instance hooks from the registry. */
export interface InstanceHooks {
  /** Called once when the instance reaches `CLOSED`. */
  onClosed?(inst: DocumentInstance): void;
}

interface LocalState {
  snap: SnapshotFile | null;
  entries: JournalEntry[];
  /** max(snapshot rev, last journal `r`). */
  rev: number;
}

/** One loaded document. Create it through `DocumentInstanceFactory`. */
export class DocumentInstance<S = unknown, O = unknown> implements FlushTarget, SessionHost {
  readonly documentId: DocumentId;
  /** `sha256hex(documentId)`. */
  readonly docKey: string;
  /** `newEpoch()` for every load (CL-7); also the `instanceId` in this instance's errors. */
  readonly epoch: Epoch;
  readonly ref: StorageRef;
  readonly format: FileFormat;
  readonly policy: KindPolicy<S, O>;
  state: InstanceState = 'LOADING';
  rev = 0;
  model!: S;
  /** True when there are findings and `meta.readOnly.allowedEdit` is false. */
  readOnly = false;
  findings: UnsupportedFinding[] = [];
  /** Conversions made by this load's import (PO-22); empty after a local reload. */
  conversions: ConversionNotice[] = [];
  dedupe = new DedupeTable();
  readonly history: OpHistory;

  readonly #d: CoreDeps;
  readonly #hooks: InstanceHooks;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #streamer: LoadStreamer<S>;
  #journal: Journal | null = null;
  #consumer: QueueConsumer | null = null;
  #opsSinceSnapshot = 0;
  #source: 'storage' | 'local' = 'storage';
  #faulting: Promise<void> | null = null;
  #closing: Promise<void> | null = null;

  constructor(
    deps: CoreDeps,
    id: DocumentId,
    doc: { ref: StorageRef; format: FileFormat },
    policy: KindPolicy<S, O>,
    hooks: InstanceHooks = {},
  ) {
    this.#d = deps;
    this.#hooks = hooks;
    this.documentId = id;
    this.docKey = docKeyOf(id);
    this.epoch = newEpoch();
    this.ref = doc.ref;
    this.format = doc.format;
    this.policy = policy;
    this.history = new OpHistory(historyMaxOps(deps.config.snapshot.everyOps), 0);
    this.#streamer = new LoadStreamer<S>(this, deps.sink);
  }

  /** The document kind. */
  get kind(): DocKind {
    return this.policy.kind;
  }

  /** Sessions currently attached. */
  get sessions(): ReadonlyMap<string, SessionRecord> {
    return this.#sessions;
  }

  /** The committed state. Zero-copy: `OtType` never mutates its inputs (N11). */
  currentSnapshot(): { rev: number; model: S } {
    return { rev: this.rev, model: this.model };
  }

  // --- load ----------------------------------------------------------------------------------

  /**
   * Loads the document (§8.4) and becomes `ACTIVE`. On failure the instance becomes `CLOSED`
   * and the error is rethrown; local files are kept.
   */
  async load(): Promise<void> {
    try {
      await this.#loadInner();
      const meta = this.#d.meta.get(this.docKey);
      if (meta === undefined) throw engineError('DOCUMENT_FAULTED', { message: 'Document meta is missing after load.' });
      meta.rev = this.rev;
      meta.updatedAt = this.#d.clock.now();
      meta.lineage = [...meta.lineage, { epoch: this.epoch, fromRev: this.rev }].slice(-LINEAGE_MAX);
      await this.#d.meta.put(meta);
      this.readOnly = this.findings.length > 0 && !meta.readOnly.allowedEdit;
    } catch (err) {
      await this.#releaseJournal();
      this.state = 'CLOSED';
      this.#hooks.onClosed?.(this);
      throw this.#asEngineError(err, 'DOCUMENT_FAULTED');
    }
    this.state = 'ACTIVE';
    const at = this.#d.clock.now();
    this.#d.sink.document({ documentId: this.documentId, state: 'loaded', at, epoch: this.epoch, rev: this.rev, source: this.#source });
    if (this.findings.length > 0) {
      this.#d.sink.document({ documentId: this.documentId, state: 'unsupported', at, findings: [...this.findings] });
    }
    this.#consumer = this.#d.queue.consume(this.documentId, (d) => this.#deliver(d));
  }

  async #loadInner(): Promise<void> {
    const cfg = this.#d.config;
    this.#journal = await Journal.open(journalDir(cfg.dataDir, this.docKey), { fsync: cfg.journal.fsync, logger: this.#d.logger });
    if (cfg.journal.fsync === 'interval') this.#d.syncTimer?.add(this.#journal);
    const meta = this.#d.meta.get(this.docKey);
    if (meta === undefined) {
      await this.#freshImport(0, undefined);
      return;
    }
    const local = await this.#readLocal();
    if (meta.storageState !== 'NORMAL' || local.rev > meta.lastFlushedRev) {
      this.#replayLocal(local, meta); // the local copy is newer [§5]
      return;
    }
    let st: Awaited<ReturnType<StorageAdapter['stat']>> | undefined;
    let statErr: unknown;
    try {
      st = await this.#storage((a, signal) => a.stat(this.ref, { signal }));
    } catch (err) {
      statErr = err;
    }
    if (statErr === undefined && st !== null && st !== undefined && st.version === meta.lastKnownVersion && local.snap !== null) {
      this.#replayLocal(local, meta); // same content; keeps rev continuity (LLD choice)
    } else if (statErr !== undefined && local.snap !== null) {
      this.#replayLocal(local, meta); // storage unreachable: state stays NORMAL (LLD choice)
    } else {
      // rev never decreases for a documentId (LLD choice).
      await this.#freshImport(Math.max(meta.rev, local.rev), meta);
    }
  }

  async #readLocal(): Promise<LocalState> {
    const snap = await this.#d.snapshots.read(this.docKey);
    const entries: JournalEntry[] = [];
    for await (const e of (this.#journal as Journal).read()) entries.push(e);
    const last = entries.at(-1);
    return { snap, entries, rev: Math.max(snap?.rev ?? 0, last?.r ?? 0) };
  }

  /** `replayLocal()` (§8.4): snapshot, then journal entries with `f ≥ S`, checking continuity. */
  #replayLocal(local: LocalState, meta: DocumentMeta): void {
    const snap = local.snap;
    if (snap === null) throw engineError('DOCUMENT_FAULTED', { message: 'The local snapshot is missing.' });
    if (snap.kind !== this.kind) throw engineError('DOCUMENT_FAULTED', { message: 'The local snapshot has the wrong kind.' });
    const ot = this.policy.ot;
    let model = ot.deserializeSnapshot(snap.model);
    const s = snap.rev;
    const dedupe = DedupeTable.fromJSON(snap.dedupe);
    this.history.reset(s);
    // The tail before the snapshot rebuilds the history window (§10.3): keep the contiguous run.
    const tail = local.entries.filter((e) => e.f < s);
    let runStart = 0;
    for (let i = 1; i < tail.length; i++) {
      if ((tail[i] as JournalEntry).f !== (tail[i - 1] as JournalEntry).r) runStart = i;
    }
    const run = tail.slice(runStart);
    if (run.length > 0 && (run.at(-1) as JournalEntry).r === s) {
      this.history.reset((run[0] as JournalEntry).f);
      for (const e of run) {
        this.history.push(e);
        dedupe.record(e.c, e.q, e.r);
      }
    }
    let rev = s;
    for (const e of local.entries) {
      if (e.f < s) continue;
      if (e.f !== rev || e.r !== e.f + e.o.length) {
        throw engineError('DOCUMENT_FAULTED', { message: `Journal gap at rev ${rev}.` });
      }
      let r: { snapshot: S; applied: O[]; dropped: number };
      try {
        r = ot.apply(model, e.o as O[]);
      } catch (err) {
        throw engineError('DOCUMENT_FAULTED', { message: 'A journal entry failed to apply.', cause: err });
      }
      if (r.dropped > 0) throw engineError('DOCUMENT_FAULTED', { message: 'A journal entry did not apply cleanly.' });
      model = r.snapshot;
      rev = e.r;
      this.history.push(e);
      dedupe.record(e.c, e.q, e.r);
    }
    this.model = model;
    this.rev = rev;
    this.dedupe = dedupe;
    this.#opsSinceSnapshot = rev - s;
    this.findings = [...meta.readOnly.findings];
    this.#source = 'local';
  }

  /** First load or a changed storage file: import through the codec at `rev`. */
  async #freshImport(rev: number, old: DocumentMeta | undefined): Promise<void> {
    const max = this.#d.config.limits.maxFileBytes;
    const st = await this.#storage((a, signal) => a.stat(this.ref, { signal }));
    if (st === null) throw engineError('DOCUMENT_NOT_FOUND', { documentId: this.documentId });
    if (st.size > max) throw engineError('DOCUMENT_TOO_LARGE', { documentId: this.documentId });
    const read = await this.#storage((a, signal) => a.read(this.ref, { signal, maxBytes: max }));
    if (read === null) throw engineError('DOCUMENT_NOT_FOUND', { documentId: this.documentId });
    const imp = await this.#d.codec.import({ bytes: read.bytes, format: this.format, assetDir: this.#d.assets.dir(this.docKey) });
    if (imp.kind !== this.kind) throw engineError('CONVERSION_FAILED', { message: 'The import produced another document kind.' });
    let model: S;
    try {
      model = this.policy.ot.deserializeSnapshot(imp.snapshot);
    } catch (err) {
      throw engineError('CONVERSION_FAILED', { message: 'The imported model is invalid.', cause: err });
    }
    const now = this.#d.clock.now();
    await this.#d.snapshots.write(this.docKey, {
      v: 1,
      kind: this.kind,
      rev,
      savedAt: now,
      model: this.policy.ot.serializeSnapshot(model),
      dedupe: [],
    });
    // Drop journal entries of the old content, so a later replay never mixes them in.
    const j = this.#journal as Journal;
    await j.rotate(rev);
    await j.trimBefore(rev + 1);
    const meta: DocumentMeta = {
      schema: 1,
      documentId: this.documentId,
      kind: this.kind,
      format: this.format,
      ref: this.ref,
      storageState: 'NORMAL',
      lastKnownVersion: read.version,
      lastFlushedRev: rev,
      rev,
      auditEmittedRev: Math.max(old?.auditEmittedRev ?? 0, rev),
      retryCount: 0,
      nextRetryAt: null,
      localSince: null,
      readOnly: { findings: imp.findings, allowedEdit: false },
      lineage: [],
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#d.meta.put(meta);
    this.model = model;
    this.rev = rev;
    this.dedupe = new DedupeTable(); // clear dedupe and lineage (§8.4)
    this.history.reset(rev);
    this.#opsSinceSnapshot = 0;
    this.findings = [...imp.findings];
    this.conversions = [...(imp.conversions ?? [])];
    this.#source = 'storage';
  }

  /** Calls the routed storage adapter with the {@link STORAGE_CALL_TIMEOUT_MS} abort. */
  async #storage<T>(fn: (a: StorageAdapter, signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const clock = this.#d.clock;
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = clock.setTimeout(() => {
        ac.abort();
        reject(engineError('STORAGE_READ_FAILED', { message: 'The storage call timed out.', documentId: this.documentId }));
      }, STORAGE_CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([fn(this.#d.router.route(this.ref), ac.signal), timeout]);
    } catch (err) {
      throw this.#asEngineError(err, 'STORAGE_READ_FAILED');
    } finally {
      clock.clearTimeout(timer);
    }
  }

  // --- sessions ------------------------------------------------------------------------------

  /** Attaches a session (after `join`). */
  addSession(r: SessionRecord): void {
    this.#sessions.set(r.sessionId, r);
  }

  /** Detaches a session. Idempotent. */
  removeSession(id: string): void {
    this.#sessions.delete(id);
    this.#streamer.cancel(id);
  }

  /** A `written` event: refills a paced load (§8.5). */
  onWritten(sessionId: string, token: number): void {
    this.#streamer.onWritten(sessionId, token);
  }

  /** Routes one decoded client message (§8.1). An unexpected throw faults this instance only. */
  async handleMessage(r: SessionRecord, msg: ClientMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'hello':
          this.onHello(r, msg);
          return;
        case 'submit':
          await this.onSubmit(r, msg);
          return;
        case 'asset-put':
          await this.onAssetPut(r, msg, msg.bytes);
          return;
        case 'asset-get':
          await this.onAssetGet(r, msg);
          return;
        case 'ping':
          this.#send(r.sessionId, { type: 'pong', n: msg.n });
          return;
        default:
          return; // upload-* (V4) and annotation-* (V5) have no handler in V1
      }
    } catch (err) {
      void this.fault(err);
    }
  }

  /**
   * `hello` (§8.5, R11, PO-16, R-8). A second `hello` on one session is refused, because the
   * `clientId` binding guards the dedupe table (§8.7).
   */
  onHello(r: SessionRecord, m: HelloMsg): void {
    if (!this.#sessions.has(r.sessionId)) return;
    if (m.protocol !== PROTOCOL_VERSION) {
      sendError(this.#d.sink, r.sessionId, engineError('PROTOCOL_VERSION_UNSUPPORTED'));
      this.#d.sink.close([r.sessionId], closeCodeFor('PROTOCOL_VERSION_UNSUPPORTED') ?? CloseCode.PROTOCOL_ERROR, 'protocol');
      return;
    }
    if (r.clientId !== undefined) {
      sendError(this.#d.sink, r.sessionId, engineError('PROTOCOL_INVALID_MESSAGE', { message: 'Second hello.' }));
      return;
    }
    r.clientId = m.clientId;
    const res = m.resume;
    if (res === undefined) {
      this.#streamer.fullLoad(r);
      return;
    }
    if (res.epoch === this.epoch) {
      if (this.history.covers(res.rev)) {
        this.#streamer.catchUp(r, res.rev);
        return;
      }
      this.#resyncAndReload(r, res.rev > this.rev ? 'inconsistent' : 'history-unavailable');
      return;
    }
    // Old epoch (PO-16, R-8): rev persists across loads, so replay the retained batches after
    // the client's rev, then reload for the new epoch.
    if (this.history.covers(res.rev)) this.#streamer.replay(r, res.rev);
    this.#resyncAndReload(r, 'epoch-changed');
  }

  /** Intake (§8.4): reject what needs no queue, otherwise enqueue. */
  async onSubmit(r: SessionRecord, m: SubmitMsg): Promise<void> {
    const ctx = { clientSeq: m.clientSeq };
    if (this.state === 'CLOSING') return; // shutting down: the client resends after reconnecting (R9)
    if (this.state !== 'ACTIVE') {
      sendError(this.#d.sink, r.sessionId, this.#faultError(undefined), ctx);
      return;
    }
    if (r.access === 'view') return sendError(this.#d.sink, r.sessionId, engineError('ACCESS_DENIED'), ctx);
    if (this.readOnly) return sendError(this.#d.sink, r.sessionId, engineError('DOCUMENT_READ_ONLY'), ctx);
    if (m.clientId !== r.clientId) {
      return sendError(this.#d.sink, r.sessionId, engineError('PROTOCOL_INVALID_MESSAGE', { message: 'clientId mismatch.' }), ctx);
    }
    const { clientId, clientSeq, epoch, baseRev, ops } = m;
    const res = await this.#d.queue.enqueue({
      documentId: this.documentId,
      sessionId: r.sessionId,
      userId: r.userId,
      access: r.access,
      receivedAt: this.#d.clock.now(),
      envelope: { clientId, clientSeq, epoch, baseRev, ops },
    });
    if (!res.ok) sendError(this.#d.sink, r.sessionId, engineError(res.code), ctx);
  }

  // --- FIFO loop -----------------------------------------------------------------------------

  async #deliver(d: QueueDelivery): Promise<void> {
    try {
      await this.#d.sink.whenWritable(); // IPC backpressure (§6.4)
      if (this.state !== 'ACTIVE') return; // stop() drops the item
      await this.#process(d);
    } catch (err) {
      // Not awaited: fault() stops the consumer, which waits for this delivery to return.
      void this.fault(err);
    }
  }

  async #process(d: QueueDelivery): Promise<void> {
    const env = d.item.envelope;
    const sid = d.item.sessionId;
    const s = sid === null ? undefined : this.#sessions.get(sid);
    const ctx = { clientSeq: env.clientSeq };
    // 1–2: repeat the intake checks for items that waited while the state changed.
    if (d.item.access === 'view') {
      if (s) sendError(this.#d.sink, s.sessionId, engineError('ACCESS_DENIED'), ctx);
      return d.ack();
    }
    if (this.readOnly) {
      if (s) sendError(this.#d.sink, s.sessionId, engineError('DOCUMENT_READ_ONLY'), ctx);
      return d.ack();
    }
    // 3: duplicate (CL-12, R10).
    if (this.dedupe.lookup(env.clientId, env.clientSeq)) {
      const h = this.history.findByClient(env.clientId, env.clientSeq);
      if (s) {
        if (h) this.#send(s.sessionId, h.x ? { type: 'ack', clientSeq: h.q, rev: h.r, committed: h.o } : { type: 'ack', clientSeq: h.q, rev: h.r });
        else this.#resyncAndReload(s, 'history-unavailable');
      }
      return d.ack();
    }
    // 4: epoch and base checks (R4, R13).
    const reason: ResyncMsg['reason'] | null =
      env.epoch !== this.epoch
        ? 'epoch-changed'
        : env.baseRev > this.rev
          ? 'inconsistent'
          : env.baseRev < this.history.floorRev
            ? 'history-unavailable'
            : null;
    if (reason !== null) {
      if (s) this.#resyncAndReload(s, reason);
      return d.ack();
    }
    // 5: validate, check assets, rebase and apply. An op-level throw rejects only this batch.
    let result: { snapshot: S; applied: O[]; dropped: number };
    let over: O[];
    try {
      const ops = this.policy.ot.validateOps(env.ops);
      for (const id of this.policy.assetRefs(ops)) {
        if ((await this.#d.assets.get(this.docKey, id)) === null) {
          throw engineError('PROTOCOL_OP_REJECTED', { message: 'Unknown asset.' });
        }
      }
      over = this.history.opsSince(env.baseRev) as O[];
      result = this.policy.rebaseApply(this.model, ops, over);
    } catch (err) {
      if (s) sendError(this.#d.sink, s.sessionId, engineError('PROTOCOL_OP_REJECTED'), ctx);
      this.#d.sink.error(
        engineError('PROTOCOL_OP_REJECTED', { message: 'A batch was rejected.', documentId: this.documentId, instanceId: this.epoch, cause: err }),
      );
      return d.ack();
    }
    // 6: journal first. A throw faults the instance (caught by #deliver), and no ack is sent.
    const entry: JournalEntry = {
      f: this.rev,
      r: this.rev + result.applied.length,
      c: env.clientId,
      q: env.clientSeq,
      u: d.item.userId,
      t: this.#d.clock.now(),
      x: over.length > 0 || result.dropped > 0,
      o: result.applied,
    };
    await (this.#journal as Journal).append(entry);
    // 7: commit in memory.
    this.model = result.snapshot;
    this.rev = entry.r;
    this.history.push(entry);
    this.dedupe.record(entry.c, entry.q, entry.r);
    this.#d.flush.markDirty(this);
    this.#opsSinceSnapshot += result.applied.length;
    // 8–9: ack and broadcast, as one send.
    const frames: Array<{ ids: string[]; msg: ServerMessage }> = [];
    if (s) {
      frames.push({
        ids: [s.sessionId],
        msg: entry.x ? { type: 'ack', clientSeq: entry.q, rev: entry.r, committed: result.applied } : { type: 'ack', clientSeq: entry.q, rev: entry.r },
      });
    }
    if (result.applied.length > 0) {
      const ids = [...this.#sessions.values()]
        .filter((x) => x.sessionId !== sid && (x.state === 'live' || x.state === 'loading'))
        .map((x) => x.sessionId);
      if (ids.length > 0) frames.push({ ids, msg: { type: 'remote', fromRev: entry.f, ops: result.applied, clientId: entry.c } });
    }
    if (frames.length > 0) {
      this.#d.sink.send(
        frames.map((f) => {
          const data = encodeMessage(f.msg);
          return { sessionIds: f.ids, data, binary: typeof data !== 'string' };
        }),
      );
    }
    // 10: audit. An all-dropped batch moves no rev, so it has no audit event: (documentId, rev)
    // is the adopters' dedupe key (PO-17).
    if (result.applied.length > 0) {
      this.#d.audit.emit({
        documentId: this.documentId,
        kind: this.kind,
        rev: entry.r,
        fromRev: entry.f,
        at: entry.t,
        userId: entry.u,
        clientId: entry.c,
        clientSeq: entry.q,
        sessionId: sid,
        ops: result.applied,
        replayed: false,
      });
    }
    // 11: queue commit after the journal.
    await d.ack();
    // 12: compaction (§10.3).
    if (this.#opsSinceSnapshot >= this.#d.config.snapshot.everyOps) await this.#snapshotAndRotate();
  }

  /** `snapshotAndRotate()` (§10.3). */
  async #snapshotAndRotate(): Promise<void> {
    const j = this.#journal as Journal;
    await j.rotate(this.rev);
    await this.#d.snapshots.write(this.docKey, {
      v: 1,
      kind: this.kind,
      rev: this.rev,
      savedAt: this.#d.clock.now(),
      model: this.policy.ot.serializeSnapshot(this.model),
      dedupe: this.dedupe.toJSON(),
    });
    await j.trimBefore(this.rev - historyMaxOps(this.#d.config.snapshot.everyOps));
    this.#opsSinceSnapshot = 0;
  }

  #resyncAndReload(r: SessionRecord, reason: ResyncMsg['reason']): void {
    this.#send(r.sessionId, { type: 'resync', reason });
    this.#streamer.fullLoad(r); // R-9: a full load follows on the same socket
  }

  // --- assets (CL-8) -------------------------------------------------------------------------

  /** `asset-put`: edit sessions on a writable instance; PNG, JPEG or GIF only (PO-24). */
  async onAssetPut(r: SessionRecord, m: AssetPutMsg, bytes: Uint8Array): Promise<void> {
    const ctx = { reqId: m.reqId };
    if (r.access === 'view') return sendError(this.#d.sink, r.sessionId, engineError('ACCESS_DENIED'), ctx);
    if (this.readOnly) return sendError(this.#d.sink, r.sessionId, engineError('DOCUMENT_READ_ONLY'), ctx);
    let stored: { id: string; mime: AssetPutMsg['mime'] };
    try {
      stored = await this.#d.assets.put(this.docKey, bytes);
    } catch (err) {
      return sendError(this.#d.sink, r.sessionId, err, ctx);
    }
    this.#send(r.sessionId, { type: 'asset', reqId: m.reqId, assetId: stored.id, mime: stored.mime, size: bytes.length });
  }

  /** `asset-get`: only from this document's asset folder. */
  async onAssetGet(r: SessionRecord, m: AssetGetMsg): Promise<void> {
    const ctx = { reqId: m.reqId };
    let a: { bytes: Uint8Array; mime: AssetPutMsg['mime'] } | null;
    try {
      a = await this.#d.assets.get(this.docKey, m.assetId);
    } catch (err) {
      return sendError(this.#d.sink, r.sessionId, err, ctx);
    }
    if (a === null) return sendError(this.#d.sink, r.sessionId, engineError('DOCUMENT_NOT_FOUND'), ctx);
    this.#send(r.sessionId, { type: 'asset', reqId: m.reqId, assetId: m.assetId, mime: a.mime, size: a.bytes.length, bytes: a.bytes });
  }

  // --- lifecycle -----------------------------------------------------------------------------

  /** ACTIVE → ACTIVE: lets users edit a document with unsupported content. */
  async allowUnsupportedEdit(): Promise<void> {
    const meta = this.#d.meta.get(this.docKey);
    if (meta === undefined) throw engineError('DOCUMENT_NOT_FOUND', { documentId: this.documentId });
    meta.readOnly = { ...meta.readOnly, allowedEdit: true };
    meta.updatedAt = this.#d.clock.now();
    await this.#d.meta.put(meta);
    this.readOnly = false;
    const ids = [...this.#sessions.keys()];
    if (ids.length === 0) return;
    const data = encodeMessage({ type: 'notice', notice: 'read-only', readOnly: false, reason: 'unsupported-content' });
    this.#d.sink.send([{ sessionIds: ids, data, binary: typeof data !== 'string' }]);
  }

  /**
   * ACTIVE → ACTIVE for `recovery.resolve('discard-local')` (LLD Part 2 §13): replaces the local
   * copy with a fresh import of the storage file, then sends every session that has a load
   * `resync` followed by a full load (R-9). Sessions still waiting for `hello` get the new
   * content when it arrives.
   *
   * - The FIFO loop pauses first: stopping the consumer waits for the delivery in progress.
   *   Items still queued are dropped (memory queue, S-29); their senders reload anyway.
   * - The fresh import (§8.4) writes the new snapshot atomically before it rotates and trims
   *   the journal and writes a NORMAL meta, so the old local copy goes only **after** the new
   *   snapshot is durable. It resets `allowedEdit`, dedupe and lineage (S-36).
   * - **`rev` becomes `rev + 1`** (V1-16 choice; the LLD does not say). The epoch stays the
   *   same, so the jump is what makes the discarded content's revs stale: a later submit or
   *   resume based on them gets `resync('history-unavailable')`, and no cached load chunks
   *   of the old content are reused. `rev` still never decreases.
   *
   * @throws {OpenDocexError} the import's error (`DOCUMENT_NOT_FOUND`, `DOCUMENT_TOO_LARGE`,
   *   `STORAGE_READ_FAILED`, `CONVERSION_*`) when nothing local was replaced; the instance keeps
   *   running on the local copy. A failure after the snapshot was replaced faults the instance
   *   (the next `join` reloads from local state) and throws `DOCUMENT_FAULTED`.
   */
  async reloadFromStorage(): Promise<void> {
    if (this.state !== 'ACTIVE') {
      throw engineError('DOCUMENT_FAULTED', { documentId: this.documentId, instanceId: this.epoch, message: 'The document is not active.' });
    }
    const consumer = this.#consumer;
    this.#consumer = null;
    await consumer?.stop();
    const rev = this.rev + 1;
    try {
      await this.#freshImport(rev, this.#d.meta.get(this.docKey));
      const meta = this.#d.meta.get(this.docKey);
      if (meta === undefined) throw engineError('DOCUMENT_FAULTED', { message: 'Document meta is missing after reload.' });
      meta.updatedAt = this.#d.clock.now();
      meta.lineage = [{ epoch: this.epoch, fromRev: this.rev }];
      await this.#d.meta.put(meta);
      this.readOnly = this.findings.length > 0 && !meta.readOnly.allowedEdit;
    } catch (err) {
      let replaced = this.rev === rev;
      if (!replaced) {
        try {
          replaced = (await this.#d.snapshots.read(this.docKey))?.rev === rev;
        } catch {
          replaced = true; // unknown: assume the local copy changed
        }
      }
      if (replaced) {
        await this.fault(err);
        throw this.#faultError(err);
      }
      if (this.state === 'ACTIVE') this.#consumer = this.#d.queue.consume(this.documentId, (d) => this.#deliver(d));
      throw this.#asEngineError(err, 'DOCUMENT_FAULTED');
    }
    for (const r of this.#sessions.values()) {
      if (r.state === 'loading' || r.state === 'live') this.#resyncAndReload(r, 'history-unavailable');
    }
    if (this.state === 'ACTIVE') this.#consumer = this.#d.queue.consume(this.documentId, (d) => this.#deliver(d));
  }

  /**
   * Faults this instance (HLD §11.3, [A2]): stop consuming, sync the journal, flush best effort,
   * close every session with `DOCUMENT_FAULTED`, emit, then `CLOSED`. Idempotent. Other
   * instances are not affected; the next `join` reloads with a new epoch.
   */
  fault(err: unknown): Promise<void> {
    this.#faulting ??= this.#doFault(err);
    return this.#faulting;
  }

  async #doFault(cause: unknown): Promise<void> {
    if (this.state === 'CLOSED') return;
    this.state = 'FAULTED';
    const err = this.#faultError(cause);
    this.#d.logger.error('Document faulted.', { documentId: this.documentId, epoch: this.epoch, code: codeOf(cause) });
    try {
      await this.#consumer?.stop();
    } catch {
      // stopping is best effort
    }
    this.#consumer = null;
    try {
      await this.#journal?.datasync();
    } catch {
      // the journal may be the failing part
    }
    const meta = this.#d.meta.get(this.docKey);
    if (meta !== undefined && meta.storageState === 'NORMAL' && this.rev > meta.lastFlushedRev) {
      try {
        await this.#d.flush.flushNow(this, { timeoutMs: FAULT_FLUSH_TIMEOUT_MS });
      } catch {
        // best effort, from the last committed state
      }
    }
    const ids = [...this.#sessions.keys()];
    if (ids.length > 0) {
      for (const id of ids) sendError(this.#d.sink, id, err);
      this.#d.sink.close(ids, CloseCode.DOCUMENT_FAULTED, 'document faulted');
    }
    for (const id of ids) this.removeSession(id);
    this.#d.sink.document({ documentId: this.documentId, state: 'faulted', at: this.#d.clock.now(), epoch: this.epoch, rev: this.rev, error: err });
    this.#d.sink.error(err);
    await this.#releaseJournal();
    this.state = 'CLOSED';
    this.#hooks.onClosed?.(this);
  }

  /** ACTIVE → CLOSING → CLOSED (shutdown): stop intake, wait for the current delivery, sync. */
  close(): Promise<void> {
    this.#closing ??= this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    if (this.#faulting !== null) return this.#faulting;
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSING';
    await this.#consumer?.stop();
    this.#consumer = null;
    await this.#releaseJournal();
    this.state = 'CLOSED';
    this.#hooks.onClosed?.(this);
  }

  async #releaseJournal(): Promise<void> {
    const j = this.#journal;
    if (j === null) return;
    this.#journal = null;
    this.#d.syncTimer?.delete(j);
    try {
      await j.close(); // syncs first
    } catch (err) {
      this.#d.logger.error('Journal close failed.', { documentId: this.documentId, code: codeOf(err) });
    }
  }

  #faultError(cause: unknown): OpenDocexError {
    if (cause instanceof OpenDocexError && cause.code === 'DOCUMENT_FAULTED' && cause.instanceId === this.epoch) return cause;
    return engineError('DOCUMENT_FAULTED', { documentId: this.documentId, instanceId: this.epoch, cause });
  }

  #asEngineError(err: unknown, fallback: 'DOCUMENT_FAULTED' | 'STORAGE_READ_FAILED'): OpenDocexError {
    if (err instanceof OpenDocexError) return err;
    return engineError(fallback, { documentId: this.documentId, instanceId: this.epoch, cause: err });
  }

  #send(sessionId: string, msg: ServerMessage): void {
    sendTo(this.#d.sink, sessionId, msg);
  }
}

function codeOf(err: unknown): string {
  return OpenDocexError.is(err) ? err.code : 'UNKNOWN';
}
