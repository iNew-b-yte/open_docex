/**
 * Hand-written runtime validation combinators (LLD Part 1 §5.3). Internal to the protocol
 * module: no dependencies, no `eval` or `new Function`, so it is CSP-safe.
 *
 * Every check takes an untrusted value and a path such as `$.resume.epoch`, and returns a
 * fresh value or throws {@link ValidationError}. Inputs are never mutated.
 *
 * @module
 * @internal
 */

/** A validation failure at `path`. The decoder turns it into `PROTOCOL_INVALID_MESSAGE`. */
export class ValidationError extends Error {
  override readonly name = 'ValidationError' as const;
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

/** A check: returns the validated value or throws {@link ValidationError}. */
export type Check<T> = (x: unknown, path: string) => T;

/** Keys that are never read from or copied out of untrusted objects. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** True for a plain data object (`{}` or a null-prototype object), as `JSON.parse` makes. */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function own(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** Result type of an object check: required keys plus optional keys that may be absent. */
type ObjOf<R extends Record<string, Check<unknown>>, O extends Record<string, Check<unknown>>> = {
  [K in keyof R]: ReturnType<R[K]>;
} & { [K in keyof O]?: ReturnType<O[K]> };

function int(min: number, max: number): Check<number> {
  return (x, path) => {
    if (typeof x !== 'number' || !Number.isSafeInteger(x)) throw new ValidationError(path, 'expected a safe integer');
    if (x < min || x > max) throw new ValidationError(path, `expected an integer in [${min}, ${max}]`);
    return x;
  };
}

function str(maxLen: number, re?: RegExp): Check<string> {
  return (x, path) => {
    if (typeof x !== 'string') throw new ValidationError(path, 'expected a string');
    if (x.length > maxLen) throw new ValidationError(path, `expected at most ${maxLen} characters`);
    if (re !== undefined && !re.test(x)) throw new ValidationError(path, 'string has the wrong format');
    return x;
  };
}

function bool(): Check<boolean> {
  return (x, path) => {
    if (typeof x !== 'boolean') throw new ValidationError(path, 'expected a boolean');
    return x;
  };
}

function lit<T extends string>(...values: T[]): Check<T> {
  const allowed: ReadonlySet<string> = new Set(values);
  return (x, path) => {
    if (typeof x !== 'string' || !allowed.has(x)) throw new ValidationError(path, 'unexpected value');
    return x as T;
  };
}

function arr<T>(item: Check<T>, o: { min?: number; max: number }): Check<T[]> {
  const min = o.min ?? 0;
  return (x, path) => {
    if (!Array.isArray(x)) throw new ValidationError(path, 'expected an array');
    if (x.length < min || x.length > o.max) {
      throw new ValidationError(path, `expected ${min} to ${o.max} items`);
    }
    const out: T[] = [];
    for (let i = 0; i < x.length; i++) out.push(item(x[i], `${path}[${i}]`));
    return out;
  };
}

/**
 * Requires a plain object and copies only the declared keys into a fresh object, so unknown
 * fields are dropped. `__proto__`, `constructor` and `prototype` are never read or copied, and
 * a schema may not declare them. A missing required field fails. An absent optional field is
 * left absent, never set to `undefined` (`exactOptionalPropertyTypes`).
 */
function obj<R extends Record<string, Check<unknown>>, O extends Record<string, Check<unknown>> = Record<never, never>>(
  req: R,
  opt?: O,
): Check<ObjOf<R, O>> {
  const reqKeys = Object.keys(req);
  const optKeys = opt === undefined ? [] : Object.keys(opt);
  for (const k of [...reqKeys, ...optKeys]) {
    if (FORBIDDEN_KEYS.has(k)) throw new Error(`protocol schema may not declare the key "${k}"`);
  }
  return (x, path) => {
    if (!isPlainObject(x)) throw new ValidationError(path, 'expected an object');
    const out: Record<string, unknown> = {};
    for (const k of reqKeys) {
      if (!own(x, k)) throw new ValidationError(`${path}.${k}`, 'missing required field');
      out[k] = req[k]!(x[k], `${path}.${k}`);
    }
    for (const k of optKeys) {
      if (own(x, k) && x[k] !== undefined) out[k] = opt![k]!(x[k], `${path}.${k}`);
    }
    return out as ObjOf<R, O>;
  };
}

function bytes(maxLen: number): Check<Uint8Array> {
  return (x, path) => {
    if (!(x instanceof Uint8Array)) throw new ValidationError(path, 'expected bytes');
    if (x.byteLength > maxLen) throw new ValidationError(path, `expected at most ${maxLen} bytes`);
    return x;
  };
}

/** Accepts a plain object and returns it as is. Deep validation is the caller's job. */
function plain(): Check<Record<string, unknown>> {
  return (x, path) => {
    if (!isPlainObject(x)) throw new ValidationError(path, 'expected an object');
    return x;
  };
}

/** Accepts `x` when `pred(x)` is true. */
function is<T>(pred: (x: unknown) => x is T, reason: string): Check<T> {
  return (x, path) => {
    if (!pred(x)) throw new ValidationError(path, reason);
    return x;
  };
}

/** The validation combinators (LLD Part 1 §5.3), plus `bool`, `plain` and `is`. */
export const v = { int, str, bool, lit, arr, obj, bytes, plain, is };
