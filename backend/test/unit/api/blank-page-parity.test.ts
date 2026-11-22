/**
 * `resolveWorkerConfig` checks `blankDocument.page` with a copy of the shared `doc` attribute
 * bounds, because `api/` may only type-import `@open-docex/shared/text`. This test compares
 * that copy with shared's real checks, so any drift fails here.
 *
 * Shared's checks:
 * - per attribute: `textSchema`'s `doc` attribute validators (run by `create` and `check()`);
 * - fit: `pageSettingsFit`, which is not exported publicly, so it is reached through the
 *   public `assembleText`, which calls it after building the document.
 */
import { describe, expect, it } from 'vitest';
import { assembleText, textSchema, type PageSettings, type TextChunkData } from '@open-docex/shared/text';
import type { Chunk } from '@open-docex/shared/ot';
import { resolveWorkerConfig } from '../../../src/api/validate-options.js';

/** True when shared accepts `page` as the page style of a document. */
function sharedAccepts(page: PageSettings): boolean {
  try {
    const body = textSchema.node('body', null, [textSchema.node('paragraph')]);
    textSchema.node('doc', { size: page.size, orientation: page.orientation, margins: page.margins }, [body]).check();
  } catch {
    return false;
  }
  const chunks: Chunk<TextChunkData>[] = [
    {
      seq: 0,
      data: {
        kind: 'text',
        part: 'doc',
        page,
        textDefaults: { fontFamily: null, fontSize: null, color: null },
        header: false,
        footer: false,
      },
    },
    { seq: 1, data: { kind: 'text', part: 'blocks', region: 'body', blocks: [{ type: 'paragraph' }] } },
  ];
  try {
    assembleText(chunks);
    return true;
  } catch {
    return false;
  }
}

/** True when `resolveWorkerConfig` accepts `page` as `blankDocument.page`. */
function copyAccepts(page: PageSettings): boolean {
  try {
    resolveWorkerConfig({ blankDocument: { page } }, process.cwd());
    return true;
  } catch {
    return false;
  }
}

const SIZE = { width: 612, height: 792 };
const MARGINS = { top: 72, right: 72, bottom: 72, left: 72 };

function page(over: { size?: Partial<PageSettings['size']>; margins?: Partial<PageSettings['margins']>; orientation?: string }): PageSettings {
  return {
    size: { ...SIZE, ...over.size },
    orientation: (over.orientation ?? 'portrait') as PageSettings['orientation'],
    margins: { ...MARGINS, ...over.margins },
  };
}

const E = 0.001;

const cases: [string, PageSettings, boolean][] = [
  ['letter portrait', page({}), true],
  ['landscape', page({ orientation: 'landscape' }), true],
  ['orientation unknown', page({ orientation: 'square' }), false],
  // Size range 36–4000 pt (margins 0 so the fit rule does not interfere at the low end).
  ['width at min', page({ size: { width: 36 }, margins: { left: 0, right: 0 } }), true],
  ['width just below min', page({ size: { width: 36 - E }, margins: { left: 0, right: 0 } }), false],
  ['height at min', page({ size: { height: 36 }, margins: { top: 0, bottom: 0 } }), true],
  ['height just below min', page({ size: { height: 36 - E }, margins: { top: 0, bottom: 0 } }), false],
  ['width at max', page({ size: { width: 4000 } }), true],
  ['width just above max', page({ size: { width: 4000 + E } }), false],
  ['height at max', page({ size: { height: 4000 } }), true],
  ['height just above max', page({ size: { height: 4000 + E } }), false],
  ['width NaN', page({ size: { width: Number.NaN } }), false],
  ['height Infinity', page({ size: { height: Number.POSITIVE_INFINITY } }), false],
  // Margin range 0–1000 pt, on a page big enough for the fit rule to pass.
  ['margin at 0', page({ margins: { top: 0, right: 0, bottom: 0, left: 0 } }), true],
  ['top just below 0', page({ margins: { top: -E } }), false],
  ['right just below 0', page({ margins: { right: -E } }), false],
  ['bottom just below 0', page({ margins: { bottom: -E } }), false],
  ['left just below 0', page({ margins: { left: -E } }), false],
  ['top at max', page({ size: { width: 4000, height: 4000 }, margins: { top: 1000 } }), true],
  ['top just above max', page({ size: { width: 4000, height: 4000 }, margins: { top: 1000 + E } }), false],
  ['right at max', page({ size: { width: 4000, height: 4000 }, margins: { right: 1000 } }), true],
  ['right just above max', page({ size: { width: 4000, height: 4000 }, margins: { right: 1000 + E } }), false],
  ['bottom just above max', page({ size: { width: 4000, height: 4000 }, margins: { bottom: 1000 + E } }), false],
  ['left just above max', page({ size: { width: 4000, height: 4000 }, margins: { left: 1000 + E } }), false],
  // Fit: left + right ≤ width − 36, top + bottom ≤ height − 36.
  ['horizontal margins fit exactly', page({ margins: { left: 288, right: 288 } }), true],
  ['horizontal margins just too wide', page({ margins: { left: 288, right: 288 + E } }), false],
  ['vertical margins fit exactly', page({ margins: { top: 378, bottom: 378 } }), true],
  ['vertical margins just too tall', page({ margins: { top: 378 + E, bottom: 378 } }), false],
  ['small page, default margins do not fit', page({ size: { width: 100 } }), false],
];

describe('blankDocument.page bounds match @open-docex/shared/text', () => {
  it.each(cases)('%s', (_name, p, expected) => {
    expect(sharedAccepts(p)).toBe(expected);
    expect(copyAccepts(p)).toBe(sharedAccepts(p));
  });

  it('the default blank page passes shared', () => {
    expect(sharedAccepts(resolveWorkerConfig({}, process.cwd()).blankDocument.page)).toBe(true);
  });
});
