/**
 * Error codes and the error catalogue (HLD §11.2, LLD Part 1 §4).
 *
 * @module
 */

/** Every error code open_docex raises (HLD §11.2). `CLIENT_*` codes are raised in the browser only (LLD L-16). */
export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_LIBREOFFICE_NOT_FOUND'
  | 'CONFIG_DATA_DIR_UNWRITABLE'
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_LOCAL_MODE'
  | 'STORAGE_PENDING'
  | 'STORAGE_CONFLICT'
  | 'QUEUE_FULL'
  | 'QUEUE_UNAVAILABLE'
  | 'ENGINE_RESTARTING'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_FAILED'
  | 'DOCUMENT_FAULTED'
  | 'DOCUMENT_UNSUPPORTED_CONTENT'
  | 'DOCUMENT_READ_ONLY'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_TOO_LARGE'
  | 'CONVERSION_FAILED'
  | 'CONVERSION_TIMEOUT'
  | 'SESSION_SLOW_CONSUMER'
  | 'SESSION_CLOSED'
  | 'SESSION_RESYNC_REQUIRED'
  | 'ACCESS_DENIED'
  | 'PROTOCOL_INVALID_MESSAGE'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'PROTOCOL_OP_REJECTED'
  | 'CLIENT_CONNECT_FAILED'
  | 'CLIENT_ASSET_TOO_LARGE'
  | 'CLIENT_IMAGE_TYPE_UNSUPPORTED';

/** The family an error belongs to (HLD §11.1). */
export type ErrorCategory =
  | 'config'
  | 'storage'
  | 'queue'
  | 'engine'
  | 'session'
  | 'access'
  | 'protocol'
  | 'document'
  | 'conversion'
  | 'recovery'
  | 'client';

/** How serious an error is (HLD §11.1). */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

/** The fixed properties of one error code. */
export interface CatalogueEntry {
  category: ErrorCategory;
  retryable: boolean;
  severity: ErrorSeverity;
  /** The only text a client ever sees for this code (HLD §11.1, §14). */
  clientMessage: string;
  /** What the adopter should do about it. */
  remediation: string;
}

/** Client text for codes that are not meant to reach a client (LLD Part 1 §4). */
const SERVER_PROBLEM = 'The editing service hit a server problem.';

function entry(
  category: ErrorCategory,
  retryable: boolean,
  severity: ErrorSeverity,
  clientMessage: string,
  remediation: string,
): Readonly<CatalogueEntry> {
  return Object.freeze({ category, retryable, severity, clientMessage, remediation });
}

/**
 * The full error catalogue (LLD Part 1 §4). The catalogue and every entry are frozen.
 * `OpenDocexError` takes its category, retryability, severity and remediation from here,
 * so they cannot drift from the code.
 */
