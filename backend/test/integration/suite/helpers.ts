// Small helpers shared by the scenario files.
import type { DocumentId } from '@open-docex/shared/ids';
import type { AckMsg, ServerMessage } from '@open-docex/shared/protocol';
import type { Of, TestClient } from '../test-client.js';
import { appendOp } from './doc-helpers.js';
import type { Rig } from './rig.js';

/** A document ID from a plain string. */
export const id = (s: string): DocumentId => s as DocumentId;

/** Matches the `ack` of `clientSeq`. */
export const ackOf =
  (clientSeq: number) =>
  (m: ServerMessage): m is AckMsg =>
    m.type === 'ack' && m.clientSeq === clientSeq;

/** Matches `notice { notice: 'storage', state }`. */
export const storageNotice =
  (state: 'normal' | 'local' | 'pending') =>
  (m: ServerMessage): m is Of<'notice'> =>
    m.type === 'notice' && m.notice === 'storage' && m.state === state;

/** Matches `notice { notice: 'read-only', readOnly }`. */
export const readOnlyNotice =
  (readOnly: boolean) =>
  (m: ServerMessage): m is Of<'notice'> =>
    m.type === 'notice' && m.notice === 'read-only' && m.readOnly === readOnly;

/** The close code a client sees when the Core goes away: the Gateway's 4001 (worker), or the engine stop's 1001 (main). */
export function crashCloseCode(mode: 'main' | 'worker'): { code: number; reason: string } {
  return mode === 'worker' ? { code: 4001, reason: 'ENGINE_RESTARTING' } : { code: 1001, reason: 'GOING_AWAY' };
}

/** A document with "base" and a session that appended "!" ("base!" locally), then storage changed outside. */
export async function intoConflict(rig: Rig): Promise<{ c: TestClient; epoch: string }> {
  await rig.addFile('doc', 'base');
  const { c, load } = await rig.join('doc', 'alice');
  await rig.outsideEdit('doc', 'edited by someone else'); // after our import: our known version is now stale
  await c.submit([appendOp('base', '!')]);
  await rig.waitRecovery('doc', 'CONFLICT'); // the first flush found the file changed
  await c.waitFor(storageNotice('pending'));
  return { c, epoch: load.start.epoch };
}
