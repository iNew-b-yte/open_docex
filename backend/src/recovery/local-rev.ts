/**
 * `localRev` at boot (LLD Part 2 §13): the snapshot rev advanced by the last journal entry,
 * read from the tail of the last segment only, without opening the journal.
 *
 * A segment is named after the rev it was rotated at (`<fromRev:012d>.ndjson`, §10.2), which is
 * the snapshot rev for `snapshotAndRotate` and fresh imports. So an empty last segment gives its
 * `fromRev`. A torn last line (the journal repairs it at open) is skipped.
 *
 * @module
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeLine, segmentName } from '../persistence/journal.js';
import { journalDir } from '../persistence/layout.js';

const SEGMENT = /^(\d{12})\.ndjson$/;

/** Returns the local rev of `docKey`, or `null` when it has no journal segment. */
export async function readLocalRev(dataDir: string, docKey: string): Promise<number | null> {
  const dir = journalDir(dataDir, docKey);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let last = -1;
  for (const n of names) {
    const m = SEGMENT.exec(n);
    if (m?.[1] !== undefined) last = Math.max(last, Number(m[1]));
  }
  if (last < 0) return null;
  const lines = (await readFile(path.join(dir, segmentName(last)), 'utf8')).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line === '') continue;
    const e = decodeLine(line);
    if (e !== null) return Math.max(last, e.r);
  }
  return last;
}
