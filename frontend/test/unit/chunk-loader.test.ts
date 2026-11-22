import { describe, expect, it, vi } from 'vitest';
import { newClientId, newEpoch } from '@open-docex/shared/ids';
import type { Chunk } from '@open-docex/shared/ot';
import type { LoadStartMsg, RemoteMsg } from '@open-docex/shared/protocol';
import { ChunkLoader, LoaderError } from '../../src/load/ChunkLoader.js';
import type { LoadProgress } from '../../src/events.js';

const epoch = newEpoch();
const start = (extra: Partial<LoadStartMsg> = {}): LoadStartMsg => ({
  type: 'load-start',
  epoch,
  rev: 7,
  kind: 'text',
  access: 'edit',
  readOnly: false,
  ...extra,
});
const remote = (fromRev: number): RemoteMsg => ({ type: 'remote', fromRev, ops: [{ n: fromRev }], clientId: newClientId() });

function make() {
  const progress: LoadProgress[] = [];
  const assemble = vi.fn((chunks: Chunk[]) => chunks.map((c) => c.data));
  const loader = new ChunkLoader({ assemble }, (p) => progress.push(p));
  return { loader, assemble, progress };
}

describe('ChunkLoader', () => {
  it('assembles in-order chunks through assemble', () => {
    const { loader, assemble } = make();
    loader.begin(start());
    expect(loader.active).toBe(true);
    loader.onChunk({ type: 'load-chunk', seq: 0, data: { a: 1 } }, 10);
    loader.onChunk({ type: 'load-chunk', seq: 1, data: { b: 2 } }, 20);
    const r = loader.finish({ type: 'load-done', rev: 7 });
    expect(assemble).toHaveBeenCalledWith([
      { seq: 0, data: { a: 1 } },
      { seq: 1, data: { b: 2 } },
    ]);
    expect(r).toEqual({ snapshot: [{ a: 1 }, { b: 2 }], rev: 7, epoch, buffered: [] });
    expect(loader.active).toBe(false);
  });

  it('throws on an out-of-order seq and on a rev mismatch', () => {
    const { loader } = make();
    loader.begin(start());
    expect(() => loader.onChunk({ type: 'load-chunk', seq: 1, data: {} })).toThrow(LoaderError);
    loader.onChunk({ type: 'load-chunk', seq: 0, data: {} });
    expect(() => loader.onChunk({ type: 'load-chunk', seq: 0, data: {} })).toThrow(expect.objectContaining({ reason: 'seq' }) as Error);
    expect(() => loader.finish({ type: 'load-done', rev: 8 })).toThrow(expect.objectContaining({ reason: 'rev' }) as Error);
  });

  it('throws without an active load', () => {
    const { loader } = make();
    expect(() => loader.onChunk({ type: 'load-chunk', seq: 0, data: {} })).toThrow(LoaderError);
    expect(() => loader.bufferRemote(remote(7))).toThrow(LoaderError);
    expect(() => loader.finish({ type: 'load-done', rev: 7 })).toThrow(LoaderError);
  });

  it('returns remotes received during loading in arrival order, without applying them early', () => {
    const { loader, assemble } = make();
    loader.begin(start());
    const r1 = remote(7);
    const r2 = remote(8);
    loader.onChunk({ type: 'load-chunk', seq: 0, data: {} });
    loader.bufferRemote(r2);
    loader.bufferRemote(r1);
    expect(assemble).not.toHaveBeenCalled();
    expect(loader.finish({ type: 'load-done', rev: 7 }).buffered).toEqual([r2, r1]);
  });

  it('releases chunk references after finish', () => {
    const seen: Chunk[][] = [];
    const loader = new ChunkLoader({ assemble: (c: Chunk[]) => (seen.push(c), 'snap') }, () => {});
    loader.begin(start());
    loader.onChunk({ type: 'load-chunk', seq: 0, data: {} });
    loader.finish({ type: 'load-done', rev: 7 });
    loader.begin(start());
    loader.finish({ type: 'load-done', rev: 7 });
    // The second load assembles a fresh, empty array: nothing from the first load is retained.
    expect(seen[1]).toEqual([]);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('a new begin drops the previous load', () => {
    const { loader } = make();
    loader.begin(start());
    loader.onChunk({ type: 'load-chunk', seq: 0, data: { old: true } });
    loader.bufferRemote(remote(7));
    loader.begin(start({ rev: 9 }));
    loader.onChunk({ type: 'load-chunk', seq: 0, data: { fresh: true } });
    expect(loader.finish({ type: 'load-done', rev: 9 })).toMatchObject({ snapshot: [{ fresh: true }], buffered: [] });
  });

  it('reports progress, with and without totalChunks', () => {
    const a = make();
    a.loader.begin(start());
    a.loader.onChunk({ type: 'load-chunk', seq: 0, data: {} }, 100);
    a.loader.onChunk({ type: 'load-chunk', seq: 1, data: {} }, 50);
    expect(a.progress).toEqual([
      { chunksReceived: 0, bytesReceived: 0 },
      { chunksReceived: 1, bytesReceived: 100 },
      { chunksReceived: 2, bytesReceived: 150 },
    ]);
    const b = make();
    b.loader.begin(start({ totalChunks: 2 }));
    b.loader.onChunk({ type: 'load-chunk', seq: 0, data: {} }, 5);
    expect(b.progress.at(-1)).toEqual({ chunksReceived: 1, bytesReceived: 5, totalChunks: 2 });
  });

  it('exposes what load-start said', () => {
    const { loader } = make();
    expect(loader.info).toBeNull();
    loader.begin(start({ access: 'view', readOnly: true, unsupported: [{ feature: 'comments', count: 1 }] }));
    expect(loader.info).toEqual({
      epoch,
      rev: 7,
      kind: 'text',
      access: 'view',
      readOnly: true,
      unsupported: [{ feature: 'comments', count: 1 }],
    });
  });
});
