# @open-docex/server

The open_docex engine for Node.js. It adds collaborative editing of `.docx` and `.odt` files to your own application: a WebSocket gateway on your HTTP server, a document core that merges concurrent edits, local persistence with crash recovery, and a LibreOffice-based codec that converts files to and from the editing model.

Pair it with [`@open-docex/client`](../frontend/README.md) in the browser. Both packages must be the same release.

## Install

```sh
npm install @open-docex/server
```

Requires Node.js 22, 24 or 26. The package is ESM only.

## LibreOffice is required

open_docex converts documents with LibreOffice, run headless. **Install LibreOffice on the server.** It is an external program: open_docex never bundles it.

- The engine auto-detects `soffice`. If it is somewhere unusual, set `libreoffice.path` in the worker config module.
- If LibreOffice is missing, `createEngine` rejects at start-up with `CONFIG_LIBREOFFICE_NOT_FOUND`.
- Install LibreOffice Draw (the drawing component) and a reasonable set of fonts. They are needed to convert EMF, WMF, TIFF and SVG images inside documents.
- CI tests the engine against LibreOffice 26.2 and 26.8.
- LibreOffice runs with macros disabled, in a temporary profile, with a timeout. Documents never execute.

You also need a writable `dataDir` (default `./open-docex-data` under the current directory) for the journal and local copies.

## Quick start

An engine needs two files: your application and a worker config module.

`worker-config.mjs`

```js
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineWorkerConfig, LocalFsStorage } from '@open-docex/server';

const files = fileURLToPath(new URL('./files', import.meta.url));
mkdirSync(files, { recursive: true });

export default defineWorkerConfig({
  storage: new LocalFsStorage({ root: files }),
  dataDir: fileURLToPath(new URL('./data', import.meta.url)),
});
```

`server.mjs`

```js
import http from 'node:http';
import { createEngine } from '@open-docex/server';

const server = http.createServer();
let ref; // the storage ref of the document to open (see "Storage")

const engine = await createEngine({
  workerConfigModule: new URL('./worker-config.mjs', import.meta.url),
  http: { server, path: '/open-docex' },
  authorize: async ({ request, documentId }) => {
    const cookie = request.headers.cookie ?? '';
    if (!cookie.includes('session=')) return { deny: 401 };
    if (documentId !== 'demo') return null; // 403
    return { userId: 'u1', access: 'edit', document: { ref, format: 'docx' } };
  },
});

({ ref } = await engine.documents.create({ kind: 'text', format: 'docx', name: 'Demo', target: 'storage' }));

server.listen(3000);
```

In production, replace the cookie check with a lookup in your own session store, and map `documentId` to a ref from your database.

`createEngine` returns a promise. It rejects with an `OpenDocexError` if configuration is invalid or the core cannot start (`CONFIG_INVALID`, `CONFIG_LIBREOFFICE_NOT_FOUND`, `CONFIG_DATA_DIR_UNWRITABLE`). No `upgrade` listener is attached before start-up succeeds.

## Engine options

Passed to `createEngine` in your main process.

| Option | Default | Meaning |
|---|---|---|
| `workerConfigModule` | required | Absolute path or `file:` URL of the worker config module |
| `authorize(ctx)` | required | Decides each WebSocket upgrade. See below |
| `mode` | `'worker'` | `'worker'` runs the core in a child process, `'main'` in your process |
| `http.server` | none | An `http` or `https` server to attach to. Without it, call `engine.attach(server)` later |
| `http.path` | `'/open-docex'` | URL path of the WebSocket endpoint |
| `canSubmit(session)` | none | Optional per-change gate, may be async. Return `false` to reject the change |
| `supervisor.heartbeatIntervalMs` | `5000` | Worker mode: heartbeat interval |
| `supervisor.heartbeatTimeoutMs` | `15000` | Worker mode: must be greater than the interval |
| `supervisor.backoffMs` | `[1000, 2000, 4000, 8000, 16000]` | Restart delays |
| `supervisor.maxRestarts` | `5` | Restarts allowed per `restartWindowMs` |
| `supervisor.restartWindowMs` | `600000` | Restart window (10 minutes) |
| `supervisor.bootTimeoutMs` | `60000` | Time allowed for the core to boot |
| `supervisor.shutdownTimeoutMs` | `10000` | Time allowed for the core to stop |
| `send.highWaterMarkBytes` | `8388608` (8 MiB) | Send buffer limit before a slow client is disconnected |
| `ws.maxPayloadBytes` | `16777216` (16 MiB) | Largest WebSocket message accepted |
| `ws.pingIntervalMs` | `30000` | Server ping interval, detects dead connections |
| `ws.helloTimeoutMs` | `30000` | Time a client has to send its first message |
| `logger` | no-op | Object with `debug`, `info`, `warn`, `error` `(message, fields?)` |
| `logLevel` | `'info'` | `'debug'`, `'info'`, `'warn'` or `'error'` |

