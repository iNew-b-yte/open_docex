/**
 * `DocumentRegistry` (LLD Part 2 §8.2): the loaded instances, with single-flight loading.
 *
 * - Concurrent loads of one document share one promise. A failed load removes its entry, so
 *   the next `join` retries.
 * - **First ref wins (LLD choice):** a `join` whose `ref` or `format` differs from the loaded
 *   instance's is logged at warn level and joins the loaded instance.
 * - An instance removes itself when it reaches `CLOSED` (fault or shutdown).
 *
 * @module
 */
import type { DocumentId } from '@open-docex/shared/ids';
import type { FileFormat } from '@open-docex/shared/protocol';
import type { Logger } from '../log/logger.js';
import type { MetaStore } from '../persistence/meta-store.js';
import { docKeyOf } from '../persistence/layout.js';
import type { StorageRef } from '../storage/storage-adapter.js';
import type { DocumentInstance } from './document-instance.js';
import type { DocumentInstanceFactory } from './instance-factory.js';

/** The loaded documents of one Core. */
export class DocumentRegistry {
  readonly #factory: DocumentInstanceFactory;
  readonly #logger: Logger;
  readonly #meta: MetaStore | undefined;
  readonly #loaded = new Map<DocumentId, DocumentInstance>();
  readonly #loading = new Map<DocumentId, Promise<DocumentInstance>>();

  constructor(d: { factory: DocumentInstanceFactory; logger: Logger; meta?: MetaStore }) {
    this.#factory = d.factory;
    this.#logger = d.logger;
    this.#meta = d.meta;
  }

  /** The loaded (ACTIVE or closing) instance, if any. */
  get(id: DocumentId): DocumentInstance | undefined {
    return this.#loaded.get(id);
  }

  /** Returns the loaded instance, or loads it once for all concurrent callers. */
  getOrLoad(id: DocumentId, doc: { ref: StorageRef; format: FileFormat }): Promise<DocumentInstance> {
    const inst = this.#loaded.get(id);
    if (inst !== undefined) {
      this.#checkSameDoc(inst, doc);
      return Promise.resolve(inst);
    }
    const pending = this.#loading.get(id);
    if (pending !== undefined) {
      return pending.then((i) => {
        this.#checkSameDoc(i, doc);
        return i;
      });
    }
    const p = this.#load(id, doc);
    this.#loading.set(id, p);
    return p;
  }

  async #load(id: DocumentId, doc: { ref: StorageRef; format: FileFormat }): Promise<DocumentInstance> {
    try {
      const inst = this.#factory.create(id, doc, {
        onClosed: (i) => {
          if (this.#loaded.get(id) === i) this.#loaded.delete(id);
        },
      });
      await inst.load();
      this.#loaded.set(id, inst);
      return inst;
    } finally {
      this.#loading.delete(id);
    }
  }

  /**
   * V3: a durable queue has a backlog for a document with no consumer. `ref` and `format` come
   * from `MetaStore`; with no meta, the backlog is acked and dropped with a warn log. In V1 the
   * memory queue never reports a backlog.
   */
  async ensureLoadedForBacklog(id: DocumentId): Promise<void> {
    if (this.#loaded.has(id)) return;
    const meta = this.#meta?.get(docKeyOf(id));
    if (meta === undefined) {
      // Acking and dropping the backlog needs a durable adapter (V3); the memory queue has none.
      this.#logger.warn('Queue backlog for an unknown document dropped.', { documentId: id });
      return;
    }
    await this.getOrLoad(id, { ref: meta.ref, format: meta.format });
  }

  /** Forgets an instance (it calls this itself through its `onClosed` hook). */
  remove(id: DocumentId): void {
    this.#loaded.delete(id);
  }

  /** Every loaded instance. */
  all(): Iterable<DocumentInstance> {
    return [...this.#loaded.values()];
  }

  #checkSameDoc(inst: DocumentInstance, doc: { ref: StorageRef; format: FileFormat }): void {
    if (inst.format !== doc.format || stableJson(inst.ref) !== stableJson(doc.ref)) {
      this.#logger.warn('Join with a different ref or format; joined the loaded document.', { documentId: inst.documentId });
    }
  }
}

/** JSON with object keys sorted, so equal refs compare equal whatever their key order. */
function stableJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (typeof x === 'object' && x !== null) {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(x) ?? 'null';
}
