/**
 * The engine logger contract, the no-op default, the level filter and the field allowlist
 * (LLD Part 2 §3, HLD §14, §15).
 *
 * @module
 */

/** Log severity, lowest first. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields attached to a log line. Only keys in {@link LOG_FIELD_ALLOWLIST} survive. */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** The logger an adopter passes as `EngineOptions.logger`. */
export interface Logger {
  debug(m: string, f?: LogFields): void;
  info(m: string, f?: LogFields): void;
  warn(m: string, f?: LogFields): void;
  error(m: string, f?: LogFields): void;
}

/** Every log level, lowest first. */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze(['debug', 'info', 'warn', 'error']);

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** True when a line at `level` passes a filter set to `min`. */
export function levelEnabled(level: LogLevel, min: LogLevel): boolean {
  return RANK[level] >= RANK[min];
}

/**
 * The only `fields` keys that may be logged (LLD Part 2 §3). Request headers, cookies, query
 * strings, tokens, document bytes and op payloads must never be logged (HLD §14). `path` is
 * the configured engine path only.
 */
export const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'documentId',
  'sessionId',
  'userId',
  'epoch',
  'rev',
  'code',
  'pid',
  'durationMs',
  'attempt',
  'state',
  'path',
  'count',
]);

/**
 * Whether an unknown field key throws instead of being dropped. LLD Part 2 §3: dropped in
 * production, thrown in tests. Tests are detected by `NODE_ENV === 'test'`, which Vitest sets.
 */
function strictFields(): boolean {
  return process.env['NODE_ENV'] === 'test';
}

/**
 * Returns `fields` with only allowlisted keys. An unknown key is dropped, or throws when
 * `strict` is true (the default in tests).
 */
export function sanitizeFields(fields: LogFields | undefined, strict: boolean = strictFields()): LogFields | undefined {
  if (fields === undefined) return undefined;
  let out: Record<string, string | number | boolean | null | undefined> | undefined;
  for (const key of Object.keys(fields)) {
    if (LOG_FIELD_ALLOWLIST.has(key)) continue;
    if (strict) throw new Error(`Log field "${key}" is not in the allowlist (LLD Part 2 §3).`);
    out ??= { ...fields };
    delete out[key];
  }
  return out ?? fields;
}

/** A logger that discards every line: the default when the adopter passes none (HLD §15). */
export const noopLogger: Logger = Object.freeze({
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
});

/**
 * Wraps `logger` so that lines below `min` are dropped and `fields` are reduced to the
 * allowlist. Main wraps the adopter's logger with this (LLD Part 2 §3).
 */
export function levelFilter(logger: Logger, min: LogLevel): Logger {
  const at =
    (level: LogLevel) =>
    (m: string, f?: LogFields): void => {
      if (!levelEnabled(level, min)) return;
      const safe = sanitizeFields(f);
      if (safe === undefined) logger[level](m);
      else logger[level](m, safe);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
