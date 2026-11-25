# @open-docex/shared

Contracts shared by `@open-docex/server` and `@open-docex/client`: the wire protocol, the error catalogue and `OpenDocexError`, branded ids, and the text document model with its operational-transform (OT) functions.

It runs in Node.js and in browsers and has no Node or DOM dependency.

**Most adopters do not install this package directly.** `@open-docex/server` and `@open-docex/client` depend on it and install it for you. Install it yourself only if you want to import error types or codes in your own code, for example to handle `OpenDocexError` in a route.

## Install

```sh
npm install @open-docex/shared
```

Requires Node.js 22, 24 or 26. The package is ESM only.

## What it exports

Import from a subpath. The root re-exports everything, but a server's main process should use only `/errors`, `/ids` and `/protocol`, so that ProseMirror stays out of it.

| Subpath | Contents |
|---|---|
| `@open-docex/shared/errors` | `ERROR_CATALOGUE`, `OpenDocexError`, `toClientError`, and the types `ErrorCode`, `ErrorCategory`, `ErrorSeverity`, `CatalogueEntry` |
| `@open-docex/shared/ids` | `DocumentId` and other branded ids, `asDocumentId`, `newClientId` |
| `@open-docex/shared/protocol` | WebSocket message types and the encode/decode functions |
| `@open-docex/shared/ot` | Chunking types shared by the document models |
| `@open-docex/shared/text` | The text schema, text operations, rebase, chunking, page settings |

The protocol, the OT functions and the text model are internal contracts between the two packages. They are public so that both packages can share them, but they are not a stable integration surface for adopters. Build against `@open-docex/server` and `@open-docex/client`, not against the wire format.

## Errors

Every failure in open_docex is an `OpenDocexError` with a code from the catalogue below. `category`, `retryable`, `severity` and `remediation` always come from `ERROR_CATALOGUE`, so they cannot differ from the table.

```js
import { ERROR_CATALOGUE, OpenDocexError, toClientError } from '@open-docex/shared/errors';
import { asDocumentId } from '@open-docex/shared/ids';

const documentId = asDocumentId('invoice-2026-001');

const err = new OpenDocexError('STORAGE_READ_FAILED', 'S3 returned 503 for bucket acme-private', { documentId });
console.log(err.code, err.category, err.retryable, err.severity);
// STORAGE_READ_FAILED storage true error

// What a browser may see: the catalogue text only, never `message` or `cause`.
console.log(toClientError(err));
// { code: 'STORAGE_READ_FAILED', retryable: true, message: 'The document could not be loaded. Retrying.' }

console.log(ERROR_CATALOGUE.CONFIG_LIBREOFFICE_NOT_FOUND.remediation);
// Install LibreOffice on the server, or set `libreoffice.path` to the `soffice` executable.
```

`message` on the server side is for your logs and may contain detail. Clients only ever receive the catalogue's client message (HLD section 11.1, 14). Do not send `err.message` or `err.cause` to a browser.

### Error codes

Generated from `ERROR_CATALOGUE`. `CLIENT_*` codes are raised in the browser only.

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

## Not supported in V1

- Text documents only. Spreadsheets arrive in a later version, so `@open-docex/shared/sheet` does not exist yet.
- No undo or redo.
- A file with content the editor cannot represent opens read-only, with the error code `DOCUMENT_UNSUPPORTED_CONTENT`. See the server README.

## Licence

MIT.
