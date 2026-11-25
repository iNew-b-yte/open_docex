// HLD §10.3 "Saving and flushing", §10.4 "Storage failure and recovery" and the state machine of
// §11.3: LOCAL, PENDING, CONFLICT, `retry()` and `recovery.resolve()`.
import { expect } from 'vitest';
import { waitFor } from '../../../wait-for.js';
import { isType } from '../../test-client.js';
import { appendOp, loadedText } from '../doc-helpers.js';
import { id, intoConflict, storageNotice } from '../helpers.js';
import type { Scenario } from '../register.js';

export const storageScenarios: Scenario[] = [
  {
    name: '10.3 flushes to storage after the quiet period, and the saved file re-opens in a fresh engine',
    run: async (rig) => {
      await rig.addFile('doc', 'one');
      const { c } = await rig.join('doc', 'alice');
      await c.submit([appendOp('one', ' two')]);
      await rig.waitStored('doc', 'one two');
      const meta = await rig.waitMeta('doc', (m) => m.lastFlushedRev === 1);
      expect(meta).toMatchObject({ storageState: 'NORMAL', rev: 1 });
      expect(await rig.recoveryEntry('doc')).toBeUndefined();

      // A new data folder has no local state, so the saved file is what gets imported.
      await rig.stop();
      await rig.start({ freshData: true });
      const again = await rig.join('doc', 'alice');
      expect(loadedText(again.load)).toBe('one two');
      expect(again.load.start.rev).toBe(0);
    },
  },
  {
    name: '10.3 a clean stop flushes edits that the quiet period had not reached yet',
    rig: { config: { flush: { quietMs: 60_000, maxIntervalMs: 300_000 } } },
    run: async (rig) => {
      await rig.addFile('doc', 'draft');
      const { c } = await rig.join('doc', 'alice');
      await c.submit([appendOp('draft', ' v2')]);
      expect(await rig.storedText('doc')).toBe('draft'); // the quiet period is a minute
      await rig.stop();
      expect(await rig.storedText('doc')).toBe('draft v2');
    },
  },
  {
    name: '10.4 a failed write puts the document in LOCAL, editing goes on, and retry() recovers it',
    run: async (rig) => {
      await rig.addFile('doc', 'kept');
      const alice = await rig.join('doc', 'alice');
      rig.storageDown(['write']);
      await alice.c.submit([appendOp('kept', '!')]);

      // The quiet period passes, the write fails, the copy is local from now on.
      const entry = await rig.waitRecovery('doc', 'LOCAL');
      expect(entry).toMatchObject({ documentId: 'doc', state: 'LOCAL', localRev: 1, lastFlushedRev: 0, retryCount: 0, lastError: { code: 'STORAGE_WRITE_FAILED' } });
      await alice.c.waitFor(storageNotice('local'));
      expect(await rig.waitStorageEvent('local')).toMatchObject({ documentId: 'doc', state: 'local' });
      await waitFor(() => expect(rig.events.error.map((e) => e.code)).toContain('STORAGE_LOCAL_MODE'));

      // Editing continues; a session that joins now is told that the copy is local.
      expect((await alice.c.submit([appendOp('kept!', ' more')])).rev).toBe(2);
      const bob = await rig.join('doc', 'bob');
      expect(loadedText(bob.load)).toBe('kept! more');
      await bob.c.waitFor(storageNotice('local'));
      const copy = await rig.engine.recovery.readLocalCopy(id('doc'));
      expect(new TextDecoder().decode(copy.bytes)).toBe('kept! more');
      expect(copy).toMatchObject({ rev: 2, format: 'docx' });
      expect(await rig.storedText('doc')).toBe('kept'); // storage was not touched

      // Storage is back: retry() checks it, writes the local copy and returns to NORMAL.
      rig.storageUp();
      expect(await rig.engine.recovery.retry(id('doc'))).toMatchObject({ documentId: 'doc', state: 'NORMAL', retryCount: 0 });
      expect(await rig.storedText('doc')).toBe('kept! more');
      expect(await rig.waitStorageEvent('recovered')).toMatchObject({ documentId: 'doc' });
      await alice.c.waitFor(storageNotice('normal'));
      expect(await rig.engine.recovery.list()).toEqual([]);
    },
  },
  {
    name: '10.4 the retry timer recovers a document by itself once storage is back',
    rig: { config: { recovery: { retryDelaysMs: [2500, 2500, 2500] } } },
    run: async (rig) => {
      await rig.addFile('doc', 'a');
      const { c } = await rig.join('doc', 'alice');
      rig.storageDown(['write']);
      await c.submit([appendOp('a', 'b')]);
      await rig.waitStorageEvent('local');
      rig.storageUp();
      await rig.waitStorageEvent('recovered');
      await rig.waitRecovery('doc', 'NORMAL');
      expect(await rig.storedText('doc')).toBe('ab');
    },
  },
  {
    name: '10.4 three failed retries make it PENDING, retry() stays PENDING while storage is down, then recovers',
    rig: { config: { recovery: { retryDelaysMs: [200, 200, 200] } } },
    run: async (rig) => {
      await rig.addFile('doc', 'a');
      const { c } = await rig.join('doc', 'alice');
      rig.storageDown(); // reads too, so every CHECK fails
      await c.submit([appendOp('a', 'b')]);
      const entry = await rig.waitRecovery('doc', 'PENDING');
      expect(entry).toMatchObject({ state: 'PENDING', retryCount: 3, nextRetryAt: null });
      await c.waitFor(storageNotice('pending'));
      const states = rig.events.storage.map((s) => s.state);
      expect(states[0]).toBe('local');
      expect(states).toContain('pending');
      await waitFor(() => expect(rig.events.error.map((e) => e.code)).toContain('STORAGE_PENDING'));

      expect(await rig.engine.recovery.retry(id('doc'))).toMatchObject({ state: 'PENDING', retryCount: 3 }); // still down
      rig.storageUp();
      expect(await rig.engine.recovery.retry(id('doc'))).toMatchObject({ state: 'NORMAL' });
      expect(await rig.storedText('doc')).toBe('ab');
    },
  },
  {
    name: '10.4 a PENDING document is resolved with overwrite-storage once storage is back',
    rig: { config: { recovery: { retryDelaysMs: [200, 200, 200] } } },
    run: async (rig) => {
      await rig.addFile('doc', 'a');
      const { c } = await rig.join('doc', 'alice');
      rig.storageDown();
      await c.submit([appendOp('a', 'b')]);
      await rig.waitRecovery('doc', 'PENDING');
      rig.storageUp();
      expect(await rig.engine.recovery.resolve(id('doc'), 'overwrite-storage')).toMatchObject({ state: 'NORMAL' });
      expect(await rig.storedText('doc')).toBe('ab');
      await c.waitFor(storageNotice('normal'));
    },
  },
  {
    name: '10.4 a storage file changed outside gives CONFLICT (STORAGE_CONFLICT); the engine never overwrites it',
    run: async (rig) => {
      const { c } = await intoConflict(rig);
      const entry = await rig.recoveryEntry('doc');
      expect(entry).toMatchObject({ state: 'CONFLICT', localRev: 1 });
      expect(await rig.waitStorageEvent('conflict')).toMatchObject({ documentId: 'doc', state: 'conflict', error: { code: 'STORAGE_CONFLICT' } });
      await waitFor(() => expect(rig.events.error.map((e) => e.code)).toContain('STORAGE_CONFLICT'));
      await expect(rig.engine.recovery.retry(id('doc'))).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' }); // a decision is needed
      expect(await rig.storedText('doc')).toBe('edited by someone else');
      expect(new TextDecoder().decode((await rig.engine.recovery.readLocalCopy(id('doc'))).bytes)).toBe('base!');

      // Editing goes on locally and storage is still untouched.
      expect((await c.submit([appendOp('base!', '?')])).rev).toBe(2);
      expect(await rig.storedText('doc')).toBe('edited by someone else');
    },
  },
  {
    name: '10.4 a file that changes while storage was down is found by the retry: LOCAL then CONFLICT',
    run: async (rig) => {
      await rig.addFile('doc', 'base');
      const { c } = await rig.join('doc', 'alice');
      rig.storageDown(['write']);
      await c.submit([appendOp('base', '!')]);
      await rig.waitRecovery('doc', 'LOCAL');
      await rig.outsideEdit('doc', 'edited by someone else'); // somebody saved a copy meanwhile
      rig.storageUp();
      expect(await rig.engine.recovery.retry(id('doc'))).toMatchObject({ state: 'CONFLICT' }); // the CHECK saw another version
      await c.waitFor(storageNotice('pending'));
      expect(await rig.storedText('doc')).toBe('edited by someone else');
    },
  },
  {
    name: "recovery.resolve('overwrite-storage') writes the local copy over the changed file",
    run: async (rig) => {
      const { c } = await intoConflict(rig);
      expect(await rig.engine.recovery.resolve(id('doc'), 'overwrite-storage')).toMatchObject({ state: 'NORMAL' });
      expect(await rig.storedText('doc')).toBe('base!');
      expect(await rig.waitStorageEvent('recovered')).toMatchObject({ documentId: 'doc' });
      await c.waitFor(storageNotice('normal'));
      expect(await rig.engine.recovery.list()).toEqual([]);
      // Back to normal flushing.
      await c.submit([appendOp('base!', '?')]);
      await rig.waitStored('doc', 'base!?');
    },
  },
  {
    name: "recovery.resolve('discard-local') reloads the storage file: sessions get resync and a full load, the local edits are gone",
    run: async (rig) => {
      const { c, epoch } = await intoConflict(rig);
      const from = c.mark();
      expect(await rig.engine.recovery.resolve(id('doc'), 'discard-local')).toMatchObject({ state: 'NORMAL' });

      expect(await c.waitFor(isType('resync'), { from })).toMatchObject({ reason: 'history-unavailable' });
      const load = await c.loadedSince(from);
      expect(loadedText(load)).toBe('edited by someone else');
      expect(load.start.epoch).toBe(epoch); // the instance lives on
      expect(load.start.rev).toBe(2); // rev + 1: the old content's revs are stale, and rev never goes back
      expect(await rig.storedText('doc')).toBe('edited by someone else'); // nothing was written
      expect(await rig.engine.recovery.list()).toEqual([]);
      await c.waitFor(storageNotice('normal'));

      // The session carries on from the reloaded content.
      expect((await c.submit([appendOp('edited by someone else', '.')])).rev).toBe(3);
      await rig.waitStored('doc', 'edited by someone else.');
    },
  },
  {
    name: "recovery.resolve('mark-resolved') accepts the storage file as it is: nothing is written or discarded",
    run: async (rig) => {
      const { c } = await intoConflict(rig);
      const from = c.mark();
      expect(await rig.engine.recovery.resolve(id('doc'), 'mark-resolved')).toMatchObject({ state: 'NORMAL' });
      expect(await rig.storedText('doc')).toBe('edited by someone else'); // not overwritten
      await c.waitFor(storageNotice('normal'), { from });
      expect(await rig.engine.recovery.list()).toEqual([]);

      // The session was not reloaded and its next edit is accepted; flushing works again.
      const ack = await c.submit([appendOp('base!', '?')]);
      expect(ack.rev).toBe(2);
      expect(c.all(isType('resync'), from)).toEqual([]);
      await rig.waitStored('doc', 'base!?'); // the next flush writes the local model on top of the accepted version
      await waitFor(() => expect(rig.events.storage.filter((s) => s.state === 'conflict')).toHaveLength(1)); // no second conflict
    },
  },
];
