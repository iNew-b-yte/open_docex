/**
 * Page geometry and the block height read for pagination (LLD Part 3 §10; §0 S-1, S-2).
 *
 * @module
 */
import type { PageSettings } from '@open-docex/shared/text';

const PT_TO_PX = 96 / 72;

/** The gap between two page frames, in CSS px. */
export const GAP_PX = 24;

/**
 * Rounds a length to 1/64 px, the unit Chromium lays out in (§0 S-1, S-2). Unsnapped values
 * are rounded by the browser one spacer at a time, and the error adds up down the page stack.
 */
export function snap64(px: number): number {
  return Math.round(px * 64) / 64;
}

/** Page size, margins and gap in CSS px. All values are snapped to 1/64 px (§0 S-2). */
export interface PageGeometry {
  widthPx: number;
  heightPx: number;
  margin: { top: number; right: number; bottom: number; left: number };
  gapPx: number;
}

/** Converts page settings (pt) to CSS px at 96/in. Landscape swaps width and height. */
export function pageGeometry(p: PageSettings): PageGeometry {
  let w = p.size.width;
  let h = p.size.height;
  if (p.orientation === 'landscape') [w, h] = [h, w];
  const m = p.margins;
  return {
    widthPx: snap64(w * PT_TO_PX),
    heightPx: snap64(h * PT_TO_PX),
    margin: {
      top: snap64(m.top * PT_TO_PX),
      right: snap64(m.right * PT_TO_PX),
      bottom: snap64(m.bottom * PT_TO_PX),
      left: snap64(m.left * PT_TO_PX),
    },
    gapPx: GAP_PX,
  };
}

/** Reads one block's height in CSS px. Tests stub this, as jsdom has no layout. */
export type HeightReader = (el: HTMLElement) => number;

/**
 * The §0 S-1 height read: the computed `height` snapped to 1/64 px, on a `box-sizing:
 * border-box` element. It is never `offsetHeight` (integer rounding adds up to hundreds of px
 * at 500 pages) and never `getBoundingClientRect()` (it drifts far from the viewport).
 */
export const readHeight: HeightReader = (el) => {
  const view = el.ownerDocument.defaultView;
  const h = parseFloat((view ?? window).getComputedStyle(el).height);
  return Number.isFinite(h) ? snap64(h) : 0;
};