Invalid options throw `CONFIG_INVALID` naming the option.

## Authorization

`authorize` runs before every WebSocket upgrade, before any document is touched. **Access is denied by default**: you decide who gets in.

```ts
authorize(ctx: AuthorizeContext): AuthorizeResult | AuthorizeDenial | null | Promise<...>
```

`AuthorizeContext`:

| Field | Meaning |
|---|---|
| `request` | The Node.js `IncomingMessage` of the upgrade. Read your cookie, `Authorization` header or `Sec-WebSocket-Protocol` from it |
| `url` | The parsed request URL (a query-string token is in `url.searchParams`) |
| `documentId` | From the `?doc=` query parameter set by the client |
| `purpose` | Always `'document'` in V1 |

Return one of:

| Return | Result |
|---|---|
| `{ userId, access: 'edit' \| 'view', document: { ref, format } }` | Accept. `ref` is your storage ref, `format` is `'docx'` or `'odt'`. View sessions cannot submit changes |
| `{ deny: 401 }` or `{ deny: 403 }` | Refuse with that HTTP status |
| `null` | Refuse with 403 |
| a thrown error | HTTP 500 and an `ACCESS_DENIED` error event |
| `{ deny: <other value> }` | Malformed: HTTP 500 and a `CONFIG_INVALID` error event |

Browsers cannot read the status of a failed WebSocket upgrade. They see close code 1006 whichever you return.

`canSubmit(session)` is an optional second gate that runs for each change. `Session` has `id`, `documentId`, `userId`, `access` and `openedAt`.

## Main mode and worker mode

- **Worker mode (default).** The core, which holds every open document and runs the codec, runs in a child process. Your main process only forwards frames, so a slow conversion cannot stall your application. If the core crashes, the supervisor restarts it with back-off, clients reconnect, and acknowledged changes are recovered from the journal. A crash of the core process loses none of them. After a power loss or operating-system crash the default `journal.fsync: 'interval'` can lose up to about one `fsyncIntervalMs` (1 s) of acknowledged changes; `'always'` closes that gap at a cost in speed. After `supervisor.maxRestarts` within `restartWindowMs`, the engine goes to `failed`: see `ENGINE_FAILED`.
- **Main mode (`mode: 'main'`).** The core runs inside your process. Simpler for development and tests. A crash in the core is a crash of your process.

Both modes read the same worker config module. In worker mode the module is loaded in the child process, so everything in it (including your storage adapter) lives there, and values must be created inside the module.

## Worker config module

The default export of the module you pass as `workerConfigModule`. Use `defineWorkerConfig` for type inference. It returns its argument unchanged.

| Option | Default | Meaning |
|---|---|---|
| `storage` | none | Your `StorageAdapter`. Without it, `LocalFsStorage` under `<dataDir>/local-storage` is the primary storage |
| `dataDir` | `<cwd>/open-docex-data` | Journal, snapshots and local copies. Must be writable |
| `queue` | `{ type: 'memory', perDocument: 1000, global: 50000 }` | Bounds of the in-memory change queue. When full, clients retry (`QUEUE_FULL`) |
| `journal.fsync` | `'interval'` | `'interval'` or `'always'` |
| `journal.fsyncIntervalMs` | `1000` | Used with `'interval'` |
| `snapshot.everyOps` | `500` | Operations between snapshots |
| `flush.quietMs` | `30000` | Save to storage after this long without edits |
| `flush.maxIntervalMs` | `300000` | Save to storage at least this often while editing |
| `recovery.retryDelaysMs` | `[60000, 300000, 900000]` | Delays of the three storage retries |
| `libreoffice.path` | auto-detect | Path of the `soffice` executable |
| `libreoffice.maxConcurrent` | `2` | Concurrent LibreOffice conversions |
| `libreoffice.timeoutMs` | `120000` | Time allowed for one conversion |
| `codecThreads` | `1` | Codec worker threads |
| `load.chunk.textBlocks` | `200` | Text blocks per load chunk |
| `load.chunk.sheetRows` | `500` | Not used in V1 |
| `load.chunk.maxBytes` | `262144` | Bytes per load chunk |
| `limits.maxFileBytes` | `52428800` (50 MiB) | Largest file accepted |
| `blankDocument.page` | A4 portrait, 2.54 cm margins | Page settings of documents created with `documents.create` |

