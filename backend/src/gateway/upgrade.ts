/**
 * Upgrade helpers (LLD Part 2 §4.2): URL checks, `authorize` result validation and the HTTP
 * reject. The flow that ties them together is `Gateway.#onUpgrade`.
 *
 * @module
 */
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { asDocumentId, type DocumentId } from '@open-docex/shared/ids';
import type { AuthorizeDenial, AuthorizeResult } from '../api/options.js';

/** The longest `?doc=` value the Gateway accepts (LLD choice, §4.2). */
export const MAX_DOCUMENT_ID_LENGTH = 512;

const FORMATS: ReadonlySet<string> = new Set(['docx', 'odt', 'xlsx', 'ods']);

/** What {@link parseUpgrade} found. */
export type ParsedUpgrade =
  | { kind: 'other' }
  | { kind: 'bad-request' }
  | { kind: 'ours'; url: URL; documentId: DocumentId };

/**
 * Reads the upgrade request's URL. A request for another path is `other`: other `upgrade`
 * listeners handle it. A missing, overlong or control-character `doc` is `bad-request`.
 */
export function parseUpgrade(req: IncomingMessage, path: string): ParsedUpgrade {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return { kind: 'other' };
  }
  if (url.pathname !== path) return { kind: 'other' };
  const doc = url.searchParams.get('doc');
  if (doc === null || doc.length === 0 || doc.length > MAX_DOCUMENT_ID_LENGTH || /[\u0000-\u001f]/.test(doc)) {
    return { kind: 'bad-request' };
  }
  try {
    return { kind: 'ours', url, documentId: asDocumentId(doc) };
  } catch {
    return { kind: 'bad-request' };
  }
}

/** True for a well-formed {@link AuthorizeResult}. */
export function isValidAuthorizeResult(x: unknown): x is AuthorizeResult {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r['userId'] !== 'string' || r['userId'].length === 0) return false;
  if (r['access'] !== 'edit' && r['access'] !== 'view') return false;
  const d = r['document'];
  if (typeof d !== 'object' || d === null) return false;
  const doc = d as Record<string, unknown>;
  if (typeof doc['format'] !== 'string' || !FORMATS.has(doc['format'])) return false;
  const ref = doc['ref'];
  if (typeof ref === 'string') return ref.length > 0;
  return typeof ref === 'object' && ref !== null && !Array.isArray(ref);
}

/** A value with an own `deny` key: an {@link AuthorizeDenial}, valid or not. */
export function hasDeny(x: unknown): x is { deny: unknown } {
  return typeof x === 'object' && x !== null && Object.hasOwn(x, 'deny');
}

/** True when `x` is `{ deny: 401 | 403 }`. */
export function isValidDenial(x: { deny: unknown }): x is AuthorizeDenial {
  return x.deny === 401 || x.deny === 403;
}

/**
 * Answers the upgrade with a plain HTTP status and closes the socket (pattern from
 * https://github.com/websockets/ws#client-authentication). The body is empty, so nothing about
 * the engine or the adopter's reasons leaks.
 */
export function rejectSocket(socket: Duplex, status: number, headers: Readonly<Record<string, string | number>> = {}): void {
  if (!socket.destroyed && socket.writable) {
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
  }
  socket.destroy();
}
