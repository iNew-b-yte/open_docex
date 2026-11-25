// At-least-once audit delivery (LLD §0.1 PO-17, §0.3 R-19, §0.5 S-40): live events carry
// `replayed: false`; after a crash the Core re-emits the entries it had not emitted, with
// `replayed: true`, and never the ones it had.
import { expect } from 'vitest';
import { waitFor } from '../../../wait-for.js';
import { appendOp } from '../doc-helpers.js';
import type { Scenario } from '../register.js';

export const auditScenarios: Scenario[] = [
  {
    name: 'audit: each applied batch is emitted once, in order, with replayed: false; a dropped duplicate is not emitted',
    run: async (rig) => {
      rig.listenToAudit();
      await rig.engine.recovery.list(); // `audit.enable` is ahead of this call in the channel
      await rig.addFile('doc', 'x');
      const { c } = await rig.join('doc', 'alice');
      await c.submit([appendOp('x', 'A')]); // clientSeq 1
      await c.submit([appendOp('xA', 'B')]); // clientSeq 2
      c.sendSubmit([appendOp('x', 'A')], { clientSeq: 1, baseRev: 0 }); // seq 1 again: a duplicate
      await c.submit([appendOp('xAB', 'C')]); // clientSeq 3, after the duplicate in the same FIFO

      await waitFor(() => expect(rig.audit).toHaveLength(3));
      expect(rig.audit.map((a) => [a.rev, a.fromRev, a.clientSeq, a.replayed])).toEqual([
        [1, 0, 1, false],
        [2, 1, 2, false],
        [3, 2, 3, false],
      ]);
      expect(rig.audit[0]).toMatchObject({
        documentId: 'doc',
        kind: 'text',
        userId: 'alice',
        clientId: c.clientId,
        sessionId: expect.any(String) as unknown,
        ops: [appendOp('x', 'A')],
      });
    },
  },
  {
    name: 'audit: after a crash the unemitted entries are re-emitted with replayed: true, the emitted ones are not',
    rig: { config: { flush: { quietMs: 60_000, maxIntervalMs: 300_000 } } },
    run: async (rig) => {
      await rig.addFile('doc', 'x');
      rig.listenToAudit();
      await rig.engine.recovery.list();
      const { c } = await rig.join('doc', 'alice');
      await c.submit([appendOp('x', '1')]); // rev 1
      await c.submit([appendOp('x1', '2')]); // rev 2
      await waitFor(() => expect(rig.audit.map((a) => a.rev)).toEqual([1, 2]));
      await rig.waitMeta('doc', (m) => m.auditEmittedRev === 2); // the Core has recorded that revs 1 and 2 went out

      // Nobody listens now: revs 3 and 4 are applied but not emitted, and auditEmittedRev stays at 2.
      await rig.stopListeningToAudit();
      await c.submit([appendOp('x12', '3')]); // rev 3
      await c.submit([appendOp('x123', '4')]); // rev 4
      expect(rig.audit).toHaveLength(2);
      expect((await rig.metaOnDisk('doc')).auditEmittedRev).toBe(2);

      await rig.crash();

      // A listener that joins after the crash gets exactly what had not gone out.
      rig.listenToAudit();
      await waitFor(() => expect(rig.audit).toHaveLength(4));
      const replayed = rig.audit.slice(2);
      expect(replayed.map((a) => [a.rev, a.fromRev, a.replayed, a.sessionId, a.userId])).toEqual([
        [3, 2, true, null, 'alice'],
        [4, 3, true, null, 'alice'],
      ]);
      expect(replayed[0]).toMatchObject({ documentId: 'doc', clientId: c.clientId, clientSeq: 3, ops: [appendOp('x12', '3')] });
      await rig.waitMeta('doc', (m) => m.auditEmittedRev === 4);

      // A second crash re-emits nothing: the next event is the live one for rev 5. Boot replay runs
      // before any session, so a replay would have come first.
      const mark = rig.audit.length;
      await rig.crash();
      const again = await rig.join('doc', 'alice');
      await again.c.submit([appendOp('x1234', '5')]);
      await waitFor(() => expect(rig.audit.length).toBeGreaterThan(mark));
      expect(rig.audit.slice(mark).map((a) => [a.rev, a.replayed])).toEqual([[5, false]]);
    },
  },
];
