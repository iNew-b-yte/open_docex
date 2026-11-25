// The rig of the integration suite (LLD Part 2 §21, HLD §17): one engine, its HTTP server, its
// storage and its data folder, started in `mode: 'main'` or `mode: 'worker'` behind one API, so
// that a scenario is written once and runs in both modes.
//
// What differs by mode stays inside this file:
// - **Where the Core runs.** Main mode: in this process, over `LocalFsStorage`, with the fake text
//   codec (or the real `CodecService`). Worker mode: a forked, compiled Core (`npm run build`).
// - **A crash.** Worker mode kills the Core process and lets the Supervisor restart it. Main mode
//   has no process to kill, so it stops the engine with the codec's export switched off (nothing
//   is flushed, the journal and meta stay as they were) and boots a new engine on the same data
//   folder. Both end with the same recovery work on boot.
//
// Failures are switched with flag files (`fixtures/suite-env.mjs`), which both modes read the same
// way. Waiting is `waitFor` from `test/wait-for.ts` only.
import type { ChildProcess, ForkOptions } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenDocexError } from '@open-docex/shared/errors';
import type { ClientId, DocumentId } from '@open-docex/shared/ids';
import { textSchema } from '@open-docex/shared/text';
import { createEngineWith } from '../../../src/api/create-engine.js';
import type { Engine } from '../../../src/api/engine-facade.js';
import type { AuditEvent, DocumentEvent, EngineStateEvent, StorageEvent } from '../../../src/api/events.js';
import type { AuthorizeContext, AuthorizeResult, SupervisorOptions, WorkerConfig } from '../../../src/api/options.js';
import { resolveWorkerConfig } from '../../../src/api/validate-options.js';
import type { DocumentMeta } from '../../../src/persistence/meta-store.js';
import { docKeyOf, metaPath, snapshotPath } from '../../../src/persistence/layout.js';
import { LocalFsStorage } from '../../../src/storage/local-fs-storage.js';
import type { StorageRef } from '../../../src/storage/storage-adapter.js';
import { realCodec } from '../../unit/core/in-process-pool.js';
import { waitFor } from '../../wait-for.js';
import type { WiredCodec } from '../../../src/core/core-entry.js';
import type { CoreServiceContext } from '../../../src/core/core-runtime.js';
import { buildWorkerConfig, createSuiteCodec, flagOn, type SuiteSettings } from '../fixtures/suite-env.mjs';
import { dist, fixtures, haveDist, plainFork } from '../worker-harness.js';
import { TestClient, type Loaded } from '../test-client.js';
import { loadedText } from './doc-helpers.js';

export { haveDist };

/** Where the Core runs. */
export type Mode = 'main' | 'worker';

/** Per-scenario settings. */
export interface RigOptions {
  /** `'fake'` (default): UTF-8 text, one paragraph per line. `'lo'`: the real LibreOffice codec. */
  codec?: 'fake' | 'lo';
  /** `WorkerConfig` overrides, a whole section at a time (the suite's default is `flush.quietMs` 1 000). */
  config?: WorkerConfig;
  /** Worker mode only. */
  supervisor?: SupervisorOptions;
}

/** The engine events the rig records. `audit` is separate: it is on only while a test listens. */
export interface RecordedEvents {
  engine: EngineStateEvent[];
  storage: StorageEvent[];
  error: OpenDocexError[];
  fatal: OpenDocexError[];
  document: DocumentEvent[];
}

type StorageOp = 'read' | 'write' | 'stat' | 'create';

const SELF = fileURLToPath(import.meta.url);

/**
 * The real codec with the `export-fail` flag honoured, so that main mode can stop "without a
 * flush" with LibreOffice too (the fake codec reads the flag itself, `fixtures/suite-env.mjs`).
 */
function withExportFlag(inner: WiredCodec, ctlDir: string): WiredCodec {
  return {
    import: (i) => inner.import(i),
    probe: () => inner.probe(),
    close: () => inner.close(),
    export: (i) => (flagOn(ctlDir, 'export-fail') ? Promise.reject(new Error('export is down')) : inner.export(i)),
  };
}

/** Closes the engine and its folders in `dispose()`. */
export class Rig {
  readonly mode: Mode;
  readonly root: string;
  readonly storageRoot: string;
  readonly ctlDir: string;
  /** Changes with `start({ freshData: true })`. */
  dataDir: string;
  /** documentId → storage ref, read by `authorize`. */
  readonly refs = new Map<string, StorageRef>();
  readonly events: RecordedEvents = { engine: [], storage: [], error: [], fatal: [], document: [] };
  /** Audit events seen by the listener (see {@link Rig.listenToAudit}). */
  readonly audit: AuditEvent[] = [];
  engine!: Engine;

