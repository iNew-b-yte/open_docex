/**
 * The client error policy (LLD Part 3 §16, §0 L-12, L-16).
 *
 * `policyFor` decides what the session does with an error from the server or from the client
 * itself. It is a pure function: the session (V1-31) carries out the decision, calls
 * `hooks.onError` and emits `error`.
 *
 * @module
 */
import { ERROR_CATALOGUE, type ErrorCode } from '@open-docex/shared/errors';
import type { ClientError } from '../events.js';

/** What the session does about an error (LLD Part 3 §16). */
export type ClientPolicy =
  /** Show a notice or update the status; editing continues. */
  | 'notice'
  /** Keep the change pending and resend it after backoff. */
  | 'retry-submit'
  /** Close and reconnect with backoff, resuming. */
  | 'reconnect'
  /** Reload the document, rescuing unconfirmed changes. */
  | 'reload'
  /** Drop unconfirmed changes, then reload. */
  | 'discard-reload'
  /** Switch the editor to read-only. */
  | 'read-only'
  /** Fail the one asset operation; the document carries on. */
  | 'asset-failed'
  /** Stop and show the error screen with a Reload button. Never reconnects on its own. */
  | 'terminal';

/** The session's phase (LLD Part 3 §3). */
export type SessionPhase =
  | 'init'
  | 'connecting'
  | 'handshake'
  | 'loading'
  | 'live'
  | 'terminal'
  | 'destroyed';

/** The fields of an error the policy reads (LLD Part 3 §16, §0 R-10). */
export interface PolicyInput {
  /** An `ErrorCode`. Typed as `string` because it is untrusted and may be unknown. */
  code: string;
  retryable: boolean;
  /** Present when the error answers one of this client's submissions. */
  clientSeq?: number;
  /** Present when the error answers an asset request (R-10: assets are correlated by `reqId`). */
  reqId?: number;
}

/**
 * L-12: after this many failed connection attempts in a row with no successful open, the
 * client stops retrying on its own and raises `CLIENT_CONNECT_FAILED`.
 */
export const MAX_FAILED_CONNECT_ATTEMPTS = 5;

/**
 * L-12: true once `failedInARow` consecutive attempts have failed without an open. The caller
 * resets its count to 0 when a socket opens.
 */
export function connectAttemptsExhausted(failedInARow: number): boolean {
  return failedInARow >= MAX_FAILED_CONNECT_ATTEMPTS;
}

const hasClientSeq = (e: PolicyInput): boolean => e.clientSeq !== undefined;
const retryableOr = (e: PolicyInput, yes: ClientPolicy, no: ClientPolicy): ClientPolicy => (e.retryable ? yes : no);

type Rule = (e: PolicyInput) => ClientPolicy;

/** One rule per catalogue code. A `Record` over `ErrorCode` makes a missing code a type error. */
const rules: Record<ErrorCode, Rule> = {
  CONFIG_INVALID: () => 'terminal',
  CONFIG_LIBREOFFICE_NOT_FOUND: () => 'terminal',
  CONFIG_DATA_DIR_UNWRITABLE: () => 'terminal',
  STORAGE_READ_FAILED: (e) => retryableOr(e, 'reconnect', 'terminal'),
  STORAGE_WRITE_FAILED: () => 'notice',
  STORAGE_LOCAL_MODE: () => 'notice',
  STORAGE_PENDING: () => 'notice',
  STORAGE_CONFLICT: () => 'notice',
  QUEUE_FULL: () => 'retry-submit',
  QUEUE_UNAVAILABLE: (e) => retryableOr(e, 'retry-submit', 'terminal'),
  // The ≥ 1 s minimum delay comes from the close-code table (LLD Part 3 §4).
  ENGINE_RESTARTING: () => 'reconnect',
  ENGINE_UNAVAILABLE: () => 'terminal',
  ENGINE_FAILED: () => 'terminal',
  DOCUMENT_FAULTED: (e) => retryableOr(e, 'reload', 'terminal'),
  DOCUMENT_UNSUPPORTED_CONTENT: () => 'read-only',
  // "read-only (server) + discard-reload if pending": an error that answers a submission means
  // changes were pending (LLD Part 3 §6, "on submit"). The session also sets read-only.
  DOCUMENT_READ_ONLY: (e) => (hasClientSeq(e) ? 'discard-reload' : 'read-only'),
  DOCUMENT_NOT_FOUND: () => 'terminal',
  DOCUMENT_TOO_LARGE: (e) => (e.reqId !== undefined ? 'asset-failed' : 'terminal'),
  CONVERSION_FAILED: () => 'terminal',
  CONVERSION_TIMEOUT: (e) => retryableOr(e, 'reconnect', 'terminal'),
  SESSION_SLOW_CONSUMER: () => 'reload',
  SESSION_CLOSED: () => 'terminal',
  SESSION_RESYNC_REQUIRED: () => 'reload',
  ACCESS_DENIED: (e) => (hasClientSeq(e) ? 'discard-reload' : 'terminal'),
  // Two in a row → terminal is tracked by the session (LLD Part 3 §3).
  PROTOCOL_INVALID_MESSAGE: (e) => (hasClientSeq(e) ? 'discard-reload' : 'reload'),
  PROTOCOL_VERSION_UNSUPPORTED: () => 'terminal',
  PROTOCOL_OP_REJECTED: () => 'discard-reload',
  // L-12: "Can't connect" with a Retry button; the session stops retrying on its own.
  CLIENT_CONNECT_FAILED: () => 'terminal',
  // L-16: client-side checks on one image; the document carries on.
  CLIENT_ASSET_TOO_LARGE: () => 'asset-failed',
  CLIENT_IMAGE_TYPE_UNSUPPORTED: () => 'asset-failed',
};
const RULES: Readonly<Record<ErrorCode, Rule>> = Object.freeze(rules);

/** True when `code` is one of the catalogue's codes. Safe for untrusted input. */
export function isKnownErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOGUE, code);
}

/**
 * The policy for an error (LLD Part 3 §16). An unknown code follows the unknown-code rule:
 * `retryable` → `reconnect`, otherwise `terminal`.
 *
 * `phase` is part of the LLD signature. No §16 rule depends on it yet, so it is accepted and
 * not read.
 */
export function policyFor(e: PolicyInput, phase: SessionPhase): ClientPolicy {
  void phase;
  if (!isKnownErrorCode(e.code)) return e.retryable === true ? 'reconnect' : 'terminal';
  return RULES[e.code](e);
}

/**
 * Builds the adopter-facing {@link ClientError}. The message is always the catalogue's client
 * message for a known code, so no server text, token or URL reaches the adopter
 * (LLD Part 3 §15). An unknown code is reported as `PROTOCOL_INVALID_MESSAGE`.
 */
export function toClientErrorEvent(e: PolicyInput, policy: ClientPolicy): ClientError {
  const code: ErrorCode = isKnownErrorCode(e.code) ? e.code : 'PROTOCOL_INVALID_MESSAGE';
  return {
    code,
    retryable: e.retryable === true,
    message: ERROR_CATALOGUE[code].clientMessage,
    terminal: policy === 'terminal',
  };
}
