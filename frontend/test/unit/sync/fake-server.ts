/**
 * The test authority for the text sync client (LLD Part 3 §7.4): an in-memory server that keeps
 * a document and a revision, rebases with the shared `TextOtType.rebase` and applies with
 * `TextOtType.apply`, deduplicates by `(clientId, clientSeq)` and keeps one FIFO per client with
 * controllable delivery. Plus a client harness around a real `EditorView` in jsdom.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Transform, type Step } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import type { ErrorCode } from '@open-docex/shared/errors';
import { newClientId, newEpoch, type ClientId, type Epoch } from '@open-docex/shared/ids';
import type { ServerMessage, SubmitMsg } from '@open-docex/shared/protocol';
import { TextOtType, textSchema, type TextOp } from '@open-docex/shared/text';
import type { SyncEvent } from '../../../src/events.js';
import { collabSyncPlugin, getSyncState } from '../../../src/sync/collabSyncPlugin.js';
import { TextSyncClient } from '../../../src/sync/TextSyncClient.js';
import type { ReloadReason, RestoreNotice, SyncActivity, TextOrphans } from '../../../src/sync/types.js';

const A4 = {
  size: { width: 595.28, height: 841.89 },
  orientation: 'portrait',
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
} as const;

/** A body-only document with one paragraph per text. Text of the first paragraph starts at 2. */
export function bodyDoc(...texts: string[]): PMNode {
  return textSchema.nodeFromJSON({
    type: 'doc',
    attrs: A4,
    content: [
      {
        type: 'body',
        content: texts.map((t) => ({ type: 'paragraph', ...(t ? { content: [{ type: 'text', text: t }] } : {}) })),
      },
    ],
  });
}

/** The steps that insert `text` at `pos` in `doc`. */
export function insertSteps(doc: PMNode, pos: number, text: string): Step[] {
  return new Transform(doc).insert(pos, textSchema.text(text)).steps;
}

/** The ops that insert `text` at `pos` in `doc`. */
export function insertOps(doc: PMNode, pos: number, text: string): TextOp[] {
  return insertSteps(doc, pos, text).map((s) => s.toJSON() as TextOp);
}

/** The texts of the body's paragraphs. */
export function texts(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isTextblock) {
      out.push(n.textContent);
      return false;
    }
    return true;
  });
  return out;
}

/** One committed batch (LLD Part 2 §8.4 journal entry). */
export interface Entry {
  f: number;
  r: number;
  c: ClientId;
  q: number;
  x: boolean;
  o: TextOp[];
}

export class FakeServer {
  doc: PMNode;
  rev: number;
  epoch: Epoch = newEpoch();
  readonly history: Entry[] = [];
  /** Revs below this are trimmed: a submit based on them is answered with `resync`. */
  floorRev: number;
  readonly #lastSeq = new Map<ClientId, number>();
  readonly #out = new Map<ClientId, ServerMessage[]>();
  readonly #connected = new Set<ClientId>();
  /** Submissions received while `holdInbox` is set, not yet processed. */
  readonly inbox: { from: ClientId; msg: SubmitMsg }[] = [];
  holdInbox = false;
  /** Answer the next N submissions with `QUEUE_FULL`. */
  queueFull = 0;
  /** Answer the next submission with this error. */
  rejectNext: ErrorCode | null = null;
  /** Drop the last op of the next batch after rebasing (forces a `committed` correction). */
  dropLastOfNext = false;
  /** Every submission processed, in order. */
  readonly received: SubmitMsg[] = [];

  constructor(doc: PMNode, rev = 0) {
    this.doc = doc;
    this.rev = rev;
    this.floorRev = rev;
  }

