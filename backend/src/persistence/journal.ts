/**
 * The per-document append-only journal (LLD Part 2 §10.2, HLD CL-5).
 *
 * Entries live in segment files `journal/<fromRev:012d>.ndjson`. Each line is
 * `{"k":"<crc32 hex>","e":<entry JSON>}\n`, where `k` is `zlib.crc32` of the entry JSON text,
 * as 8 lowercase hex digits.
 *
 * - **Writing:** the current segment is opened with flag `'a'`. All operations (append, rotate,
 *   trim, datasync, close) run one at a time on a per-journal mutex, because concurrent
 *   `filehandle.write()` calls on one file are unsafe.
 * - **Durability:** a resolved `append` has reached the OS, so it survives a process crash.
 *   With fsync `'always'`, `append` also `datasync`s, so it survives an OS crash. With
 *   `'interval'`, a {@link JournalSyncTimer} calls {@link Journal.datasync} on a fixed period.
 * - **Repair:** on `open`, a torn last line of the last segment (no newline, bad JSON or bad
 *   CRC) is truncated away with a warning. A bad line anywhere else fails `read` with
 *   `DOCUMENT_FAULTED`, and the file is kept as is.
 *
 * Platform differences: on Windows, `'a'` maps to `FILE_APPEND_DATA` and `datasync` to
 * `FlushFileBuffers`, which also flushes metadata, so it is slower than Linux `fdatasync`.
 * A new segment's folder entry is made durable with a folder fsync on POSIX only (see
 * {@link fsyncDir}).
 *
 * @module
 */
import { mkdir, open, readdir, readFile, truncate, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { OpenDocexError } from '@open-docex/shared/errors';
import type { ClientId } from '@open-docex/shared/ids';
import { engineError } from '../errors/engine-error.js';
import { noopLogger, type Logger } from '../log/logger.js';
import { fsyncDir } from './atomic-file.js';
import { DIR_MODE, FILE_MODE } from './layout.js';

/** One applied submission (LLD Part 2 §10.2). `toRev = f + o.length`. */
export interface JournalEntry {
  /** fromRev. */
  f: number;
  /** toRev. */
  r: number;
  /** clientId. */
  c: ClientId;
  /** clientSeq. */
  q: number;
  /** userId. */
  u: string;
  /** Time in ms. */
  t: number;
  /** Transformed: the ack echoes `committed`. */
  x: boolean;
  /** The applied ops. */
  o: unknown[];
}

/** The fsync policy (`JournalConfig.fsync`, HLD CL-5). */
export type FsyncPolicy = 'interval' | 'always';

/** Options for {@link Journal.open}. */
export interface JournalOpenOptions {
  fsync: FsyncPolicy;
  /** Receives the torn-tail repair warning. Defaults to a no-op logger. */
  logger?: Logger;
}

const SEGMENT = /^(\d{12})\.ndjson$/;
const LINE = /^\{"k":"([0-9a-f]{8})","e":(.*)\}$/s;
const NEWLINE = 0x0a;

/** Returns the segment file name for `fromRev`: 12 zero-padded digits plus `.ndjson`. */
export function segmentName(fromRev: number): string {
  if (!Number.isSafeInteger(fromRev) || fromRev < 0) throw new RangeError('fromRev must be a non-negative integer.');
  return `${String(fromRev).padStart(12, '0')}.ndjson`;
}

/** Builds one journal line, including its trailing newline. */
export function encodeLine(e: JournalEntry): string {
  const json = JSON.stringify(e);
  return `{"k":"${crc32(json).toString(16).padStart(8, '0')}","e":${json}}\n`;
}

/** Parses one journal line (without its newline). Returns `null` when it is torn or corrupt. */
export function decodeLine(line: string): JournalEntry | null {
  const m = LINE.exec(line);
  if (m === null) return null;
  const json = m[2] ?? '';
  if (crc32(json).toString(16).padStart(8, '0') !== m[1]) return null;
  let e: unknown;
  try {
    e = JSON.parse(json);
  } catch {
    return null;
  }
  return isEntry(e) ? e : null;
}

function isEntry(e: unknown): e is JournalEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    Number.isSafeInteger(o['f']) &&
    Number.isSafeInteger(o['r']) &&
    typeof o['c'] === 'string' &&
    Number.isSafeInteger(o['q']) &&
    typeof o['u'] === 'string' &&
    typeof o['t'] === 'number' &&
    typeof o['x'] === 'boolean' &&
    Array.isArray(o['o'])
  );
}

