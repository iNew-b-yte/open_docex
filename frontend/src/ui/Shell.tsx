/**
 * The React shell (LLD Part 3 §14). Internal: nothing here is exported from the package
 * (PO-12). V1-36 renders it from `mount`.
 *
 * @module
 */
import { DialogHost } from './dialogs.js';
import { EditorHost } from './EditorHost.js';
import { ErrorScreen } from './ErrorScreen.js';
import { ReadOnlyBadge } from './ReadOnlyBadge.js';
import { StatusBar } from './StatusBar.js';
import { Toolbar } from './Toolbar.js';
import { UnsupportedBanner } from './UnsupportedBanner.js';
import { ShellContext, useSession, useShell, type ShellEnv } from './useSession.js';

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
