/**
 * WebSocket close codes (LLD Part 1 §5.5, §0 R-16). The close reason is the `ErrorCode`
 * string; when there is one, the server first sends an `error` frame with it, then closes.
 *
 * @module
 */
import type { ErrorCode } from '../errors/index.js';

/** Every close code open_docex uses. */
export const CloseCode = {
  /** Client `destroy()`. */
  NORMAL: 1000,
  /** Engine shutdown; reconnect with backoff and `resume`. */
  GOING_AWAY: 1001,
  /** Worker crash (`ENGINE_RESTARTING`); reconnect with backoff and `resume`. */
  ENGINE_RESTARTING: 4001,
  /** Engine FAILED (`ENGINE_UNAVAILABLE`); no automatic reconnect. */
  ENGINE_UNAVAILABLE: 4002,
  /** The adopter closed the session by user or document (`ACCESS_DENIED`); no reconnect. */
  ACCESS_DENIED: 4003,
  /** `SESSION_SLOW_CONSUMER`; reconnect at once with no `resume` (full reload). */
  SLOW_CONSUMER: 4004,
  /** `SESSION_CLOSED`; no reconnect. */
  SESSION_CLOSED: 4005,
  /** `DOCUMENT_FAULTED`; reload on user action. */
  DOCUMENT_FAULTED: 4006,
  /** `PROTOCOL_VERSION_UNSUPPORTED` or `PROTOCOL_INVALID_MESSAGE`; no reconnect. */
  PROTOCOL_ERROR: 4007,
  /** Load failed; reconnect with backoff only if the code is retryable. */
  LOAD_FAILED: 4008,
} as const;
/** A close code value. */
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

const BY_ERROR: Partial<Record<ErrorCode, CloseCode>> = {
  ENGINE_RESTARTING: CloseCode.ENGINE_RESTARTING,
  ENGINE_UNAVAILABLE: CloseCode.ENGINE_UNAVAILABLE,
  ACCESS_DENIED: CloseCode.ACCESS_DENIED,
  SESSION_SLOW_CONSUMER: CloseCode.SLOW_CONSUMER,
  SESSION_CLOSED: CloseCode.SESSION_CLOSED,
  DOCUMENT_FAULTED: CloseCode.DOCUMENT_FAULTED,
  PROTOCOL_VERSION_UNSUPPORTED: CloseCode.PROTOCOL_ERROR,
  PROTOCOL_INVALID_MESSAGE: CloseCode.PROTOCOL_ERROR,
  DOCUMENT_NOT_FOUND: CloseCode.LOAD_FAILED,
  DOCUMENT_TOO_LARGE: CloseCode.LOAD_FAILED,
  CONVERSION_FAILED: CloseCode.LOAD_FAILED,
  CONVERSION_TIMEOUT: CloseCode.LOAD_FAILED,
  STORAGE_READ_FAILED: CloseCode.LOAD_FAILED,
};

/**
 * Returns the close code for an error that closes the connection, or `undefined` for a code
 * with no close code in LLD Part 1 §5.5. The caller decides whether an error closes: for
 * example `ACCESS_DENIED` from `canSubmit` and asset errors keep the connection open.
 */
export function closeCodeFor(code: ErrorCode): CloseCode | undefined {
  return Object.prototype.hasOwnProperty.call(BY_ERROR, code) ? BY_ERROR[code] : undefined;
}
