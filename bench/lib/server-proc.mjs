// The engine under test, in its own process (so the load generators never share a CPU thread
// with it). Started by `net.mjs` with `ODX_BENCH_MODE=main|worker`. Reports `{type:'ready', port}`
// over IPC and answers `{cmd:'stats'}` with CPU time and memory of the main process and, in
// worker mode, of the Core process (read from the file the Core entry writes).
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textSchema } from '@open-docex/shared/text';
import { createEngineWith } from '../../backend/dist/api/create-engine.js';
import { resolveWorkerConfig } from '../../backend/dist/api/validate-options.js';
import { LocalFsStorage } from '../../backend/dist/storage/local-fs-storage.js';
import { createFakeCodec } from '../../e2e/harness/fake-codec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.ODX_BENCH_MODE === 'worker' ? 'worker' : 'main';
const root = await mkdtemp(path.join(tmpdir(), `odx-bench-${mode}-`));
const storageRoot = path.join(root, 'storage');
const ctlDir = path.join(root, 'ctl');
mkdirSync(storageRoot);
mkdirSync(ctlDir);
const settings = { dataDir: path.join(root, 'data'), storageRoot, ctlDir, config: { flush: { quietMs: 30_000, maxIntervalMs: 300_000 } } };

// Every document starts with 20 lines of ~60 characters.
const INITIAL = Array.from({ length: 20 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog again`).join('\n');
const known = new Set();
const server = createServer();
let sentCpu = 0;

const authorize = (ctx) => {
  const token = ctx.url.searchParams.get('token');
  if (token === null) return { deny: 401 };
  const [access, userId] = token.split(':');
  const id = ctx.documentId;
  const ref = `${id}.docx`;
  if (!known.has(id)) {
    known.add(id);
    if (!existsSync(path.join(storageRoot, ref))) writeFileSync(path.join(storageRoot, ref), INITIAL);
  }
  return { userId: userId ?? 'u', access, document: { ref, format: 'docx' } };
};

let child;
let engine;
if (mode === 'main') {
  const page = resolveWorkerConfig({}).blankDocument.page;
  const config = { dataDir: settings.dataDir, storage: new LocalFsStorage({ root: storageRoot }), ...settings.config };
  engine = await createEngineWith(
    { mode: 'main', workerConfigModule: path.join(here, 'worker-config.mjs'), http: { server }, authorize },
    { core: { codec: () => createFakeCodec({ textSchema, page }), importModule: () => Promise.resolve({ default: config }) } },
  );
} else {
  engine = await createEngineWith(
    { mode: 'worker', workerConfigModule: path.join(here, 'worker-config.mjs'), http: { server }, authorize },
    {
      supervisor: {
        coreEntryPath: path.join(here, 'core-entry.mjs'),
        fork: (file, args, options) => {
          const env = { ...process.env, ODX_BENCH: JSON.stringify(settings) };
          delete env.NODE_OPTIONS;
          const execArgv = (options.execArgv ?? []).filter((a) => !a.startsWith('--conditions') && !a.startsWith('-C'));
          child = fork(file, [...args], { ...options, execArgv, env });
          return child;
        },
      },
    },
  );
}
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.send({ type: 'ready', port: server.address().port, pid: process.pid });

function stats() {
  const c = process.cpuUsage();
  const m = process.memoryUsage();
  const out = { at: Date.now(), main: { cpuUs: c.user + c.system, rss: m.rss, heapUsed: m.heapUsed }, sockets: engine.sessions ? undefined : undefined };
  if (mode === 'worker') {
    try {
      const k = JSON.parse(readFileSync(path.join(ctlDir, 'core-stats.json'), 'utf8'));
      out.core = { cpuUs: k.cpuUs, rss: k.rss, heapUsed: k.heapUsed, at: k.at };
    } catch {
      out.core = null;
    }
  }
  return out;
}

process.on('message', async (msg) => {
  if (msg.cmd === 'stats') process.send({ type: 'stats', id: msg.id, stats: stats() });
  else if (msg.cmd === 'stop') {
    await engine.shutdown({ timeoutMs: 15_000 }).catch(() => undefined);
    server.closeAllConnections();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    process.exit(0);
  }
});
void sentCpu;

// Never outlive the orchestrator (a stage killed on its time limit).
process.on('disconnect', () => process.exit(0));
