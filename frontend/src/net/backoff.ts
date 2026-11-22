/**
 * Reconnect backoff with full jitter (LLD Part 3 §4, LLD choice).
 *
 * @module
 */

/** A source of uniform numbers in [0, 1), like `Math.random`. Injected in tests. */
export type RandomSource = () => number;

/**
 * Full jitter: a uniform delay in [0, min(maxMs, baseMs · 2^attempt)).
 *
 * `attempt` counts the failed attempts so far, from 0. A huge `attempt` is safe: the cap wins.
 */
export function fullJitter(baseMs: number, maxMs: number, attempt: number, random: RandomSource = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return random() * cap;
}

/** The reconnect settings of `connect.reconnect` (LLD Part 3 §2.1). */
export interface BackoffSettings {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * The delay before reconnect attempt `attempt` (LLD Part 3 §4):
 * `max(minDelayMs ?? 0, random(0, min(maxDelayMs, baseDelayMs · 2^attempt)))`.
 */
export function backoffDelay(
  attempt: number,
  settings: BackoffSettings,
  minDelayMs: number | undefined,
  random: RandomSource = Math.random,
): number {
  return Math.max(minDelayMs ?? 0, fullJitter(settings.baseDelayMs, settings.maxDelayMs, attempt, random));
}
