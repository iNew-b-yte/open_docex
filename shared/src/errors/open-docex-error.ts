/**
 * The open_docex error class and the sanitized client form (HLD §11.1, LLD Part 1 §4).
 *
 * @module
 */
import {
  ERROR_CATALOGUE,
  isErrorCode,
  type ErrorCategory,
  type ErrorCode,
  type ErrorSeverity,
} from './catalogue.js';

/** The error shape of HLD §11.1. It is plain data, so it survives IPC and structured clone. */
export interface OpenDocexErrorShape {
  code: ErrorCode;
  category: ErrorCategory;
  retryable: boolean;
  severity: ErrorSeverity;
  documentId?: string;
  instanceId?: string;
  message: string;
  remediation: string;
  cause?: unknown;
}

/** Options for {@link OpenDocexError}. */
export interface OpenDocexErrorOptions {
  documentId?: string;
  instanceId?: string;
  cause?: unknown;
}

/**
 * Every failure in open_docex is an `OpenDocexError` carrying a code from HLD §11.2.
 *
 * `category`, `retryable`, `severity` and `remediation` always come from
 * `ERROR_CATALOGUE[code]`. `message` defaults to the code's client message; it is for logs
 * and adopters and is never sent to a client (use {@link toClientError}).
 */
export class OpenDocexError extends Error implements OpenDocexErrorShape {
  override readonly name = 'OpenDocexError' as const;
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly severity: ErrorSeverity;
  readonly remediation: string;
  readonly documentId?: string;
  readonly instanceId?: string;

  constructor(code: ErrorCode, message?: string, opts?: OpenDocexErrorOptions) {
    const entry = ERROR_CATALOGUE[code];
    super(message ?? entry.clientMessage, opts && 'cause' in opts ? { cause: opts.cause } : undefined);
    this.code = code;
    this.category = entry.category;
    this.retryable = entry.retryable;
    this.severity = entry.severity;
    this.remediation = entry.remediation;
    if (opts?.documentId !== undefined) this.documentId = opts.documentId;
    if (opts?.instanceId !== undefined) this.instanceId = opts.instanceId;
  }

  /**
   * Returns the plain HLD §11.1 shape. `cause` becomes a plain `{ name, message }` object so
   * the shape is IPC-safe: IPC keeps only `name`, `message` and `stack` of an `Error` (CL-1).
   */
  toShape(): OpenDocexErrorShape {
    const shape: OpenDocexErrorShape = {
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      severity: this.severity,
      message: this.message,
      remediation: this.remediation,
    };
    if (this.documentId !== undefined) shape.documentId = this.documentId;
    if (this.instanceId !== undefined) shape.instanceId = this.instanceId;
    if (this.cause !== undefined) shape.cause = plainCause(this.cause);
    return shape;
  }

  /**
   * Rebuilds an error from a shape made by {@link OpenDocexError.toShape}. The catalogue
   * fields are taken from the code again, not from the shape.
   */
  static fromShape(s: OpenDocexErrorShape): OpenDocexError {
    const opts: OpenDocexErrorOptions = {};
    if (s.documentId !== undefined) opts.documentId = s.documentId;
    if (s.instanceId !== undefined) opts.instanceId = s.instanceId;
    if (s.cause !== undefined) opts.cause = s.cause;
    return new OpenDocexError(s.code, s.message, opts);
  }

  /**
   * Structural check, safe across realms and IPC: true for an `OpenDocexError` and for any
   * object with a known `code` and the shape's `category`, `retryable`, `severity`, `message`
   * and `remediation` fields (for example a structured clone of {@link toShape}'s result).
   * With `code`, also requires that code.
   */
  static is(x: unknown, code?: ErrorCode): x is OpenDocexError {
    if (typeof x !== 'object' || x === null) return false;
    const o = x as Record<string, unknown>;
    if (!isErrorCode(o['code'])) return false;
    if (code !== undefined && o['code'] !== code) return false;
    if (x instanceof OpenDocexError) return true;
    return (
      typeof o['category'] === 'string' &&
      typeof o['retryable'] === 'boolean' &&
      typeof o['severity'] === 'string' &&
      typeof o['message'] === 'string' &&
      typeof o['remediation'] === 'string'
    );
  }
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return '';
  }
}

function plainCause(cause: unknown): { name: string; message: string } {
  if (typeof cause === 'object' && cause !== null) {
    const c = cause as { name?: unknown; message?: unknown };
    return {
      name: typeof c.name === 'string' ? c.name : 'Error',
      message: typeof c.message === 'string' ? c.message : safeString(cause),
    };
  }
  return { name: 'Error', message: safeString(cause) };
}

/** The sanitized error a client receives (HLD §11.1, §14). */
export interface ClientErrorPayload {
  code: ErrorCode;
  retryable: boolean;
  message: string;
  clientSeq?: number;
  reqId?: number;
}

/** Context for {@link toClientError}. */
export interface ClientErrorContext {
  clientSeq?: number;
  reqId?: number;
  /** Code used when `err` is not an `OpenDocexError`. Defaults to `DOCUMENT_FAULTED`. */
  fallback?: ErrorCode;
}

/**
 * Turns any thrown value into the payload sent to a client. The code is `err.code` for an
 * `OpenDocexError`, otherwise `ctx.fallback ?? 'DOCUMENT_FAULTED'`. The message is always the
 * catalogue's client message: no `message`, `cause`, stack, path or storage detail is copied.
 */
export function toClientError(err: unknown, ctx?: ClientErrorContext): ClientErrorPayload {
  const code: ErrorCode = OpenDocexError.is(err) ? err.code : (ctx?.fallback ?? 'DOCUMENT_FAULTED');
  const entry = ERROR_CATALOGUE[code];
  const payload: ClientErrorPayload = { code, retryable: entry.retryable, message: entry.clientMessage };
  if (ctx?.clientSeq !== undefined) payload.clientSeq = ctx.clientSeq;
  if (ctx?.reqId !== undefined) payload.reqId = ctx.reqId;
  return payload;
}