## Storage

The engine reads and writes files through a `StorageAdapter`. If you configure none, it uses `LocalFsStorage` under `<dataDir>/local-storage`.

### LocalFsStorage

```js
import { LocalFsStorage } from '@open-docex/server';

const storage = new LocalFsStorage({ root: '/var/lib/myapp/docs' }); // the folder must exist
```

A ref is a relative path with `/` separators, confined to `root`. Absolute paths, `..`, drive letters and control characters are refused with `DOCUMENT_NOT_FOUND`. Parent folders are not created. Versions are `<mtimeNs>:<size>`. Files are written with mode 0600 through a temporary file and a rename.

### Your own adapter

Implement four methods. A `ref` is any JSON value (a string or an object) that you choose. `write` must compare `expectedVersion` with the current version and return a conflict when they differ (`null` means the file must not exist). Any throw counts as a failure. The engine aborts each call after 60 seconds.

```js
import { randomUUID } from 'node:crypto';
import { defineWorkerConfig } from '@open-docex/server';

class MemoryStorage {
  #files = new Map(); // id -> { bytes, version }

  async read(ref, { maxBytes }) {
    const f = this.#files.get(ref.id);
    if (!f || f.bytes.byteLength > maxBytes) return null;
    return { bytes: f.bytes, version: f.version };
  }

  async write(ref, bytes, { expectedVersion }) {
    const f = this.#files.get(ref.id);
    const current = f ? f.version : null;
    if (current !== expectedVersion) return { ok: false, reason: 'conflict', currentVersion: current ?? undefined };
    const version = randomUUID();
    this.#files.set(ref.id, { bytes, version });
    return { ok: true, version };
  }

  async stat(ref) {
    const f = this.#files.get(ref.id);
    return f ? { version: f.version, size: f.bytes.byteLength } : null;
  }

  async create({ bytes }) {
    const id = randomUUID();
    const version = randomUUID();
    this.#files.set(id, { bytes, version });
    return { ref: { id }, version };
  }
}

export default defineWorkerConfig({ storage: new MemoryStorage() });
```

This toy adapter loses data on restart. A real one writes to S3, a database or a file share. `read` and `write` also receive an `AbortSignal` (`signal`) that you should pass on to your storage client. `read` returns `null` for "not found".

## Engine API

```js
engine.state;                       // 'starting' | 'running' | 'restarting' | 'failed' | 'stopping' | 'stopped'
engine.attach(server);              // add the upgrade handler to another http(s) server
const off = engine.on('audit', fn); // returns an unsubscribe function
engine.off('audit', fn);

await engine.documents.create({ kind: 'text', format: 'docx', name: 'Report', target: 'storage' }); // { ref }
await engine.documents.allowUnsupportedEdit(documentId);
await engine.shareInfo(documentId); // { documentId, loaded, kind?, sessions: { edit, view } }
engine.sessions.close({ userId });  // or { documentId } or { sessionId }; returns how many were closed
await engine.shutdown({ timeoutMs: 10000 });
```

`documents.create` with `target: 'local'` keeps the new document in the built-in local storage even when you configured your own adapter. `sessions.close` ends the matching sessions with `SESSION_CLOSED`; an empty filter matches nothing.

## Events

| Event | Payload | When |
|---|---|---|
| `error` | `OpenDocexError` | A recoverable problem. Check `code` and `retryable` |
| `fatal` | `OpenDocexError` | The engine cannot continue (for example `ENGINE_FAILED`) |
| `audit` | `AuditEvent` | A batch of changes was applied |
| `storage` | `StorageEvent` | A document's storage state changed: `local`, `pending`, `conflict` or `recovered` |
| `engine` | `EngineStateEvent` | `started`, `restarting` or `failed` |
| `document` | `DocumentEvent` | `loaded`, `faulted` or `unsupported` |

### Audit

Every committed batch of operations produces one `audit` event with `documentId`, `kind`, `rev`, `fromRev`, `at`, `userId`, `clientId`, `clientSeq`, `sessionId`, `ops` and `replayed`. Events for one document arrive in order, after the acknowledgement and the broadcast.

**Delivery is at least once.** After a crash the core re-emits events it had not delivered, with `replayed: true`. Deduplicate by `(documentId, rev)`:

```js
const seen = new Set();
engine.on('audit', (e) => {
  const key = `${e.documentId}:${e.rev}`;
  if (seen.has(key)) return;
  seen.add(key);
  // write e to your audit log
});
```

Use a durable store for the dedupe key in production. Events that occur before the first `audit` listener exists are buffered (up to 10 000) and delivered to it.

## Recovery

When storage fails, the engine keeps editing working: changes are written to a local journal and the document enters a local mode (`storage` event `local`). It retries after 1, 5 and 15 minutes (`recovery.retryDelaysMs`). If retries run out, the state is `PENDING`. If the stored file changed while newer local edits exist, the state is `CONFLICT`. The engine never overwrites your storage on its own in that case.

```js
console.log(engine.state);
const closed = engine.sessions.close({ userId: 'u1' });
console.log('closed', closed);

const stuck = await engine.recovery.list();
for (const entry of stuck.filter((e) => e.state === 'PENDING' || e.state === 'CONFLICT')) {
  const copy = await engine.recovery.readLocalCopy(entry.documentId);
  console.log(entry.documentId, copy.format, copy.rev, copy.bytes.byteLength);
  await engine.recovery.resolve(entry.documentId, 'overwrite-storage');
}
```

| Call | Result |
|---|---|
| `recovery.list()` | `RecoveryEntry[]`: `documentId`, `state` (`NORMAL`, `LOCAL`, `CHECK`, `PENDING`, `CONFLICT`), `retryCount`, `nextRetryAt`, `localSince`, `localRev`, `lastFlushedRev`, `lastError` |
| `recovery.retry(documentId)` | Try the storage write again now |
| `recovery.readLocalCopy(documentId)` | `{ bytes, format, rev }`: the local model exported as a file, so you can compare it with storage |
| `recovery.resolve(documentId, resolution)` | `'overwrite-storage'` writes the local copy over storage; `'discard-local'` reloads from storage and drops local changes; `'mark-resolved'` accepts that you fixed storage yourself |

## Unsupported content

A file with parts the editor cannot represent (for example tracked changes, comments, footnotes, fields, text boxes, equations or charts) opens **read-only**. The user sees a banner, and a `document` event with `state: 'unsupported'` is emitted. If you pass `hooks.onEditAnyway` to the client, the user can choose to edit anyway; your handler then calls `engine.documents.allowUnsupportedEdit(documentId)`. The unsupported parts are removed when the document is saved.

## Security notes

- **Deny by default.** Nothing connects without an explicit `authorize` result. View sessions cannot submit changes. Use `canSubmit` for a per-change gate and `engine.sessions.close` to cut off a user or document.
- **Tokens.** A cookie or an `Authorization`-style subprotocol token is safest. A token in the query string can appear in proxy and server logs: prefer a short-lived token. The library never logs tokens or request headers.
- **Always use `wss:`** (TLS) in production, terminated by your server or proxy.
- **Malicious files.** The engine checks size before parsing, caps zip entry count and uncompressed size, disables XML external entities and DTDs, and runs LibreOffice headless with macros disabled, in a temporary profile, with a timeout. LibreOffice is started with an argument array, never through a shell, on generated temporary file names.
- **Paths.** Local file names come from a hash of the document id, never from raw input. `LocalFsStorage` refs are canonicalized and confined to `root`.
- **Flooding.** `ws.maxPayloadBytes`, the queue bounds and the slow-consumer disconnect limit message size and backlog. Per-user rate limits are not part of V1.
- **Errors.** Clients receive only the catalogue's sanitized message and code. Details stay in your `error` events and logs.
- **Several servers.** One document must be served by one engine. Two servers with in-memory queues on the same document produce diverging copies. Routing a document to one server is your concern.

## Error codes

Generated from `ERROR_CATALOGUE` in `@open-docex/shared`. `CLIENT_*` codes are raised in the browser only.

