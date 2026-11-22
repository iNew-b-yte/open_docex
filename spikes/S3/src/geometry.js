// LLD P3 §10 `pageGeometry`: PageSettings (pt) → CSS px at 96/in; landscape swaps w/h (C-2).
const PT_TO_PX = 96 / 72;
// Chromium lays out in 1/64 px units. Unsnapped values (A4 height = 1122.52 px) are rounded
// per spacer, and the rounding accumulates down the page stack (measured: ~1 px by page 119).
const snap = (px) => Math.round(px * 64) / 64;

export const GAP_PX = 24;

export function pageGeometry(p) {
  let w = p.size.width;
  let h = p.size.height;
  if (p.orientation === 'landscape') [w, h] = [h, w];
  const m = p.margins;
  return {
    widthPx: snap(w * PT_TO_PX),
    heightPx: snap(h * PT_TO_PX),
    margin: {
      top: snap(m.top * PT_TO_PX),
      right: snap(m.right * PT_TO_PX),
      bottom: snap(m.bottom * PT_TO_PX),
      left: snap(m.left * PT_TO_PX),
    },
    gapPx: GAP_PX,
  };
}

// PO-26: A4 portrait, 2.54 cm (= 72 pt) margins.
export const A4 = {
  size: { width: 595.28, height: 841.89 },
  orientation: 'portrait',
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
};
