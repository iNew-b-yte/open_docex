/**
 * The storage conformance suite (LLD Part 2 §11.3 tests, §21). Adopters run it with Vitest
 * against their own {@link StorageAdapter} to check that it keeps the port's rules (§11.1):
 * round trips, `null` for not found, version checks on `write`, versions that change with the
 * content, the `maxBytes` bound, aborts, and refs that survive JSON and structured clone.
 *
 * ```ts
 * runStorageConformance({
 *   name: 'MyStorage',
 *   async setup() {
 *     const adapter = new MyStorage(…);
 *     return { adapter, missingRef: 'docs/does-not-exist.docx', teardown: () => … };
 *   },
 * });
 * ```
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageAdapter, StorageCreateInput, StorageRef } from '../../src/storage/storage-adapter.js';

/** One fresh adapter for one test. */
export interface ConformanceFixture {
  adapter: StorageAdapter;
  /** A ref with no document behind it, which `write` with `expectedVersion: null` may create. */
  missingRef: StorageRef;
  /** Called after the test, for example to delete a temporary folder. */
  teardown?: () => Promise<void> | void;
}

/** Options for {@link runStorageConformance}. */
export interface ConformanceOptions {
  /** The suite name shown by Vitest. */
  name: string;
  /** Builds a fresh, empty adapter for each test. */
  setup: () => Promise<ConformanceFixture> | ConformanceFixture;
}