export const ERROR_CATALOGUE: Readonly<Record<ErrorCode, Readonly<CatalogueEntry>>> = Object.freeze({
  CONFIG_INVALID: entry('config', false, 'fatal', SERVER_PROBLEM,
    'Fix the option named in `message` (see the configuration reference) and restart.'),
  CONFIG_LIBREOFFICE_NOT_FOUND: entry('config', false, 'fatal', SERVER_PROBLEM,
    'Install LibreOffice on the server, or set `libreoffice.path` to the `soffice` executable.'),
  CONFIG_DATA_DIR_UNWRITABLE: entry('config', false, 'fatal', SERVER_PROBLEM,
    'Create `dataDir` and make it writable by the Node.js process user, or point `dataDir` elsewhere.'),
  STORAGE_READ_FAILED: entry('storage', true, 'error', 'The document could not be loaded. Retrying.',
    'Check that the storage adapter can reach its backend and that `ref` exists; see `cause`.'),
  STORAGE_WRITE_FAILED: entry('storage', true, 'warning', SERVER_PROBLEM,
    'The engine kept a local copy and retries after 1, 5 and 15 min. Check storage availability and credentials.'),
  STORAGE_LOCAL_MODE: entry('storage', false, 'warning',
    'Changes are saved on the server and will be copied to storage later.',
    'No action needed while retries run. Watch the `storage` events.'),
  STORAGE_PENDING: entry('recovery', false, 'error', 'Changes are saved on the server; storage sync is pending.',
    'Retries are exhausted. Fix storage, then call the recovery `retry()` for this document, or `resolve()` it.'),
  STORAGE_CONFLICT: entry('recovery', false, 'error', 'Changes are saved on the server; storage sync is pending.',
    'The storage file changed while a newer local copy existed. Compare both and call `resolve()` with your choice. The engine never overwrites it on its own.'),
  QUEUE_FULL: entry('queue', true, 'warning', 'The server is busy. Your change will be retried.',
    'Clients retry automatically. If this is frequent, raise `queue.perDocument`/`queue.global` or reduce load.'),
  QUEUE_UNAVAILABLE: entry('queue', true, 'error', 'The server is busy. Your change will be retried.',
    'Check connectivity and credentials for the configured Redis/Valkey or Kafka [V3].'),
  ENGINE_RESTARTING: entry('engine', true, 'warning', 'Reconnecting…',
    'Clients reconnect automatically. Inspect the preceding `error` event for the crash cause.'),
  ENGINE_UNAVAILABLE: entry('engine', false, 'error', 'The editing service is unavailable.',
    'The engine is FAILED. Fix the cause in the `fatal` event and restart the application.'),
  ENGINE_FAILED: entry('engine', false, 'fatal', SERVER_PROBLEM,
    'The restart limit was exceeded. Inspect the preceding `error` events and logs, fix, and restart.'),
  DOCUMENT_FAULTED: entry('document', false, 'error', 'This document hit an internal error. Reload to continue.',
    "Inspect the `error` event's `cause`. Other documents keep running. Reopening reloads from the journal."),
  DOCUMENT_UNSUPPORTED_CONTENT: entry('document', false, 'warning',
    "Parts of this file can't be edited here, so it opened read-only.",
    'See `unsupported`. Call `documents.allowUnsupportedEdit(documentId)` to allow editing; those parts are removed on save.'),
  DOCUMENT_READ_ONLY: entry('document', false, 'warning', 'This document is read-only.',
    'The session is view-only or the document is read-only. The change was discarded.'),
  DOCUMENT_NOT_FOUND: entry('document', false, 'error', 'The document was not found.',
    'The storage adapter reports no file for the `ref` returned by `authorize`. Check the mapping.'),
  DOCUMENT_TOO_LARGE: entry('document', false, 'error', 'The file is too large.',
    'The file exceeds `limits.maxFileBytes`. Raise the limit or reduce the file.'),
  CONVERSION_FAILED: entry('conversion', false, 'error', 'The file could not be opened.',
    'LibreOffice could not convert it. Check that the file is a valid .docx/.odt/.xlsx/.ods and that `soffice --headless --version` works for the server user.'),
  CONVERSION_TIMEOUT: entry('conversion', true, 'error', 'Opening the file took too long. Retrying.',
    'Raise `libreoffice.timeoutMs`, or add capacity (`maxConcurrent`, `codecThreads`).'),
  SESSION_SLOW_CONSUMER: entry('session', true, 'warning', 'Connection too slow. Reloading.',
    'The client fell behind its send buffer. Raise `send.highWaterMarkBytes` if this happens on healthy networks.'),
  SESSION_CLOSED: entry('session', false, 'info', 'The session was closed.',
    'Closed by the server or the adopter. No action is needed unless unexpected.'),
  SESSION_RESYNC_REQUIRED: entry('session', true, 'info', 'Reloading the latest version…',
    'The client reloads automatically.'),
  ACCESS_DENIED: entry('access', false, 'error', "You don't have access to this document.",
    'Your `authorize` or `canSubmit` hook rejected the request.'),
  PROTOCOL_INVALID_MESSAGE: entry('protocol', false, 'error', 'Client and server are out of sync. Reload the page.',
    'Make sure `@open-docex/client` and `@open-docex/server` are the same release. Otherwise a client sent a malformed frame.'),
  PROTOCOL_VERSION_UNSUPPORTED: entry('protocol', false, 'error', 'Please reload the page to update the editor.',
    'Deploy the same release of client and server.'),
  PROTOCOL_OP_REJECTED: entry('protocol', false, 'error', 'A change could not be applied. Reloading.',
    'The change failed validation and was discarded. If this is frequent, report a bug with the `error` event.'),
  CLIENT_CONNECT_FAILED: entry('client', true, 'error', "Can't connect.",
    'Check the server is running and that proxies allow WebSocket upgrades on the engine path.'),
  CLIENT_ASSET_TOO_LARGE: entry('client', false, 'warning', 'This image is too large.',
    'Use a smaller image.'),
  CLIENT_IMAGE_TYPE_UNSUPPORTED: entry('client', false, 'warning', 'Only PNG, JPEG and GIF images can be added.',
    'Only PNG, JPEG and GIF are supported (PO-24).'),
});

/** True when `x` is one of the catalogue's error codes. Safe for untrusted input. */
export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOGUE, x);
}