async function listSegments(dir: string): Promise<number[]> {
  const revs: number[] = [];
  for (const name of await readdir(dir)) {
    const m = SEGMENT.exec(name);
    if (m?.[1] !== undefined) revs.push(Number(m[1]));
  }
  return revs.sort((a, b) => a - b);
}

/**
 * Truncates a torn last line from `file`. Returns true when something was removed.
 * Only the final line can be torn, because writes are sequential.
 */
async function repairTail(file: string): Promise<boolean> {
  const buf = await readFile(file);
  if (buf.length === 0) return false;
  const lastNl = buf.lastIndexOf(NEWLINE);
  if (lastNl !== buf.length - 1) {
    // A fragment without its newline: the write was cut short.
    await truncate(file, lastNl + 1);
    return true;
  }
  const start = buf.lastIndexOf(NEWLINE, lastNl - 1) + 1;
  if (decodeLine(buf.subarray(start, lastNl).toString('utf8')) !== null) return false;
  await truncate(file, start);
  return true;
}

/**
 * An open journal for one document. Create it with {@link Journal.open}.
 */
export class Journal {
  readonly #dir: string;
  readonly #fsync: FsyncPolicy;
  #segments: number[];
  #fh: FileHandle | null = null;
  #dirty = false;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(dir: string, fsync: FsyncPolicy, segments: number[]) {
    this.#dir = dir;
    this.#fsync = fsync;
    this.#segments = segments;
  }

  /**
   * Opens the journal in `dir`, creating the folder if needed, repairing a torn tail of the
   * last segment, and opening that segment for appending. When there is no segment yet, the
   * first `append` creates one named after its entry's `f`.
   */
  static async open(dir: string, p: JournalOpenOptions): Promise<Journal> {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const segments = await listSegments(dir);
    const j = new Journal(dir, p.fsync, segments);
    const last = segments.at(-1);
    if (last !== undefined) {
      const file = path.join(dir, segmentName(last));
      if (await repairTail(file)) {
        (p.logger ?? noopLogger).warn('Journal: truncated a torn last line.', { rev: last });
      }
      j.#fh = await open(file, 'a', FILE_MODE);
    }
    return j;
  }

  /** True when entries were written since the last `datasync`. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /**
   * Appends `e`. Resolves once the line is written (and, with fsync `'always'`, `datasync`ed).
   *
   * @throws {OpenDocexError} `DOCUMENT_FAULTED` when the write fails or the journal is closed.
   */
  append(e: JournalEntry): Promise<void> {
    const line = encodeLine(e);
    return this.#run(async () => {
      if (this.#fh === null) await this.#openSegment(e.f);
      const fh = this.#fh as FileHandle;
      await fh.write(line);
      if (this.#fsync === 'always') {
        await fh.datasync();
      } else {
        this.#dirty = true;
      }
    });
  }

  /**
   * Closes the current segment (after a `datasync`) and opens `<atRev>.ndjson`. Reusing an
   * existing segment name appends to that file.
   */
  rotate(atRev: number): Promise<void> {
    return this.#run(async () => {
      await this.#closeHandle();
      await this.#openSegment(atRev);
    });
  }

  /**
   * Deletes whole segments whose last entry's `r` is below `rev`. A segment's last `r` is at
   * most the next segment's `fromRev`, so a segment is deleted when the next one starts below
   * `rev`. The current (last) segment is never deleted.
   */
  trimBefore(rev: number): Promise<void> {
    return this.#run(async () => {
      const keep: number[] = [];
      for (let i = 0; i < this.#segments.length; i++) {
        const seg = this.#segments[i] as number;
        const next = this.#segments[i + 1];
        if (next !== undefined && next < rev) {
          await unlink(path.join(this.#dir, segmentName(seg)));
        } else {
          keep.push(seg);
        }
      }
      this.#segments = keep;
    });
  }

  /**
   * Yields every entry in order, verifying each line's checksum.
   *
   * @throws {OpenDocexError} `DOCUMENT_FAULTED` on a corrupt line (the file is kept).
   */
  async *read(): AsyncIterable<JournalEntry> {
    for (const seg of [...this.#segments]) {
      const name = segmentName(seg);
      const text = await readFile(path.join(this.#dir, name), 'utf8');
      const lines = text.split('\n');
      // A complete file ends with a newline, so the last element is empty.
      const tail = lines.pop();
      if (tail !== undefined && tail !== '') throw corrupt(name, lines.length + 1);
      for (let i = 0; i < lines.length; i++) {
        const e = decodeLine(lines[i] as string);
        if (e === null) throw corrupt(name, i + 1);
        yield e;
      }
    }
  }

  /** `datasync`s the current segment when entries were written since the last sync. */
  datasync(): Promise<void> {
    return this.#run(async () => {
      if (!this.#dirty || this.#fh === null) return;
      this.#dirty = false;
      await this.#fh.datasync();
    }, true);
  }

  /** Syncs and closes the journal. Later calls to `datasync` and `close` do nothing. */
  close(): Promise<void> {
    return this.#run(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.#closeHandle();
    }, true);
  }

  async #openSegment(fromRev: number): Promise<void> {
    const file = path.join(this.#dir, segmentName(fromRev));
    this.#fh = await open(file, 'a', FILE_MODE);
    if (!this.#segments.includes(fromRev)) {
      this.#segments.push(fromRev);
      this.#segments.sort((a, b) => a - b);
      await fsyncDir(this.#dir);
    }
  }

  async #closeHandle(): Promise<void> {
    const fh = this.#fh;
    if (fh === null) return;
    this.#fh = null;
    try {
      if (this.#dirty) await fh.datasync();
      this.#dirty = false;
    } finally {
      await fh.close();
    }
  }

  /** Runs `fn` after every earlier operation. `allowClosed` lets it run after `close`. */
  #run(fn: () => Promise<void>, allowClosed = false): Promise<void> {
    const next = this.#tail.then(async () => {
      if (this.#closed && !allowClosed) {
        throw engineError('DOCUMENT_FAULTED', { message: 'The journal is closed.' });
      }
      try {
        await fn();
      } catch (err) {
        if (err instanceof OpenDocexError) throw err;
        throw engineError('DOCUMENT_FAULTED', { message: 'A journal write failed.', cause: err });
      }
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

function corrupt(name: string, line: number): Error {
  return engineError('DOCUMENT_FAULTED', { message: `Journal segment ${name} has a corrupt line ${line}.` });
}

/** The timer part of a Clock (LLD Part 2 conventions). */
export interface TimerClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real timers, `unref()`'d so they never keep the process alive. */
export const realTimerClock: TimerClock = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * The Core-wide fsync timer for policy `'interval'` (LLD Part 2 §10.2, boot step 9). Every
 * `intervalMs` it calls `datasync()` on each registered journal; a journal not written since
 * its last sync does nothing. A failed sync is logged and the timer keeps running.
 */
export class JournalSyncTimer {
  readonly #journals = new Set<Journal>();
  readonly #intervalMs: number;
  readonly #clock: TimerClock;
  readonly #logger: Logger;
  #handle: unknown = null;
  #running = false;

  constructor(o: { intervalMs: number; clock?: TimerClock; logger?: Logger }) {
    this.#intervalMs = o.intervalMs;
    this.#clock = o.clock ?? realTimerClock;
    this.#logger = o.logger ?? noopLogger;
  }

  /** Registers a journal to be synced on each tick. */
  add(j: Journal): void {
    this.#journals.add(j);
  }

  /** Unregisters a journal (for example, when its instance unloads). */
  delete(j: Journal): void {
    this.#journals.delete(j);
  }

  /** Starts ticking. Calling it again while running does nothing. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule();
  }

  /** Stops ticking. */
  stop(): void {
    this.#running = false;
    if (this.#handle !== null) this.#clock.clearTimeout(this.#handle);
    this.#handle = null;
  }

  /** Syncs every registered journal now. Used by each tick and by a fast shutdown. */
  async syncAll(): Promise<void> {
    await Promise.all(
      [...this.#journals].map((j) =>
        j.datasync().catch((err: unknown) => {
          this.#logger.error('Journal datasync failed.', { code: codeOf(err) });
        }),
      ),
    );
  }

  #schedule(): void {
    this.#handle = this.#clock.setTimeout(() => {
      this.#handle = null;
      void this.syncAll().finally(() => {
        if (this.#running) this.#schedule();
      });
    }, this.#intervalMs);
  }
}

function codeOf(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'UNKNOWN';
}
