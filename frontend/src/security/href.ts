/**
 * Client-side link and image-source rules (LLD Part 3 §15, HLD §14).
 *
 * The href allowlist itself is the shared `isAllowedHref` (LLD §0 R-11). It is re-exported
 * here, not reimplemented, so client and schema can never disagree.
 *
 * @module
 */
import type { AssetMime } from '@open-docex/shared/protocol';
import { isAllowedHref } from '@open-docex/shared/text';

export { isAllowedHref };

/** `rel` for every rendered link (LLD Part 3 §15). */
export const LINK_REL = 'noopener noreferrer nofollow';
/** `target` for every rendered link (LLD Part 3 §15). */
export const LINK_TARGET = '_blank';

/** The part of `window` that {@link openLink} uses, so tests can pass a fake. */
export interface LinkOpener {
  open(url: string, target: string, features: string): unknown;
}

/**
 * Opens `href` in a new tab without an opener or referrer, after re-validating it with
 * `isAllowedHref` (Mod+click in edit mode, LLD Part 3 §15). Returns false, and opens
 * nothing, for a disallowed href.
 */
export function openLink(href: unknown, opener: LinkOpener = window): boolean {
  if (!isAllowedHref(href)) return false;
  opener.open(href, LINK_TARGET, 'noopener,noreferrer');
  return true;
}

/** The image MIME allowlist (PO-24): PNG, JPEG and GIF. */
export const IMAGE_MIME_ALLOWLIST: ReadonlySet<AssetMime> = new Set<AssetMime>(['image/png', 'image/jpeg', 'image/gif']);

/** True when `mime` is in the image allowlist. */
export function isAllowedImageMime(mime: unknown): mime is AssetMime {
  return typeof mime === 'string' && IMAGE_MIME_ALLOWLIST.has(mime as AssetMime);
}

/**
 * The MIME type to give a blob before making an object URL from it: `mime` when it is in the
 * image allowlist, otherwise `application/octet-stream`, which a browser never renders as an
 * image or document (LLD Part 3 §15).
 */
export function forcedBlobMime(mime: unknown): AssetMime | 'application/octet-stream' {
  return isAllowedImageMime(mime) ? mime : 'application/octet-stream';
}

/**
 * True when `src` is a `blob:` URL. Image elements only ever get such a URL, made by the
 * `AssetCache` (LLD Part 3 §15); any other `src` must not be set.
 */
export function isBlobUrl(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  try {
    return new URL(src).protocol === 'blob:';
  } catch {
    return false;
  }
}
