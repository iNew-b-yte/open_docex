import { AddMarkStep, DocAttrStep, ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { parseTextOps } from '../../src/text/steps.js';
import type { TextOp } from '../../src/text/steps.js';

describe('parseTextOps', () => {
  it('parses step JSON into steps of the text schema', () => {
    const ops: TextOp[] = [
      { stepType: 'replace', from: 2, to: 2, slice: { content: [{ type: 'text', text: 'x' }] } },
      { stepType: 'addMark', from: 1, to: 3, mark: { type: 'bold' } },
      { stepType: 'docAttr', attr: 'orientation', value: 'landscape' },
    ];
    const steps = parseTextOps(ops);
    expect(steps[0]).toBeInstanceOf(ReplaceStep);
    expect(steps[1]).toBeInstanceOf(AddMarkStep);
    expect(steps[2]).toBeInstanceOf(DocAttrStep);
    expect(steps.map((s) => s.toJSON() as unknown)).toEqual(ops);
  });

  it('throws for an unknown mark type', () => {
    expect(() => parseTextOps([{ stepType: 'addMark', from: 1, to: 2, mark: { type: 'blink' } }])).toThrow();
  });
});
