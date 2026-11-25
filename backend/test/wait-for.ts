// Load-tolerant polling for the backend unit tests.
import { vi } from 'vitest';

/** How long a condition may take before the test gives up. Far above any healthy run. */
export const WAIT_FOR_TIMEOUT_MS = 20_000;

/**
 * Polls `check` until it stops throwing, or fails with its last error after `timeoutMs`.
 *
 * Vitest's own `vi.waitFor` gives up after 1 s. Tests that wait on real files (journal, snapshots)
 * or on a real LibreOffice failed against that limit on a loaded or slow-disk CI runner (the
 * Windows job of CI run 45551669411), so the backend tests use this wrapper instead. It does not
 * slow a healthy run, because it returns as soon as `check` passes. It must stay below the
 * project's `testTimeout`, so a real failure reports the failed assertion and not a bare timeout.
 */
export function waitFor<T>(check: () => T | Promise<T>, timeoutMs: number = WAIT_FOR_TIMEOUT_MS): Promise<T> {
  return vi.waitFor(check, { timeout: timeoutMs, interval: 10 });
}
