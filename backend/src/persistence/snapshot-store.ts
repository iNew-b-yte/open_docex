/**
 * `SnapshotStore`: one `snapshot.json` per document, replaced atomically (LLD Part 2 §10.3).
 *
 * The compaction sequence (`snapshotAndRotate`) belongs to the document instance; this module
 * only reads and writes the file.
 *
 * @module
 */
import { mkdir, readFile } from 'node:fs/promises';
import type { ClientId } from '@open-docex/shared/ids';
import type { DocKind } from '@open-docex/shared/protocol';
import { engineError } from '../errors/engine-error.js';
import { writeFileAtomic } from './atomic-file.js';
import { DIR_MODE, docDir, snapshotPath } from './layout.js';

/** The snapshot file (LLD Part 2 §10.3). */
export interface SnapshotFile {
  v: 1;
  kind: DocKind;
  rev: number;
  savedAt: number;
  /** `ot.serializeSnapshot` output. */
  model: unknown;
  /** Dedupe table rows: `[clientId, clientSeq, rev]`. */
  dedupe: Array<[ClientId, number, number]>;
}

/** Reads and writes `docs/<k0k1>/<docKey>/snapshot.json`. */
export class SnapshotStore {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  /**
   * Returns the snapshot, or `null` when the document has none.
   *
   * @throws {OpenDocexError} `DOCUMENT_FAULTED` when the file exists but is not a valid
   *   snapshot. The file is kept.
   */
  async read(docKey: string): Promise<SnapshotFile | null> {
    let text: string;
    try {
      text = await readFile(snapshotPath(this.#dataDir, docKey), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw engineError('DOCUMENT_FAULTED', { message: 'The snapshot could not be read.', cause: err });
    }
    let f: unknown;
    try {
      f = JSON.parse(text);
    } catch (err) {
      throw engineError('DOCUMENT_FAULTED', { message: 'The snapshot does not parse.', cause: err });
    }
    if (!isSnapshotFile(f)) throw engineError('DOCUMENT_FAULTED', { message: 'The snapshot is malformed.' });
    return f;
  }

  /** Replaces the snapshot atomically, creating the document folder if needed. */
  async write(docKey: string, f: SnapshotFile): Promise<void> {
    await mkdir(docDir(this.#dataDir, docKey), { recursive: true, mode: DIR_MODE });
    await writeFileAtomic(snapshotPath(this.#dataDir, docKey), JSON.stringify(f));
  }
}

function isSnapshotFile(x: unknown): x is SnapshotFile {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o['v'] === 1 &&
    (o['kind'] === 'text' || o['kind'] === 'sheet') &&
    Number.isSafeInteger(o['rev']) &&
    typeof o['savedAt'] === 'number' &&
    'model' in o &&
    Array.isArray(o['dedupe'])
  );
}
