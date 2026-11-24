import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenDocexError } from '@open-docex/shared/errors';
import { computeAssetId } from '@open-docex/shared/ids';
import type { AssetGetMsg, AssetPutMsg } from '@open-docex/shared/protocol';
import { AssetCache, PUT_TIMEOUT_MS } from '../../src/assets/AssetCache.js';
import { installDomStubs } from './text-fixtures.js';

const id = (c: string): string => c.repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function harness(opts: { connected?: boolean; maxConcurrentGets?: number } = {}) {
  const sent: (AssetGetMsg | AssetPutMsg)[] = [];
  let connected = opts.connected ?? true;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const cache = new AssetCache({
    send: (m) => {
      sent.push(m);
      return connected;
    },
    connected: () => connected,
    ...(opts.maxConcurrentGets !== undefined ? { maxConcurrentGets: opts.maxConcurrentGets } : {}),
    timers: {
      set: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        if (h) (h as { cleared: boolean }).cleared = true;
      },
    },
  });
  return {
    cache,
    sent,
    timers,
    setConnected: (c: boolean) => {
      connected = c;
    },
  };
}

const gets = (sent: unknown[]): AssetGetMsg[] => sent.filter((m): m is AssetGetMsg => (m as AssetGetMsg).type === 'asset-get');
const puts = (sent: unknown[]): AssetPutMsg[] => sent.filter((m): m is AssetPutMsg => (m as AssetPutMsg).type === 'asset-put');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(installDomStubs);

describe('AssetCache.load', () => {
  it('sends one asset-get per id, even with concurrent loads', async () => {
    const { cache, sent } = harness();
    const a = cache.load(id('a'));
    const b = cache.load(id('a'));
    expect(gets(sent)).toHaveLength(1);
    const req = gets(sent)[0] as AssetGetMsg;
    cache.onAsset({ type: 'asset', reqId: req.reqId, assetId: id('a'), mime: 'image/png', size: 3, bytes: PNG });
    const [ua, ub] = await Promise.all([a, b]);
    expect(ua).toMatch(/^blob:/);
    expect(ub).toBe(ua);
    expect(cache.url(id('a'))).toBe(ua);
    await expect(cache.load(id('a'))).resolves.toBe(ua);
    expect(gets(sent)).toHaveLength(1);
  });

  it('keeps at most maxConcurrentGets in flight', () => {
    const { cache, sent } = harness({ maxConcurrentGets: 2 });
    for (const c of 'abcd') void cache.load(id(c));
    expect(gets(sent).map((g) => g.assetId)).toEqual([id('a'), id('b')]);
    const first = gets(sent)[0] as AssetGetMsg;
    cache.onAsset({ type: 'asset', reqId: first.reqId, assetId: id('a'), mime: 'image/png', size: 3, bytes: PNG });
    expect(gets(sent).map((g) => g.assetId)).toEqual([id('a'), id('b'), id('c')]);
  });

  it('defaults to four gets in flight', () => {
    const { cache, sent } = harness();
    for (const c of 'abcdef') void cache.load(id(c));
    expect(gets(sent)).toHaveLength(4);
  });

  it('forces a non-image MIME type to application/octet-stream', async () => {
    const { cache, sent } = harness();
    const blobs: Blob[] = [];
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b as Blob);
      return 'blob:http://localhost/x';
    });
    const p = cache.load(id('a'));
    const req = gets(sent)[0] as AssetGetMsg;
    cache.onAsset({ type: 'asset', reqId: req.reqId, assetId: id('a'), mime: 'text/html' as never, size: 3, bytes: PNG });
    await p;
    expect(blobs[0]?.type).toBe('application/octet-stream');
    spy.mockRestore();
  });

  it('rejects a get on its correlated error and frees the slot', async () => {
    const { cache, sent } = harness({ maxConcurrentGets: 1 });
    const a = cache.load(id('a'));
    void cache.load(id('b'));
    const req = gets(sent)[0] as AssetGetMsg;
    cache.onAssetError({ type: 'error', code: 'DOCUMENT_NOT_FOUND', retryable: false, message: 'x', reqId: req.reqId });
    await expect(a).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    expect(gets(sent).map((g) => g.assetId)).toEqual([id('a'), id('b')]);
  });

  it('ignores an asset for an unknown reqId or the wrong asset ID', async () => {
    const { cache, sent } = harness();
    const a = cache.load(id('a'));
    const req = gets(sent)[0] as AssetGetMsg;
    cache.onAsset({ type: 'asset', reqId: 999, assetId: id('a'), mime: 'image/png', size: 3, bytes: PNG });
    cache.onAsset({ type: 'asset', reqId: req.reqId, assetId: id('b'), mime: 'image/png', size: 3, bytes: PNG });
    expect(cache.url(id('a'))).toBeUndefined();
    cache.onAsset({ type: 'asset', reqId: req.reqId, assetId: id('a'), mime: 'image/png', size: 3, bytes: PNG });
    await expect(a).resolves.toMatch(/^blob:/);
  });
});

