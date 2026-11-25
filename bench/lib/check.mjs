// Sanity check of a stage's result: non-empty, finite numbers, and every `{p50,p95,p99,max}`
// object in order (p50 <= p95 <= p99 <= max). Returns a list of problems (empty = sane).

export function checkResult(data) {
  const problems = [];
  let leaves = 0;
  const walk = (v, where) => {
    if (typeof v === 'number') {
      leaves++;
      if (!Number.isFinite(v)) problems.push(`${where}: not a finite number`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v === null || typeof v !== 'object') return;
    const { p50, p95, p99, max } = v;
    if ([p50, p95, p99, max].every((x) => typeof x === 'number')) {
      if (!(p50 <= p95 && p95 <= p99 && p99 <= max)) problems.push(`${where}: percentiles out of order ${p50}/${p95}/${p99}/${max}`);
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  walk(data, '$');
  if (data === null || typeof data !== 'object' || Object.keys(data).length === 0) problems.push('$: empty result');
  else if (leaves === 0) problems.push('$: no numbers in the result');
  return problems;
}
