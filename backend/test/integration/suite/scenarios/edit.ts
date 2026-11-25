// HLD §10.2 "Concurrent edit, ack and broadcast", plus dedupe after a resend (HLD §10.5 step 4,
// LLD Part 1 §6 R10) and resume without a crash (R11, R-8).
import { TextOtType, type TextOp } from '@open-docex/shared/text';
import type { AckMsg } from '@open-docex/shared/protocol';
import { expect } from 'vitest';
import { waitFor } from '../../../wait-for.js';
import { isType } from '../../test-client.js';
import { appendOp, insertOp, loadedDoc, loadedText, docText, posIn } from '../doc-helpers.js';
import { ackOf, id, readOnlyNotice } from '../helpers.js';
import type { Scenario } from '../register.js';

/** Applies `ops` to a document with the shared text type, as a client would. */
function applyOps(doc: ReturnType<typeof loadedDoc>, ops: unknown[]): ReturnType<typeof loadedDoc> {
  return TextOtType.apply(doc, ops as TextOp[]).snapshot;
}

export const editScenarios: Scenario[] = [
  {
    name: '10.2 two clients edit in turn: acks go to the sender, remotes to the others, revs are consecutive',
    run: async (rig) => {
      await rig.addFile('doc', 'Hello');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');

      const ack1 = await alice.c.submit([appendOp('Hello', ' world')]);
      expect(ack1).toMatchObject({ type: 'ack', rev: 1, clientSeq: 1 });
      expect(ack1.committed).toBeUndefined(); // not transformed

      const remote = await bob.c.waitFor(isType('remote'));
      expect(remote).toMatchObject({ clientId: alice.c.clientId, fromRev: 0, ops: [appendOp('Hello', ' world')] });
      expect(bob.c.rev).toBe(1);

      const ack2 = await bob.c.submit([appendOp('Hello world', '!')]);
      expect(ack2).toMatchObject({ rev: 2, clientSeq: 1 });
      const back = await alice.c.waitFor(isType('remote'), { from: alice.c.messages.indexOf(ack1) + 1 });
      expect(back).toMatchObject({ clientId: bob.c.clientId, fromRev: 1, ops: [appendOp('Hello world', '!')] });

      // A sender never gets its own batch back as a remote.
      expect(alice.c.all(isType('remote')).every((m) => m.clientId !== alice.c.clientId)).toBe(true);
      expect(bob.c.all(isType('remote')).every((m) => m.clientId !== bob.c.clientId)).toBe(true);
      expect(await rig.engine.shareInfo(id('doc'))).toMatchObject({ sessions: { edit: 2, view: 0 } });
      expect(await rig.textOf('doc')).toBe('Hello world!');
    },
  },
  {
    name: '10.2 BRD §3 "cat": two clients insert after "c" from the same rev and converge to "choat"',
    run: async (rig) => {
      await rig.addFile('doc', 'cat');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');
      const base = loadedDoc(alice.load);
      const afterC = posIn('cat', 0, 1);

      // Both type at the same position on rev 0. Alice reaches the server first (we wait for her
      // ack), so Bob's batch is rebased over hers: his "o" lands after her "h".
      const mine = [insertOp(afterC, 'h')];
      const ackA = await alice.c.submit(mine);
      expect(ackA).toMatchObject({ rev: 1 });
      expect(ackA.committed).toBeUndefined();
      const fromB = bob.c.mark();
      const seqB = bob.c.sendSubmit([insertOp(afterC, 'o')], { baseRev: 0 });
      const ackB = await bob.c.ackFor(seqB, fromB);
      expect(ackB.rev).toBe(2);
      expect(ackB.committed).toEqual([insertOp(afterC + 1, 'o')]); // transformed: after the "h"

      // Bob saw Alice's batch before his own ack; Alice sees Bob's batch as committed.
      const remoteForBob = await bob.c.waitFor(isType('remote'));
      const remoteForAlice = await alice.c.waitFor(isType('remote'));
      expect(bob.c.messages.indexOf(remoteForBob)).toBeLessThan(bob.c.messages.indexOf(ackB));
      expect(remoteForAlice.ops).toEqual(ackB.committed);

      // Replaying only what each client received gives the same document, which the server holds too.
      const aliceDoc = applyOps(applyOps(base, mine), remoteForAlice.ops);
      const bobDoc = applyOps(applyOps(base, remoteForBob.ops), ackB.committed ?? []);
      expect(docText(aliceDoc)).toBe('choat');
      expect(aliceDoc.eq(bobDoc)).toBe(true);
      expect(await rig.textOf('doc')).toBe('choat');
    },
  },
  {
    name: '10.2 BRD §3 "cat": two submits sent at once converge, in whichever order the server takes them',
    run: async (rig) => {
      await rig.addFile('doc', 'cat');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');
      const afterC = posIn('cat', 0, 1);
      const fromA = alice.c.mark();
      const fromB = bob.c.mark();
      const seqA = alice.c.sendSubmit([insertOp(afterC, 'h')], { baseRev: 0 });
      const seqB = bob.c.sendSubmit([insertOp(afterC, 'o')], { baseRev: 0 });
      const [ackA, ackB] = await Promise.all([alice.c.ackFor(seqA, fromA), bob.c.ackFor(seqB, fromB)]);

      // One batch was first (rev 1, as sent); the other was rebased over it (rev 2, with `committed`).
      expect([ackA.rev, ackB.rev].sort()).toEqual([1, 2]);
      const [first, second] = ackA.rev === 1 ? [ackA, ackB] : [ackB, ackA];
      expect(first.committed).toBeUndefined();
      expect(second.committed).toBeDefined();
      const text = await rig.textOf('doc');
      expect(text).toBe(ackA.rev === 1 ? 'choat' : 'cohat');
      // Everyone who joins now sees the converged document, and both clients know rev 2.
      await waitFor(() => {
        expect(alice.c.rev).toBe(2);
        expect(bob.c.rev).toBe(2);
      });
      expect((await rig.join('doc', 'carol')).load.start.rev).toBe(2);
    },
  },
  {
    name: '10.2 a view session receives the broadcasts but cannot change the document',
    run: async (rig) => {
      await rig.addFile('doc', 'text');
      const alice = await rig.join('doc', 'alice');
      const viewer = await rig.join('doc', 'vera', { access: 'view' });
      expect(viewer.load.start.access).toBe('view');

      await alice.c.submit([appendOp('text', '+')]);
      const remote = await viewer.c.waitFor(isType('remote'));
      expect(remote.ops).toEqual([appendOp('text', '+')]);

      const from = viewer.c.mark();
      const seq = viewer.c.sendSubmit([appendOp('text+', 'x')]);
      expect(await viewer.c.errorFor(seq, from)).toMatchObject({ code: 'ACCESS_DENIED', clientSeq: seq });
      expect(viewer.c.closeInfo).toBeUndefined();
      expect(await rig.textOf('doc')).toBe('text+');
    },
  },
  {
    name: '10.2 many edits from two clients keep one order: revs are consecutive and every client sees every batch',
    run: async (rig) => {
      await rig.addFile('doc', '');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');
      let text = '';
      for (let i = 0; i < 8; i++) {
        const [writer, reader] = i % 2 === 0 ? [alice, bob] : [bob, alice];
        const letter = String.fromCharCode(97 + i);
        const ack = await writer.c.submit([appendOp(text, letter)]);
        text += letter;
        expect(ack.rev).toBe(i + 1);
        await waitFor(() => expect(reader.c.rev).toBe(i + 1)); // the reader got the remote before it writes
      }
      expect(text).toBe('abcdefgh');
      expect(await rig.textOf('doc')).toBe(text);
      const seen = alice.c.all(isType('remote')).concat(bob.c.all(isType('remote')));
      expect(seen.map((r) => r.fromRev).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    },
  },
  {
    name: 'dedupe: a clientSeq sent twice on one socket is applied once, and the repeat gets the same ack',
    run: async (rig) => {
      await rig.addFile('doc', 'x');
      const { c } = await rig.join('doc', 'alice');
      const from = c.mark();
      const seq = c.sendSubmit([appendOp('x', 'A')]);
      c.sendSubmit([appendOp('x', 'A')], { clientSeq: seq, baseRev: 0 }); // the same clientSeq again
      await waitFor(() => expect(c.all(ackOf(seq), from)).toHaveLength(2));
      expect(c.all(ackOf(seq), from).map((a) => a.rev)).toEqual([1, 1]);

      // The next batch's ack comes after the repeat was fully handled (one FIFO per document).
      const next = await c.submit([appendOp('xA', 'B')]);
      expect(next.rev).toBe(2);
      expect(await rig.textOf('doc')).toBe('xAB'); // "A" once
    },
  },
  {
    name: 'dedupe: a transformed batch sent again gets its committed ops back and is not applied twice',
    run: async (rig) => {
      await rig.addFile('doc', 'cat');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');
      await alice.c.submit([insertOp(posIn('cat', 0, 1), 'h')]);
      const from = bob.c.mark();
      const seq = bob.c.sendSubmit([insertOp(posIn('cat', 0, 1), 'o')], { baseRev: 0 });
      const first = await bob.c.ackFor(seq, from);
      expect(first.committed).toBeDefined();
      bob.c.sendSubmit([insertOp(posIn('cat', 0, 1), 'o')], { clientSeq: seq, baseRev: 0 });
      await waitFor(() => expect(bob.c.all(ackOf(seq), from)).toHaveLength(2));
      const [, again] = bob.c.all(ackOf(seq), from) as [AckMsg, AckMsg];
      expect(again).toMatchObject({ rev: first.rev, committed: first.committed });
      expect(await rig.textOf('doc')).toBe('choat');
    },
  },
  {
    name: 'dedupe: after a reconnect (new socket, same client), a repeated clientSeq is acknowledged and not applied',
    run: async (rig) => {
      await rig.addFile('doc', 'x');
      const first = await rig.join('doc', 'alice');
      await first.c.submit([appendOp('x', 'A')]); // seq 1, rev 1
      await first.c.submit([appendOp('xA', 'B')]); // seq 2, rev 2
      await first.c.close();

      // Full reload: the load says which of this client's batches the document already holds.
      const c2 = await rig.connect('doc', 'alice', { clientId: first.c.clientId });
      const load2 = await c2.hello();
      expect(load2.start.ackedClientSeq).toBe(2);
      expect(loadedText(load2)).toBe('xAB');
      const from2 = c2.mark();
      c2.sendSubmit([appendOp('x', 'A')], { clientSeq: 1, baseRev: 0 }); // seq 1 again, with a stale base
      expect(await c2.ackFor(1, from2)).toMatchObject({ rev: 1 });
      expect((await c2.submit([appendOp('xAB', 'C')])).rev).toBe(3); // the client carries on after seq 2
      expect(await rig.textOf('doc')).toBe('xABC');
      await c2.close();

      // Resume on the same epoch: no reload, the repeat is still acknowledged once.
      const c3 = await rig.connect('doc', 'alice', { clientId: first.c.clientId });
      c3.epoch = load2.start.epoch;
      const from3 = c3.mark();
      c3.sendHello({ epoch: load2.start.epoch, rev: 3 });
      await c3.waitFor(readOnlyNotice(false), { from: from3 }); // the catch-up starts with this notice
      c3.sendSubmit([appendOp('xAB', 'C')], { clientSeq: 3, baseRev: 2 });
      expect(await c3.ackFor(3, from3)).toMatchObject({ rev: 3 });
      expect((await c3.submit([appendOp('xABC', 'D')])).rev).toBe(4);
      expect(await rig.textOf('doc')).toBe('xABCD');
    },
  },
  {
    name: 'resume on the same epoch replays the missed acks (own batches) and remotes (other clients)',
    run: async (rig) => {
      await rig.addFile('doc', 'a');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');
      await alice.c.submit([appendOp('a', '1')]); // rev 1 (alice seq 1)
      await waitFor(() => expect(bob.c.rev).toBe(1));
      await bob.c.submit([appendOp('a1', '2')]); // rev 2 (bob seq 1)
      await waitFor(() => expect(alice.c.rev).toBe(2));
      await alice.c.submit([appendOp('a12', '3')]); // rev 3 (alice seq 2)
      await alice.c.close();

      // Alice comes back on a new socket and says she only knows rev 0.
      const back = await rig.connect('doc', 'alice', { clientId: alice.c.clientId });
      const from = back.mark();
      back.sendHello({ epoch: alice.load.start.epoch, rev: 0 });
      await back.waitFor(ackOf(2), { from });
      const replayed = back.messages.slice(from);
      expect(replayed.map((m) => m.type)).toEqual(['notice', 'ack', 'remote', 'ack']);
      expect(replayed[1]).toMatchObject({ clientSeq: 1, rev: 1 });
      expect(replayed[2]).toMatchObject({ type: 'remote', clientId: bob.c.clientId, fromRev: 1, ops: [appendOp('a1', '2')] });
      expect(replayed[3]).toMatchObject({ clientSeq: 2, rev: 3 });
      expect(replayed.some((m) => m.type === 'load-start')).toBe(false); // no reload on the same epoch
    },
  },
];