describe('AssetCache.put', () => {
  it('resolves only on the server confirmation, and caches the URL at once', async () => {
    const { cache, sent } = harness();
    let done = false;
    const p = cache.put(PNG, 'image/png').then((v) => {
      done = true;
      return v;
    });
    await flush();
    const req = puts(sent)[0] as AssetPutMsg;
    expect(req).toMatchObject({ type: 'asset-put', mime: 'image/png' });
    const expected = await computeAssetId(PNG);
    expect(cache.url(expected)).toMatch(/^blob:/);
    expect(done).toBe(false);
    cache.onAsset({ type: 'asset', reqId: req.reqId, assetId: expected, mime: 'image/png', size: PNG.length });
    await expect(p).resolves.toBe(expected);
  });

  it('rejects types outside PNG, JPEG and GIF with CLIENT_IMAGE_TYPE_UNSUPPORTED', async () => {
    const { cache, sent } = harness();
    for (const mime of ['image/svg+xml', 'image/webp', 'text/html', '']) {
      await expect(cache.put(PNG, mime)).rejects.toMatchObject({ code: 'CLIENT_IMAGE_TYPE_UNSUPPORTED' });
    }
    expect(sent).toHaveLength(0);
  });

  it('rejects bytes over maxAssetBytes with CLIENT_ASSET_TOO_LARGE', async () => {
    const { cache, sent } = harness();
    cache.setMaxAssetBytes(PNG.length - 1);
    await expect(cache.put(PNG, 'image/png')).rejects.toMatchObject({ code: 'CLIENT_ASSET_TOO_LARGE' });
    expect(cache.check('image/gif', PNG.length - 1)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('rejects on a correlated error and revokes the unconfirmed URL', async () => {
    const { cache, sent } = harness();
    const p = cache.put(PNG, 'image/png');
    await flush();
    const req = puts(sent)[0] as AssetPutMsg;
    const assetId = await computeAssetId(PNG);
    cache.onAssetError({ type: 'error', code: 'DOCUMENT_TOO_LARGE', retryable: false, message: 'x', reqId: req.reqId });
    await expect(p).rejects.toSatisfy((e: unknown) => OpenDocexError.is(e, 'DOCUMENT_TOO_LARGE'));
    expect(cache.url(assetId)).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('rejects after the 60 s timeout', async () => {
    const { cache, timers } = harness();
    const p = cache.put(PNG, 'image/png');
    await flush();
    const t = timers.find((x) => x.ms === PUT_TIMEOUT_MS);
    expect(t).toBeDefined();
    t?.fn();
    await expect(p).rejects.toThrow(/not confirmed/);
  });

  it('fails puts in flight on failPuts (1009 close)', async () => {
    const { cache } = harness();
    const p = cache.put(PNG, 'image/png');
    await flush();
    cache.failPuts();
    await expect(p).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });

  it('shares one upload between concurrent puts of the same bytes', async () => {
    const { cache, sent } = harness();
    const a = cache.put(PNG, 'image/png');
    const b = cache.put(PNG, 'image/png');
    await flush();
    expect(puts(sent)).toHaveLength(1);
    const req = puts(sent)[0] as AssetPutMsg;
    const assetId = await computeAssetId(PNG);
    cache.onAsset({ type: 'asset', reqId: req.reqId, assetId, mime: 'image/png', size: PNG.length });
    await expect(Promise.all([a, b])).resolves.toEqual([assetId, assetId]);
  });
});

describe('AssetCache reconnect and destroy', () => {
  it('re-sends outstanding gets and puts once after a reconnect', async () => {
    const h = harness();
    void h.cache.load(id('a')).catch(() => undefined);
    const p = h.cache.put(PNG, 'image/png');
    await flush();
    expect(h.sent).toHaveLength(2);
    h.setConnected(false);
    void h.cache.load(id('b')).catch(() => undefined);
    expect(h.sent).toHaveLength(2);
    h.setConnected(true);
    h.cache.onReconnected();
    const again = h.sent.slice(2);
    expect(again.map((m) => m.type).sort()).toEqual(['asset-get', 'asset-get', 'asset-put']);
    expect(new Set(again.map((m) => m.reqId)).size).toBe(3);
    void p.catch(() => undefined);
    h.cache.destroy();
  });

  it('revokes every URL and rejects outstanding requests on destroy', async () => {
    const { cache, sent } = harness();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    revoke.mockClear();
    const a = cache.load(id('a'));
    const req = gets(sent)[0] as AssetGetMsg;
    cache.onAsset({ type: 'asset', reqId: req.reqId, assetId: id('a'), mime: 'image/png', size: 3, bytes: PNG });
    const url = await a;
    const b = cache.load(id('b'));
    const put = cache.put(PNG, 'image/gif');
    await flush();
    cache.destroy();
    expect(revoke).toHaveBeenCalledWith(url);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(cache.url(id('a'))).toBeUndefined();
    await expect(b).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    await expect(put).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    await expect(cache.load(id('a'))).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });
});
