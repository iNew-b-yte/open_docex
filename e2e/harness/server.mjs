// The e2e harness (LLD Part 1 §1.1, Part 3 §17): one HTTP server that serves the built client
// page and hosts the real engine (`createEngineWith` from the compiled backend, with the fake codec
// of `fake-codec.mjs`). Each call of `startHarness` makes its own folders and listens on an
// ephemeral port, so tests never share state.
//
// Authentication: the page puts `?token=<access>:<user>` on the socket URL (`edit:alice`).
import { fork } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textSchema } from '@open-docex/shared/text';
import { createEngineWith } from '../../backend/dist/api/create-engine.js';
import { resolveWorkerConfig } from '../../backend/dist/api/validate-options.js';
import { LocalFsStorage } from '../../backend/dist/storage/local-fs-storage.js';
import { createFakeCodec } from './fake-codec.mjs';
import { pageDir } from './global-setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF_CONFIG = path.join(here, 'worker-config.mjs');

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>open_docex e2e</title>
<link rel="stylesheet" href="/page.css"></head><body style="margin:0"><div id="root"></div>
<script src="/page.js"></script></body></html>`;

/** Polls `check` until it stops throwing. For harness-side waits only (tests use `expect.poll`). */
export async function until(check, { timeoutMs = 60_000, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(last)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Starts a harness.
 * @param {{ mode?: 'main' | 'worker', highWaterMarkBytes?: number, config?: object, supervisor?: object }} [o]
 */
export async function startHarness(o = {}) {
  const mode = o.mode ?? 'main';
  const root = await mkdtemp(path.join(tmpdir(), `odx-e2e-${mode}-`));
  const storageRoot = path.join(root, 'storage');
  const dataDir = path.join(root, 'data');
  mkdirSync(storageRoot);
  const settings = { dataDir, storageRoot, config: { flush: { quietMs: 1000, maxIntervalMs: 60_000 }, ...o.config } };

  const refs = new Map();
  const page = { js: await readFile(path.join(pageDir, 'page.js')), css: await readFile(path.join(pageDir, 'page.css')) };
  /** user → open server-side sockets, for {@link Harness.stall}. */
  const sockets = new Map();
  /** user → how many connections were accepted. */
  const connections = new Map();
  const children = [];
  const engineStates = [];
  let engine;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/edit-anyway') {
      // The adopter route behind the "Edit anyway" button.
      engine.documents
        .allowUnsupportedEdit(url.searchParams.get('doc') ?? '')
        .then(() => res.writeHead(204).end(), () => res.writeHead(500).end());
    } else if (url.pathname === '/page.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(page.js);
    else if (url.pathname === '/page.css') res.writeHead(200, { 'content-type': 'text/css' }).end(page.css);
    else if (url.pathname === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(INDEX);
    else res.writeHead(404).end();
  });
  server.on('upgrade', (req) => {
    const user = (new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? '').split(':')[1] ?? '';
    connections.set(user, (connections.get(user) ?? 0) + 1);
    const set = sockets.get(user) ?? new Set();
    sockets.set(user, set);
    set.add(req.socket);
    req.socket.once('close', () => set.delete(req.socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const authorize = (ctx) => {
    const token = ctx.url.searchParams.get('token');
    if (token === null) return { deny: 401 };
    const [access, userId] = token.split(':');
    const ref = refs.get(ctx.documentId);
    if (ref === undefined || (access !== 'edit' && access !== 'view') || userId === undefined) return null;
    return { userId, access, document: { ref, format: 'docx' } };
  };
  const send = o.highWaterMarkBytes === undefined ? {} : { highWaterMarkBytes: o.highWaterMarkBytes };

  if (mode === 'main') {
    const page0 = resolveWorkerConfig({}).blankDocument.page;
    const config = { dataDir, storage: new LocalFsStorage({ root: storageRoot }), ...settings.config };
    engine = await createEngineWith(
      { mode: 'main', workerConfigModule: SELF_CONFIG, http: { server }, authorize, send },
      {
        core: {
          codec: () => createFakeCodec({ textSchema, page: page0 }),
          importModule: () => Promise.resolve({ default: config }),
        },
      },
    );
  } else {
    engine = await createEngineWith(
      {
        mode: 'worker',
        workerConfigModule: SELF_CONFIG,
        http: { server },
        authorize,
        send,
        supervisor: { backoffMs: [200, 400, 800], ...o.supervisor },
      },
      {
        supervisor: {
          coreEntryPath: path.join(here, 'fake-core.mjs'),
          fork: (file, args, options) => {
            // A plain node child: the test runner's loader flags must not reach the compiled Core.
            const env = { ...process.env, ODX_E2E: JSON.stringify(settings) };
            delete env.NODE_OPTIONS;
            const execArgv = (options.execArgv ?? []).filter((a) => !a.startsWith('--conditions') && !a.startsWith('-C'));
            const child = fork(file, [...args], { ...options, execArgv, env });
            children.push(child);
            return child;
          },
        },
      },
    );
  }
  engine.on('engine', (s) => engineStates.push(s.state));

  let disposed = false;
  return {
    mode,
    engine,
    /** `http://127.0.0.1:<port>/` */
    baseUrl: `http://127.0.0.1:${port}/`,
    engineStates,
    /** Puts `text` in storage as a document and registers it for `authorize`. */
    async addDoc(documentId, text) {
      const ref = `${documentId}.docx`;
      await writeFile(path.join(storageRoot, ref), text);
      refs.set(documentId, ref);
    },
    /** The text in storage (fake codec). */
    async storedText(documentId) {
      return readFile(path.join(storageRoot, `${documentId}.docx`), 'utf8');
    },
    /** How many sockets `user` opened so far. */
    connectionCount: (user) => connections.get(user) ?? 0,
    /**
     * Makes the server-side sockets of `user` that are open now behave like a stuck client: their
     * writes never complete, so the Gateway's send queue fills up (a slow consumer).
     */
    stall(user) {
      for (const socket of sockets.get(user) ?? []) {
        socket.write = () => true;
        // `ws` hands its frames to `cork`/`write`; with the callback never called, `pendingBytes` grows.
      }
    },
    /** Worker mode: SIGKILLs the Core; the Supervisor restarts it. Resolves once serving again. */
    async restartCore() {
      const child = children.at(-1);
      if (child === undefined) throw new Error('restartCore() is for worker mode');
      const mark = engineStates.length;
      child.kill('SIGKILL');
      await until(
        () => {
          const now = engineStates.slice(mark);
          if (!now.includes('restarting') || engine.state !== 'running') throw new Error(`states: ${now.join(',')}, engine ${engine.state}`);
        },
        { what: 'the Core to restart' },
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await engine.shutdown({ timeoutMs: 15_000 }).catch(() => undefined);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}