  connect(id: ClientId): void {
    this.#connected.add(id);
    if (!this.#out.has(id)) this.#out.set(id, []);
  }

  disconnect(id: ClientId): void {
    this.#connected.delete(id);
    this.#out.set(id, []);
  }

  /** The messages waiting for `id`. */
  queue(id: ClientId): ServerMessage[] {
    return this.#out.get(id) ?? [];
  }

  /** Removes and returns the first `n` messages waiting for `id` (all by default). */
  take(id: ClientId, n = Infinity): ServerMessage[] {
    const q = this.queue(id);
    return q.splice(0, Math.min(n, q.length));
  }

  #push(id: ClientId, m: ServerMessage): void {
    if (this.#connected.has(id)) this.queue(id).push(m);
  }

  receive(from: ClientId, msg: SubmitMsg): void {
    if (this.holdInbox) this.inbox.push({ from, msg });
    else this.#process(from, msg);
  }

  /** Processes held submissions. */
  processInbox(): void {
    for (const { from, msg } of this.inbox.splice(0)) this.#process(from, msg);
  }

  /** `hello { resume: { rev } }` with the current epoch (LLD Part 1 §6 R11, §0 R-8). */
  resume(id: ClientId, rev: number): void {
    this.connect(id);
    for (const e of this.history) {
      if (e.f < rev) continue;
      if (e.c === id) this.#push(id, { type: 'ack', clientSeq: e.q, rev: e.r, ...(e.x ? { committed: e.o } : {}) });
      else if (e.o.length > 0) this.#push(id, { type: 'remote', fromRev: e.f, ops: e.o, clientId: e.c });
    }
  }

  /** Commits ops directly, as another client would (no ack). */
  commitFrom(id: ClientId, ops: TextOp[]): void {
    const seq = (this.#lastSeq.get(id) ?? 0) + 1;
    this.#process(id, { type: 'submit', clientId: id, clientSeq: seq, epoch: this.epoch, baseRev: this.rev, ops });
  }

  /** A restart: a new epoch, with the rev and history kept (C-5). Every client is disconnected. */
  restart(): void {
    this.epoch = newEpoch();
    for (const id of [...this.#connected]) this.disconnect(id);
  }

  #process(from: ClientId, msg: SubmitMsg): void {
    this.received.push(msg);
    const err = (code: ErrorCode, retryable: boolean): void =>
      this.#push(from, { type: 'error', code, retryable, message: code, clientSeq: msg.clientSeq });
    if (this.queueFull > 0) {
      this.queueFull--;
      return err('QUEUE_FULL', true);
    }
    if (this.rejectNext !== null) {
      const code = this.rejectNext;
      this.rejectNext = null;
      return err(code, false);
    }
    if (msg.clientSeq <= (this.#lastSeq.get(from) ?? 0)) {
      const h = this.history.find((e) => e.c === from && e.q === msg.clientSeq);
      if (h === undefined) return this.#push(from, { type: 'resync', reason: 'history-unavailable' });
      return this.#push(from, { type: 'ack', clientSeq: h.q, rev: h.r, ...(h.x ? { committed: h.o } : {}) });
    }
    if (msg.baseRev > this.rev || msg.baseRev < this.floorRev) {
      return this.#push(from, { type: 'resync', reason: 'history-unavailable' });
    }
    const ops = TextOtType.validateOps(msg.ops);
    const over = this.history.filter((e) => e.f >= msg.baseRev).flatMap((e) => e.o);
    let rebased = over.length > 0 ? TextOtType.rebase(ops, over) : ops;
    let forced = 0;
    if (this.dropLastOfNext) {
      this.dropLastOfNext = false;
      rebased = rebased.slice(0, -1);
      forced = 1;
    }
    const r = TextOtType.apply(this.doc, rebased);
    const e: Entry = {
      f: this.rev,
      r: this.rev + r.applied.length,
      c: from,
      q: msg.clientSeq,
      x: over.length > 0 || r.dropped + forced > 0,
      o: r.applied,
    };
    this.doc = r.snapshot;
    this.rev = e.r;
    this.history.push(e);
    this.#lastSeq.set(from, msg.clientSeq);
    this.#push(from, { type: 'ack', clientSeq: e.q, rev: e.r, ...(e.x ? { committed: e.o } : {}) });
    if (e.o.length > 0) {
      for (const id of this.#connected) {
        if (id !== from) this.#push(id, { type: 'remote', fromRev: e.f, ops: e.o, clientId: from });
      }
    }
  }
}

/** Lets queued microtasks (the client's coalesced flush) run. */
export async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

export interface HarnessOptions {
  readOnly?: boolean;
  maxBatchSteps?: number;
}

/** One client: an `EditorView` with the sync plugin, a `TextSyncClient` and recorders. */
export class TestClient {
  readonly id: ClientId = newClientId();
  readonly client: TextSyncClient;
  view: EditorView;
  readOnly: boolean;
  /** Whether `send` reaches the server. */
  online = true;
  readonly sent: SubmitMsg[] = [];
  readonly syncs: SyncEvent[] = [];
  readonly notices: RestoreNotice[] = [];
  readonly errors: ErrorCode[] = [];
  readonly reloads: { reason: ReloadReason; discard: boolean }[] = [];
  readonly activity: SyncActivity[] = [];
  /** What `exportOrphans` returned when the client asked for a reload. */
  orphansAtReload: TextOrphans | null = null;

  constructor(
    readonly server: FakeServer,
    opts: HarnessOptions = {},
  ) {
    this.readOnly = opts.readOnly ?? false;
    this.client = new TextSyncClient({
      view: () => this.view,
      clientId: this.id,
      send: (m) => {
        this.sent.push(m);
        if (this.online) this.server.receive(this.id, m);
        return this.online;
      },
      emit: (e) => this.syncs.push(e),
      reload: (reason, discard) => {
        this.reloads.push({ reason, discard });
        // Like the session: orphans are taken at once, unless discarded.
        this.orphansAtReload = discard ? null : this.client.exportOrphans();
      },
      notify: (n) => this.notices.push(n),
      onError: (code) => this.errors.push(code),
      activity: (a) => this.activity.push(a),
      random: () => 0.5,
      ...(opts.maxBatchSteps !== undefined ? { maxBatchSteps: opts.maxBatchSteps } : {}),
    });
    this.view = new EditorView(document.createElement('div'), { state: this.#state(server.doc) });
    server.connect(this.id);
    this.client.start({ epoch: server.epoch, rev: server.rev, readOnly: this.readOnly });
  }

  /** Shows a loaded document in a fresh state, as the binding does at `load-done`. */
  show(doc: PMNode): void {
    this.view.updateState(this.#state(doc));
  }

  #state(doc: PMNode): EditorState {
    return EditorState.create({ doc, plugins: [collabSyncPlugin(this.client, { readOnly: this.readOnly })] });
  }

  get doc(): PMNode {
    return this.view.state.doc;
  }

  get pending(): number {
    return getSyncState(this.view.state).pending.length;
  }

  get inflightCount(): number {
    return getSyncState(this.view.state).inflightCount;
  }

  get caret(): number {
    return this.view.state.selection.head;
  }

  /** Types `text` at `pos` (default: the caret) and lets the flush run. */
  async type(text: string, pos = this.caret): Promise<void> {
    const tr = this.view.state.tr.insertText(text, pos);
    tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
    this.view.dispatch(tr);
    await tick();
  }

  /** Delivers up to `n` waiting server messages, routing them like the session does. */
  async deliver(n = Infinity): Promise<void> {
    for (const m of this.server.take(this.id, n)) {
      if (m.type === 'remote') this.client.onRemote(m);
      else if (m.type === 'ack') this.client.onAck(m);
      else if (m.type === 'error' && m.clientSeq !== undefined) this.client.onSubmitError(m);
      await tick();
    }
  }

  /** The socket drops (§6.1). */
  disconnect(): void {
    this.online = false;
    this.server.disconnect(this.id);
    this.client.onDisconnected();
  }

  /** Reconnects with `hello { resume }` (§6.1): the server replays, then the client resends. */
  async resume(): Promise<void> {
    const info = this.client.resumeInfo();
    if (info === null) throw new Error('not started');
    this.online = true;
    this.server.resume(this.id, info.rev);
    this.client.onReconnected();
    await tick();
  }

  /**
   * A full reload like the session's (§3, §6.2): exports orphans, shows the server's current
   * document in a fresh state, starts, then restores the orphans.
   */
  async reload(opts: { readOnly?: boolean; orphans?: TextOrphans | null } = {}): Promise<TextOrphans | null> {
    const orphans = opts.orphans !== undefined ? opts.orphans : this.client.exportOrphans();
    this.client.onDisconnected();
    this.readOnly = opts.readOnly ?? this.readOnly;
    this.online = true;
    this.server.connect(this.id);
    this.server.take(this.id);
    this.show(this.server.doc);
    this.client.start({ epoch: this.server.epoch, rev: this.server.rev, readOnly: this.readOnly });
    this.client.restoreOrphans(orphans, { epoch: this.server.epoch, rev: this.server.rev });
    await tick();
    return orphans;
  }

  destroy(): void {
    this.client.destroy();
    this.view.destroy();
  }
}

/** Delivers to every client until no messages are left. */
export async function settle(...clients: TestClient[]): Promise<void> {
  for (let round = 0; round < 50; round++) {
    if (clients.every((c) => c.server.queue(c.id).length === 0)) return;
    for (const c of clients) await c.deliver();
  }
  throw new Error('did not settle');
}
