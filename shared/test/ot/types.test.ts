import { describe, expect, it } from 'vitest';
import * as root from '../../src/index.js';
import { DEFAULT_CHUNK_LIMITS } from '../../src/ot/index.js';

describe('ot', () => {
  it('has frozen default chunk limits (HLD §12)', () => {
    expect(DEFAULT_CHUNK_LIMITS).toEqual({ textBlocks: 200, sheetRows: 500, maxBytes: 262_144 });
    expect(Object.isFrozen(DEFAULT_CHUNK_LIMITS)).toBe(true);
  });

  it('is re-exported from the package root, together with text', () => {
    expect(root.DEFAULT_CHUNK_LIMITS).toBe(DEFAULT_CHUNK_LIMITS);
    expect(typeof root.textSchema.nodes.doc).toBe('object');
    expect(typeof root.isAllowedHref).toBe('function');
    expect(typeof root.chunkText).toBe('function');
    expect(typeof root.assembleText).toBe('function');
    expect(typeof root.parseTextOps).toBe('function');
    expect(typeof root.getPageSettings).toBe('function');
    expect(typeof root.pageSettingStep).toBe('function');
  });
});
