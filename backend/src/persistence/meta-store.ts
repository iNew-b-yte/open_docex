/**
 * `MetaStore`: per-document metadata in `meta.json`, cached in memory (LLD Part 2 §10.4,
 * §0 R-19).
 *
 * - `loadAll()` scans `docs/*\/*\/meta.json` at boot.
 * - `put` writes atomically and is serialized per docKey.
 * - A `meta.json` that does not parse is logged and skipped; its folder is never deleted.
 *
 * @module
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ErrorCode } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import type { DocKind, FileFormat, UnsupportedFinding } from '@open-docex/shared/protocol';
import { noopLogger, type Logger } from '../log/logger.js';
import type { StorageRef, StorageVersion } from '../storage/storage-adapter.js';
import { writeFileAtomic } from './atomic-file.js';
import { DIR_MODE, docDir, docKeyOf, docsRoot, isDocKey, metaPath } from './layout.js';

/** The storage state machine's states (LLD Part 2 §13). */
export type StorageState = 'NORMAL' | 'LOCAL' | 'CHECK' | 'PENDING' | 'CONFLICT';

/** The persisted metadata of one document (LLD Part 2 §10.4). */
export interface DocumentMeta {
  schema: 1;
  documentId: DocumentId;
  kind: DocKind;
  format: FileFormat;
  /** Must be JSON-serializable. */
  ref: StorageRef;
  storageState: StorageState;
  /** The storage version after our last successful read or write. */
  lastKnownVersion: StorageVersion | null;
  lastFlushedRev: number;
  /** The last rev written into meta (on flush, state change, snapshot). */
  rev: number;
  /**
   * The highest rev whose `audit` event has been emitted (§0 R-19, PO-17). On boot the Core
   * re-emits journal entries with `rev > auditEmittedRev`, flagged `replayed`.
   */
  auditEmittedRev: number;
  /** 0..3. */
  retryCount: number;
  nextRetryAt: number | null;
  localSince: number | null;
  lastError?: { code: ErrorCode; message: string; at: number };
  conflict?: { detectedAt: number; storageVersion: StorageVersion | null };
  readOnly: { findings: UnsupportedFinding[]; allowedEdit: boolean };
  /** V3 (§8.6), at most 32 entries. */
  lineage: Array<{ epoch: string; fromRev: number }>;
  createdAt: number;
  updatedAt: number;
}

/** The in-memory cache of every document's `meta.json`. */
export class MetaStore {
  readonly #dataDir: string;
  readonly #logger: Logger;
  readonly #byKey = new Map<string, DocumentMeta>();
  readonly #writes = new Map<string, Promise<unknown>>();

  constructor(dataDir: string, o: { logger?: Logger } = {}) {
    this.#dataDir = dataDir;
    this.#logger = o.logger ?? noopLogger;
  }

  /**
   * Loads every `docs/<k0k1>/<docKey>/meta.json` into memory. Folders whose names are not hash
   * shaped are ignored. A file that does not parse, is malformed or belongs to another docKey is
   * logged and skipped.
   */
  async loadAll(): Promise<void> {
    const root = docsRoot(this.#dataDir);
    let shards: string[];
    try {
      shards = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      let keys: string[];
      try {
        keys = await readdir(path.join(root, shard));
      } catch {
        continue; // not a folder
      }
      for (const key of keys) {
        if (!isDocKey(key) || key.slice(0, 2) !== shard) continue;
        await this.#loadOne(key);
      }
    }
  }

  async #loadOne(key: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(metaPath(this.#dataDir, key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.#logger.warn('MetaStore: meta.json could not be read; skipped.');
      return;
    }
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      this.#logger.warn('MetaStore: meta.json does not parse; skipped.');
      return;
    }
    if (!isMeta(m) || docKeyOf(m.documentId) !== key) {
      this.#logger.warn('MetaStore: meta.json is malformed; skipped.');
      return;
    }
    this.#byKey.set(key, m);
  }

  /** Returns a copy of the cached metadata for `docKey`, if any. */
  get(docKey: string): DocumentMeta | undefined {
    const m = this.#byKey.get(docKey);
    return m === undefined ? undefined : structuredClone(m);
  }

  /**
   * Writes `m` to its document's `meta.json` atomically, then updates the cache. Calls for the
   * same document run one at a time, in call order.
   */
  put(m: DocumentMeta): Promise<void> {
    const key = docKeyOf(m.documentId);
    const copy = structuredClone(m);
    const prev = this.#writes.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(docDir(this.#dataDir, key), { recursive: true, mode: DIR_MODE });
      await writeFileAtomic(metaPath(this.#dataDir, key), JSON.stringify(copy));
      this.#byKey.set(key, copy);
    });
    const settled = next.catch(() => undefined);
    this.#writes.set(key, settled);
    void settled.then(() => {
      if (this.#writes.get(key) === settled) this.#writes.delete(key);
    });
    return next;
  }

  /** Returns copies of every cached document's metadata. */
  list(): DocumentMeta[] {
    return [...this.#byKey.values()].map((m) => structuredClone(m));
  }
}

function isNonNegInt(x: unknown): boolean {
  return Number.isSafeInteger(x) && (x as number) >= 0;
}

function isMeta(x: unknown): x is DocumentMeta {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o['schema'] === 1 &&
    typeof o['documentId'] === 'string' &&
    (o['kind'] === 'text' || o['kind'] === 'sheet') &&
    typeof o['storageState'] === 'string' &&
    isNonNegInt(o['rev']) &&
    isNonNegInt(o['lastFlushedRev']) &&
    isNonNegInt(o['auditEmittedRev']) &&
    typeof o['readOnly'] === 'object' &&
    o['readOnly'] !== null &&
    Array.isArray(o['lineage'])
  );
}
