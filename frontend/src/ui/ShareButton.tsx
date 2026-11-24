import { useShell } from './useSession.js';

/** Calls `hooks.onShare(documentId)`. Rendered only when the hook exists (LLD Part 3 §14). */
export function ShareButton() {
  const { hooks, labels, documentId } = useShell();
  const onShare = hooks.onShare;
  if (onShare === undefined) return null;
  return (
    <button type="button" className="odx-btn" onClick={() => onShare(documentId)}>
      {labels.toolbar.share}
    </button>
  );
}
