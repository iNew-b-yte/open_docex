/**
 * `StorageRouter`: picks the adapter for a ref (LLD Part 2 §11.3, §2.6).
 *
 * - No adopter storage: every ref goes to `LocalFsStorage(<dataDir>/local-storage)`, and refs
 *   are plain strings.
 * - A ref shaped exactly `{ $local: string }`: the built-in local adapter. Such refs come from
 *   `documents.create({ target: 'local' })` while an adopter storage is configured, and are
 *   opaque to adopters.
 * - Everything else: the adopter's adapter.
 *
 * Callers pass the original ref to the routed adapter (`router.route(ref).write(ref, …)`), so
 * the adapter returned for a `{ $local }` ref unwraps it before calling `LocalFsStorage`.
 *
 * @module
 */
import path from 'node:path';
import type { Logger } from '../log/logger.js';
import { LocalFsStorage } from './local-fs-storage.js';
import type { StorageAdapter, StorageRef } from './storage-adapter.js';

/** The ref shape of a document kept in the built-in local storage beside an adopter storage. */
export interface LocalRef {
  readonly $local: string;
}

/** True when `ref` is exactly `{ $local: string }`, with no other own keys. */
export function isLocalRef(ref: unknown): ref is LocalRef {
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return false;
  const keys = Object.keys(ref);
  return keys.length === 1 && keys[0] === '$local' && typeof (ref as { $local: unknown }).$local === 'string';
}

/** Options for {@link StorageRouter}. */
export interface StorageRouterOptions {
  /** The engine's data folder; the built-in local storage lives in `<dataDir>/local-storage`. */
  dataDir: string;
  /** The adopter's adapter (`WorkerConfig.storage`), if any. */
  storage?: StorageAdapter;
  logger?: Logger;
}

/** The folder name of the built-in local storage inside the data folder (LLD Part 2 §10.1). */
export const LOCAL_STORAGE_DIR = 'local-storage';

/** Routes refs to the adopter's adapter or to the built-in local adapter (LLD Part 2 §11.3). */
export class StorageRouter {
  /** The built-in local adapter, with plain string refs. */
  readonly local: LocalFsStorage;
  readonly #adopter: StorageAdapter | undefined;
  readonly #wrapped: StorageAdapter;

  constructor(o: StorageRouterOptions) {
    this.local = new LocalFsStorage({
      root: path.join(o.dataDir, LOCAL_STORAGE_DIR),
      ...(o.logger !== undefined ? { logger: o.logger } : {}),
    });
    this.#adopter = o.storage;
    this.#wrapped = localRefAdapter(this.local);
  }

  /** Whether an adopter storage is configured. */
  get hasAdopterStorage(): boolean {
    return this.#adopter !== undefined;
  }

  /** The adapter that serves `ref`. Pass the same `ref` to it. */
  route(ref: StorageRef): StorageAdapter {
    if (isLocalRef(ref)) return this.#wrapped;
    return this.#adopter ?? this.local;
  }

  /**
   * The adapter whose `create` makes a document for `documents.create` (LLD Part 2 §2.6).
   * `'local'` with an adopter storage gives the `{ $local }`-ref adapter; otherwise the
   * primary storage.
   */
  forCreate(target: 'storage' | 'local'): StorageAdapter {
    if (this.#adopter === undefined) return this.local;
    return target === 'local' ? this.#wrapped : this.#adopter;
  }
}

/** `{ $local: x }` → `x`; any other ref is passed on unchanged (`LocalFsStorage` checks it). */
function unwrap(ref: StorageRef): StorageRef {
  return isLocalRef(ref) ? ref.$local : ref;
}

/** A `LocalFsStorage` view whose refs are `{ $local: string }`. */
function localRefAdapter(local: LocalFsStorage): StorageAdapter {
  return {
    read: (ref, o) => local.read(unwrap(ref), o),
    write: (ref, bytes, o) => local.write(unwrap(ref), bytes, o),
    stat: (ref, o) => local.stat(unwrap(ref), o),
    async create(input, o) {
      const made = await local.create(input, o);
      return { ref: { $local: made.ref }, version: made.version };
    },
  };
}
