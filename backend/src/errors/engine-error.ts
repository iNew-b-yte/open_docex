/**
 * Server error helpers (LLD Part 2 §19.1). Every server error is built with
 * {@link engineError}, so category, retryable, severity and remediation always come from
 * `ERROR_CATALOGUE[code]`.
 *
 * @module
 */
import { OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';

type CtorOptions = NonNullable<ConstructorParameters<typeof OpenDocexError>[2]>;

/** Optional details for {@link engineError}. */
export interface EngineErrorDetails {
  /** Log and adopter message; defaults to the code's client message. Never sent to a client. */
  message?: string;
  documentId?: string;
  instanceId?: string;
  /** The underlying error, kept for logs and adopters; stripped before reaching a client. */
  cause?: unknown;
}

/** Builds an {@link OpenDocexError} for `code`, with the catalogue fields filled in. */
export function engineError(code: ErrorCode, d?: EngineErrorDetails): OpenDocexError {
  const opts: CtorOptions = {};
  if (d?.documentId !== undefined) opts.documentId = d.documentId;
  if (d?.instanceId !== undefined) opts.instanceId = d.instanceId;
  if (d !== undefined && 'cause' in d) opts.cause = d.cause;
  return new OpenDocexError(code, d?.message, opts);
}
