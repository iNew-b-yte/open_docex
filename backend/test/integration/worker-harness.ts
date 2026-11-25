// Shared setup for the worker-mode integration tests: a plain-`node` fork of the compiled Core, an
// http server, and per-run data and storage folders.
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEngineWith } from '../../src/api/create-engine.js';
import type { Engine } from '../../src/api/engine-facade.js';
import type { EngineStateEvent } from '../../src/api/events.js';
import type { AuthorizeResult } from '../../src/api/options.js';
import { TestClient } from './test-client.js';

/** `backend/dist`: the compiled build the forked Core runs. */
export const dist = path.join(import.meta.dirname, '..', '..', 'dist');
/** `backend/test/integration/fixtures`. */
export const fixtures = path.join(import.meta.dirname, 'fixtures');
/** True when `npm run build` (or `tsc -b`) has been run. */
export const haveDist = existsSync(path.join(dist, 'core', 'core-entry.js'));

/**
 * A `fork` like the Supervisor's, minus what Vitest adds for running TypeScript sources: its
 * `--conditions` flag would send the compiled Core to shared's `src` instead of its `dist` (the
 * same reason `codec/thread-entry.lo.test.ts` runs a plain `node` child).
 */
export function plainFork(env: NodeJS.ProcessEnv) {
  return (file: string, args: readonly string[], options: ForkOptions): ChildProcess => {
    const execArgv: string[] = [];
    const given = options.execArgv ?? [];
    for (let i = 0; i < given.length; i++) {
      const a = given[i] as string;
      if (a === '--conditions' || a === '-C') i++; // skip the flag and its value
      else if (!a.startsWith('--conditions=') && !a.startsWith('-C=')) execArgv.push(a);
    }
    const childEnv = { ...env };
    delete childEnv['NODE_OPTIONS'];
    return fork(file, [...args], { ...options, execArgv, env: childEnv });
  };
}

/** What {@link WorkerHarness.start} returns. */
export interface StartedEngine {
  engine: Engine;
  /** documentId → storage ref, read by `authorize`. */
  refs: Map<string, string>;
  states: EngineStateEvent[];
  storageRoot: string;
  dataDir: string;
  connect(documentId: string, user: string): Promise<TestClient>;
}

/** Starts and cleans up engines, servers and clients for one test file. */
export class WorkerHarness {
  readonly #roots: string[] = [];
  readonly #engines: Engine[] = [];
  readonly #servers: Server[] = [];
  readonly #clients: TestClient[] = [];

  /** A fresh empty folder, removed by {@link cleanup}. */
  async tempDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'odx-worker-'));
    this.#roots.push(d);
    return d;
  }

  /** An http server on a random local port, closed by {@link cleanup}. */
  async server(): Promise<{ server: Server; port: number }> {
    const server = createServer();
    this.#servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }

  /**
   * `createEngine` in worker mode with `fixtures/worker-config.mjs`.
   *
   * @param o.coreEntry the Core entry to fork (a fixture with a fake codec, or the compiled `core-entry.js`).
   */
  async start(o: { coreEntry: string; supervisor?: Record<string, number | number[]>; env?: NodeJS.ProcessEnv }): Promise<StartedEngine> {
    const root = await this.tempDir();
    const storageRoot = path.join(root, 'storage');
    const dataDir = path.join(root, 'data');
    await mkdir(storageRoot);
    const env = { ...process.env, ODX_SMOKE_DATA_DIR: dataDir, ODX_SMOKE_STORAGE_ROOT: storageRoot, ...o.env };
    const { server, port } = await this.server();
    const refs = new Map<string, string>();
    const engine = await createEngineWith(
      {
        mode: 'worker',
        workerConfigModule: path.join(fixtures, 'worker-config.mjs'),
        http: { server },
        supervisor: o.supervisor ?? {},
        authorize: (ctx): AuthorizeResult | null => {
          const ref = refs.get(ctx.documentId);
          const user = ctx.request.headers.authorization?.replace('Bearer ', '');
          return ref === undefined || user === undefined ? null : { userId: user, access: 'edit', document: { ref, format: 'docx' } };
        },
      },
      { supervisor: { coreEntryPath: o.coreEntry, fork: plainFork(env) } },
    );
    this.#engines.push(engine);
    const states: EngineStateEvent[] = [];
    engine.on('engine', (s) => states.push(s));
    const connect = async (id: string, user: string): Promise<TestClient> => {
      const c = await TestClient.open(`ws://127.0.0.1:${port}/open-docex?doc=${id}`, { headers: { authorization: `Bearer ${user}` } });
      this.#clients.push(c);
      return c;
    };
    return { engine, refs, states, storageRoot, dataDir, connect };
  }

  /** Closes clients, shuts engines down, closes servers and removes the folders. */
  async cleanup(): Promise<void> {
    for (const c of this.#clients.splice(0)) await c.close().catch(() => undefined);
    for (const e of this.#engines.splice(0)) await e.shutdown({ timeoutMs: 5000 });
    for (const s of this.#servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const r of this.#roots.splice(0)) await rm(r, { recursive: true, force: true });
  }
}
