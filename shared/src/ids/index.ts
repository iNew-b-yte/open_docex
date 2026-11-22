/**
 * `@open-docex/shared/ids`: typed identifiers and random ID generation, identical in Node.js
 * and browsers (LLD Part 1 §3, §0 R-12).
 *
 * @module
 */
import { OpenDocexError } from '../errors/index.js';
import { base64url, randomBytes } from '../util/index.js';

declare const brand: unique symbol;

/** A nominal ("branded") type: `T` that only a checking function can produce. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
/** An adopter document ID: 1–1,024 UTF-16 code units with no C0 control characters (LLD L-5). */
export type DocumentId = Brand<string, 'DocumentId'>;
/** A client session ID: 22 base64url characters. */
export type ClientId = Brand<string, 'ClientId'>;
/** A document load epoch: 22 base64url characters. */
export type Epoch = Brand<string, 'Epoch'>;

const RANDOM_ID = /^[A-Za-z0-9_-]{22}$/;
const ASSET_ID = /^[0-9a-f]{64}$/;
const C0_CONTROL = /[\u0000-\u001f]/;
const MAX_DOCUMENT_ID_LENGTH = 1024;

/**
 * Returns 16 random bytes as base64url (22 characters). Uses `crypto.getRandomValues`, not
 * `randomUUID`, because `randomUUID` fails on non-secure origins.
 */
export function newRandomId(): string {
  return base64url(randomBytes(16));
}

/** Returns a new random {@link ClientId} (same format as {@link newRandomId}). */
export function newClientId(): ClientId {
  return newRandomId() as ClientId;
}

/** Returns a new random {@link Epoch} (same format as {@link newRandomId}). */
export function newEpoch(): Epoch {
  return newRandomId() as Epoch;
}

/**
 * Checks an adopter document ID: 1–1,024 UTF-16 code units with no C0 control characters.
 * The ID is never used as a file name (HLD §14).
 *
 * @throws {OpenDocexError} `PROTOCOL_INVALID_MESSAGE` when `raw` is not a valid document ID.
 */
export function asDocumentId(raw: string): DocumentId {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_DOCUMENT_ID_LENGTH ||
    C0_CONTROL.test(raw)
  ) {
    throw new OpenDocexError('PROTOCOL_INVALID_MESSAGE', 'Invalid document ID.');
  }
  return raw as DocumentId;
}

/** True when `x` has the {@link ClientId} format (`/^[A-Za-z0-9_-]{22}$/`). */
export function isClientId(x: unknown): x is ClientId {
  return typeof x === 'string' && RANDOM_ID.test(x);
}

/** True when `x` has the {@link Epoch} format (`/^[A-Za-z0-9_-]{22}$/`). */
export function isEpoch(x: unknown): x is Epoch {
  return typeof x === 'string' && RANDOM_ID.test(x);
}

/** True when `x` is an asset ID: the lowercase hex SHA-256 of the asset's bytes (64 characters). */
export function isAssetId(x: unknown): x is string {
  return typeof x === 'string' && ASSET_ID.test(x);
}

/**
 * Returns the asset ID of `bytes`: their SHA-256 as 64 lowercase hex characters, computed with
 * `globalThis.crypto.subtle` (LLD §0 R-12). In browsers `crypto.subtle` exists only in secure
 * contexts (HTTPS or localhost).
 */
export async function computeAssetId(bytes: Uint8Array): Promise<string> {
  // A copy backed by a plain ArrayBuffer satisfies the DOM lib's BufferSource type when the client
  // type-checks shared's source, without a type assertion.
  const data: Uint8Array<ArrayBuffer> = new Uint8Array(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
