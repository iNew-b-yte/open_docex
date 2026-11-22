import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenDocexError } from '@open-docex/shared/errors';
import { asDocumentId, type ClientId } from '@open-docex/shared/ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetStore, sniffAssetMime } from '../../../src/persistence/asset-store.js';
import { docDir, docKeyOf, metaPath, snapshotPath } from '../../../src/persistence/layout.js';
import { MetaStore, type DocumentMeta } from '../../../src/persistence/meta-store.js';
import { SnapshotStore, type SnapshotFile } from '../../../src/persistence/snapshot-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-stores-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta = (id: string, over: Partial<DocumentMeta> = {}): DocumentMeta => ({
  schema: 1,
  documentId: asDocumentId(id),
  kind: 'text',
  format: 'docx',
  ref: { bucket: 'b', key: id },
  storageState: 'NORMAL',
  lastKnownVersion: 'v1',
  lastFlushedRev: 0,
  rev: 0,
  auditEmittedRev: 0,
  retryCount: 0,
  nextRetryAt: null,
  localSince: null,
  readOnly: { findings: [], allowedEdit: false },
  lineage: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('MetaStore', () => {
  it('puts, gets and lists metadata, including auditEmittedRev, and reloads it at boot', async () => {
    const store = new MetaStore(dir);
    const a = meta('doc/a', { rev: 5, auditEmittedRev: 4 });
    const b = meta('../b', { kind: 'sheet', format: 'xlsx' });
    await store.put(a);
    await store.put(b);
    expect(store.get(docKeyOf(a.documentId))).toEqual(a);
    expect(store.list()).toHaveLength(2);

    const fresh = new MetaStore(dir);
    await fresh.loadAll();
    expect(fresh.get(docKeyOf(a.documentId))?.auditEmittedRev).toBe(4);
    expect(fresh.list().map((m) => m.documentId).sort()).toEqual(['../b', 'doc/a']);
  });

  it('returns copies, so callers cannot change the cache by mutation', async () => {
    const store = new MetaStore(dir);
    const a = meta('a');
    await store.put(a);
    a.rev = 99;
    const got = store.get(docKeyOf(a.documentId));
    expect(got?.rev).toBe(0);
    if (got) got.rev = 42;
    expect(store.get(docKeyOf(a.documentId))?.rev).toBe(0);
  });

  it('serializes puts per document; the last call wins', async () => {
    const store = new MetaStore(dir);
    await Promise.all([1, 2, 3, 4, 5].map((rev) => store.put(meta('a', { rev }))));
    const key = docKeyOf(asDocumentId('a'));
    expect(store.get(key)?.rev).toBe(5);
    expect((JSON.parse(await readFile(metaPath(dir, key), 'utf8')) as DocumentMeta).rev).toBe(5);
    expect(await readdir(docDir(dir, key))).toEqual(['meta.json']);
  });

  it('skips a meta.json that does not parse, is malformed or sits under the wrong docKey, and keeps the folders', async () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const good = meta('good');
    await new MetaStore(dir).put(good);

    const brokenKey = docKeyOf(asDocumentId('broken'));
    await mkdir(docDir(dir, brokenKey), { recursive: true });
    await writeFile(metaPath(dir, brokenKey), '{"schema":1,');

    const noAuditKey = docKeyOf(asDocumentId('no-audit'));
    const noAudit: Partial<DocumentMeta> = meta('no-audit');
    delete noAudit.auditEmittedRev;
    await mkdir(docDir(dir, noAuditKey), { recursive: true });
    await writeFile(metaPath(dir, noAuditKey), JSON.stringify(noAudit));

    const wrongKey = docKeyOf(asDocumentId('wrong'));
    await mkdir(docDir(dir, wrongKey), { recursive: true });
    await writeFile(metaPath(dir, wrongKey), JSON.stringify(meta('someone-else')));

    await mkdir(path.join(dir, 'docs', 'zz', 'not-a-key'), { recursive: true });

    const store = new MetaStore(dir, { logger });
    await store.loadAll();
    expect(store.list().map((m) => m.documentId)).toEqual(['good']);
    expect(warnings).toHaveLength(3);
    for (const key of [brokenKey, noAuditKey, wrongKey]) expect(await readdir(docDir(dir, key))).toEqual(['meta.json']);
  });

  it('loads nothing from a missing docs folder', async () => {
    const store = new MetaStore(path.join(dir, 'none'));
    await store.loadAll();
    expect(store.list()).toEqual([]);
  });
});

