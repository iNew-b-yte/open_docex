import { describe, expect, it } from 'vitest';
import { formatLength, parseLengthPt } from '../../../src/codec/odf-units.js';

describe('odf-units', () => {
  it('converts every supported unit to pt', () => {
    expect(parseLengthPt('1in')).toBeCloseTo(72);
    expect(parseLengthPt('2.54cm')).toBeCloseTo(72);
    expect(parseLengthPt('25.4mm')).toBeCloseTo(72);
    expect(parseLengthPt('10pt')).toBe(10);
    expect(parseLengthPt('1pc')).toBe(12);
    expect(parseLengthPt('96px')).toBeCloseTo(72);
    expect(parseLengthPt('-.5in')).toBeCloseTo(-36);
  });
  it('rejects other units and malformed values with CONVERSION_FAILED', () => {
    for (const bad of ['10em', '50%', 'abc', '', '1 cm cm', '1e3pt']) {
      expect(() => parseLengthPt(bad), bad).toThrow(expect.objectContaining({ code: 'CONVERSION_FAILED' }));
    }
  });
  it('formats and round trips', () => {
    expect(formatLength(72, 'cm')).toBe('2.54cm');
    expect(parseLengthPt(formatLength(123.4, 'mm'))).toBeCloseTo(123.4, 2);
  });
});