const MAX = 1024 * 1024;

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function input(text: string, name = 'Report'): StorageCreateInput {
  return { kind: 'text', format: 'docx', name, bytes: bytesOf(text) };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function aborted(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

/** The bytes as a plain `Uint8Array`, so `Buffer` and `Uint8Array` results compare equal. */
function plain(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/** Registers the conformance suite for one adapter with Vitest. */
export function runStorageConformance(o: ConformanceOptions): void {
  describe(`StorageAdapter conformance: ${o.name}`, () => {
    let fx: ConformanceFixture;

    beforeEach(async () => {
      fx = await o.setup();
    });

    afterEach(async () => {
      await fx.teardown?.();
    });

    it('create returns a ref that read and stat serve with the same version', async () => {
      const made = await fx.adapter.create(input('hello'), { signal: signal() });
      expect(typeof made.version).toBe('string');
      const read = await fx.adapter.read(made.ref, { signal: signal(), maxBytes: MAX });
      expect(read).not.toBeNull();
      expect(plain(read!.bytes)).toEqual(bytesOf('hello'));
      expect(read!.version).toBe(made.version);
      expect(await fx.adapter.stat(made.ref, { signal: signal() })).toEqual({ version: made.version, size: 5 });
    });

    it('stores empty content', async () => {
      const made = await fx.adapter.create(input(''), { signal: signal() });
      const read = await fx.adapter.read(made.ref, { signal: signal(), maxBytes: MAX });
      expect(read!.bytes.byteLength).toBe(0);
      expect((await fx.adapter.stat(made.ref, { signal: signal() }))!.size).toBe(0);
    });

    it('create gives distinct refs for the same name', async () => {
      const a = await fx.adapter.create(input('a'), { signal: signal() });
      const b = await fx.adapter.create(input('b'), { signal: signal() });
      expect(a.ref).not.toEqual(b.ref);
      expect(plain((await fx.adapter.read(a.ref, { signal: signal(), maxBytes: MAX }))!.bytes)).toEqual(bytesOf('a'));
      expect(plain((await fx.adapter.read(b.ref, { signal: signal(), maxBytes: MAX }))!.bytes)).toEqual(bytesOf('b'));
    });

    it('refs survive JSON and structured clone', async () => {
      const made = await fx.adapter.create(input('json'), { signal: signal() });
      const viaJson = JSON.parse(JSON.stringify(made.ref)) as StorageRef;
      const viaClone = structuredClone(made.ref);
      expect(viaJson).toEqual(made.ref);
      expect((await fx.adapter.stat(viaJson, { signal: signal() }))!.version).toBe(made.version);
      expect((await fx.adapter.stat(viaClone, { signal: signal() }))!.version).toBe(made.version);
    });

    it('read and stat return null for a missing document', async () => {
      expect(await fx.adapter.read(fx.missingRef, { signal: signal(), maxBytes: MAX })).toBeNull();
      expect(await fx.adapter.stat(fx.missingRef, { signal: signal() })).toBeNull();
    });

    it('write with the current version replaces the content and changes the version', async () => {
      const made = await fx.adapter.create(input('one'), { signal: signal() });
      const res = await fx.adapter.write(made.ref, bytesOf('two!'), { expectedVersion: made.version, signal: signal() });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.version).not.toBe(made.version);
      const read = await fx.adapter.read(made.ref, { signal: signal(), maxBytes: MAX });
      expect(plain(read!.bytes)).toEqual(bytesOf('two!'));
      expect(read!.version).toBe(res.version);
    });

    it('the version changes when same-size content changes', async () => {
      const made = await fx.adapter.create(input('aaaa'), { signal: signal() });
      const seen = new Set([made.version]);
      let version = made.version;
      for (const text of ['bbbb', 'cccc', 'dddd']) {
        const res = await fx.adapter.write(made.ref, bytesOf(text), { expectedVersion: version, signal: signal() });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(seen.has(res.version)).toBe(false);
        seen.add(res.version);
        version = res.version;
      }
    });

    it('write with a stale version is a conflict and leaves the content unchanged', async () => {
      const made = await fx.adapter.create(input('one'), { signal: signal() });
      const first = await fx.adapter.write(made.ref, bytesOf('two'), { expectedVersion: made.version, signal: signal() });
      expect(first.ok).toBe(true);
      const res = await fx.adapter.write(made.ref, bytesOf('three'), { expectedVersion: made.version, signal: signal() });
      expect(res).toMatchObject({ ok: false, reason: 'conflict' });
      const current = await fx.adapter.stat(made.ref, { signal: signal() });
      if (!res.ok && res.currentVersion !== undefined) expect(res.currentVersion).toBe(current!.version);
      const read = await fx.adapter.read(made.ref, { signal: signal(), maxBytes: MAX });
      expect(plain(read!.bytes)).toEqual(bytesOf('two'));
    });

    it('write with expectedVersion null is a conflict when the document exists', async () => {
      const made = await fx.adapter.create(input('one'), { signal: signal() });
      const res = await fx.adapter.write(made.ref, bytesOf('two'), { expectedVersion: null, signal: signal() });
      expect(res).toMatchObject({ ok: false, reason: 'conflict' });
      expect(plain((await fx.adapter.read(made.ref, { signal: signal(), maxBytes: MAX }))!.bytes)).toEqual(bytesOf('one'));
    });

    it('write with expectedVersion null creates a missing document', async () => {
      const res = await fx.adapter.write(fx.missingRef, bytesOf('new'), { expectedVersion: null, signal: signal() });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const read = await fx.adapter.read(fx.missingRef, { signal: signal(), maxBytes: MAX });
      expect(plain(read!.bytes)).toEqual(bytesOf('new'));
      expect(read!.version).toBe(res.version);
    });

    it('write with a version to a missing document is a conflict', async () => {
      const made = await fx.adapter.create(input('x'), { signal: signal() });
      const res = await fx.adapter.write(fx.missingRef, bytesOf('new'), { expectedVersion: made.version, signal: signal() });
      expect(res).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await fx.adapter.stat(fx.missingRef, { signal: signal() })).toBeNull();
    });

    it('read rejects content larger than maxBytes', async () => {
      const made = await fx.adapter.create(input('0123456789'), { signal: signal() });
      await expect(fx.adapter.read(made.ref, { signal: signal(), maxBytes: 9 })).rejects.toThrow();
      const exact = await fx.adapter.read(made.ref, { signal: signal(), maxBytes: 10 });
      expect(exact!.bytes.byteLength).toBe(10);
    });

    it('every call rejects with an already-aborted signal', async () => {
      const made = await fx.adapter.create(input('one'), { signal: signal() });
      await expect(fx.adapter.read(made.ref, { signal: aborted(), maxBytes: MAX })).rejects.toThrow();
      await expect(fx.adapter.stat(made.ref, { signal: aborted() })).rejects.toThrow();
      await expect(
        fx.adapter.write(made.ref, bytesOf('two'), { expectedVersion: made.version, signal: aborted() }),
      ).rejects.toThrow();
      await expect(fx.adapter.create(input('x'), { signal: aborted() })).rejects.toThrow();
      expect(plain((await fx.adapter.read(made.ref, { signal: signal(), maxBytes: MAX }))!.bytes)).toEqual(bytesOf('one'));
    });
  });
}
