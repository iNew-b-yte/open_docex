// The main-mode smoke flow with real LibreOffice (V1-19 acceptance): `createEngine` with the real
// `CodecService`, a real WebSocket client, a blank document made by `documents.create`, and a
// fixture .docx from `test/fixtures/text`. Run with OPEN_DOCEX_LO_TESTS=1 (CI sets it).
//
// The codec runs in this process (`InProcessPool`), like the other `*.lo.test.ts` files; the
// compiled worker-thread pool is covered by `engine-worker-mode.lo.test.ts`.
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleText, type TextChunkData } from '@open-docex/shared/text';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineWith } from '../../src/api/create-engine.js';
import type { Engine } from '../../src/api/engine-facade.js';
import { CodecService } from '../../src/codec/codec-service.js';
import { noopLogger } from '../../src/log/logger.js';
import { LocalFsStorage } from '../../src/storage/local-fs-storage.js';
import { ins } from '../unit/core/harness.js';
import { InProcessPool, realCodec } from '../unit/core/in-process-pool.js';
import { TestClient } from './test-client.js';

const LO = process.env['OPEN_DOCEX_LO_TESTS'] === '1';
const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'text');

const roots: string[] = [];
const engines: Engine[] = [];
const servers: Server[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const e of engines.splice(0)) await e.shutdown({ timeoutMs: 20_000 });
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function start() {
  const root = await mkdtemp(path.join(tmpdir(), 'odx-lo-'));
  roots.push(root);
  const storageRoot = path.join(root, 'storage');
  await mkdir(storageRoot);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const refs = new Map<string, string>();
  const engine = await createEngineWith(
    {
      mode: 'main',
      workerConfigModule: fileURLToPath(import.meta.url),
      http: { server },
      authorize: (ctx) => {
        const ref = refs.get(ctx.documentId);
        return ref === undefined
          ? null
          : { userId: 'alice', access: 'edit', document: { ref, format: 'docx' } };
      },
    },
    {
      core: {
        codec: realCodec,
        importModule: () => Promise.resolve({ default: { dataDir: path.join(root, 'data'), storage: new LocalFsStorage({ root: storageRoot }) } }),
      },
    },
  );
  engines.push(engine);
  const connect = async (id: string): Promise<TestClient> => {
    const c = await TestClient.open(`ws://127.0.0.1:${port}/open-docex?doc=${id}`);
    clients.push(c);
    return c;
  };
  return { engine, refs, storageRoot, connect, root };
}

/** Imports saved .docx bytes with a separate real codec and returns the snapshot as JSON text. */
async function importedJson(bytes: Uint8Array, root: string): Promise<string> {
  const service = new CodecService({
    pool: new InProcessPool(),
    tmpDir: await mkdtemp(path.join(root, 'verify-')),
    libreoffice: { maxConcurrent: 1, timeoutMs: 120_000 },
    maxFileBytes: 50 * 1024 * 1024,
    logger: noopLogger,
  });
  try {
    const result = await service.import({ bytes, format: 'docx', assetDir: await mkdtemp(path.join(root, 'assets-')) });
    return JSON.stringify(result.snapshot);
  } finally {
    await service.close();
  }
}

describe.skipIf(!LO)('createEngine in main mode with real LibreOffice', () => {
  it('a client edits a blank document made by documents.create, and shutdown saves a real .docx', async () => {
    const t = await start();
    const { ref } = await t.engine.documents.create({ kind: 'text', format: 'docx', name: 'Blank', target: 'storage' });
    t.refs.set('blank', ref as string);
    const blankBytes = new Uint8Array(await readFile(path.join(t.storageRoot, ref as string)));
    expect([...blankBytes.subarray(0, 2)]).toEqual([0x50, 0x4b]); // a zip: PK

    const alice = await t.connect('blank');
    const load = await alice.hello();
    expect(load.start).toMatchObject({ kind: 'text', access: 'edit', rev: 0 });
    expect(load.start.unsupported ?? []).toEqual([]);
    expect((await alice.submit([ins(2, 'Hello LibreOffice')])).rev).toBe(1);

    await t.engine.shutdown({ timeoutMs: 60_000 });
    const saved = new Uint8Array(await readFile(path.join(t.storageRoot, ref as string)));
    expect(saved.byteLength).toBeGreaterThan(0);
    expect(await importedJson(saved, t.root)).toContain('Hello LibreOffice');
  }, 240_000);

  it('opens the fixture features.docx, applies an edit, and saves it', async () => {
    const t = await start();
    await copyFile(path.join(FIXTURES, 'features.docx'), path.join(t.storageRoot, 'features.docx'));
    t.refs.set('features', 'features.docx');

    const alice = await t.connect('features');
    const load = await alice.hello();
    expect(load.start.kind).toBe('text');
    expect(load.json).toContain('ALIGN-LEFT paragraph');
    // The fixture is fully supported, so it opens editable.
    expect(load.start.unsupported ?? []).toEqual([]);

    // Insert at the start of the first body paragraph.
    const doc = assembleText(load.chunkMessages as Array<{ seq: number; data: TextChunkData }>);
    let at = -1;
    doc.forEach((region, offset) => {
      if (region.type.name !== 'body') return;
      region.descendants((node, pos) => {
        if (at < 0 && node.type.name === 'paragraph') at = offset + 1 + pos + 1;
        return false;
      });
    });
    expect(at).toBeGreaterThan(0);
    expect((await alice.submit([ins(at, 'EDIT: ')])).rev).toBe(1);

    await t.engine.shutdown({ timeoutMs: 60_000 });
    const saved = new Uint8Array(await readFile(path.join(t.storageRoot, 'features.docx')));
    const json = await importedJson(saved, t.root);
    expect(json).toContain('EDIT: ');
    expect(json).toContain('ALIGN-LEFT paragraph');
  }, 240_000);
});
