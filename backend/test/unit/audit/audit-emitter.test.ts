import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asDocumentId, type ClientId } from '@open-docex/shared/ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../../src/api/events.js';
import { AuditEmitter } from '../../../src/audit/audit-emitter.js';
import { Journal, type JournalEntry } from '../../../src/persistence/journal.js';
import { docKeyOf, journalDir } from '../../../src/persistence/layout.js';
import { MetaStore, type DocumentMeta } from '../../../src/persistence/meta-store.js';

const DOC = asDocumentId('doc-a');
const KEY = docKeyOf(DOC);
const CLIENT = 'AAAAAAAAAAAAAAAAAAAAAA' as ClientId;

const entry = (f: number, n = 1): JournalEntry => ({
  f,
  r: f + n,
  c: CLIENT,
  q: f + 1,
  u: 'user-1',
  t: 1000 + f,
  x: false,
  o: Array.from({ length: n }, (_, i) => ({ op: f + i })),
});

const meta = (over: Partial<DocumentMeta> = {}): DocumentMeta => ({
  schema: 1,
  documentId: DOC,
  kind: 'text',
  format: 'docx',
  ref: { bucket: 'b', key: 'k' },
  storageState: 'NORMAL',
  lastKnownVersion: 'v1',
  lastFlushedRev: 0,
  rev: 0,
  auditEmittedRev: 0,
  retryCount: 0,
  nextRetryAt: null,
  localSince: null,
  readOnly: { findings: [], allowedEdit: false },
  lineage: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const live = (rev: number, fromRev = rev - 1): AuditEvent => ({
  documentId: DOC,
  kind: 'text',
  rev,
  fromRev,
  at: 5,
  userId: 'u',
  clientId: CLIENT,
  clientSeq: rev,
  sessionId: 's1',
  ops: [{}],
  replayed: false,
});

let dir: string;
let store: MetaStore;
let sent: AuditEvent[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-audit-'));
  store = new MetaStore(dir);
  sent = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = (o: { enabled?: boolean; emit?: (e: 'audit', p: AuditEvent) => void } = {}): AuditEmitter =>
  new AuditEmitter({ dataDir: dir, meta: store, enabled: o.enabled ?? true, emit: o.emit ?? ((_e, p) => void sent.push(p)) });

async function writeJournal(entries: JournalEntry[]): Promise<void> {
  const j = await Journal.open(journalDir(dir, KEY), { fsync: 'always' });
  for (const e of entries) await j.append(e);
  await j.close();
}

const emittedRev = (): number | undefined => store.get(KEY)?.auditEmittedRev;

describe('live emit', () => {
  it('sends the event unchanged (replayed false) and then advances auditEmittedRev', async () => {
    await store.put(meta());
    const a = make();
    a.emit(live(1));
    expect(sent).toEqual([live(1)]);
    expect(sent[0]?.replayed).toBe(false);
    await a.flush();
    expect(emittedRev()).toBe(1);
  });

  it('does not advance auditEmittedRev before the hand-off has happened', async () => {
    await store.put(meta());
    let revAtHandOff: number | undefined;
    const a = make({
      emit: (_e, p) => {
        revAtHandOff = emittedRev();
        sent.push(p);
      },
    });
    a.emit(live(1));
    await a.flush();
    expect(revAtHandOff).toBe(0);
    expect(emittedRev()).toBe(1);
  });

  it('keeps FIFO order and coalesces advances to the highest rev', async () => {
    await store.put(meta());
    const a = make();
    for (let r = 1; r <= 5; r++) a.emit(live(r));
    await a.flush();
    expect(sent.map((e) => e.rev)).toEqual([1, 2, 3, 4, 5]);
    expect(emittedRev()).toBe(5);
  });

  it('never moves auditEmittedRev backwards', async () => {
    await store.put(meta({ auditEmittedRev: 9 }));
    const a = make();
    a.emit(live(3));
    await a.flush();
    expect(emittedRev()).toBe(9);
  });

  it('sends nothing and advances nothing while disabled, then works once enabled', async () => {
    await store.put(meta());
    const a = make({ enabled: false });
    a.emit(live(1));
    await a.flush();
    expect(sent).toEqual([]);
    expect(emittedRev()).toBe(0);
    a.setEnabled(true);
    a.emit(live(2));
    await a.flush();
    expect(sent.map((e) => e.rev)).toEqual([2]);
  });

  it('keeps the rev behind when the hand-off throws, and does not throw itself', async () => {
    await store.put(meta());
    const a = make({
      emit: () => {
        throw new Error('channel closed');
      },
    });
    expect(() => a.emit(live(1))).not.toThrow();
    await a.flush();
    expect(emittedRev()).toBe(0);
  });
});

describe('boot replay (R-19)', () => {
  it('re-emits entries after auditEmittedRev with replayed true, in order, then advances', async () => {
    await writeJournal([entry(0), entry(1, 2), entry(3)]); // revs 1, 3, 4
    await store.put(meta({ auditEmittedRev: 1, rev: 4 }));
    const a = make();
    expect(await a.replayPending(DOC)).toBe(2);
    expect(sent.map((e) => e.rev)).toEqual([3, 4]);
    expect(sent.every((e) => e.replayed)).toBe(true);
    expect(sent[0]).toEqual({
      documentId: DOC,
      kind: 'text',
      rev: 3,
      fromRev: 1,
      at: 1001,
      userId: 'user-1',
      clientId: CLIENT,
      clientSeq: 2,
      sessionId: null,
      ops: [{ op: 1 }, { op: 2 }],
      replayed: true,
    });
    expect(emittedRev()).toBe(4);
  });

  it('simulated crash: emitted but rev not persisted is re-emitted after reboot, and only once', async () => {
    await writeJournal([entry(0), entry(1), entry(2)]);
    await store.put(meta({ rev: 3 }));
    // Process 1 hands off rev 1 and 2, but "crashes" before the meta write (no flush, store discarded).
    const first = make();
    first.emit(live(1, 0));
    first.emit(live(2, 1));
    expect(sent.map((e) => e.replayed)).toEqual([false, false]);
    await first.flush();
    // Simulate the lost meta write by resetting the persisted rev on disk.
    await store.put(meta({ rev: 3, auditEmittedRev: 0 }));

    sent = [];
    const reboot = new MetaStore(dir);
    await reboot.loadAll();
    const second = new AuditEmitter({ dataDir: dir, meta: reboot, enabled: true, emit: (_e, p) => void sent.push(p) });
    expect(await second.replayAll()).toBe(3);
    expect(sent.map((e) => [e.rev, e.replayed])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
    // A second boot has nothing left to replay.
    sent = [];
    const third = new MetaStore(dir);
    await third.loadAll();
    expect(third.get(KEY)?.auditEmittedRev).toBe(3);
    expect(await new AuditEmitter({ dataDir: dir, meta: third, enabled: true, emit: (_e, p) => void sent.push(p) }).replayAll()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('does not re-emit already acknowledged revs', async () => {
    await writeJournal([entry(0), entry(1)]);
    await store.put(meta({ auditEmittedRev: 2, rev: 2 }));
    expect(await make().replayPending(DOC)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('does nothing while disabled, for an unknown document, and with no journal', async () => {
    await writeJournal([entry(0)]);
    await store.put(meta());
    expect(await make({ enabled: false }).replayPending(DOC)).toBe(0);
    expect(await make().replayPending(asDocumentId('nope'))).toBe(0);
    expect(sent).toEqual([]);
    const other = asDocumentId('doc-b');
    await store.put(meta({ documentId: other }));
    expect(await make().replayPending(other)).toBe(0);
  });

  it('leaves auditEmittedRev unchanged for entries it could not hand off', async () => {
    await writeJournal([entry(0), entry(1), entry(2)]);
    await store.put(meta({ rev: 3 }));
    let n = 0;
    const a = make({
      emit: (_e, p) => {
        if (++n === 2) throw new Error('down');
        sent.push(p);
      },
    });
    expect(await a.replayPending(DOC)).toBe(1);
    expect(emittedRev()).toBe(1);
  });

  it('replayAll isolates a corrupt journal and still replays other documents', async () => {
    const bad = asDocumentId('doc-bad');
    await writeJournal([entry(0)]);
    await store.put(meta({ rev: 1 }));
    await store.put(meta({ documentId: bad, rev: 1 }));
    const j = await Journal.open(journalDir(dir, docKeyOf(bad)), { fsync: 'always' });
    await j.append(entry(0));
    await j.append(entry(1));
    await j.close();
    // Corrupt the first line of the bad journal (not the tail, so open() will not repair it).
    const { readdir, readFile, writeFile } = await import('node:fs/promises');
    const jd = journalDir(dir, docKeyOf(bad));
    const [seg] = await readdir(jd);
    const file = path.join(jd, seg as string);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('"k":"', '"k":"0'));
    expect(await make().replayAll()).toBe(1);
    expect(sent.map((e) => e.documentId)).toEqual([DOC]);
  });
});
