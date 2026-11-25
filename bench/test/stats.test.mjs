// Functional tests of the statistics helpers and the result checker. Run: node --test bench/test/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkResult } from '../lib/check.mjs';
import { quantile, summarize } from '../lib/stats.mjs';

test('quantile is nearest-rank on sorted input', () => {
  const v = Float64Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(quantile(v, 0.5), 50);
  assert.equal(quantile(v, 0.95), 95);
  assert.equal(quantile(v, 0.99), 99);
  assert.equal(quantile(v, 1), 100);
  assert.equal(quantile(v, 0), 1);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  assert.equal(quantile([7], 0.99), 7);
});

test('summarize sorts, rounds and orders p50 <= p95 <= p99 <= max', () => {
  const shuffled = Array.from({ length: 1000 }, (_, i) => ((i * 7919) % 1000) + 0.123456);
  const s = summarize(shuffled);
  assert.equal(s.n, 1000);
  assert.equal(s.p50, 499.12);
  assert.equal(s.p95, 949.12);
  assert.equal(s.p99, 989.12);
  assert.equal(s.max, 999.12);
  assert.ok(s.p50 <= s.p95 && s.p95 <= s.p99 && s.p99 <= s.max);
  assert.deepEqual(summarize([]), { n: 0, p50: null, p95: null, p99: null, max: null, mean: null });
});

test('checkResult accepts a sane result and flags empty, NaN and unordered percentiles', () => {
  assert.deepEqual(checkResult({ a: summarize([1, 2, 3, 4]), rows: [{ x: 1 }] }), []);
  assert.ok(checkResult({}).length > 0);
  assert.ok(checkResult({ s: 'text only' }).length > 0);
  assert.ok(checkResult({ x: Number.NaN }).some((p) => p.includes('finite')));
  assert.ok(checkResult({ ack: { p50: 5, p95: 4, p99: 6, max: 7 } }).some((p) => p.includes('out of order')));
});
