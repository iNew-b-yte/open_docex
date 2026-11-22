/**
 * Loader for the golden protocol fixtures in `shared/fixtures/protocol/{valid,invalid}/`
 * (LLD Part 1 §5.5 Tests). One file per message type holds an array of cases.
 */
import { writeBinaryFrame } from '../../src/protocol/frames.js';

/** One fixture case. A binary case's `message` is the frame header (the message without `bytes`). */
export interface FixtureCase {
  name: string;
  direction: 'client' | 'server';
  frame: 'text' | 'binary';
  message: Record<string, unknown>;
  /** Binary payload bytes. */
  payload?: number[];
  /** Binary payload of this many zero bytes, for size limits. */
  payloadLength?: number;
  /** The decoded message when it differs from `message` (for example, unknown fields dropped). */
  expected?: Record<string, unknown>;
}

/** Every client message type (LLD Part 1 §5.2). */
export const CLIENT_TYPES = [
  'hello', 'submit', 'asset-put', 'asset-get', 'ping', 'upload-start', 'upload-chunk', 'upload-end',
  'annotation-list', 'annotation-put', 'annotation-delete',
] as const;

/** Every server message type (LLD Part 1 §5.2). */
export const SERVER_TYPES = [
  'load-start', 'load-chunk', 'load-done', 'ack', 'remote', 'error', 'resync', 'notice', 'asset', 'pong',
  'upload-ack', 'upload-done', 'annotation-result', 'annotation-changed',
] as const;

/** Every message type. */
export const ALL_TYPES: readonly string[] = [...CLIENT_TYPES, ...SERVER_TYPES];

/** Loads `fixtures/protocol/<set>/<type>.json`. */
export async function loadFixtures(set: 'valid' | 'invalid', type: string): Promise<FixtureCase[]> {
  const mod = (await import(`../../fixtures/protocol/${set}/${type}.json`)) as { default: FixtureCase[] };
  return mod.default;
}

/** The payload bytes of a binary case. */
export function payloadOf(c: FixtureCase): Uint8Array {
  return c.payloadLength !== undefined ? new Uint8Array(c.payloadLength) : Uint8Array.from(c.payload ?? []);
}

/** The raw frame a fixture case describes. */
export function frameOf(c: FixtureCase): string | Uint8Array {
  if (c.frame === 'text') return JSON.stringify(c.message);
  const frame = writeBinaryFrame(new TextEncoder().encode(JSON.stringify(c.message)), payloadOf(c));
  if (frame === undefined) throw new Error(`fixture ${c.name}: header out of range`);
  return frame;
}

/** The message a valid case decodes to. */
export function expectedOf(c: FixtureCase): Record<string, unknown> {
  const base = c.expected ?? c.message;
  return c.frame === 'binary' ? { ...base, bytes: payloadOf(c) } : base;
}
