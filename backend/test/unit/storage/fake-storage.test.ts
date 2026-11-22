import { describe, expect, it } from 'vitest';
import { FakeStorage } from '../../../test-kit/storage/fake-storage.js';
import { runStorageConformance } from '../../../test-kit/storage/storage-conformance.js';

const signal = (): AbortSignal => new AbortController().signal;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

runStorageConformance({ name: 'FakeStorage', setup: () => ({ adapter: new FakeStorage(), missingRef: 'missing' }) });

describe('FakeStorage', () => {
  it('throws scripted failures in order, per op', async () => {
    const s = new FakeStorage();
    const boom = new Error('boom');
    s.failNext('write', { error: boom });
    s.failNext('any', { times: 2 });
    await expect(s.write('a', bytes('x'), { expectedVersion: null, signal: signal() })).rejects.toBe(boom);
    await expect(s.stat('a', { signal: signal() })).rejects.toThrow('FakeStorage failure');
    await expect(s.read('a', { signal: signal(), maxBytes: 9 })).rejects.toThrow('FakeStorage failure');
    expect(await s.stat('a', { signal: signal() })).toBeNull();
    expect(s.calls.map((c) => c.op)).toEqual(['write', 'stat', 'read', 'stat']);
  });

  it('simulates an outside edit with setFile', async () => {
    const s = new FakeStorage();
    const made = await s.create({ kind: 'text', format: 'docx', name: 'A', bytes: bytes('1') }, { signal: signal() });
    s.setFile(made.ref, bytes('outside'), 'external-1');
    const res = await s.write(made.ref, bytes('2'), { expectedVersion: made.version, signal: signal() });
    expect(res).toEqual({ ok: false, reason: 'conflict', currentVersion: 'external-1' });
    expect(new TextDecoder().decode(s.getFile(made.ref)!.bytes)).toBe('outside');
  });

  it('applies latency through the injected sleep', async () => {
    const delays: number[] = [];
    const s = new FakeStorage({
      latencyMs: 25,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    await s.stat('a', { signal: signal() });
    expect(delays).toEqual([25]);
  });

  it('rejects when aborted during the real-timer latency', async () => {
    const s = new FakeStorage({ latencyMs: 10_000 });
    const c = new AbortController();
    const p = s.stat('a', { signal: c.signal });
    c.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
  });
});
