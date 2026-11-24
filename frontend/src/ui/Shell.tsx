/**
 * The React shell (LLD Part 3 §14). Internal: nothing here is exported from the package
 * (PO-12). V1-36 renders it from `mount`.
 *
 * @module
 */
import { useState } from 'react';
import { DialogHost } from './dialogs.js';
import { EditorHost } from './EditorHost.js';
import { ErrorScreen } from './ErrorScreen.js';
import { ReadOnlyBadge } from './ReadOnlyBadge.js';
import { StatusBar } from './StatusBar.js';
import { Toolbar } from './Toolbar.js';
import { UnsupportedBanner } from './UnsupportedBanner.js';
import { ShellContext, useSession, useShell, type ShellEnv } from './useSession.js';

/** A restore notice from the sync client (LLD Part 3 §6.2, S-37). Dismissible. */
function RestoreBanner({ notice }: { notice: 'discarded' | 'partialLoss' | 'lost' }) {
  const { labels } = useShell();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (dismissed === notice) return null;
  return (
    <div className="odx-banner odx-banner-restore" role="alert">
      <p>{labels.restore[notice]}</p>
      <button type="button" className="odx-btn" onClick={() => setDismissed(notice)}>
        {labels.banner.dismiss}
      </button>
    </div>
  );
}

function Layout() {
  const env = useShell();
  const snap = useSession();
  const { labels, hooks, toolbar } = env;
  const terminal = snap.phase === 'terminal' && snap.error !== null;
  const { status } = snap;
  const unsupported = snap.ready?.unsupported ?? [];
  const canEditAnyway =
    hooks.onEditAnyway !== undefined && status.access === 'edit' && status.readOnlyReason === 'unsupported';
  return (
    <div className="odx-shell">
      {toolbar !== false && (
        <Toolbar
          editor={env.getEditor()}
          items={toolbar.text.items}
          fontFamilies={toolbar.text.fontFamilies}
          fontSizes={toolbar.text.fontSizes}
          shellItems={toolbar.shell.items}
        />
      )}
      {status.readOnlyReason !== null && <ReadOnlyBadge reason={status.readOnlyReason} />}
      {snap.restoreNotice != null && <RestoreBanner notice={snap.restoreNotice} />}
      <UnsupportedBanner
        findings={unsupported}
        {...(snap.conversions ? { conversions: snap.conversions } : {})}
        canEditAnyway={canEditAnyway}
      />
      {terminal ? <ErrorScreen error={snap.error} /> : <EditorHost />}
      {status.load === 'loading' && !terminal && (
        <div className="odx-progress" role="progressbar" aria-busy="true" aria-label={labels.status.loading}>
          {labels.status.loading}
        </div>
      )}
      <StatusBar />
      <DialogHost />
    </div>
  );
}

/**
 * Layout: Toolbar (unless `ui.toolbar === false`), read-only badge, UnsupportedBanner,
 * EditorHost (replaced by ErrorScreen in `terminal`), a progress overlay while loading, and
 * StatusBar. The AnnotationsPanel (V5) and UploadButton (V4) are not part of V1.
 */
export function Shell({ env }: { env: ShellEnv }) {
  return (
    <ShellContext value={env}>
      <Layout />
    </ShellContext>
  );
}
