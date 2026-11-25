// createEngine (LLD Part 2 §2.5, §2.7 tests): option validation, boot failures that reject with the
// Core's error, no `upgrade` listener before boot succeeds, and a clean shutdown. Main mode with a
// fake codec (or the real `CodecService` with a wrong LibreOffice path); worker mode is covered by
// the integration smoke tests.
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenDocexError } from '@open-docex/shared/errors';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, createEngineWith, type EngineInternals } from '../../../src/api/create-engine.js';
import type { Engine } from '../../../src/api/engine-facade.js';
import type { EngineOptions, WorkerConfig } from '../../../src/api/options.js';
import { engineError } from '../../../src/errors/engine-error.js';
import { lockPath } from '../../../src/persistence/layout.js';
import { realCodec } from '../core/in-process-pool.js';
import { TextFileCodec } from '../core/wiring-fakes.js';

const PLACEHOLDER_MODULE = fileURLToPath(import.meta.url);

const dirs: string[] = [];
const engines: Engine[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown({ timeoutMs: 2000 });
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'odx-engine-'));
  dirs.push(d);
  return d;
}

function server(): Server {
  const s = createServer();
  servers.push(s);
  return s;
}

function options(over: Partial<EngineOptions> = {}): EngineOptions {
  return { mode: 'main', workerConfigModule: PLACEHOLDER_MODULE, authorize: () => null, ...over };
}

/** Test seams for main mode: the config the Core "imports", and the codec it uses. */
function internals(config: unknown, codec: EngineInternals['core'] = {}): EngineInternals {
  return { core: { importModule: () => Promise.resolve({ default: config }), codec: () => new TextFileCodec(), ...codec } };
}

async function start(over: Partial<EngineOptions>, config: WorkerConfig, codec?: EngineInternals['core']): Promise<Engine> {
  const e = await createEngineWith(options(over), internals(config, codec));
  engines.push(e);
  return e;
}

async function rejection(p: Promise<unknown>): Promise<OpenDocexError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OpenDocexError);
  return err as OpenDocexError;
}

describe('createEngine: option validation', () => {
  it('rejects bad options with CONFIG_INVALID before anything starts', async () => {
    const s = server();
    for (const bad of [
      {} as never,
      options({ authorize: undefined as never }),
      options({ workerConfigModule: 'relative/worker.mjs' }),
      options({ workerConfigModule: path.join(tmpdir(), 'odx-no-such-file.mjs') }),
      options({ mode: 'cluster' as never }),
      options({ http: { server: s, path: 'no-slash' } }),
    ]) {
      const err = await rejection(createEngine(bad));
      expect(err.code).toBe('CONFIG_INVALID');
    }
    expect(s.listenerCount('upgrade')).toBe(0);
  });
});