| Code | Category | Retryable | Severity | What to do |
|---|---|---|---|---|
| `CONFIG_INVALID` | config | no | fatal | Fix the option named in `message` (see the configuration reference) and restart. |
| `CONFIG_LIBREOFFICE_NOT_FOUND` | config | no | fatal | Install LibreOffice on the server, or set `libreoffice.path` to the `soffice` executable. |
| `CONFIG_DATA_DIR_UNWRITABLE` | config | no | fatal | Create `dataDir` and make it writable by the Node.js process user, or point `dataDir` elsewhere. |
| `STORAGE_READ_FAILED` | storage | yes | error | Check that the storage adapter can reach its backend and that `ref` exists; see `cause`. |
| `STORAGE_WRITE_FAILED` | storage | yes | warning | The engine kept a local copy and retries after 1, 5 and 15 min. Check storage availability and credentials. |
| `STORAGE_LOCAL_MODE` | storage | no | warning | No action needed while retries run. Watch the `storage` events. |
| `STORAGE_PENDING` | recovery | no | error | Retries are exhausted. Fix storage, then call the recovery `retry()` for this document, or `resolve()` it. |
| `STORAGE_CONFLICT` | recovery | no | error | The storage file changed while a newer local copy existed. Compare both and call `resolve()` with your choice. The engine never overwrites it on its own. |
| `QUEUE_FULL` | queue | yes | warning | Clients retry automatically. If this is frequent, raise `queue.perDocument`/`queue.global` or reduce load. |
| `QUEUE_UNAVAILABLE` | queue | yes | error | Raised when the queue is closed, for example during shutdown. Clients retry. |
| `ENGINE_RESTARTING` | engine | yes | warning | Clients reconnect automatically. Inspect the preceding `error` event for the crash cause. |
| `ENGINE_UNAVAILABLE` | engine | no | error | The engine is FAILED. Fix the cause in the `fatal` event and restart the application. |
| `ENGINE_FAILED` | engine | no | fatal | The restart limit was exceeded. Inspect the preceding `error` events and logs, fix, and restart. |
| `DOCUMENT_FAULTED` | document | no | error | Inspect the `error` event's `cause`. Other documents keep running. Reopening reloads from the journal. |
| `DOCUMENT_UNSUPPORTED_CONTENT` | document | no | warning | See `unsupported`. Call `documents.allowUnsupportedEdit(documentId)` to allow editing; those parts are removed on save. |
| `DOCUMENT_READ_ONLY` | document | no | warning | The session is view-only or the document is read-only. The change was discarded. |
| `DOCUMENT_NOT_FOUND` | document | no | error | The storage adapter reports no file for the `ref` returned by `authorize`. Check the mapping. |
| `DOCUMENT_TOO_LARGE` | document | no | error | The file exceeds `limits.maxFileBytes`. Raise the limit or reduce the file. |
| `CONVERSION_FAILED` | conversion | no | error | LibreOffice could not convert it. Check that the file is a valid .docx/.odt/.xlsx/.ods and that `soffice --headless --version` works for the server user. |
| `CONVERSION_TIMEOUT` | conversion | yes | error | Raise `libreoffice.timeoutMs`, or add capacity (`maxConcurrent`, `codecThreads`). |
| `SESSION_SLOW_CONSUMER` | session | yes | warning | The client fell behind its send buffer. Raise `send.highWaterMarkBytes` if this happens on healthy networks. |
| `SESSION_CLOSED` | session | no | info | Closed by the server or the adopter. No action is needed unless unexpected. |
| `SESSION_RESYNC_REQUIRED` | session | yes | info | The client reloads automatically. |
| `ACCESS_DENIED` | access | no | error | Your `authorize` or `canSubmit` hook rejected the request. |
| `PROTOCOL_INVALID_MESSAGE` | protocol | no | error | Make sure `@open-docex/client` and `@open-docex/server` are the same release. Otherwise a client sent a malformed frame. |
| `PROTOCOL_VERSION_UNSUPPORTED` | protocol | no | error | Deploy the same release of client and server. |
| `PROTOCOL_OP_REJECTED` | protocol | no | error | The change failed validation and was discarded. If this is frequent, report a bug with the `error` event. |
| `CLIENT_CONNECT_FAILED` | client | yes | error | Check the server is running and that proxies allow WebSocket upgrades on the engine path. |
| `CLIENT_ASSET_TOO_LARGE` | client | no | warning | Use a smaller image. |
| `CLIENT_IMAGE_TYPE_UNSUPPORTED` | client | no | warning | Only PNG, JPEG and GIF are supported (PO-24). |

`CLIENT_ASSET_TOO_LARGE`: the limit in the server's `load-start` message is fixed in V1 and is not an option.

## Not supported in V1

- **No undo or redo.**
- **Text documents only** (`.docx`, `.odt`). Spreadsheets are not part of V1.
- Files with unsupported content open read-only unless you allow editing (see above).
- Memory queue only: one engine process per document, no Redis or Kafka.
- Images in documents are PNG, JPEG and GIF when added by users.

## Licence

MIT. LibreOffice (MPL-2.0) is an external program and is not distributed with this package.
