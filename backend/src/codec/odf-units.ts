/**
 * ODF length units (LLD Part 2 §14.5 "Units"). Part 1 stores `PageSettings` and image sizes in
 * pt, so every ODF length is converted to and from pt here.
 *
 * @module
 */
import { engineError } from '../errors/engine-error.js';

/** The ODF length units the codec accepts. Any other unit is `CONVERSION_FAILED`. */
export type OdfUnit = 'cm' | 'mm' | 'in' | 'pt' | 'pc' | 'px';

/** Points per unit. `px` is the CSS pixel (1/96 in), as ODF and LibreOffice define it. */
const PT_PER_UNIT: Readonly<Record<OdfUnit, number>> = {
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  pt: 1,
  pc: 12,
  px: 0.75,
};

const LENGTH = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(cm|mm|in|pt|pc|px)$/;

/** Parses an ODF length such as `2.54cm` into pt. Throws `CONVERSION_FAILED` on any other form. */
export function parseLengthPt(value: string): number {
  const m = LENGTH.exec(value.trim());
  if (m === null) {
    throw engineError('CONVERSION_FAILED', { message: `Unsupported or invalid length "${value.slice(0, 40)}"` });
  }
  const pt = Number(m[1]) * PT_PER_UNIT[m[2] as OdfUnit];
  if (!Number.isFinite(pt)) throw engineError('CONVERSION_FAILED', { message: 'Length out of range' });
  return pt;
}

/** Formats `pt` as an ODF length in `unit`, rounded to 4 decimals (for example `2.54cm`). */
export function formatLength(pt: number, unit: OdfUnit): string {
  const v = Math.round((pt / PT_PER_UNIT[unit]) * 10_000) / 10_000;
  return `${String(v)}${unit}`;
}
