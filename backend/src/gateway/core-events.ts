/**
 * Routes the Core's `log` and `emit` events to the adopter's logger and the engine's event
 * emitter (LLD Part 2 §3, §6.2, §2.7). Errors inside payloads arrive as `WireError`s and are
 * rebuilt as `OpenDocexError`s with `fromWire`, so category, retryable and remediation come
 * from the catalogue.
 *
 * `send` and `close` events belong to the Gateway.
 *
 * @module
 */
import type { OpenDocexError } from '@open-docex/shared/errors';
import type { AuditEvent, DocumentEvent, EngineEventMap, StorageEvent } from '../api/events.js';
import type { TypedEmitter } from '../api/typed-emitter.js';
import type { EngineChannel } from '../channel/engine-channel.js';
import type { CoreEvent } from '../channel/messages.js';
import { fromWire, isWireError } from '../channel/wire-error.js';
import type { Logger } from '../log/logger.js';

/** Where audit events from the Core go. The facade decides between listeners and a buffer. */
export type AuditSink = (e: AuditEvent) => void;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** Replaces a `WireError` in `payload.error` with an `OpenDocexError`; a malformed one is dropped. */
function withRebuiltError<T extends { error?: OpenDocexError }>(payload: unknown): T | undefined {
  if (!isObj(payload)) return undefined;
  const { error, ...rest } = payload;
  if (error === undefined) return rest as T;
  return (isWireError(error) ? { ...rest, error: fromWire(error) } : rest) as T;
}

/**
 * Subscribes to `channel` and forwards `log` and `emit` events. Returns the unsubscribe function.
 *
 * @param audit receives each `audit` payload.
 */
export function routeCoreEvents(
  channel: EngineChannel,
  emitter: TypedEmitter<EngineEventMap>,
  logger: Logger,
  audit: AuditSink,
): () => void {
  return channel.onEvent((ev: CoreEvent) => {
    if (ev.type === 'log') {
      logger[ev.level](ev.msg, ev.fields);
      return;
    }
    if (ev.type !== 'emit') return;
    switch (ev.event) {
      case 'error':
        if (isWireError(ev.payload)) emitter.emit('error', fromWire(ev.payload));
        return;
      case 'audit':
        if (isObj(ev.payload)) audit(ev.payload as unknown as AuditEvent);
        return;
      case 'storage': {
        const p = withRebuiltError<StorageEvent>(ev.payload);
        if (p !== undefined) emitter.emit('storage', p);
        return;
      }
      case 'document': {
        const p = withRebuiltError<DocumentEvent>(ev.payload);
        if (p !== undefined) emitter.emit('document', p);
        return;
      }
    }
  });
}
