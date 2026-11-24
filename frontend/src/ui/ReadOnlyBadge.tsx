import type { SessionStatus } from '../events.js';
import { useShell } from './useSession.js';

/** The read-only reason as text (LLD Part 3 §14). */
export function ReadOnlyBadge({ reason }: { reason: NonNullable<SessionStatus['readOnlyReason']> }) {
  const { labels } = useShell();
  return <span className="odx-badge">{labels.badge[reason]}</span>;
}
