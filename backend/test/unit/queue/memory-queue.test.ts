import { OpenDocexError } from '@open-docex/shared/errors';
import { asDocumentId, type DocumentId } from '@open-docex/shared/ids';
import type { SubmitEnvelope } from '@open-docex/shared/protocol';
import { describe, expect, it } from 'vitest';
import { MemoryQueue } from '../../../src/queue/memory-queue.js';
import type { QueueDelivery, QueueItem } from '../../../src/queue/queue-adapter.js';

const A = asDocumentId('doc-a');
const B = asDocumentId('doc-b');

function item(documentId: DocumentId, clientSeq: number): QueueItem {
  const envelope = { clientId: 'c', clientSeq, epoch: 'e', baseRev: 0, ops: [] } as unknown as SubmitEnvelope;
  return { documentId, sessionId: 's', userId: 'u', access: 'edit', receivedAt: 0, envelope };
}

/** Lets queued microtasks and promise continuations run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const seqOf = (d: QueueDelivery): number => d.item.envelope.clientSeq;

describe('MemoryQueue', () => {
  it('is a memory adapter and starts without a backlog', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    expect(q.kind).toBe('memory');
    let backlog = 0;
    await q.start({ onBacklog: () => backlog++ });
    expect(backlog).toBe(0);
  });

  it('delivers one document in FIFO order, serially', async () => {
    const q = new MemoryQueue({ perDocument: 100, global: 100 });
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;
    q.consume(A, async (d) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await settle();
      seen.push(seqOf(d));
      active--;
      await d.ack();
    });
    for (let i = 1; i <= 20; i++) expect(await q.enqueue(item(A, i))).toEqual({ ok: true });
    for (let i = 0; i < 30; i++) await settle();
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(maxActive).toBe(1);
    expect(q.depth(A)).toBe(0);
  });

  it('delivers items enqueued before the consumer attached, with redelivered false', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    await q.enqueue(item(A, 1));
    await q.enqueue(item(A, 2));
    const seen: [number, boolean][] = [];
    q.consume(A, async (d) => {
      seen.push([seqOf(d), d.redelivered]);
      await d.ack();
    });
    await settle();
    expect(seen).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it('does not deliver synchronously inside enqueue', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    const seen: number[] = [];
    q.consume(A, async (d) => {
      seen.push(seqOf(d));
      await d.ack();
    });
    const p = q.enqueue(item(A, 1));
    expect(seen).toEqual([]);
    await p;
    await settle();
    expect(seen).toEqual([1]);
  });

  it('returns QUEUE_FULL over the per-document bound', async () => {
    const q = new MemoryQueue({ perDocument: 2, global: 100 });
    expect(await q.enqueue(item(A, 1))).toEqual({ ok: true });
    expect(await q.enqueue(item(A, 2))).toEqual({ ok: true });
    expect(await q.enqueue(item(A, 3))).toEqual({ ok: false, code: 'QUEUE_FULL' });
    expect(await q.enqueue(item(B, 1))).toEqual({ ok: true });
    expect(q.depth(A)).toBe(2);
  });

  it('returns QUEUE_FULL over the global bound', async () => {
    const q = new MemoryQueue({ perDocument: 100, global: 3 });
    await q.enqueue(item(A, 1));
    await q.enqueue(item(A, 2));
    await q.enqueue(item(B, 1));
    expect(await q.enqueue(item(B, 2))).toEqual({ ok: false, code: 'QUEUE_FULL' });
    expect(await q.enqueue(asItemForNewDoc())).toEqual({ ok: false, code: 'QUEUE_FULL' });
  });

  it('frees bound capacity on ack', async () => {
    const q = new MemoryQueue({ perDocument: 1, global: 1 });
    const gates: QueueDelivery[] = [];
    q.consume(A, (d) => {
      gates.push(d);
      return Promise.resolve();
    });
    await q.enqueue(item(A, 1));
    await settle();
    expect(await q.enqueue(item(A, 2))).toEqual({ ok: false, code: 'QUEUE_FULL' });
    await gates[0]!.ack();
    expect(await q.enqueue(item(A, 2))).toEqual({ ok: true });
  });

  it('counts depth from enqueue until ack, including the item in delivery', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    const gate = deferred();
    const depths: number[] = [];
    q.consume(A, async (d) => {
      depths.push(q.depth(A));
      await gate.promise;
      await d.ack();
      depths.push(q.depth(A));
    });
    const p1 = q.enqueue(item(A, 1));
    const p2 = q.enqueue(item(A, 2));
    expect(q.depth(A)).toBe(2);
    await Promise.all([p1, p2]);
    await settle();
    expect(q.depth(A)).toBe(2);
    gate.resolve();
    await settle();
    expect(depths).toEqual([2, 1, 1, 0]);
    expect(q.depth(A)).toBe(0);
    expect(q.depth(B)).toBe(0);
  });

  it('does not let a slow consumer block other documents', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    const gate = deferred();
    q.consume(A, async (d) => {
      await gate.promise;
      await d.ack();
    });
    const seenB: number[] = [];
    q.consume(B, async (d) => {
      seenB.push(seqOf(d));
      await d.ack();
    });
    await q.enqueue(item(A, 1));
    await q.enqueue(item(B, 1));
    await q.enqueue(item(B, 2));
    await settle();
    expect(seenB).toEqual([1, 2]);
    expect(q.depth(A)).toBe(1);
    gate.resolve();
    await settle();
    expect(q.depth(A)).toBe(0);
  });

  it('allows only one consumer per document', () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    q.consume(A, () => Promise.resolve());
    let err: unknown;
    try {
      q.consume(A, () => Promise.resolve());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OpenDocexError);
    expect((err as OpenDocexError).code).toBe('QUEUE_UNAVAILABLE');
    expect((err as OpenDocexError).documentId).toBe(A);
    expect(() => q.consume(B, () => Promise.resolve())).not.toThrow();
  });

  it('stops the pump on an un-acked delivery and resumes on a late ack', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    const got: QueueDelivery[] = [];
    q.consume(A, (d) => {
      got.push(d);
      return Promise.resolve();
    });
    await q.enqueue(item(A, 1));
    await q.enqueue(item(A, 2));
    await settle();
    expect(got.map(seqOf)).toEqual([1]);
    await got[0]!.ack();
    await settle();
    expect(got.map(seqOf)).toEqual([1, 2]);
    await got[1]!.ack();
    await got[1]!.ack(); // a second ack has no further effect
    expect(q.depth(A)).toBe(0);
    expect(await q.enqueue(item(A, 3))).toEqual({ ok: true });
    expect(q.depth(A)).toBe(1);
  });

  it('treats a throwing delivery without an ack as un-acked', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    const got: number[] = [];
    q.consume(A, (d) => {
      got.push(seqOf(d));
      return Promise.reject(new Error('boom'));
    });
    await q.enqueue(item(A, 1));
    await q.enqueue(item(A, 2));
    await settle();
    expect(got).toEqual([1]);
    expect(q.depth(A)).toBe(2);
  });

  it('drains the document on stop, waits for the delivery in progress, and ignores stale acks', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 3 });
    const gate = deferred();
    let first: QueueDelivery | undefined;
    const c = q.consume(A, async (d) => {
      first = d;
      await gate.promise;
    });
    await q.enqueue(item(A, 1));
    await q.enqueue(item(A, 2));
    await q.enqueue(item(A, 3));
    await settle();
    let stopped = false;
    const stopping = c.stop().then(() => (stopped = true));
    expect(q.depth(A)).toBe(0);
    await settle();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    await first!.ack();
    expect(q.depth(A)).toBe(0);
    // global capacity was released by the drain
    for (let i = 1; i <= 3; i++) expect(await q.enqueue(item(B, i))).toEqual({ ok: true });
    await c.stop(); // idempotent
  });

  it('lets a new consumer attach after stop, without overlapping the old delivery', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    const gate = deferred();
    let oldActive = false;
    const c = q.consume(A, async () => {
      oldActive = true;
      await gate.promise;
      oldActive = false;
    });
    await q.enqueue(item(A, 1));
    await settle();
    void c.stop();
    const overlap: boolean[] = [];
    const seen: number[] = [];
    q.consume(A, async (d) => {
      overlap.push(oldActive);
      seen.push(seqOf(d));
      await d.ack();
    });
    await q.enqueue(item(A, 2));
    await settle();
    expect(seen).toEqual([]);
    gate.resolve();
    await settle();
    expect(seen).toEqual([2]);
    expect(overlap).toEqual([false]);
  });

  it('close stops consumers, drops items and refuses new work', async () => {
    const q = new MemoryQueue({ perDocument: 10, global: 10 });
    q.consume(A, () => Promise.resolve());
    await q.enqueue(item(A, 1));
    await q.enqueue(item(B, 1));
    await q.close();
    expect(q.depth(A)).toBe(0);
    expect(q.depth(B)).toBe(0);
    expect(await q.enqueue(item(A, 2))).toEqual({ ok: false, code: 'QUEUE_UNAVAILABLE' });
    expect(() => q.consume(B, () => Promise.resolve())).toThrow(OpenDocexError);
  });

  it('keeps FIFO order across ring-buffer growth and wrap-around', async () => {
    const q = new MemoryQueue({ perDocument: 1000, global: 1000 });
    const got: QueueDelivery[] = [];
    q.consume(A, (d) => {
      got.push(d);
      return Promise.resolve();
    });
    let next = 1;
    const expected: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 37; i++) {
        expected.push(next);
        await q.enqueue(item(A, next++));
      }
      for (let i = 0; i < 20; i++) {
        await settle();
        await got[got.length - 1]!.ack();
      }
    }
    for (;;) {
      await settle();
      const last = got[got.length - 1]!;
      if (q.depth(A) === 0) break;
      await last.ack();
    }
    expect(got.map(seqOf)).toEqual(expected);
  });
});

function asItemForNewDoc(): QueueItem {
  return item(asDocumentId('doc-c'), 1);
}
