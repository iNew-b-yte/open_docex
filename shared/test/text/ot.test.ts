import { describe, expect, it } from 'vitest';
import * as root from '../../src/index.js';
import { OpenDocexError } from '../../src/errors/index.js';
import { DEFAULT_CHUNK_LIMITS } from '../../src/ot/index.js';
import { textOpsEqual } from '../../src/text/equal.js';
import { TextOtType } from '../../src/text/ot.js';
import { textSchema } from '../../src/text/schema.js';
import type { TextOp } from '../../src/text/steps.js';
import { runOtLaws } from '../ot/laws.js';
import { A4, docWithParagraphs, everythingJson, para } from './fixtures.js';
import { bodyDoc, texts } from './sim.js';

const everything = textSchema.nodeFromJSON(everythingJson());
const huge = textSchema.nodeFromJSON({
  type: 'doc',
  attrs: A4,
  content: [{ type: 'body', content: [para('a'), para('x'.repeat(300_000)), para('b')] }],
});

const ins = (pos: number, text: string): TextOp => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

function codeOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    return e instanceof OpenDocexError ? e.code : 'other';
  }
  return undefined;
}

describe('TextOtType laws (LLD Part 1 Â§7)', () => {
  runOtLaws(TextOtType, {
    snapshots: [
      everything,
      docWithParagraphs(1),
      docWithParagraphs(200, { header: true, footer: true }),
      docWithParagraphs(201, { header: true }),
      docWithParagraphs(201, { footer: true }),
      huge,
    ],
    applyCases: [
      { snapshot: bodyDoc('ab'), ops: [ins(3, 'x'), ins(4, 'y')] },
      { snapshot: bodyDoc('ab'), ops: [ins(1000, 'x'), ins(3, 'y')] },
      // A page_field in the body is dropped (Â§0 S-20), and so is typing inside it.
      {
        snapshot: bodyDoc('ab'),
        ops: [
          { stepType: 'replace', from: 3, to: 3, slice: { content: [{ type: 'text', text: 'xy' }, { type: 'page_field', attrs: { kind: 'number' } }] } },
          ins(4, 'Z'),
        ],
      },
      { snapshot: everything, ops: [{ stepType: 'docAttr', attr: 'margins', value: { top: 0, right: 600, bottom: 0, left: 0 } }] },
      // An op that does not parse is dropped, not thrown.
      { snapshot: bodyDoc('ab'), ops: [{ stepType: 'addMark', from: 2, to: 3, mark: { type: 'blink' } }, ins(3, 'q')] },
    ],
    rebaseCases: [
      { ops: [ins(3, 'x'), ins(4, 'y')], over: [ins(2, 'q')] },
      { ops: [{ stepType: 'addMark', from: 2, to: 4, mark: { type: 'bold' } }], over: [{ stepType: 'replace', from: 2, to: 3 }] },
    ],
    limits: [DEFAULT_CHUNK_LIMITS, { textBlocks: 1, sheetRows: 500, maxBytes: 262_144 }, { textBlocks: 200, sheetRows: 500, maxBytes: 200 }],
    // The 'doc' part is one indivisible unit (page settings and region flags).
    unitsIn: (c) => (c.data.part === 'blocks' ? c.data.blocks.length : 1),
    validOps: [
      { input: [ins(3, 'x')], expected: [ins(3, 'x')] },
      {
        input: [{ stepType: 'addMark', from: 1, to: 3, mark: { type: 'bold' }, extra: 1 }],
        expected: [{ stepType: 'addMark', from: 1, to: 3, mark: { type: 'bold' } }],
      },
      { input: [{ stepType: 'docAttr', attr: 'orientation', value: 'landscape' }], expected: [{ stepType: 'docAttr', attr: 'orientation', value: 'landscape' }] },
      { input: [{ stepType: 'attr', pos: 1, attr: 'align', value: 'center' }], expected: [{ stepType: 'attr', pos: 1, attr: 'align', value: 'center' }] },
    ],
    invalidOps: [
      undefined,
      null,
      [],
      {},
      'replace',
      [null],
      [[]],
      [{ stepType: 'bogus', from: 1, to: 1 }],
      [{ stepType: '__proto__' }],
      [{ ...ins(3, 'x'), from: -1 }],
      [{ ...ins(3, 'x'), to: 1.5 }],
      [{ ...ins(3, 'x'), from: '3' }],
      [{ ...ins(3, 'x'), from: Number.MAX_SAFE_INTEGER + 1 }],
      [{ stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'script' }] } }],
      [{ stepType: 'addMark', from: 1, to: 2, mark: { type: 'blink' } }],
      [{ stepType: 'addMark', from: 1, to: 2, mark: { type: 'link', attrs: { href: 'javascript:alert(1)' } } }],
      [{ stepType: 'docAttr', attr: 'textDefaults', value: { fontFamily: null, fontSize: null, color: null } }],
      [{ stepType: 'docAttr', attr: 'bogus', value: 1 }],
      [{ stepType: 'attr', pos: 1, attr: 'onclick', value: 'x' }],
      [{ stepType: 'attr', pos: 1, value: 'x' }],
      [{ stepType: 'replace' }],
      [ins(3, 'x'), { stepType: 'bogus' }],
    ],
  });
});

