// Small statistics helpers shared by the benchmark scripts.

/** The `q` quantile (0..1) of an ascending-sorted array, nearest-rank. */
export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/** `{ n, p50, p95, p99, max, mean }` of a list of numbers (ms), rounded to 0.01. */
export function summarize(values) {
  const v = Float64Array.from(values).sort();
  const r = (x) => (Number.isNaN(x) ? null : Math.round(x * 100) / 100);
  let sum = 0;
  for (const x of v) sum += x;
  return {
    n: v.length,
    p50: r(quantile(v, 0.5)),
    p95: r(quantile(v, 0.95)),
    p99: r(quantile(v, 0.99)),
    max: v.length ? r(v[v.length - 1]) : null,
    mean: v.length ? r(sum / v.length) : null,
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
