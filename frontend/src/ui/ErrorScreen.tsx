import type { ClientError } from '../events.js';
import { errorLabel } from '../labels.js';
import { useShell } from './useSession.js';

/**
 * Shows the error's label and a Reload button, or Retry for "Can't connect" (LLD §0 L-12;
 * Part 3 §14, §16). The text is `labels.errors[code]`, with the sanitized message as fallback.
 */
export function ErrorScreen({ error }: { error: ClientError }) {
  const { labels, session } = useShell();
  const connect = error.code === 'CLIENT_CONNECT_FAILED';
  return (
    <div className="odx-error" role="alert">
      <p>{errorLabel(labels, error.code, error.message)}</p>
      <button type="button" className="odx-btn" onClick={() => session.retry()}>
        {connect ? labels.status.retry : labels.status.reload}
      </button>
    </div>
  );
}