describe('SnapshotStore', () => {
  const key = docKeyOf(asDocumentId('doc'));
  const snap: SnapshotFile = {
    v: 1,
    kind: 'text',
    rev: 10,
    savedAt: 1000,
    model: { type: 'doc', content: [] },
    dedupe: [['AAAAAAAAAAAAAAAAAAAAAA' as ClientId, 3, 9]],
  };

  it('returns null when there is no snapshot, and round-trips one', async () => {
    const store = new SnapshotStore(dir);
    expect(await store.read(key)).toBeNull();
    await store.write(key, snap);
    expect(await store.read(key)).toEqual(snap);
    await store.write(key, { ...snap, rev: 11 });
    expect((await store.read(key))?.rev).toBe(11);
    expect(await readdir(docDir(dir, key))).toEqual(['snapshot.json']);
  });

  it.each([
    ['does not parse', '{"v":1,'],
    ['is malformed', JSON.stringify({ v: 2, kind: 'text', rev: 1, savedAt: 1, model: null, dedupe: [] })],
  ])('throws DOCUMENT_FAULTED when the file %s, and keeps it', async (_n, text) => {
    await mkdir(docDir(dir, key), { recursive: true });
    await writeFile(snapshotPath(dir, key), text);
    const err = await new SnapshotStore(dir).read(key).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenDocexError);
    expect((err as OpenDocexError).code).toBe('DOCUMENT_FAULTED');
    expect(await readFile(snapshotPath(dir, key), 'utf8')).toBe(text);
  });
});

describe('AssetStore', () => {
  const key = docKeyOf(asDocumentId('doc'));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
  const gif = new TextEncoder().encode('GIF89a....');
  const webp = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');

  it('sniffs PNG, JPEG and GIF, and nothing else', () => {
    expect(sniffAssetMime(png)).toBe('image/png');
    expect(sniffAssetMime(jpeg)).toBe('image/jpeg');
    expect(sniffAssetMime(gif)).toBe('image/gif');
    expect(sniffAssetMime(new TextEncoder().encode('GIF87a'))).toBe('image/gif');
    expect(sniffAssetMime(webp)).toBeNull();
    expect(sniffAssetMime(new TextEncoder().encode('<svg/>'))).toBeNull();
    expect(sniffAssetMime(new Uint8Array())).toBeNull();
  });

  it('stores content-addressed, idempotently, under the hashed document folder', async () => {
    const store = new AssetStore(dir);
    const a = await store.put(key, png);
    expect(a.mime).toBe('image/png');
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.put(key, png)).toEqual(a);
    expect(await readdir(store.dir(key))).toEqual([a.id]);
    expect(path.relative(dir, store.dir(key)).split(path.sep)).toEqual(['docs', key.slice(0, 2), key, 'assets']);
    expect(await store.get(key, a.id)).toEqual({ bytes: png, mime: 'image/png' });
  });

  it('rejects types outside the allowlist with PROTOCOL_OP_REJECTED', async () => {
    await expect(new AssetStore(dir).put(key, webp)).rejects.toMatchObject({ code: 'PROTOCOL_OP_REJECTED' });
  });

  it('returns null for malformed or traversal IDs, unknown IDs and other documents', async () => {
    const store = new AssetStore(dir);
    const { id } = await store.put(key, gif);
    for (const bad of ['../meta.json', id.toUpperCase(), `${id}x`, '', '..']) expect(await store.get(key, bad)).toBeNull();
    expect(await store.get(key, 'a'.repeat(64))).toBeNull();
    expect(await store.get(docKeyOf(asDocumentId('other')), id)).toBeNull();
  });
});
