import type { ClientId } from '@open-docex/shared/ids';
import { describe, expect, it } from 'vitest';
import { DedupeTable } from '../../../src/core/dedupe-table.js';
import { historyMaxOps, OpHistory } from '../../../src/core/op-history.js';
import { replayMessage } from '../../../src/core/load-streamer.js';
import type { JournalEntry } from '../../../src/persistence/journal.js';

const c = (s: string): ClientId => s as ClientId;

function entry(f: number, n: number, client = 'a', q = 1, x = false): JournalEntry {
  return { f, r: f + n, c: c(client), q, u: 'u', t: 0, x, o: Array.from({ length: n }, (_, i) => `op${f + i}`) };
}

describe('DedupeTable', () => {
  it('treats seq ≤ last committed as a duplicate and keeps the rev', () => {
    const t = new DedupeTable();
    expect(t.lookup(c('a'), 1)).toBe(false);
    t.record(c('a'), 3, 10);
    expect(t.lookup(c('a'), 1)).toBe(true);
    expect(t.lookup(c('a'), 3)).toBe(true);
    expect(t.lookup(c('a'), 4)).toBe(false);
    expect(t.lastSeq(c('a'))).toBe(3);
    expect(t.lastRev(c('a'))).toBe(10);
    expect(t.lastSeq(c('b'))).toBeUndefined();
  });

  it('ignores a lower seq and allows gaps', () => {
    const t = new DedupeTable();
    t.record(c('a'), 5, 10);
    t.record(c('a'), 2, 20);
    expect(t.lastRev(c('a'))).toBe(10);
    t.record(c('a'), 9, 30);
    expect(t.lastSeq(c('a'))).toBe(9);
  });

  it('evicts the lowest rev when over the cap', () => {
    const t = new DedupeTable(2);
    t.record(c('a'), 1, 1);
    t.record(c('b'), 1, 2);
    t.record(c('a'), 2, 3); // a moves to the newest
    t.record(c('c'), 1, 4);
    expect(t.size).toBe(2);
    expect(t.lastSeq(c('b'))).toBeUndefined();
    expect(t.lastSeq(c('a'))).toBe(2);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const t = new DedupeTable();
    t.record(c('b'), 4, 7);
    t.record(c('a'), 2, 9);
    const u = DedupeTable.fromJSON(t.toJSON());
    expect(u.toJSON()).toEqual([
      ['b', 4, 7],
      ['a', 2, 9],
    ]);
  });
});

describe('OpHistory', () => {
  it('serves opsSince, including a baseRev inside an entry, and checks the window', () => {
    const h = new OpHistory(100, 5);
    h.push(entry(5, 2));
    h.push(entry(7, 3, 'b'));
    expect(h.floorRev).toBe(5);
    expect(h.headRev).toBe(10);
    expect(h.opsSince(5)).toEqual(['op5', 'op6', 'op7', 'op8', 'op9']);
    expect(h.opsSince(8)).toEqual(['op8', 'op9']);
    expect(h.opsSince(10)).toEqual([]);
    expect(() => h.opsSince(4)).toThrow(RangeError);
    expect(() => h.opsSince(11)).toThrow(RangeError);
  });

  it('rejects a non-contiguous entry', () => {
    const h = new OpHistory(100, 0);
    expect(() => h.push(entry(1, 1))).toThrow(RangeError);
  });

  it('evicts the oldest entries past maxOps and keeps the newest', () => {
    const h = new OpHistory(3, 0);
    h.push(entry(0, 2, 'a', 1));
    h.push(entry(2, 2, 'b', 1));
    expect(h.floorRev).toBe(2);
    expect(h.findByClient(c('a'), 1)).toBeUndefined();
    expect(h.findByClient(c('b'), 1)?.r).toBe(4);
    h.push(entry(4, 5, 'c', 1));
    expect(h.length).toBe(1);
    expect(h.floorRev).toBe(4);
  });

  it('entriesAfter includes all-dropped entries at the rev and skips entries ending there', () => {
    const h = new OpHistory(100, 0);
    h.push(entry(0, 2, 'a', 1));
    h.push(entry(2, 0, 'b', 1));
    h.push(entry(2, 1, 'c', 1));
    expect(h.entriesAfter(2).map((e) => e.c)).toEqual(['b', 'c']);
    expect(h.entriesAfter(0).map((e) => e.c)).toEqual(['a', 'b', 'c']);
  });

  it('historyMaxOps is max(1000, 2 × everyOps)', () => {
    expect(historyMaxOps(100)).toBe(1000);
    expect(historyMaxOps(800)).toBe(1600);
  });
});

describe('replayMessage', () => {
  it('acks own batches (committed when transformed) and sends remotes for others', () => {
    expect(replayMessage(entry(0, 1, 'a', 3, true), c('a'))).toEqual({ type: 'ack', clientSeq: 3, rev: 1, committed: ['op0'] });
    expect(replayMessage(entry(0, 1, 'a', 3), c('a'))).toEqual({ type: 'ack', clientSeq: 3, rev: 1 });
    expect(replayMessage(entry(0, 1, 'b', 3), c('a'))).toEqual({ type: 'remote', fromRev: 0, ops: ['op0'], clientId: 'b' });
    expect(replayMessage(entry(0, 0, 'b', 3), c('a'))).toBeNull();
  });
});