describe('createEngine: boot failures reject with the Core error and attach nothing', () => {
  async function bootFails(config: unknown, codec?: EngineInternals['core']): Promise<{ err: OpenDocexError; server: Server }> {
    const s = server();
    const err = await rejection(createEngineWith(options({ http: { server: s } }), internals(config, codec)));
    return { err, server: s };
  }

  it('a worker config module without a default export gives CONFIG_INVALID', async () => {
    const dataDir = await tempDir();
    const s = server();
    const err = await rejection(
      createEngineWith(options({ http: { server: s } }), { core: { importModule: () => Promise.resolve({ notDefault: { dataDir } }), codec: () => new TextFileCodec() } }),
    );
    expect(err.code).toBe('CONFIG_INVALID');
    expect(s.listenerCount('upgrade')).toBe(0);
  });

  it('an invalid worker config gives CONFIG_INVALID naming the field', async () => {
    const dataDir = await tempDir();
    const { err, server: s } = await bootFails({ dataDir, codecThreads: 0 });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('codecThreads');
    expect(s.listenerCount('upgrade')).toBe(0);
  });

  it('a failing LibreOffice probe gives CONFIG_LIBREOFFICE_NOT_FOUND and frees the data folder', async () => {
    const dataDir = await tempDir();
    const codec = new TextFileCodec();
    codec.probeError = engineError('CONFIG_LIBREOFFICE_NOT_FOUND');
    const { err, server: s } = await bootFails({ dataDir }, { codec: () => codec });
    expect(err.code).toBe('CONFIG_LIBREOFFICE_NOT_FOUND');
    expect(s.listenerCount('upgrade')).toBe(0);
    expect(existsSync(lockPath(dataDir))).toBe(false);
    expect(codec.closed).toBe(true);
  });

  it('a wrong libreoffice.path with the real CodecService gives CONFIG_LIBREOFFICE_NOT_FOUND', async () => {
    const dataDir = await tempDir();
    const { err, server: s } = await bootFails(
      { dataDir, libreoffice: { path: path.join(dataDir, 'no-such-dir', 'soffice') } },
      { codec: realCodec },
    );
    expect(err.code).toBe('CONFIG_LIBREOFFICE_NOT_FOUND');
    expect(s.listenerCount('upgrade')).toBe(0);
  });

  it('a data folder that cannot be created gives CONFIG_DATA_DIR_UNWRITABLE', async () => {
    const dataDir = await tempDir();
    const file = path.join(dataDir, 'a-file');
    await writeFile(file, 'x');
    const { err, server: s } = await bootFails({ dataDir: path.join(file, 'sub') });
    expect(err.code).toBe('CONFIG_DATA_DIR_UNWRITABLE');
    expect(s.listenerCount('upgrade')).toBe(0);
  });

  it('a data folder held by a live engine is refused, and the first engine keeps running', async () => {
    const dataDir = await tempDir();
    const first = await start({}, { dataDir });
    const { err } = await bootFails({ dataDir });
    expect(err.code).toBe('CONFIG_DATA_DIR_UNWRITABLE');
    expect(existsSync(lockPath(dataDir))).toBe(true);
    expect(first.state).toBe('running');
  });
});

describe('createEngine: a running engine', () => {
  it('attaches to http.server only after boot, and shutdown removes every listener and the lock', async () => {
    const dataDir = await tempDir();
    const s = server();
    const other = server();
    const engine = await start({ http: { server: s } }, { dataDir });
    expect(engine.state).toBe('running');
    expect(s.listenerCount('upgrade')).toBe(1);
    engine.attach(other);
    expect(other.listenerCount('upgrade')).toBe(1);
    expect(existsSync(lockPath(dataDir))).toBe(true);
    await engine.shutdown({ timeoutMs: 2000 });
    expect(engine.state).toBe('stopped');
    expect(s.listenerCount('upgrade')).toBe(0);
    expect(other.listenerCount('upgrade')).toBe(0);
    expect(existsSync(lockPath(dataDir))).toBe(false);
  });

  it('can be started again on the same data folder after a shutdown', async () => {
    const dataDir = await tempDir();
    const a = await start({}, { dataDir });
    await a.shutdown({ timeoutMs: 2000 });
    const b = await start({}, { dataDir });
    expect(b.state).toBe('running');
  });

  it('works without http.server: nothing listens until attach()', async () => {
    const dataDir = await tempDir();
    const engine = await start({}, { dataDir });
    const s = server();
    expect(s.listenerCount('upgrade')).toBe(0);
    engine.attach(s);
    expect(s.listenerCount('upgrade')).toBe(1);
  });

  it('creates a blank document through documents.create', async () => {
    const dataDir = await tempDir();
    const engine = await start({}, { dataDir });
    const made = await engine.documents.create({ kind: 'text', format: 'docx', name: 'Blank', target: 'storage' });
    expect(typeof made.ref).toBe('string');
    await expect(engine.documents.create({ kind: 'text', format: 'xlsx', name: 'x', target: 'storage' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('reports no recovery entries on a fresh data folder', async () => {
    const dataDir = await tempDir();
    const engine = await start({}, { dataDir });
    await expect(engine.recovery.list()).resolves.toEqual([]);
  });
});
