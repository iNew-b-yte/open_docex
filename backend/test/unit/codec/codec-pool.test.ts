import { describe, expect, it } from 'vitest';
import { CodecPool, type CodecJob } from '../../../src/codec/codec-pool.js';
import type { Logger } from '../../../src/log/logger.js';

const entry = new URL('./fixtures/echo-thread.mjs', import.meta.url);
const limits = { soffice: 'x', timeoutMs: 1, maxFlatXmlBytes: 1, maxFileBytes: 1 };
const job = (mode: string): CodecJob => ({ op: 'probe', workDir: mode, profileDir: 'p', limits });
function logger(lines: string[]): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (m) => void lines.push(`warn:${m}`),
    error: (m) => void lines.push(`error:${m}`),
  };
}

describe('CodecPool', () => {
  it('sends each job to the thread with the fewest jobs in flight', async () => {
    const pool = new CodecPool({ size: 2, entry, logger: logger([]) });
    const a = pool.run<{ threadId: number }>(job('slow'));
    const b = pool.run<{ threadId: number }>(job('slow'));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.threadId).not.toBe(rb.threadId);
    await pool.close();
  });
  it('maps a thread error result back to its error code', async () => {
    const pool = new CodecPool({ size: 1, entry, logger: logger([]) });
    await expect(pool.run(job('fail'))).rejects.toMatchObject({ code: 'CONVERSION_TIMEOUT' });
    await pool.close();
  });
  it('forwards thread logs', async () => {
    const lines: string[] = [];
    const pool = new CodecPool({ size: 1, entry, logger: logger(lines) });
    await pool.run(job('log'));
    expect(lines).toContain('warn:hello');
    await pool.close();
  });
  it('a crashed thread rejects its jobs with CONVERSION_FAILED and is replaced', async () => {
    const lines: string[] = [];
    const pool = new CodecPool({ size: 1, entry, logger: logger(lines) });
    await expect(pool.run(job('crash'))).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    await expect(pool.run(job('ok'))).resolves.toMatchObject({ threadId: expect.any(Number) as number });
    expect(lines.some((l) => l.startsWith('error:'))).toBe(true);
    await pool.close();
  });
  it('close rejects further work and pending jobs with ENGINE_UNAVAILABLE', async () => {
    const pool = new CodecPool({ size: 1, entry, logger: logger([]) });
    const pending = pool.run(job('hang'));
    const assertion = expect(pending).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    await pool.close();
    await assertion;
    await expect(pool.run(job('ok'))).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
  it('rejects a bad size', () => {
    expect(() => new CodecPool({ size: 0, entry, logger: logger([]) })).toThrow(RangeError);
  });
});
