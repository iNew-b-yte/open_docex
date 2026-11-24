import type { ConversionNotice, UnsupportedFinding } from '@open-docex/shared/protocol';
import { useState } from 'react';
import { fill, useSession, useShell } from './useSession.js';

/** Props of {@link UnsupportedBanner}. */
export interface UnsupportedBannerProps {
  findings: readonly UnsupportedFinding[];
  /** Images converted on import (PO-22). They are a notice, not a restriction. */
  conversions?: readonly ConversionNotice[];
  /** `hooks.onEditAnyway` exists, `access === 'edit'` and `readOnlyReason === 'unsupported'`. */
  canEditAnyway: boolean;
}

/**
 * Lists unsupported findings and converted images (LLD Part 3 §14, §0 PO-13, PO-22). "Edit
 * anyway" disables itself, awaits `hooks.onEditAnyway(documentId)`, then waits for the server's
 * read-only-off notice (the session's `readOnlyReason` leaving `'unsupported'`). A rejected
 * promise shows an inline error. Afterwards the banner is one warning line.
 */
export function UnsupportedBanner({ findings, conversions = [], canEditAnyway }: UnsupportedBannerProps) {
  const { labels, hooks, documentId } = useShell();
  const { status } = useSession();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (findings.length === 0 && conversions.length === 0) return null;
  const converted = conversions.reduce((n, c) => n + c.count, 0);
  const notice =
    converted > 0 ? <p className="odx-banner-conversions">{fill(labels.banner.imagesConverted, { n: converted })}</p> : null;

  if (findings.length > 0 && status.readOnlyReason !== 'unsupported' && status.access === 'edit') {
    // Editing was enabled: collapse to one warning line.
    return (
      <div className="odx-banner" role="alert">
        <p>{labels.banner.editingAnyway}</p>
        {notice}
      </div>
    );
  }

  const onEditAnyway = hooks.onEditAnyway;
  const click = (): void => {
    if (onEditAnyway === undefined) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        await onEditAnyway(documentId);
      } catch {
        setFailed(true);
        setPending(false);
      }
      // On success the button stays disabled until the notice collapses the banner.
    })();
  };

  return (
    <div className="odx-banner" role="alert">
      {findings.length > 0 && (
        <>
          <p>{labels.banner.unsupported}</p>
          <ul>
            {findings.map((f) => (
              <li key={f.feature}>
                {labels.findings[f.feature]} ({fill(labels.banner.findingCount, { n: f.count })})
              </li>
            ))}
          </ul>
          <p>{labels.banner.removedOnSave}</p>
          {canEditAnyway && (
            <button type="button" className="odx-btn" disabled={pending} onClick={click}>
              {labels.banner.editAnyway}
            </button>
          )}
          {failed && <p className="odx-banner-error">{labels.banner.editAnywayFailed}</p>}
        </>
      )}
      {notice}
    </div>
  );
}
