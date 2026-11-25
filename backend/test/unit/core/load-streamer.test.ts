// `load-start.limits.maxAssetBytes` (LLD §0.3 R-3, §0.5 S-45): the Core announces the largest
// image an `asset-put` may carry, on every full load (first load, resync and reload).
import { decodeServerMessage, encodeMessage } from '@open-docex/shared/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ASSET_BYTES } from '../../../src/core/load-streamer.js';
import { makeHarness, type Harness } from './harness.js';

let harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses) await h.dispose();
  harnesses = [];
});

describe('LoadStreamer: limits.maxAssetBytes', () => {
  it('the limit leaves room for the largest binary frame prefix and header inside the 16 MiB edge limit', () => {
    expect(MAX_ASSET_BYTES + 6 + 65_536).toBe(16 * 1024 * 1024);
    expect(Number.isSafeInteger(MAX_ASSET_BYTES)).toBe(true);
  });

  it('every full load starts with load-start carrying limits.maxAssetBytes', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const id = h.file('a.docx', 'hello');
    const first = await h.open(id, 'cA');
    expect(h.sink.of(first.sid, 'load-start')[0]?.limits).toEqual({ maxAssetBytes: MAX_ASSET_BYTES });

    // A second session, and a resync reload on the same session, announce it again.
    const second = await h.open(id, 'cB');
    expect(h.sink.of(second.sid, 'load-start')[0]?.limits).toEqual({ maxAssetBytes: MAX_ASSET_BYTES });
    h.hello(h.join(id), 'cC', { epoch: 'stale-epoch', rev: 0 }); // wrong epoch: resync, then a full load
    await h.idle();
    const reloads = h.sink.events.flatMap((e) => (e.kind === 'send' ? e.frames : [])).map((f) => decodeServerMessage(f.data));
    const starts = reloads.flatMap((r) => (r.kind === 'message' && r.message.type === 'load-start' ? [r.message] : []));
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const s of starts) expect(s.limits).toEqual({ maxAssetBytes: MAX_ASSET_BYTES });
  });

  it('the load-start message with the limit survives the protocol codec', () => {
    const wire = encodeMessage({
      type: 'load-start',
      epoch: 'e'.repeat(22) as never,
      rev: 0,
      kind: 'text',
      access: 'edit',
      readOnly: false,
      limits: { maxAssetBytes: MAX_ASSET_BYTES },
    });
    const decoded = decodeServerMessage(wire);
    expect(decoded.kind === 'message' && decoded.message.type === 'load-start' && decoded.message.limits).toEqual({
      maxAssetBytes: MAX_ASSET_BYTES,
    });
  });
});
