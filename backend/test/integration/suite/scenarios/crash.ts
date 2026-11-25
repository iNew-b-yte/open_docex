// HLD §10.5 "Engine (worker) crash" and the recovery that follows it. `rig.crash()` kills the
// Core process in worker mode; in main mode it stops the engine without a flush and boots a new
// one on the same data folder (see `rig.ts`). The scenarios say the same about both: what the
// clients see, and what the new Core finds on disk.
import { expect } from 'vitest';
import { waitFor } from '../../../wait-for.js';
import { isType } from '../../test-client.js';
import { appendOp, loadedText } from '../doc-helpers.js';
import { crashCloseCode, id, intoConflict, storageNotice } from '../helpers.js';
import type { Scenario } from '../register.js';

/** No flush before a crash: the quiet period is a minute. */
const NO_FLUSH = { flush: { quietMs: 60_000, maxIntervalMs: 300_000 } };

export const crashScenarios: Scenario[] = [
  {
    name: '10.5 a crash closes the clients; they resume with the old epoch and get a resync, a reload and every acked edit',
    rig: { config: NO_FLUSH },
    run: async (rig) => {
      await rig.addFile('doc', 'base');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');
      await alice.c.submit([appendOp('base', '+A')]); // rev 1
      await waitFor(() => expect(bob.c.rev).toBe(1));
      await bob.c.submit([appendOp('base+A', '+B')]); // rev 2
      await waitFor(() => expect(alice.c.rev).toBe(2));
      const oldEpoch = alice.load.start.epoch;

      await rig.crash();
      expect(await alice.c.whenClosed()).toEqual(crashCloseCode(rig.mode));
      expect(await bob.c.whenClosed()).toEqual(crashCloseCode(rig.mode));
      expect(await rig.storedText('doc')).toBe('base'); // nothing was flushed: the edits live in the journal

      // Alice reconnects as the same client and says what she knows. The Core has a new epoch.
      const a2 = await rig.connect('doc', 'alice', { clientId: alice.c.clientId });
      const fromA = a2.mark();
      a2.sendHello({ epoch: oldEpoch, rev: alice.c.rev });
      expect(await a2.waitFor(isType('resync'), { from: fromA })).toMatchObject({ reason: 'epoch-changed' });
      const load = await a2.loadedSince(fromA);
      expect(a2.messages.slice(fromA, fromA + 2).map((m) => m.type)).toEqual(['resync', 'load-start']); // nothing was missed after rev 2
      expect(load.start.epoch).not.toBe(oldEpoch);
      expect(load.start).toMatchObject({ rev: 2, ackedClientSeq: 1, readOnly: false });
      expect(loadedText(load)).toBe('base+A+B');

      // Bob says he only knew rev 1: the retained batch is replayed (his own, as an ack) before the resync.
      const b2 = await rig.connect('doc', 'bob', { clientId: bob.c.clientId });
      const fromB = b2.mark();
      b2.sendHello({ epoch: oldEpoch, rev: 1 });
      const loadB = await b2.loadedSince(fromB);
      expect(b2.messages.slice(fromB, fromB + 3).map((m) => m.type)).toEqual(['ack', 'resync', 'load-start']);
      expect(b2.messages[fromB]).toMatchObject({ type: 'ack', clientSeq: 1, rev: 2 });
      expect(loadedText(loadB)).toBe('base+A+B');
    },
  },
  {
    name: '10.5 after a crash a resent batch that was already committed is dropped by (clientId, clientSeq), and a new one is applied',
    rig: { config: NO_FLUSH },
    run: async (rig) => {
      await rig.addFile('doc', 'base');
      const first = await rig.join('doc', 'alice');
      await first.c.submit([appendOp('base', '+A')]); // clientSeq 1, rev 1
      await first.c.submit([appendOp('base+A', '+B')]); // clientSeq 2, rev 2
      await rig.crash();

      const c = await rig.connect('doc', 'alice', { clientId: first.c.clientId });
      const from = c.mark();
      c.sendHello({ epoch: first.load.start.epoch, rev: 2 });
      const load = await c.loadedSince(from);
      expect(load.start).toMatchObject({ rev: 2, ackedClientSeq: 2 }); // the document holds seq 1 and 2

      // The client did not see the ack of seq 2, so it sends it again, and then seq 3, which it typed meanwhile.
      const sent = c.mark();
      c.sendSubmit([appendOp('base+A', '+B')], { clientSeq: 2, baseRev: 1 });
      c.sendSubmit([appendOp('base+A+B', '+C')], { clientSeq: 3 });
      expect(await c.ackFor(2, sent)).toMatchObject({ rev: 2 }); // acknowledged, not applied
      expect(await c.ackFor(3, sent)).toMatchObject({ rev: 3 });
      expect(await rig.textOf('doc')).toBe('base+A+B+C'); // "+B" once
    },
  },
  {
    name: '10.5 recovery from a snapshot plus the journal tail keeps the text and the dedupe table',
    rig: { config: { ...NO_FLUSH, snapshot: { everyOps: 2 } } },
    run: async (rig) => {
      await rig.addFile('doc', '');
      const first = await rig.join('doc', 'alice');
      let text = '';
      for (const letter of ['a', 'b', 'c', 'd', 'e']) {
        await first.c.submit([appendOp(text, letter)]);
        text += letter;
      }
      expect(await rig.snapshotRevOnDisk('doc')).toBe(4); // snapshots at revs 2 and 4; rev 5 is only in the journal
      await rig.crash();

      const c = await rig.connect('doc', 'alice', { clientId: first.c.clientId });
      const load = await c.hello();
      expect(loadedText(load)).toBe('abcde');
      expect(load.start).toMatchObject({ rev: 5, ackedClientSeq: 5 });

      // Seq 1 is older than the snapshot, seq 5 is in the tail: both are known, neither is applied again.
      const from = c.mark();
      c.sendSubmit([appendOp('', 'a')], { clientSeq: 1, baseRev: 0 });
      c.sendSubmit([appendOp('abcd', 'e')], { clientSeq: 5, baseRev: 4 });
      expect(await c.ackFor(1, from)).toMatchObject({ rev: 1 });
      expect(await c.ackFor(5, from)).toMatchObject({ rev: 5 });
      expect((await c.submit([appendOp('abcde', 'f')])).rev).toBe(6);
      expect(await rig.textOf('doc')).toBe('abcdef');
    },
  },
  {
    name: '10.5 on boot the Core flushes a document whose journal was never flushed, with nobody connected',
    run: async (rig) => {
      await rig.addFile('doc', 'base');
      const { c } = await rig.join('doc', 'alice');
      rig.exportDown(true); // a flush cannot export, so nothing reaches storage before the crash
      await c.submit([appendOp('base', '+edit')]);
      await rig.crash();
      rig.exportDown(false);
      expect(await rig.storedText('doc')).toBe('base');

      await rig.waitStored('doc', 'base+edit'); // the boot scan found the journal ahead of storage and scheduled a flush
      await rig.waitMeta('doc', (m) => m.lastFlushedRev === 1 && m.storageState === 'NORMAL');
    },
  },
  {
    name: '10.5 a crash while storage is down keeps the local copy; after the restart retry() writes it',
    run: async (rig) => {
      await rig.addFile('doc', 'kept');
      const { c } = await rig.join('doc', 'alice');
      rig.storageDown(['write']);
      await c.submit([appendOp('kept', '!')]);
      await rig.waitRecovery('doc', 'LOCAL');

      await rig.crash();
      expect(await rig.waitRecovery('doc', 'LOCAL')).toMatchObject({ state: 'LOCAL', localRev: 1, lastFlushedRev: 0 }); // meta found it again
      const again = await rig.join('doc', 'alice');
      expect(loadedText(again.load)).toBe('kept!'); // the local copy, not storage
      await again.c.waitFor(storageNotice('local'));
      expect(await rig.storedText('doc')).toBe('kept');

      rig.storageUp();
      expect(await rig.engine.recovery.retry(id('doc'))).toMatchObject({ state: 'NORMAL' });
      expect(await rig.storedText('doc')).toBe('kept!');
    },
  },
  {
    name: '10.5 a conflict survives a crash and can then be resolved',
    run: async (rig) => {
      await intoConflict(rig);
      await rig.crash();
      expect(await rig.recoveryEntry('doc')).toMatchObject({ state: 'CONFLICT', localRev: 1 });
      const again = await rig.join('doc', 'alice');
      expect(loadedText(again.load)).toBe('base!'); // the local copy
      await again.c.waitFor(storageNotice('pending'));
      expect(await rig.storedText('doc')).toBe('edited by someone else');

      expect(await rig.engine.recovery.resolve(id('doc'), 'overwrite-storage')).toMatchObject({ state: 'NORMAL' });
      expect(await rig.storedText('doc')).toBe('base!');
    },
  },
  {
    only: 'worker',
    name: '10.5 the Gateway closes sessions with 4001, answers 503 and ENGINE_RESTARTING while the Core restarts, then serves again',
    rig: { supervisor: { backoffMs: [10] } },
    run: async (rig) => {
      await rig.addFile('doc', 'base');
      const alice = await rig.join('doc', 'alice');
      const bob = await rig.join('doc', 'bob');
      await alice.c.submit([appendOp('base', '+A')]);
      const mark = rig.events.engine.length;

      rig.holdBoot(true); // the restarted Core waits in its boot, so "restarting" lasts as long as the test needs
      rig.killCore();
      expect(await alice.c.whenClosed()).toEqual({ code: 4001, reason: 'ENGINE_RESTARTING' });
      expect(await bob.c.whenClosed()).toEqual({ code: 4001, reason: 'ENGINE_RESTARTING' });
      expect(alice.c.messages.some((m) => m.type === 'notice' && m.notice === 'engine-restarting')).toBe(true);

      await waitFor(() => expect(rig.engine.state).toBe('restarting'));
      await expect(rig.engine.recovery.list()).rejects.toMatchObject({ code: 'ENGINE_RESTARTING', retryable: true });
      await expect(rig.connect('doc', 'carol')).rejects.toThrow('HTTP 503');

      rig.holdBoot(false);
      await rig.whenRestarted(mark);
      expect(rig.events.engine.slice(mark).map((s) => s.state)).toEqual(['restarting', 'started']);
      expect(rig.events.engine[mark]).toMatchObject({ state: 'restarting', restartCount: 1 });
      const again = await rig.join('doc', 'alice');
      expect(loadedText(again.load)).toBe('base+A'); // recovered from the journal
    },
  },
  {
    only: 'worker',
    name: '10.5 five restarts in ten minutes are tolerated; the sixth crash makes the engine FAILED: fatal event and ENGINE_UNAVAILABLE',
    rig: { supervisor: { backoffMs: [10] } },
    timeoutMs: 240_000,
    run: async (rig) => {
      await rig.addFile('doc', 'x');
      for (let i = 0; i < 5; i++) {
        const mark = rig.events.engine.length;
        rig.killCore();
        await rig.whenRestarted(mark);
      }
      expect(rig.events.engine.filter((s) => s.state === 'restarting').map((s) => s.restartCount)).toEqual([1, 2, 3, 4, 5]);

      rig.killCore(); // the sixth within the window
      await rig.whenState('failed');
      await waitFor(() => expect(rig.events.fatal).toHaveLength(1));
      expect(rig.events.fatal[0]).toMatchObject({ code: 'ENGINE_FAILED' });
      expect(rig.events.engine.at(-1)).toMatchObject({ state: 'failed', error: { code: 'ENGINE_FAILED' } });
      await expect(rig.engine.recovery.list()).rejects.toMatchObject({ code: 'ENGINE_FAILED' });

      // A new session is accepted at the HTTP level and closed at once with ENGINE_UNAVAILABLE (4002).
      const c = await rig.connect('doc', 'alice');
      expect(await c.whenClosed()).toMatchObject({ code: 4002, reason: 'ENGINE_UNAVAILABLE' });
    },
  },
];
