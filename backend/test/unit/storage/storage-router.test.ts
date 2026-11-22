import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsStorage } from '../../../src/storage/local-fs-storage.js';
import { isLocalRef, LOCAL_STORAGE_DIR, StorageRouter } from '../../../src/storage/storage-router.js';
import { FakeStorage } from '../../../test-kit/storage/fake-storage.js';

const signal = (): AbortSignal => new AbortController().signal;
const input = { kind: 'text', format: 'docx', name: 'Doc', bytes: new TextEncoder().encode('hi') } as const;

describe('isLocalRef', () => {
  it.each<[unknown, boolean]>([
    [{ $local: 'a.docx' }, true],
    [{ $local: 1 }, false],
    [{ $local: 'a.docx', other: 1 }, false],
    [{ local: 'a.docx' }, false],
    ['a.docx', false],
    [null, false],
    [['a'], false],
  ])('%j → %s', (ref, expected) => {
    expect(isLocalRef(ref)).toBe(expected);
  });
});

describe('StorageRouter', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'odx-router-'));
    await mkdir(path.join(dataDir, LOCAL_STORAGE_DIR));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('without adopter storage routes every ref to the local adapter with string refs', async () => {
    const router = new StorageRouter({ dataDir });
    expect(router.hasAdopterStorage).toBe(false);
    expect(router.route('a.docx')).toBe(router.local);
    expect(router.local).toBeInstanceOf(LocalFsStorage);
    expect(router.forCreate('local')).toBe(router.local);
    const made = await router.forCreate('storage').create(input, { signal: signal() });
    expect(typeof made.ref).toBe('string');
    expect(await readFile(path.join(dataDir, LOCAL_STORAGE_DIR, made.ref as string), 'utf8')).toBe('hi');
  });

  it('with adopter storage routes plain refs to the adopter', () => {
    const adopter = new FakeStorage();
    const router = new StorageRouter({ dataDir, storage: adopter });
    expect(router.hasAdopterStorage).toBe(true);
    expect(router.route('a.docx')).toBe(adopter);
    expect(router.route({ bucket: 'b', key: 'k' })).toBe(adopter);
    expect(router.forCreate('storage')).toBe(adopter);
  });

  it('creates and serves { $local } refs through the built-in adapter', async () => {
    const adopter = new FakeStorage();
    const router = new StorageRouter({ dataDir, storage: adopter });
    const made = await router.forCreate('local').create(input, { signal: signal() });
    expect(isLocalRef(made.ref)).toBe(true);
    const ref = JSON.parse(JSON.stringify(made.ref)) as typeof made.ref;
    const adapter = router.route(ref);
    expect(adapter).not.toBe(adopter);
    const read = await adapter.read(ref, { signal: signal(), maxBytes: 100 });
    expect(new TextDecoder().decode(read!.bytes)).toBe('hi');
    const res = await adapter.write(ref, new TextEncoder().encode('bye'), {
      expectedVersion: made.version,
      signal: signal(),
    });
    expect(res.ok).toBe(true);
    expect((await adapter.stat(ref, { signal: signal() }))!.size).toBe(3);
    expect(adopter.calls).toEqual([]);
  });

  it('keeps { $local } refs confined', async () => {
    const router = new StorageRouter({ dataDir, storage: new FakeStorage() });
    const ref = { $local: '../escape.docx' };
    await expect(router.route(ref).stat(ref, { signal: signal() })).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  });
});
