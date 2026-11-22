/**
 * Page settings of a text document (LLD Part 1 §8.1, CL-9).
 *
 * There is one page style per document, held in the `doc` attributes `size`,
 * `orientation` and `margins`. Page settings change through `DocAttrStep`, one attribute
 * at a time, so concurrent changes to different attributes all survive. All lengths are
 * in points.
 */
import { DocAttrStep } from 'prosemirror-transform';
import type { TextSnapshot } from './schema.js';

/** The page style of a text document. Lengths in pt. */
export interface PageSettings {
  size: { width: number; height: number };
  orientation: 'portrait' | 'landscape';
  margins: { top: number; right: number; bottom: number; left: number };
}

/** Reads the page settings from a `doc` node's attributes. */
export function getPageSettings(doc: TextSnapshot): PageSettings {
  const a = doc.attrs;
  return {
    size: a.size as PageSettings['size'],
    orientation: a.orientation as PageSettings['orientation'],
    margins: a.margins as PageSettings['margins'],
  };
}

/** A step that sets one page attribute. Its value is validated when the step applies. */
export function pageSettingStep(key: keyof PageSettings, value: PageSettings[keyof PageSettings]): DocAttrStep {
  return new DocAttrStep(key, value);
}

/**
 * True when the margins leave at least 36 pt of body in each direction:
 * `left + right ≤ width − 36` and `top + bottom ≤ height − 36` (§8.1, `doc` attributes).
 * This check spans two attributes, so the per-attribute validators can't make it.
 */
export function pageSettingsFit(p: PageSettings): boolean {
  return (
    p.margins.left + p.margins.right <= p.size.width - 36 && p.margins.top + p.margins.bottom <= p.size.height - 36
  );
}
