/**
 * `FakeStorage`: an in-memory {@link StorageAdapter} for engine tests, with scriptable
 * failures, versions and latency (LLD Part 2 §21). It keeps the port's rules (§11.1) and
 * passes the storage conformance suite.
 *
 * @module
 */
import type {
  StorageAdapter,
  StorageCreateInput,
  StorageReadResult,
  StorageRef,
  StorageStat,
  StorageVersion,
  StorageWriteResult,
} from '../../src/storage/storage-adapter.js';

/** The four port operations. */
export type StorageOp = 'read' | 'write' | 'stat' | 'create';

/** One recorded call. `ref` is the key the ref maps to (JSON for object refs). */
export interface FakeStorageCall {
  op: StorageOp;
  ref: string | null;
}

/** Options for {@link FakeStorage}. */
export interface FakeStorageOptions {
  /** Delay before every call settles, in ms. Default 0. Changeable later through `latencyMs`. */
  latencyMs?: number;
  /** Replaces the real-timer delay, for example with a fake clock. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface Entry {
  bytes: Uint8Array;
  version: StorageVersion;
}

interface Failure {
  op: StorageOp | 'any';
  error: () => unknown;
}

function keyOf(ref: StorageRef): string {
  return typeof ref === 'string' ? ref : JSON.stringify(ref);
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An in-memory storage adapter for tests (LLD Part 2 §21). */
export class FakeStorage implements StorageAdapter {
  /** Delay before every call settles, in ms. */
  latencyMs: number;
  /** Every call, in order. */
  readonly calls: FakeStorageCall[] = [];
  readonly #files = new Map<string, Entry>();
  readonly #failures: Failure[] = [];
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #counter = 0;

  constructor(o: FakeStorageOptions = {}) {
    this.latencyMs = o.latencyMs ?? 0;
    this.#sleep = o.sleep ?? realSleep;
  }

  /**
   * Makes the next `times` calls of `op` (or of any op) throw. `error` defaults to an
   * `Error('FakeStorage failure')`. Failures are used in the order they were added.
   */
  failNext(op: StorageOp | 'any', o: { error?: unknown; times?: number } = {}): void {
    const times = o.times ?? 1;
    const error = (): unknown => ('error' in o ? o.error : new Error('FakeStorage failure'));
    for (let i = 0; i < times; i++) this.#failures.push({ op, error });
  }

  /** Drops failures not yet used. */
  clearFailures(): void {
    this.#failures.length = 0;
  }

  /**
   * Puts a document in place directly, as an outside editor would, without recording a call.
   * Returns the version, which is `version` if given, else a fresh one.
   */
  setFile(ref: StorageRef, bytes: Uint8Array, version?: StorageVersion): StorageVersion {
    const v = version ?? this.#nextVersion();
    this.#files.set(keyOf(ref), { bytes: Uint8Array.from(bytes), version: v });
    return v;
  }

  /** The stored document, or `undefined`. */
  getFile(ref: StorageRef): { bytes: Uint8Array; version: StorageVersion } | undefined {
    const e = this.#files.get(keyOf(ref));
    return e === undefined ? undefined : { bytes: Uint8Array.from(e.bytes), version: e.version };
  }

  /** Removes a document directly, without recording a call. */
  deleteFile(ref: StorageRef): void {
    this.#files.delete(keyOf(ref));
  }

  async read(ref: StorageRef, o: { signal: AbortSignal; maxBytes: number }): Promise<StorageReadResult | null> {
    await this.#enter('read', ref, o.signal);
    const e = this.#files.get(keyOf(ref));
    if (e === undefined) return null;
    if (e.bytes.byteLength > o.maxBytes) throw new Error('FakeStorage: document larger than maxBytes');
    return { bytes: Uint8Array.from(e.bytes), version: e.version };
  }

  async write(
    ref: StorageRef,
    bytes: Uint8Array,
    o: { expectedVersion: StorageVersion | null; signal: AbortSignal },
  ): Promise<StorageWriteResult> {
    await this.#enter('write', ref, o.signal);
    const key = keyOf(ref);
    const e = this.#files.get(key);
    const current = e?.version ?? null;
    if (current !== o.expectedVersion) {
      return current === null ? { ok: false, reason: 'conflict' } : { ok: false, reason: 'conflict', currentVersion: current };
    }
    const version = this.#nextVersion();
    this.#files.set(key, { bytes: Uint8Array.from(bytes), version });
    return { ok: true, version };
  }

  async stat(ref: StorageRef, o: { signal: AbortSignal }): Promise<StorageStat | null> {
    await this.#enter('stat', ref, o.signal);
    const e = this.#files.get(keyOf(ref));
    return e === undefined ? null : { version: e.version, size: e.bytes.byteLength };
  }

  async create(input: StorageCreateInput, o: { signal: AbortSignal }): Promise<{ ref: StorageRef; version: StorageVersion }> {
    await this.#enter('create', null, o.signal);
    const ref = `fake/${++this.#counter}.${input.format}`;
    const version = this.#nextVersion();
    this.#files.set(ref, { bytes: Uint8Array.from(input.bytes), version });
    return { ref, version };
  }

  /** Records the call, honours the abort signal and latency, and throws a scripted failure. */
  async #enter(op: StorageOp, ref: StorageRef | null, signal: AbortSignal): Promise<void> {
    this.calls.push({ op, ref: ref === null ? null : keyOf(ref) });
    signal.throwIfAborted();
    if (this.latencyMs > 0) await this.#sleep(this.latencyMs, signal);
    signal.throwIfAborted();
    const i = this.#failures.findIndex((f) => f.op === op || f.op === 'any');
    if (i >= 0) {
      const [f] = this.#failures.splice(i, 1);
      throw f!.error();
    }
  }

  #nextVersion(): StorageVersion {
    return `v${++this.#counter}`;
  }
}
