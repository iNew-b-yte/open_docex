import { appendFile, mkdtemp, open, readdir, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenDocexError } from '@open-docex/shared/errors';
import type { ClientId } from '@open-docex/shared/ids';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeLine,
  encodeLine,
  Journal,
  JournalSyncTimer,
  segmentName,
  type JournalEntry,
  type TimerClock,
} from '../../../src/persistence/journal.js';
import type { LogFields, Logger } from '../../../src/log/logger.js';

const entry = (f: number, n = 1): JournalEntry => ({
  f,
  r: f + n,
  c: 'AAAAAAAAAAAAAAAAAAAAAA' as ClientId,
  q: f + 1,
  u: 'user-1',
  t: 1_700_000_000_000 + f,
  x: f % 2 === 0,
  o: Array.from({ length: n }, (_, i) => ({ stepType: 'replace', at: f + i, text: 'é\n"' })),
});

async function readAll(j: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

/** The FileHandle prototype, so `datasync` calls can be counted. */
async function fileHandleProto(dir: string): Promise<FileHandle> {
  const fh = await open(path.join(dir, 'proto-probe'), 'w');
  const proto = Object.getPrototypeOf(fh) as FileHandle;
  await fh.close();
  return proto;
}

let dir: string;
let jdir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-journal-'));
  jdir = path.join(dir, 'journal');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('line format', () => {
  it('encodes {"k":crc32,"e":entry} and decodes it back', () => {
    const e = entry(3, 2);
    const line = encodeLine(e);
    expect(line.endsWith('\n')).toBe(true);
    expect(line).toMatch(/^\{"k":"[0-9a-f]{8}","e":\{/);
    expect(decodeLine(line.slice(0, -1))).toEqual(e);
  });

  it('rejects a bad CRC, bad JSON and a malformed entry', () => {
    const line = encodeLine(entry(0)).slice(0, -1);
    const badCrc = line.replace(/"k":"([0-9a-f]{8})"/, (_m, k: string) => `"k":"${k === '00000000' ? '00000001' : '00000000'}"`);
    expect(decodeLine(badCrc)).toBeNull();
    expect(decodeLine(line.slice(0, -5))).toBeNull();
    expect(decodeLine('{"k":"00000000","e":{}}')).toBeNull();
  });

  it('names segments with 12 zero-padded digits', () => {
    expect(segmentName(0)).toBe('000000000000.ndjson');
    expect(segmentName(1234)).toBe('000000001234.ndjson');
    expect(() => segmentName(-1)).toThrow(RangeError);
  });
});

describe('Journal', () => {
  it('appends and replays entries in order across a reopen', async () => {
    const j = await Journal.open(jdir, { fsync: 'interval' });
    const es = [entry(0), entry(1, 2), entry(3)];
    for (const e of es) await j.append(e);
    expect(await readAll(j)).toEqual(es);
    await j.close();

    const again = await Journal.open(jdir, { fsync: 'interval' });
    expect(await readAll(again)).toEqual(es);
    await again.append(entry(4));
    expect((await readAll(again)).map((e) => e.f)).toEqual([0, 1, 3, 4]);
    await again.close();
    expect(await readdir(jdir)).toEqual(['000000000000.ndjson']);
  });

  it('serializes overlapping append calls in call order', async () => {
    const j = await Journal.open(jdir, { fsync: 'always' });
    await Promise.all([0, 1, 2, 3, 4, 5].map((f) => j.append(entry(f))));
    expect((await readAll(j)).map((e) => e.f)).toEqual([0, 1, 2, 3, 4, 5]);
    await j.close();
  });

  it('names the first segment after the first entry', async () => {
    const j = await Journal.open(jdir, { fsync: 'interval' });
    await j.append(entry(42));
    await j.close();
    expect(await readdir(jdir)).toEqual(['000000000042.ndjson']);
  });

  describe('torn tail (crash mid-write)', () => {
    async function writeTwoThenTear(tear: string): Promise<string> {
      const j = await Journal.open(jdir, { fsync: 'interval' });
      await j.append(entry(0));
      await j.append(entry(1));
      await j.close();
      const file = path.join(jdir, segmentName(0));
      await appendFile(file, tear);
      return file;
    }

    const cases: Array<[string, () => string]> = [
      ['a line without its newline', () => encodeLine(entry(2)).slice(0, 30)],
      ['a full line missing only its newline', () => encodeLine(entry(2)).slice(0, -1)],
      ['a complete line with a bad CRC', () => encodeLine(entry(2)).replace(/"k":"[0-9a-f]{8}"/, '"k":"zzzzzzzz"')],
      ['a complete line with bad JSON', () => '{"k":"00000000","e":{"f":2,\n'],
    ];

    it.each(cases)('truncates %s and keeps every earlier entry', async (_name, tear) => {
      const file = await writeTwoThenTear(tear());
      const before = (await readFile(file)).length;
      const warnings: Array<[string, LogFields | undefined]> = [];
      const logger: Logger = {
        debug() {},
        info() {},
        warn: (m, f) => warnings.push([m, f]),
        error() {},
      };
      const j = await Journal.open(jdir, { fsync: 'interval', logger });
      expect(warnings).toHaveLength(1);
      expect((await readFile(file)).length).toBeLessThan(before);
      expect((await readAll(j)).map((e) => e.f)).toEqual([0, 1]);
      // Appending after the repair yields a clean file.
      await j.append(entry(2));
      await j.close();
      const reopened = await Journal.open(jdir, { fsync: 'interval' });
      expect((await readAll(reopened)).map((e) => e.f)).toEqual([0, 1, 2]);
      await reopened.close();
    });

    it('leaves a clean file untouched', async () => {
      const j = await Journal.open(jdir, { fsync: 'interval' });
      await j.append(entry(0));
      await j.close();
      const file = path.join(jdir, segmentName(0));
      const bytes = await readFile(file);
      const warn = vi.fn();
      const again = await Journal.open(jdir, { fsync: 'interval', logger: { debug() {}, info() {}, warn, error() {} } });
      await again.close();
      expect(warn).not.toHaveBeenCalled();
      expect(await readFile(file)).toEqual(bytes);
    });
  });

  it('fails read with DOCUMENT_FAULTED on a mid-file corrupt line and keeps the file', async () => {
    const j = await Journal.open(jdir, { fsync: 'interval' });
    await j.append(entry(0));
    await j.close();
    const file = path.join(jdir, segmentName(0));
    const good = await readFile(file, 'utf8');
    const corrupt = good.replace('"u":"user-1"', '"u":"user-X"') + encodeLine(entry(1));
    await writeFile(file, corrupt);

    const again = await Journal.open(jdir, { fsync: 'interval' });
    const err = await rejection(readAll(again));
    expect(err).toBeInstanceOf(OpenDocexError);
    expect((err as OpenDocexError).code).toBe('DOCUMENT_FAULTED');
    await again.close();
    expect(await readFile(file, 'utf8')).toBe(corrupt);
  });

  it('rotates into a new segment and trims whole old segments', async () => {
    const j = await Journal.open(jdir, { fsync: 'interval' });
    await j.append(entry(0));
    await j.append(entry(1));
    await j.rotate(2);
    await j.append(entry(2));
    await j.append(entry(3));
    await j.rotate(4);
    await j.append(entry(4));
    expect((await readdir(jdir)).sort()).toEqual(['000000000000.ndjson', '000000000002.ndjson', '000000000004.ndjson']);
    expect((await readAll(j)).map((e) => e.f)).toEqual([0, 1, 2, 3, 4]);

    await j.trimBefore(2); // segment 0 ends at r = 2, not below 2: kept
    expect(await readdir(jdir)).toHaveLength(3);
    await j.trimBefore(3); // segment 0's last r (2) < 3: deleted
    expect((await readdir(jdir)).sort()).toEqual(['000000000002.ndjson', '000000000004.ndjson']);
    await j.trimBefore(1_000); // the current segment is never deleted
    expect(await readdir(jdir)).toEqual(['000000000004.ndjson']);
    expect((await readAll(j)).map((e) => e.f)).toEqual([4]);
    await j.close();
  });

  it("with fsync 'always', datasyncs exactly once per append", async () => {
    const proto = await fileHandleProto(dir);
    const spy = vi.spyOn(proto, 'datasync');
    const j = await Journal.open(jdir, { fsync: 'always' });
    for (let f = 0; f < 5; f++) {
      await j.append(entry(f));
      expect(spy).toHaveBeenCalledTimes(f + 1);
    }
    expect(j.dirty).toBe(false);
    spy.mockClear();
    await j.close(); // nothing left to sync
    expect(spy).not.toHaveBeenCalled();
  });

  it("with fsync 'interval', append does not sync; datasync syncs once and only when dirty", async () => {
    const proto = await fileHandleProto(dir);
    const spy = vi.spyOn(proto, 'datasync');
    const j = await Journal.open(jdir, { fsync: 'interval' });
    await j.append(entry(0));
    await j.append(entry(1));
    expect(spy).not.toHaveBeenCalled();
    expect(j.dirty).toBe(true);
    await j.datasync();
    expect(spy).toHaveBeenCalledTimes(1);
    await j.datasync();
    expect(spy).toHaveBeenCalledTimes(1);
    await j.close();
  });

  it('rejects append after close with DOCUMENT_FAULTED; datasync and close stay no-ops', async () => {
    const j = await Journal.open(jdir, { fsync: 'interval' });
    await j.close();
    const err = await rejection(j.append(entry(0)));
    expect((err as OpenDocexError).code).toBe('DOCUMENT_FAULTED');
    await expect(j.datasync()).resolves.toBeUndefined();
    await expect(j.close()).resolves.toBeUndefined();
  });
});

describe('JournalSyncTimer', () => {
  class FakeClock implements TimerClock {
    pending: Array<{ fn: () => void; ms: number; id: number }> = [];
    #next = 1;
    setTimeout(fn: () => void, ms: number): unknown {
      const id = this.#next++;
      this.pending.push({ fn, ms, id });
      return id;
    }
    clearTimeout(h: unknown): void {
      this.pending = this.pending.filter((t) => t.id !== h);
    }
    fire(): void {
      const t = this.pending.shift();
      t?.fn();
    }
  }

  it('syncs every journal written since its last sync on each tick, then reschedules', async () => {
    const proto = await fileHandleProto(dir);
    const spy = vi.spyOn(proto, 'datasync');
    const clock = new FakeClock();
    const timer = new JournalSyncTimer({ intervalMs: 1000, clock });
    const a = await Journal.open(path.join(dir, 'a'), { fsync: 'interval' });
    const b = await Journal.open(path.join(dir, 'b'), { fsync: 'interval' });
    timer.add(a);
    timer.add(b);
    timer.start();
    expect(clock.pending).toHaveLength(1);
    expect(clock.pending[0]?.ms).toBe(1000);

    await a.append(entry(0));
    clock.fire();
    await vi.waitFor(() => expect(clock.pending).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1); // only `a` was dirty
    expect(a.dirty).toBe(false);

    clock.fire();
    await vi.waitFor(() => expect(clock.pending).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1); // nothing new

    timer.stop();
    expect(clock.pending).toHaveLength(0);
    await a.close();
    await b.close();
  });

  it('logs a failed sync and keeps running', async () => {
    const proto = await fileHandleProto(dir);
    vi.spyOn(proto, 'datasync').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));
    const errors: Array<LogFields | undefined> = [];
    const clock = new FakeClock();
    const timer = new JournalSyncTimer({
      intervalMs: 50,
      clock,
      logger: { debug() {}, info() {}, warn() {}, error: (_m, f) => errors.push(f) },
    });
    const j = await Journal.open(jdir, { fsync: 'interval' });
    timer.add(j);
    timer.start();
    await j.append(entry(0));
    clock.fire();
    await vi.waitFor(() => expect(clock.pending).toHaveLength(1));
    expect(errors).toEqual([{ code: 'DOCUMENT_FAULTED' }]);
    timer.stop();
    vi.restoreAllMocks();
    await j.close();
  });
});
