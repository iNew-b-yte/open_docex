/**
 * `TextSyncClient`: the client side of CL-6 for text documents (LLD Part 3 §6–§7, HLD §13).
 *
 * - **Jupiter discipline:** at most one batch is in flight; later local steps wait in the
 *   plugin's buffer. Every `remote` is applied in one rebuild transaction (§7.2).
 * - **The `committed` echo** (Part 1 §8.6): an `ack` whose `committed` differs from the
 *   in-flight steps as currently held replaces them with the server's version.
 * - **Resume and rescue** (§6.1, §6.2, §0 PO-16, R-8): the in-flight envelope is resent after a
 *   resume; across a reload, unconfirmed changes are carried as {@link TextOrphans} and either
 *   re-applied locally or sent as a rescue that the server rebases.
 * - **Read-only** (§0 L-15): a document that turns read-only with unconfirmed changes discards
 *   them and shows `labels.restore.discarded`. A read-only client never sends `submit`.
 *
 * It implements the session's {@link SessionSync} port (§0 S-35).
 *
 * @module
 */
import type { Transaction } from 'prosemirror-state';
import type { Step } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import type { Epoch } from '@open-docex/shared/ids';
import type { AckMsg, ErrorMsg, RemoteMsg, SubmitEnvelope, SubmitMsg } from '@open-docex/shared/protocol';
import { applyStepsWithDrop, rebaseSteps, textOpsEqual, type TextOp } from '@open-docex/shared/text';
import { policyFor } from '../errors/policy.js';
import type { SyncEvent } from '../events.js';
import { fullJitter } from '../net/backoff.js';
import type { ReadOnlyReason, SessionSync } from '../session/ports.js';
import { getSyncState, syncKey } from './collabSyncPlugin.js';
import {
  DEFAULT_MAX_BATCH_STEPS,
  SUBMIT_RETRY_BASE_MS,
  SUBMIT_RETRY_MAX_MS,
  type ReloadReason,
  type SyncActivity,
  type SyncMeta,
  type TextOrphans,
  type TextSyncDeps,
} from './types.js';
import { parseSteps, rebuild, stepsJson } from './xform.js';

/** The canonical `SubmitMsg` for an envelope (LLD Part 3 §6). */
export function toSubmitMsg(env: SubmitEnvelope<TextOp>): SubmitMsg<TextOp> {
  return {
    type: 'submit',
    clientId: env.clientId,
    clientSeq: env.clientSeq,
    epoch: env.epoch,
    baseRev: env.baseRev,
    ops: env.ops,
  };
}

/** An envelope on the wire, resent unchanged after `QUEUE_FULL` or a resume (dedupe-safe, CL-12). */
interface Sent {
  readonly clientSeq: number;
  readonly sent: SubmitEnvelope<TextOp>;
  /** `QUEUE_FULL` answers so far: the backoff attempt. */
  attempts: number;
}

/** A rescue in flight (§6.2): orphans sent with their old `baseRev` for the server to rebase. */
interface Rescue extends Sent {
  /** `P`: the steps sent, based on `baseRev`. */
  readonly steps: readonly Step[];
  readonly baseRev: number;
  /** `N`: the rev of the load that started the rescue. An ack at or below it is a duplicate. */
  readonly loadRev: number;
  /** How many of `steps` were the batch in flight before the reload. */
  readonly inflightCount: number;
}

/** The text sync client (LLD Part 3 §7.1). One per mount; it survives reloads. */
export class TextSyncClient implements SessionSync<TextOrphans> {
  readonly #deps: TextSyncDeps;
  readonly #maxBatch: number;
  #started = false;
  #destroyed = false;
  #epoch = '';
  #confirmedRev = 0;
  /** `clientSeq` starts at 1 per `clientId` and only goes up, across reloads (R9). */
  #nextSeq = 1;
  #connected = false;
  #inflight: Sent | null = null;
  #rescue: Rescue | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #flushQueued = false;
  /** Read-only from outside: view access, unsupported content or the server. */
  #baseReadOnly = false;
  #activity: SyncActivity = 'idle';
  #lastSync: SyncEvent | null = null;
  /**
   * Steps of the remotes applied since `start`, until `restoreOrphans` runs. The session
   * applies the remotes buffered during the load first, so orphans re-applied locally must be
   * rebased over them.
   */
  #sinceStart: Step[] | null = null;