describe('TextOtType', () => {
  it('is the text kind and is exported from the package root', () => {
    expect(TextOtType.kind).toBe('text');
    expect(root.TextOtType).toBe(TextOtType);
    expect(root.textOpsEqual).toBe(textOpsEqual);
    expect(typeof root.rebaseSteps).toBe('function');
    expect(typeof root.rebaseStepsOnDoc).toBe('function');
    expect(typeof root.applyStepsWithDrop).toBe('function');
  });

  it('apply returns the applied ops as positioned and counts drops', () => {
    const r = TextOtType.apply(bodyDoc('ab'), [ins(1000, 'x'), ins(3, 'y')]);
    expect(texts(r.snapshot)).toEqual(['ayb']);
    expect(r.applied).toEqual([ins(3, 'y')]);
    expect(r.dropped).toBe(1);
  });

  it('rebase maps ops over ops (BRD Â§3 "cat": the later insert goes after)', () => {
    expect(TextOtType.rebase([ins(3, 'o')], [ins(3, 'h')])).toEqual([ins(4, 'o')]);
  });

  it('deserializeSnapshot throws DOCUMENT_FAULTED for a corrupt snapshot', () => {
    expect(codeOf(() => TextOtType.deserializeSnapshot(null))).toBe('DOCUMENT_FAULTED');
    expect(codeOf(() => TextOtType.deserializeSnapshot({ type: 'nope' }))).toBe('DOCUMENT_FAULTED');
    // Content check: a doc without a body.
    expect(codeOf(() => TextOtType.deserializeSnapshot({ type: 'doc', attrs: A4, content: [] }))).toBe('DOCUMENT_FAULTED');
    // Root is not doc.
    expect(codeOf(() => TextOtType.deserializeSnapshot(para('x')))).toBe('DOCUMENT_FAULTED');
    // An attribute validator fails.
    const badHref = {
      type: 'doc',
      attrs: A4,
      content: [{ type: 'body', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:x' } }] }] }] }],
    };
    expect(codeOf(() => TextOtType.deserializeSnapshot(badHref))).toBe('DOCUMENT_FAULTED');
  });

  it('deserializeSnapshot enforces Â§0 S-27 with PROTOCOL_OP_REJECTED', () => {
    const margins = { ...A4, margins: { top: 72, right: 300, bottom: 72, left: 300 } };
    expect(codeOf(() => TextOtType.deserializeSnapshot({ type: 'doc', attrs: margins, content: [{ type: 'body', content: [para('x')] }] }))).toBe(
      'PROTOCOL_OP_REJECTED',
    );
    const cell = {
      type: 'doc',
      attrs: A4,
      content: [
        {
          type: 'body',
          content: [{ type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_header', attrs: { colspan: 2, colwidth: [100] }, content: [para('h')] }] }] }],
        },
      ],
    };
    expect(codeOf(() => TextOtType.deserializeSnapshot(cell))).toBe('PROTOCOL_OP_REJECTED');
  });
});

describe('textOpsEqual', () => {
  it('compares length and canonical JSON pairwise', () => {
    const a: TextOp = { stepType: 'addMark', from: 1, to: 2, mark: { type: 'bold' } };
    const reordered = { mark: { type: 'bold' }, to: 2, from: 1, stepType: 'addMark' } as TextOp;
    expect(textOpsEqual([a], [reordered])).toBe(true);
    expect(textOpsEqual([], [])).toBe(true);
    expect(textOpsEqual([a], [])).toBe(false);
    expect(textOpsEqual([a], [{ ...a, to: 3 }])).toBe(false);
  });
});
