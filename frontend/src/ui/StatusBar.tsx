import { fill, useSession, useShell } from './useSession.js';

/** Connection, sync, storage and load progress (LLD Part 3 §14). */
export function StatusBar() {
  const { labels } = useShell();
  const { status, progress, pendingCount } = useSession();
  const parts: string[] = [labels.status[status.connection]];
  if (status.load === 'loading') {
    let t = labels.status.loading;
    if (progress?.totalChunks !== undefined) {
      t += ' ' + fill(labels.status.loadingProgress, { done: progress.chunksReceived, total: progress.totalChunks });
    }
    parts.push(t);
  } else if (status.load === 'ready') {
    parts.push(
      status.sync === 'pending'
        ? fill(labels.status.pending, { n: pendingCount ?? 1 })
        : labels.status[status.sync],
    );
  }
  if (status.storage === 'local') parts.push(labels.status.storageLocal);
  if (status.storage === 'pending') parts.push(labels.status.storagePending);
  if (status.storage === 'conflict') parts.push(labels.status.storageConflict);
  return (
    <div className="odx-statusbar" role="status" aria-live="polite">
      {parts.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </div>
  );
}
