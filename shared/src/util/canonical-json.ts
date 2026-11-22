/**
 * Canonical JSON (LLD Part 1 §2, Utilities).
 *
 * @module
 */

/**
 * Serializes `v` as JSON with the keys of every object sorted recursively, so two
 * structurally equal values always give the same string. Used for equality checks.
 *
 * Otherwise follows `JSON.stringify` semantics: `toJSON` is honoured, object members whose
 * value is `undefined`, a function or a symbol are omitted, and such values inside arrays
 * become `null`. The input is not mutated. Callers pass JSON-compatible values; for a
 * top-level `undefined`, function or symbol the result is `undefined`, as with `JSON.stringify`.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, sortKeysReplacer);
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  // Null prototype: a key named `__proto__` stays an ordinary member (LLD Part 1 §2 rules).
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(value).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}