  constructor(deps: TextSyncDeps) {
    this.#deps = deps;
    this.#maxBatch = Math.max(1, deps.maxBatchSteps ?? DEFAULT_MAX_BATCH_STEPS);
  }

  /**
   * Starts (or restarts, after a reload) from a loaded document. The binding has already shown
   * the snapshot, so the plugin holds no pending steps. The socket is open.
   */
  start(p: { epoch: string; rev: number; readOnly: boolean }): void {
    if (this.#destroyed) return;
    this.#clearRetry();
    this.#started = true;
    this.#epoch = p.epoch;
    this.#confirmedRev = p.rev;
    this.#connected = true;
    this.#inflight = null;
    this.#rescue = null;
    this.#baseReadOnly = p.readOnly;
    this.#sinceStart = [];
    this.#syncReadOnly();
    this.#setActivity('idle');
    this.#emitSync();
  }

  /** Called by the plugin after every view update. Same-tick transactions share one flush. */
  scheduleFlush(): void {
    if (this.#flushQueued || this.#destroyed) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      if (!this.#destroyed) this.#flush();
    });
  }

  /** Another client's committed steps, or (defensively, R-8) our own replayed (§7.3). */
  onRemote(m: RemoteMsg): void {
    if (!this.#started || this.#destroyed) return;
    const end = m.fromRev + m.ops.length;
    if (end <= this.#confirmedRev) return; // overlap after a resume
    if (m.fromRev !== this.#confirmedRev) return this.#reload('gap', false);
    if (m.clientId === this.#deps.clientId) {
      if (this.#rescue !== null) return this.#finishRescue(m.ops, end);
      return this.#inflight !== null ? this.#confirm(m.ops, end) : this.#reload('own-without-inflight', false);
    }
    const over = parseSteps(m.ops);
    if (over === null) return this.#reload('bad-step', false);
    const view = this.#view();
    const ps = getSyncState(view.state);
    let r;
    try {
      r = rebuild(view.state, ps.pending, over);
    } catch {
      return this.#reload('remote-apply', false);
    }
    const inflightCount = r.kept.filter((i) => i < ps.inflightCount).length;
    this.#dispatchMeta(r.tr, { kind: 'rebuild', pending: r.newKeep, inflightCount });
    this.#confirmedRev = m.fromRev + over.length;
    this.#sinceStart?.push(...over);
    this.#emitSync();
  }

  /** The server committed one of our batches (§7.3). Acks we have nothing in flight for are ignored (C-4). */
  onAck(m: AckMsg): void {
    if (!this.#started || this.#destroyed) return;
    if (this.#rescue !== null && m.clientSeq === this.#rescue.clientSeq) return this.#rescueAck(m);
    if (this.#inflight === null || m.clientSeq !== this.#inflight.clientSeq) return;
    this.#confirm(m.committed, m.rev);
  }

  /** An `ErrorMsg` with `clientSeq`: applies the §16 policy to the batch it answers. */
  onSubmitError(m: ErrorMsg): void {
    if (!this.#started || this.#destroyed || m.clientSeq === undefined) return;
    if (this.#rescue !== null && m.clientSeq === this.#rescue.clientSeq) return this.#rescueFailed(m);
    const inflight = this.#inflight;
    if (inflight === null || m.clientSeq !== inflight.clientSeq) return;
    switch (policyFor({ code: m.code, retryable: m.retryable, clientSeq: m.clientSeq }, 'live')) {
      case 'retry-submit':
        this.#setActivity('busy');
        return this.#scheduleRetry(inflight);
      case 'reload':
        return this.#reload(m.code, false);
      case 'discard-reload':
        if (this.#pendingCount() > 0) this.#deps.notify('discarded');
        return this.#reload(m.code, true);
      default:
        // Connection-level (reconnect, terminal): the server closes the socket and the session
        // decides. The batch stays in flight and is resent after a resume.
        return;
    }
  }

  /** The socket closed. In-flight and buffered steps are kept; their fate is unknown (§6.1). */
  onDisconnected(): void {
    this.#connected = false;
    this.#clearRetry();
    this.#setActivity(this.#rescue !== null ? 'restoring' : 'idle');
  }

  /** Called right after `hello { resume }`: resends the original envelope, or flushes (§6.1). */
  onReconnected(): void {
    if (!this.#started || this.#destroyed) return;
    this.#connected = true;
    if (this.#baseReadOnly) return;
    if (this.#rescue !== null) this.#send(this.#rescue.sent);
    else if (this.#inflight !== null) this.#send(this.#inflight.sent);
    else this.#flush();
  }

  /**
   * Switches read-only on or off. Turning it on with unconfirmed changes discards them with the
   * `restore.discarded` notice and reloads (§0 L-15). Turning it off flushes.
   */
  setReadOnly(ro: boolean, reason: ReadOnlyReason): void {
    void reason; // The plugin only needs on/off; the session shows the reason.
    if (!this.#started || this.#destroyed) return;
    this.#baseReadOnly = ro;
    this.#syncReadOnly();
    if (!ro) return this.#flush();
    if (this.#pendingCount() === 0) return;
    this.#clearRetry();
    this.#inflight = null;
    this.#rescue = null;
    this.#setActivity('idle');
    this.#deps.notify('discarded');
    this.#reload('read-only', true);
  }

  /**
   * Captures unconfirmed changes before a reload (§6.2): `P` is the in-flight steps followed by
   * the buffer, all based on the confirmed rev. A rescue that got no answer is exported as is,
   * marked `rescueSent`. Null when nothing is unconfirmed.
   */
  exportOrphans(): TextOrphans | null {
    if (!this.#started || this.#destroyed) return null;
    const rescue = this.#rescue;
    if (rescue !== null) {
      return {
        epoch: this.#epoch,
        baseRev: rescue.baseRev,
        inflightSeq: rescue.clientSeq,
        inflightCount: rescue.inflightCount,
        pending: rescue.steps,
        rescueSent: true,
      };
    }
    const ps = getSyncState(this.#view().state);
    if (ps.pending.length === 0) return null;
    const inflight = this.#inflight;
    return {
      epoch: this.#epoch,
      baseRev: this.#confirmedRev,
      ...(inflight !== null ? { inflightSeq: inflight.clientSeq } : {}),
      inflightCount: inflight !== null ? ps.inflightCount : 0,
      pending: ps.pending.map((p) => p.step),
      rescueSent: false,
    };
  }

  /**
   * Restores orphans after `load-done { rev: N }` (§6.2, §0 PO-16, L-15):
   * - read-only document: they are discarded with `restore.discarded`;
   * - `N == R`: nothing was committed after their base, so they are re-applied locally
   *   (dropping steps that no longer apply) and sent as new pending changes;
   * - `N > R`: they are sent as a rescue with `baseRev: R`, reusing the in-flight `clientSeq`
   *   so a batch committed before the restart is deduplicated, and the editor is read-only
   *   (`restoring`) until the answer;
   * - a rescue that already went unanswered, or `N < R`: the server cannot rebase them, so
   *   they are dropped with `restore.partialLoss` and `SESSION_RESYNC_REQUIRED` (PO-16).
   */
  restoreOrphans(o: TextOrphans | null, load: { epoch: string; rev: number }): void {
    const sinceStart = this.#sinceStart ?? [];
    this.#sinceStart = null;
    if (!this.#started || this.#destroyed || o === null || o.pending.length === 0) return;
    if (this.#baseReadOnly) return this.#deps.notify('discarded');
    const n = load.rev;
    const r = o.baseRev;
    if (n === r) {
      const view = this.#view();
      const tr = view.state.tr;
      applyStepsWithDrop(tr, sinceStart.length > 0 ? rebaseSteps(o.pending, sinceStart) : o.pending);
      // A plain local transaction: the plugin records the steps as pending and schedules a flush.
      if (tr.docChanged) view.dispatch(tr);
      return;
    }
    if (o.rescueSent || n < r) {
      this.#deps.notify('partialLoss');
      this.#deps.onError('SESSION_RESYNC_REQUIRED');
      return;
    }
    const clientSeq = o.inflightSeq ?? this.#nextSeq++;
    const sent: SubmitEnvelope<TextOp> = {
      clientId: this.#deps.clientId,
      clientSeq,
      epoch: load.epoch as Epoch,
      baseRev: r,
      ops: stepsJson(o.pending),
    };
    this.#rescue = {
      clientSeq,
      sent,
      attempts: 0,
      steps: o.pending,
      baseRev: r,
      loadRev: n,
      inflightCount: o.inflightCount,
    };
    this.#syncReadOnly();
    this.#setActivity('restoring');
    this.#emitSync();
    if (this.#connected) this.#send(sent);
  }

  /** `{ epoch, rev: confirmedRev }` for `hello.resume`, or null before the first load. */
  resumeInfo(): { epoch: string; rev: number } | null {
    if (!this.#started || this.#destroyed) return null;
    return { epoch: this.#epoch, rev: this.#confirmedRev };
  }

  /** Stops timers and drops the network state. Idempotent. */
  destroy(): void {
    this.#destroyed = true;
    this.#connected = false;
    this.#clearRetry();
    this.#inflight = null;
    this.#rescue = null;
    this.#sinceStart = null;
  }

  // --- internals ------------------------------------------------------------------------------

  #view(): EditorView {
    return this.#deps.view();
  }

  /** Sends the next batch when connected, idle, editable and something is pending (§7.3). */
  #flush(): void {
    if (!this.#started || this.#destroyed) return;
    const view = this.#view();
    const ps = getSyncState(view.state);
    if (this.#connected && this.#inflight === null && this.#rescue === null && !ps.readOnly && ps.pending.length > 0) {
      const batch = ps.pending.slice(0, Math.min(this.#maxBatch, ps.pending.length));
      const sent: SubmitEnvelope<TextOp> = {
        clientId: this.#deps.clientId,
        clientSeq: this.#nextSeq++,
        epoch: this.#epoch as Epoch,
        baseRev: this.#confirmedRev,
        ops: stepsJson(batch.map((p) => p.step)),
      };
      this.#inflight = { clientSeq: sent.clientSeq, sent, attempts: 0 };
      this.#dispatchMeta(view.state.tr, { kind: 'set-inflight', inflightCount: batch.length });
      this.#send(sent);
    }
    // Also reports buffered typing while offline or waiting, so `pendingCount` is never stale (L-14).
    this.#emitSync();
  }

  /**
   * Confirms the in-flight batch at `rev` (§7.3). Without `committed`, or with a `committed`
   * equal to the in-flight steps as currently held, the steps just become confirmed. Otherwise
   * one correction transaction swaps them for the server's (Part 1 §8.6, CL-6).
   */
  #confirm(committed: readonly unknown[] | undefined, rev: number): void {
    const view = this.#view();
    const ps = getSyncState(view.state);
    const k = ps.inflightCount;
    const local = ps.pending.slice(0, k);
    const n = committed !== undefined ? committed.length : k;
    if (rev !== this.#confirmedRev + n) return this.#reload('ack-rev', false);
    const rest = ps.pending.slice(k);
    if (committed === undefined || textOpsEqual(committed as readonly TextOp[], stepsJson(local.map((p) => p.step)))) {
      this.#dispatchMeta(view.state.tr, { kind: 'rebuild', pending: rest, inflightCount: 0 }); // no doc change
    } else {
      const steps = parseSteps(committed);
      if (steps === null) return this.#reload('bad-step', false);
      const over = [...local.map((p) => p.inverted).reverse(), ...steps];
      let r;
      try {
        r = rebuild(view.state, rest, over);
      } catch {
        return this.#reload('correction', false);
      }
      this.#dispatchMeta(r.tr, { kind: 'rebuild', pending: r.newKeep, inflightCount: 0 });
    }
    this.#confirmedRev = rev;
    this.#inflight = null;
    this.#clearRetry();
    this.#setActivity('idle');
    this.#emitSync();
    this.#flush();
  }

  /** The answer to a rescue (§6.2). */
  #rescueAck(m: AckMsg): void {
    const rescue = this.#rescue as Rescue;
    if (m.rev <= rescue.loadRev) {
      // A duplicate: the in-flight batch was committed before the restart and is in the
      // snapshot. Anything buffered after it is lost.
      if (rescue.steps.length > rescue.inflightCount) {
        this.#deps.notify('partialLoss');
        this.#deps.onError('SESSION_RESYNC_REQUIRED');
      }
      return this.#endRescue();
    }
    this.#finishRescue(m.committed ?? stepsJson(rescue.steps), m.rev);
  }

  /** Applies the server's version of a committed rescue as confirmed, not pending (§6.2). */
  #finishRescue(committed: readonly unknown[], rev: number): void {
    // The rescue is answered either way: on a reload below, the new load contains it.
    this.#rescue = null;
    if (rev !== this.#confirmedRev + committed.length) {
      this.#endRescue(false);
      return this.#reload('ack-rev', false);
    }
    const steps = parseSteps(committed);
    if (steps === null) {
      this.#endRescue(false);
      return this.#reload('bad-step', false);
    }
    const view = this.#view();
    const ps = getSyncState(view.state);
    let r;
    try {
      r = rebuild(view.state, ps.pending, steps);
    } catch {
      this.#endRescue(false);
      return this.#reload('rescue-apply', false);
    }
    const inflightCount = r.kept.filter((i) => i < ps.inflightCount).length;
    this.#dispatchMeta(r.tr, { kind: 'rebuild', pending: r.newKeep, inflightCount });
    this.#confirmedRev = rev;
    this.#endRescue();
  }

  /**
   * A submit error for the rescue (§6.2). `QUEUE_FULL` retries it like any batch, and a
   * connection-level error keeps it for the resend after a resume. Any other error means the
   * server will not apply it: `restore.lost`, then the code's own policy.
   */
  #rescueFailed(m: ErrorMsg): void {
    const rescue = this.#rescue as Rescue;
    const policy = policyFor({ code: m.code, retryable: m.retryable, clientSeq: rescue.clientSeq }, 'live');
    if (policy === 'retry-submit') return this.#scheduleRetry(rescue);
    if (policy !== 'reload' && policy !== 'discard-reload') return;
    this.#rescue = null;
    this.#deps.notify('lost');
    this.#endRescue(false);
    this.#reload(m.code, policy === 'discard-reload');
  }

  /** Leaves rescue mode: editable again (unless read-only from outside), then flushes. */
  #endRescue(flush = true): void {
    this.#rescue = null;
    this.#clearRetry();
    this.#syncReadOnly();
    this.#setActivity('idle');
    this.#emitSync();
    if (flush) this.#flush();
  }

  /** Resends `target`'s original envelope after full-jitter backoff (§7.3, LLD choice). */
  #scheduleRetry(target: Sent): void {
    target.attempts++;
    this.#clearRetry();
    const delay = fullJitter(SUBMIT_RETRY_BASE_MS, SUBMIT_RETRY_MAX_MS, target.attempts, this.#deps.random);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      const current = this.#rescue ?? this.#inflight;
      if (this.#connected && current === target && !this.#destroyed) this.#send(target.sent);
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** Sends an envelope. A read-only client never submits (HLD §13): a violation is a bug. */
  #send(env: SubmitEnvelope<TextOp>): void {
    if (this.#baseReadOnly) throw new Error('TextSyncClient: submit while read-only.');
    this.#deps.send(toSubmitMsg(env));
  }

  #reload(reason: ReloadReason, discard: boolean): void {
    this.#deps.reload(reason, discard);
  }

  /** Makes the plugin's read-only flag match: read-only from outside, or restoring. */
  #syncReadOnly(): void {
    const view = this.#view();
    const want = this.#baseReadOnly || this.#rescue !== null;
    if (getSyncState(view.state).readOnly !== want) {
      this.#dispatchMeta(view.state.tr, { kind: 'read-only', readOnly: want });
    }
  }

  #dispatchMeta(tr: Transaction, meta: SyncMeta): void {
    this.#view().dispatch(tr.setMeta(syncKey, meta));
  }

  /** Unconfirmed steps: pending in the editor plus a rescue on the wire. */
  #pendingCount(): number {
    return getSyncState(this.#view().state).pending.length + (this.#rescue?.steps.length ?? 0);
  }

  /** Emits `sync` when the pending count or the confirmed rev changed. */
  #emitSync(): void {
    if (!this.#started || this.#destroyed) return;
    const e: SyncEvent = { pendingCount: this.#pendingCount(), confirmedRev: this.#confirmedRev };
    const last = this.#lastSync;
    if (last !== null && last.pendingCount === e.pendingCount && last.confirmedRev === e.confirmedRev) return;
    this.#lastSync = e;
    this.#deps.emit(e);
  }

  #setActivity(a: SyncActivity): void {
    if (this.#activity === a) return;
    this.#activity = a;
    this.#deps.activity?.(a);
  }
}
