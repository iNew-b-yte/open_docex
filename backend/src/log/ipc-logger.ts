/**
 * The Core-side logger (LLD Part 2 §3): drops lines below `logLevel`, then posts a `log`
 * message to main, which passes it on to the adopter's logger.
 *
 * @module
 */
import { levelEnabled, sanitizeFields, type LogFields, type Logger, type LogLevel } from './logger.js';

/** The `log` message the Core posts to main (LLD Part 2 §6.2). */
export interface LogLine {
  type: 'log';
  level: LogLevel;
  msg: string;
  fields?: LogFields;
}

/** A {@link Logger} that forwards lines at or above `logLevel` through `post`. */
export class IpcLogger implements Logger {
  readonly #post: (line: LogLine) => void;
  readonly #min: LogLevel;

  /**
   * @param post sends one line to main (the IPC channel, or the in-process channel in `mode: 'main'`).
   * @param logLevel the lowest level forwarded.
   */
  constructor(post: (line: LogLine) => void, logLevel: LogLevel) {
    this.#post = post;
    this.#min = logLevel;
  }

  debug(m: string, f?: LogFields): void {
    this.#emit('debug', m, f);
  }

  info(m: string, f?: LogFields): void {
    this.#emit('info', m, f);
  }

  warn(m: string, f?: LogFields): void {
    this.#emit('warn', m, f);
  }

  error(m: string, f?: LogFields): void {
    this.#emit('error', m, f);
  }

  #emit(level: LogLevel, msg: string, f: LogFields | undefined): void {
    if (!levelEnabled(level, this.#min)) return;
    const fields = sanitizeFields(f);
    const line: LogLine = { type: 'log', level, msg };
    if (fields !== undefined) line.fields = fields;
    this.#post(line);
  }
}