  readonly #o: RigOptions;
  readonly #server: Server;
  readonly #port: number;
  readonly #clients: TestClient[] = [];
  readonly #children: ChildProcess[] = [];
  #generation = 0;
  #auditOff: (() => void) | undefined;
  #disposed = false;

  private constructor(mode: Mode, o: RigOptions, root: string, server: Server, port: number) {
    this.mode = mode;
    this.#o = o;
    this.root = root;
    this.storageRoot = path.join(root, 'storage');
    this.ctlDir = path.join(root, 'ctl');
    this.dataDir = path.join(root, 'data');
    this.#server = server;
    this.#port = port;
  }

  /** Creates the folders and the HTTP server and starts the engine. */
  static async create(mode: Mode, o: RigOptions = {}): Promise<Rig> {
    const root = await mkdtemp(path.join(tmpdir(), `odx-suite-${mode}-`));
    mkdirSync(path.join(root, 'storage'));
    mkdirSync(path.join(root, 'ctl'));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const rig = new Rig(mode, o, root, server, (server.address() as AddressInfo).port);
    try {
      await rig.start();
    } catch (err) {
      await rig.dispose();
      throw err;
    }
    return rig;
  }

  // --- engine lifecycle ----------------------------------------------------------------------

  /** Starts an engine on the current folders. `freshData` uses a new, empty data folder. */
  async start(o: { freshData?: boolean } = {}): Promise<void> {
    if (o.freshData === true) this.dataDir = path.join(this.root, `data-${++this.#generation}`);
    const settings: SuiteSettings = {
      dataDir: this.dataDir,
      storageRoot: this.storageRoot,
      ctlDir: this.ctlDir,
      ...(this.#o.config !== undefined ? { config: this.#o.config } : {}),
    };
    const authorize = (ctx: AuthorizeContext): AuthorizeResult | { deny: 401 } | null => this.#authorize(ctx);
    if (this.mode === 'main') {
      const codec =
        this.#o.codec === 'lo'
          ? (c: CoreServiceContext): WiredCodec => withExportFlag(realCodec(c), this.ctlDir)
          : () => createSuiteCodec({ textSchema, page: resolveWorkerConfig({}).blankDocument.page, ctlDir: this.ctlDir });
      this.engine = await createEngineWith(
        { mode: 'main', workerConfigModule: SELF, http: { server: this.#server }, authorize },
        { core: { codec, importModule: () => Promise.resolve({ default: buildWorkerConfig({ LocalFsStorage, settings }) }) } },
      );
    } else {
      const real = this.#o.codec === 'lo';
      const fork = plainFork({ ...process.env, ODX_SUITE: JSON.stringify(settings) });
      this.engine = await createEngineWith(
        {
          mode: 'worker',
          workerConfigModule: path.join(fixtures, 'suite-config.mjs'),
          http: { server: this.#server },
          authorize,
          supervisor: { ...(real ? { bootTimeoutMs: 120_000 } : {}), ...this.#o.supervisor },
        },
        {
          supervisor: {
            coreEntryPath: real ? path.join(dist, 'core', 'core-entry.js') : path.join(fixtures, 'suite-core.mjs'),
            fork: (file: string, args: readonly string[], options: ForkOptions) => {
              const child = fork(file, args, options);
              this.#children.push(child);
              return child;
            },
          },
        },
      );
    }
    const e = this.engine;
    e.on('engine', (s) => this.events.engine.push(s));
    e.on('storage', (s) => this.events.storage.push(s));
    e.on('error', (s) => this.events.error.push(s));
    e.on('fatal', (s) => this.events.fatal.push(s));
    e.on('document', (s) => this.events.document.push(s));
    if (this.#auditOff !== undefined) this.listenToAudit(); // a listener that was on stays on
  }

  /**
   * Stops the engine. `flush: false` switches the codec's export off first, so the stop writes
   * nothing to storage: the journal and meta stay as a crash would leave them.
   */
  async stop(o: { flush?: boolean } = {}): Promise<void> {
    const flush = o.flush ?? true;
    this.#auditOff?.();
    if (!flush) this.flag('export-fail', true);
    try {
      await this.engine.shutdown({ timeoutMs: this.#shutdownMs });
    } finally {
      if (!flush) this.flag('export-fail', false);
    }
  }

  /**
   * A crash and the restart after it, resolved when the engine serves again. Worker mode kills the
   * Core process (the Supervisor restarts it); main mode stops without a flush and boots again.
   */
  async crash(): Promise<void> {
    if (this.mode === 'worker') {
      const mark = this.events.engine.length;
      this.killCore();
      await this.whenRestarted(mark);
    } else {
      await this.stop({ flush: false });
      await this.start();
    }
  }

  /** Worker mode: kills the Core process. */
  killCore(): void {
    const child = this.#children.at(-1);
    if (child === undefined) throw new Error('killCore() is for worker mode');
    child.kill('SIGKILL');
  }

  /** Worker mode: waits for the Supervisor's `restarting` and then `started` after event index `mark`. */
  async whenRestarted(mark: number): Promise<void> {
    await waitFor(() => {
      const states = this.events.engine.slice(mark).map((s) => s.state);
      if (!states.includes('restarting') || states.at(-1) !== 'started') throw new Error(`the Core has not restarted yet: ${states.join(',')}`);
      if (this.engine.state !== 'running') throw new Error(`engine state is ${this.engine.state}`);
    });
  }

  /** Worker mode: waits for the engine to reach `state` (for example `'failed'`). */
  async whenState(state: Engine['state']): Promise<void> {
    await waitFor(() => {
      if (this.engine.state !== state) throw new Error(`engine state is ${this.engine.state}, not ${state}`);
    });
  }

  /** Releases or holds the next Core boot (worker mode): a held Core stays in `restarting`. */
  holdBoot(on: boolean): void {
    this.flag('hold-boot', on);
  }

  /** Closes clients, stops the engine and removes the folders. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.flag('hold-boot', false);
    this.#auditOff?.();
    for (const c of this.#clients.splice(0)) await c.close().catch(() => undefined);
    await (this.engine as Engine | undefined)?.shutdown({ timeoutMs: this.#shutdownMs }).catch(() => undefined);
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await rm(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  get #shutdownMs(): number {
    return this.#o.codec === 'lo' ? 90_000 : 15_000;
  }

  // --- failure switches ----------------------------------------------------------------------

  /** Makes the storage throw for `ops` (default: all four) until {@link Rig.storageUp}. */
  storageDown(ops: StorageOp[] = ['read', 'write', 'stat', 'create']): void {
    for (const op of ops) this.flag(`storage-fail-${op}`, true);
  }

  /** The storage works again. */
  storageUp(): void {
    for (const op of ['read', 'write', 'stat', 'create'] as const) this.flag(`storage-fail-${op}`, false);
  }

  /** Makes the codec's export reject (fake codec only) until switched off. */
  exportDown(on: boolean): void {
    this.flag('export-fail', on);
  }

  /** Creates or removes a flag file. */
  flag(name: string, on: boolean): void {
    const file = path.join(this.ctlDir, name);
    if (on) writeFileSync(file, '');
    else rmSync(file, { force: true });
  }

  // --- documents and storage -----------------------------------------------------------------

  /** Puts `content` in storage as `<documentId>.docx` and registers it for `authorize`. */
  async addFile(documentId: string, content: string | Uint8Array): Promise<string> {
    const ref = `${documentId}.docx`;
    await writeFile(path.join(this.storageRoot, ref), content);
    this.refs.set(documentId, ref);
    return ref;
  }

  /** Copies a fixture file into storage and registers it. */
  async addFixture(documentId: string, file: string): Promise<string> {
    const ref = `${documentId}.docx`;
    await copyFile(file, path.join(this.storageRoot, ref));
    this.refs.set(documentId, ref);
    return ref;
  }

  /** `documents.create` of a blank text document, registered for `authorize`. */
  async createBlank(documentId: string, target: 'storage' | 'local' = 'storage'): Promise<StorageRef> {
    const { ref } = await this.engine.documents.create({ kind: 'text', format: 'docx', name: 'Blank', target });
    this.refs.set(documentId, ref);
    return ref;
  }

  /** The storage file of a document (a string ref in the built-in storage). */
  storagePath(documentId: string): string {
    const ref = this.refs.get(documentId);
    if (typeof ref !== 'string') throw new Error(`no string ref for ${documentId}`);
    return path.join(this.storageRoot, ref);
  }

  /** The bytes in storage. */
  async storedBytes(documentId: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.storagePath(documentId)));
  }

  /** The text in storage (fake codec). */
  async storedText(documentId: string): Promise<string> {
    return new TextDecoder().decode(await this.storedBytes(documentId));
  }

  /** Waits until storage holds exactly `text` (fake codec): a flush happened. */
  async waitStored(documentId: string, text: string): Promise<void> {
    await waitFor(async () => {
      const now = await this.storedText(documentId);
      if (now !== text) throw new Error(`storage holds ${JSON.stringify(now)}, not ${JSON.stringify(text)}`);
    });
  }

  /**
   * Changes the storage file as an outside editor would (not through the engine). The mtime is
   * set ahead, so the file's version differs even when the size is the same.
   */
  async outsideEdit(documentId: string, content: string | Uint8Array): Promise<void> {
    const file = this.storagePath(documentId);
    await writeFile(file, content);
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
  }

  /** `meta.json` of a document as the Core last wrote it. Throws while it is being replaced. */
  async metaOnDisk(documentId: string): Promise<DocumentMeta> {
    return JSON.parse(await readFile(metaPath(this.dataDir, docKeyOf(documentId as DocumentId)), 'utf8')) as DocumentMeta;
  }

  /** `snapshot.json` of a document: the rev of the last local snapshot. */
  async snapshotRevOnDisk(documentId: string): Promise<number> {
    const file = snapshotPath(this.dataDir, docKeyOf(documentId as DocumentId));
    return (JSON.parse(await readFile(file, 'utf8')) as { rev: number }).rev;
  }

  /** Waits until `check(meta)` holds for the document's `meta.json`. */
  async waitMeta(documentId: string, check: (m: DocumentMeta) => boolean): Promise<DocumentMeta> {
    return waitFor(async () => {
      const m = await this.metaOnDisk(documentId);
      if (!check(m)) throw new Error(`meta.json is not there yet: rev ${m.rev}, flushed ${m.lastFlushedRev}, audit ${m.auditEmittedRev}, ${m.storageState}`);
      return m;
    });
  }

  /** Whether `path` below the data folder exists (for the layout checks). */
  hasData(...segments: string[]): boolean {
    return existsSync(path.join(this.dataDir, ...segments));
  }

  /** The recovery entry of a document, or `undefined` when it is NORMAL. */
  async recoveryEntry(documentId: string) {
    return (await this.engine.recovery.list()).find((e) => e.documentId === documentId);
  }

  /** Waits until the document's recovery state is `state` (`'NORMAL'`: not listed). */
  async waitRecovery(documentId: string, state: 'NORMAL' | 'LOCAL' | 'CHECK' | 'PENDING' | 'CONFLICT') {
    return waitFor(async () => {
      const e = await this.recoveryEntry(documentId);
      const now = e?.state ?? 'NORMAL';
      if (now !== state) throw new Error(`recovery state is ${now}, not ${state}`);
      return e;
    });
  }

  /** Waits for a `storage` event of `state` after event index `from`. */
  async waitStorageEvent(state: StorageEvent['state'], from = 0): Promise<StorageEvent> {
    return waitFor(() => {
      const e = this.events.storage.slice(from).find((x) => x.state === state);
      if (e === undefined) throw new Error(`no ${state} storage event yet; got ${this.events.storage.slice(from).map((x) => x.state).join(',')}`);
      return e;
    });
  }

  // --- audit ---------------------------------------------------------------------------------

  /** Starts listening to `audit` events. They go to {@link Rig.audit}; replays buffered at boot are delivered. */
  listenToAudit(): void {
    this.#auditOff?.();
    this.#auditOff = this.engine.on('audit', (a) => this.audit.push(a));
  }

  /**
   * Stops listening. The Core stops sending audit events and stops advancing `auditEmittedRev`
   * once it has seen `audit.enable`, which the call to `recovery.list()` waits for (same FIFO).
   */
  async stopListeningToAudit(): Promise<void> {
    this.#auditOff?.();
    this.#auditOff = undefined;
    await this.engine.recovery.list();
  }

  // --- clients -------------------------------------------------------------------------------

  /** `ws://…/open-docex?doc=<id>`. */
  url(documentId: string): string {
    return `ws://127.0.0.1:${this.#port}/open-docex?doc=${encodeURIComponent(documentId)}`;
  }

  /** An HTTP origin for plain requests to the server. */
  get origin(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** Opens a socket as `user`. `Authorization: Bearer <access>:<user>`. The test says `hello`. */
  async connect(documentId: string, user = 'alice', o: { access?: 'edit' | 'view'; clientId?: ClientId } = {}): Promise<TestClient> {
    const c = await TestClient.open(this.url(documentId), {
      headers: { authorization: `Bearer ${o.access ?? 'edit'}:${user}` },
      ...(o.clientId !== undefined ? { clientId: o.clientId } : {}),
    });
    this.#clients.push(c);
    return c;
  }

  /** Opens a socket and loads the document. */
  async join(documentId: string, user = 'alice', o: { access?: 'edit' | 'view'; clientId?: ClientId } = {}): Promise<{ c: TestClient; load: Loaded }> {
    const c = await this.connect(documentId, user, o);
    return { c, load: await c.hello() };
  }

  /** The document's text as a fresh view session loads it. */
  async textOf(documentId: string): Promise<string> {
    const { c, load } = await this.join(documentId, 'reader', { access: 'view' });
    const text = loadedText(load);
    await c.close();
    return text;
  }

  #authorize(ctx: AuthorizeContext): AuthorizeResult | { deny: 401 } | null {
    const header = ctx.request.headers.authorization;
    if (header === undefined) return { deny: 401 };
    const [access, userId] = header.replace('Bearer ', '').split(':');
    const ref = this.refs.get(ctx.documentId);
    if (ref === undefined || (access !== 'edit' && access !== 'view') || userId === undefined) return null;
    return { userId, access, document: { ref, format: 'docx' } };
  }
}

