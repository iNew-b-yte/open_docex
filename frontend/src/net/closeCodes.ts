/**
 * Close-event classification (LLD Part 3 §4, §16; §0 L-12, R-16; contract C-8).
 *
 * `classifyClose` turns a server-side close into a {@link CloseDecision} for `Connection`, plus
 * the error to surface when the session stops. It is pure. Closes the client starts itself
 * (reload, dead link, `destroy()`) never reach it.
 *
 * @module
 */
import { ERROR_CATALOGUE, type ErrorCode } from '@open-docex/shared/errors';
import { CloseCode, type ErrorMsg } from '@open-docex/shared/protocol';
import { policyFor, type PolicyInput, type SessionPhase } from '../errors/policy.js';

/** What `Connection` reports about a close it did not start (LLD Part 3 §4). Never holds the URL. */
export interface CloseInfo {
  code: number;
  reason: string;
  /** True when this socket reached `open`. */
  everOpened: boolean;
  /** The `ErrorMsg` received just before the close, if any. Its code wins (C-8). */
  lastError?: ErrorMsg;
}

/** What `Connection` does after a close (LLD Part 3 §4). */
export type CloseDecision =
  | { action: 'reconnect'; minDelayMs?: number }
  | { action: 'terminal' }
  | { action: 'reload' };

/** A {@link CloseDecision} with what the session needs to carry it out. */
export interface CloseClassification {
  decision: CloseDecision;
  /** For `terminal` and `reload`: the error behind it. Absent for a plain reconnect. */
  error?: PolicyInput;
  /** `reload` that drops unconfirmed changes (`discard-reload` policy). */
  discard?: boolean;
  /** 1009: fail the asset upload that was in flight with `DOCUMENT_TOO_LARGE`. */
  failAsset?: boolean;
}

/** Try again later (RFC 6455 registry). */
const TRY_AGAIN_LATER = 1013;
/** Message too big. */
const MESSAGE_TOO_BIG = 1009;
/** Policy violation. */
const POLICY_VIOLATION = 1008;
/** The minimum delays of the close-code table, in ms. */
const MIN_DELAY_TRY_AGAIN_LATER = 5000;
const MIN_DELAY_ENGINE_RESTARTING = 1000;

/** The policy fields of an `ErrorMsg`. Its `message` (server text) is never read. */
export function toPolicyInput(e: ErrorMsg): PolicyInput {
  const input: PolicyInput = { code: e.code, retryable: e.retryable };
  if (e.clientSeq !== undefined) input.clientSeq = e.clientSeq;
  if (e.reqId !== undefined) input.reqId = e.reqId;
  return input;
}

const fromCatalogue = (code: ErrorCode): PolicyInput => ({ code, retryable: ERROR_CATALOGUE[code].retryable });

/** The minimum reconnect delay a close code asks for, if any. */
function minDelayFor(code: number): number | undefined {
  if (code === TRY_AGAIN_LATER) return MIN_DELAY_TRY_AGAIN_LATER;
  if (code === CloseCode.ENGINE_RESTARTING) return MIN_DELAY_ENGINE_RESTARTING;
  return undefined;
}

function reconnect(code: number): CloseClassification {
  const minDelayMs = minDelayFor(code);
  return { decision: minDelayMs === undefined ? { action: 'reconnect' } : { action: 'reconnect', minDelayMs } };
}

/**
 * The close-code table without `lastError` (LLD Part 3 §4).
 *
 * Codes the table does not list (for example 1002, 1003 or 1007) are
 * treated like app codes: reconnect, the conservative choice.
 */
function byCloseCode(code: number): CloseClassification {
  if (code === CloseCode.NORMAL) return { decision: { action: 'terminal' }, error: fromCatalogue('SESSION_CLOSED') };
  if (code === POLICY_VIOLATION) return { decision: { action: 'terminal' }, error: fromCatalogue('ACCESS_DENIED') };
  if (code === MESSAGE_TOO_BIG) return { ...reconnect(code), failAsset: true };
  return reconnect(code);
}

/**
 * Classifies a close the client did not start (LLD Part 3 §4).
 *
 * With `lastError`, its policy (§16) decides: `reconnect`, `reload`, `discard-reload` or
 * `terminal`. A `lastError` whose policy does not end the connection (a notice, an asset
 * failure, a submit retry) gives way to the close-code table.
 *
 * L-12 (attempts that never open) is counted by the session, not here.
 */
export function classifyClose(info: CloseInfo, phase: SessionPhase): CloseClassification {
  const e = info.lastError;
  if (e !== undefined) {
    const input = toPolicyInput(e);
    switch (policyFor(input, phase)) {
      case 'reconnect':
        return reconnect(info.code === CloseCode.ENGINE_RESTARTING || e.code === 'ENGINE_RESTARTING'
          ? CloseCode.ENGINE_RESTARTING
          : info.code);
      case 'reload':
        return { decision: { action: 'reload' }, error: input };
      case 'discard-reload':
        return { decision: { action: 'reload' }, error: input, discard: true };
      case 'terminal':
        return { decision: { action: 'terminal' }, error: input };
      default:
        break;
    }
  }
  return byCloseCode(info.code);
}
