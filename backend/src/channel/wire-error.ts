/**
 * Converting errors to and from {@link WireError}, the only form in which an error crosses IPC
 * (LLD Part 2 §6.2, §19.1; §0.5 S-22).
 *
 * @module
 */
import { ERROR_CATALOGUE, OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import { engineError } from '../errors/engine-error.js';
import type { WireError } from './messages.js';

/**
 * Where a non-{@link OpenDocexError} was caught, which decides its code (LLD Part 2 §19.1):
 * - `instance`: inside a document instance → `DOCUMENT_FAULTED`
 * - `boot`: during Core boot → `CONFIG_INVALID`
 * - `document`: elsewhere, with a document involved → `DOCUMENT_FAULTED`
 *
 * §19.1's last case (elsewhere, with no document) has no context here: such an error is only
 * logged, so the caller logs it and never calls {@link toWire}.
 */
export type WireContext =
  | { readonly where: 'instance'; readonly documentId?: string; readonly instanceId?: string }
  | { readonly where: 'boot' }
  | { readonly where: 'document'; readonly documentId: string };

/** True for a code in the error catalogue. */
function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && Object.hasOwn(ERROR_CATALOGUE, x);
}

function codeFor(ctx: WireContext): ErrorCode {
  return ctx.where === 'boot' ? 'CONFIG_INVALID' : 'DOCUMENT_FAULTED';
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return 'unknown error';
  }
}

/** The message of a thrown value or of a plain `{ message }` cause. */
function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return safeString(e);
}

/**
 * Converts `e` to a {@link WireError}.
 *
 * An {@link OpenDocexError}, or a plain shape that `OpenDocexError.is` accepts (S-17), keeps its
 * code, message, documentId and instanceId; its cause's message becomes `causeMessage`. Any other
 * value gets the code `ctx` selects, the catalogue's default message, and its own message as
 * `causeMessage`. `ctx` is required, so a caller always states where the error was caught.
 */
export function toWire(e: unknown, ctx: WireContext): WireError {
  if (OpenDocexError.is(e)) {
    const w: WireError = { code: e.code, message: e.message };
    if (typeof e.documentId === 'string') w.documentId = e.documentId;
    if (typeof e.instanceId === 'string') w.instanceId = e.instanceId;
    if (e.cause !== undefined) w.causeMessage = messageOf(e.cause);
    return w;
  }
  const d: { documentId?: string; instanceId?: string } = {};
  if (ctx.where !== 'boot') {
    if (ctx.documentId !== undefined) d.documentId = ctx.documentId;
    if (ctx.where === 'instance' && ctx.instanceId !== undefined) d.instanceId = ctx.instanceId;
  }
  const w: WireError = { code: codeFor(ctx), message: engineError(codeFor(ctx)).message, ...d };
  w.causeMessage = messageOf(e);
  return w;
}

/**
 * Rebuilds the error in main: `engineError(code, { message, documentId, instanceId, cause:
 * causeMessage })`, so category, retryable, severity and remediation come from the catalogue.
 */
export function fromWire(w: WireError): OpenDocexError {
  const d: Parameters<typeof engineError>[1] = { message: w.message };
  if (w.documentId !== undefined) d.documentId = w.documentId;
  if (w.instanceId !== undefined) d.instanceId = w.instanceId;
  if (w.causeMessage !== undefined) d.cause = w.causeMessage;
  return engineError(w.code, d);
}

/** Structural check for a {@link WireError} received over IPC. */
export function isWireError(x: unknown): x is WireError {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const optString = (k: string): boolean => o[k] === undefined || typeof o[k] === 'string';
  return (
    isErrorCode(o['code']) &&
    typeof o['message'] === 'string' &&
    optString('documentId') &&
    optString('instanceId') &&
    optString('causeMessage')
  );
}
