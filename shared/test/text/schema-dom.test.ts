// @vitest-environment jsdom
import { DOMParser, DOMSerializer } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { textSchema } from '../../src/text/schema.js';
import { ASSET, everythingJson } from './fixtures.js';

const s = textSchema;

// shared compiles without the DOM lib (LLD Part 1 §1.4), so the jsdom globals used here are
// typed locally.
interface TestElement {
  innerHTML: string;
  textContent: string | null;
  readonly outerHTML: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: unknown): unknown;
}
const document = (globalThis as unknown as { document: { createElement(tag: string): TestElement } }).document;
const parser = DOMParser.fromSchema(s);
const serializer = DOMSerializer.fromSchema(s);

/** Parses HTML as pasted content into a `body` node. */
function parseBody(html: string): PMNode {
  const div = document.createElement('div');
  div.innerHTML = html; // test input only
  return parser.parse(div, { topNode: s.nodes.body.create() });
}

function toHtml(node: PMNode): string {
  const div = document.createElement('div');
  div.appendChild(serializer.serializeFragment(node.content));
  return div.innerHTML;
}

function firstText(body: PMNode): PMNode {
  let found: PMNode | undefined;
  body.descendants((n) => {
    if (!found && n.isText) found = n;
  });
  if (!found) throw new Error('no text');
  return found;
}

describe('textSchema DOM round trip', () => {
  it('serializes the body of the full fixture and parses it back to the same content', () => {
    const doc = s.nodeFromJSON(everythingJson());
    const body = doc.child(1);
    const reparsed = parseBody(toHtml(body));
    // CSS has no "at least" line height, so it shows, and parses back, as exact (§0 S-19).
    const expected = body.toJSON() as { content: { attrs?: { lineHeight?: { kind: string } | null } }[] };
    const atLeast = expected.content[2]?.attrs?.lineHeight;
    expect(atLeast?.kind).toBe('atLeast');
    if (atLeast) atLeast.kind = 'exact';
    expect(reparsed.toJSON()).toEqual(expected);
  });

  it('serializes header, footer and page fields with their classes, and never parses them back', () => {
    const doc = s.nodeFromJSON(everythingJson());
    const html = toHtml(doc);
    expect(html).toContain('<header class="odx-header">');
    expect(html).toContain('<footer class="odx-footer">');
    expect(html).toContain('<span class="odx-page-field" data-page-field="number"></span>');
    const parsed = parseBody('<p>Page <span class="odx-page-field" data-page-field="number"></span></p>');
    const types: string[] = [];
    parsed.descendants((n) => {
      types.push(n.type.name);
    });
    expect(types).not.toContain('page_field');
  });

  it('writes paragraph formatting as CSS in pt and line-height by kind', () => {
    const p = s.nodes.paragraph.create({
      align: 'center',
      spacingBefore: 12,
      spacingAfter: 6,
      indentLeft: 10,
      indentRight: 20,
      indentFirstLine: -5,
      lineHeight: { kind: 'multiple', value: 1.15 },
    });
    const toDOM = (n: PMNode): unknown => n.type.spec.toDOM?.(n);
    expect(toDOM(p)).toEqual([
      'p',
      {
        style:
          'text-align: center; margin-top: 12pt; margin-bottom: 6pt; margin-left: 10pt; margin-right: 20pt; text-indent: -5pt; line-height: 1.15',
      },
      0,
    ]);
    const atLeast = s.nodes.heading.create({ level: 3, lineHeight: { kind: 'atLeast', pt: 14 } });
    expect(toDOM(atLeast)).toEqual(['h3', { style: 'line-height: 14pt' }, 0]);
    expect(toDOM(s.nodes.paragraph.create())).toEqual(['p', {}, 0]);
  });

  it('writes images without src', () => {
    const img = s.nodes.image.create({ assetId: ASSET, alt: 'x', width: 20 });
    expect(toHtml(s.nodes.body.create(null, img))).toBe(`<img data-asset-id="${ASSET}" alt="x" data-width="20">`);
  });
});

describe('textSchema parseDOM', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    '//evil.example',
    '/relative',
  ])('keeps the text but drops a link to %s', (href) => {
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.textContent = 'click';
    const body = parseBody(`<p>${a.outerHTML}</p>`);
    expect(body.textContent).toBe('click');
    expect(firstText(body).marks).toEqual([]);
  });

  it('keeps an allowed link', () => {
    const body = parseBody('<p><a href="mailto:a@example.com">m</a></p>');
    expect(firstText(body).marks.map((m) => m.attrs)).toEqual([{ href: 'mailto:a@example.com' }]);
  });

  it('ignores <img> without a valid data-asset-id', () => {
    const body = parseBody('<p>a</p><img src="https://evil.example/x.png"><img data-asset-id="bad" src="x">');
    expect(body.childCount).toBe(1);
  });

  it('parses an image with a valid asset id and skips invalid sizes', () => {
    const body = parseBody(`<img data-asset-id="${ASSET}" alt="pic" data-width="120" data-height="0">`);
    expect(body.firstChild?.attrs).toEqual({ assetId: ASSET, alt: 'pic', width: 120, height: null });
  });

  it('reads text_style from span styles and skips invalid properties', () => {
    const body = parseBody(
      '<p><span style="font-family: \'Courier New\', monospace; font-size: 16px; color: rgb(255, 0, 16)">x</span></p>',
    );
    expect(firstText(body).marks.map((m) => [m.type.name, m.attrs])).toEqual([
      ['text_style', { fontFamily: 'Courier New', fontSize: 12, color: '#ff0010' }],
    ]);
  });

  it('rejects CSS injection through font-family', () => {
    const span = document.createElement('span');
    span.setAttribute('style', 'font-family: "a;background:url(x)"');
    span.textContent = 'x';
    const body = parseBody(`<p>${span.outerHTML}</p>`);
    expect(firstText(body).marks).toEqual([]);
  });

  it('reads paragraph formatting from styles (px → pt) and skips invalid values', () => {
    const body = parseBody(
      '<p style="text-align: right; margin-top: 16px; margin-bottom: 3pt; margin-left: -4pt; text-indent: -8px; line-height: 24px">x</p>' +
        '<h2 style="line-height: 1.5; margin-right: 2em">y</h2>',
    );
    expect(body.child(0).attrs).toEqual({
      align: 'right',
      spacingBefore: 12,
      spacingAfter: 3,
      lineHeight: { kind: 'exact', pt: 18 },
      indentLeft: null,
      indentRight: null,
      indentFirstLine: -6,
    });
    expect(body.child(1).attrs).toMatchObject({ level: 2, lineHeight: { kind: 'multiple', value: 1.5 }, indentRight: null });
  });

  it('parses the basic marks from tags and styles', () => {
    const body = parseBody(
      '<p><b style="font-weight: normal">n</b><span style="font-weight: 600; font-style: italic; text-decoration: underline line-through">s</span></p>',
    );
    const names = (i: number): string[] => body.child(0).child(i).marks.map((m) => m.type.name);
    expect(names(0)).toEqual([]);
    expect(names(1)).toEqual(['bold', 'italic', 'underline', 'strike']);
  });

  it('reads an ordered list start and falls back to 1 for an invalid one', () => {
    const body = parseBody('<ol start="4"><li><p>a</p></li></ol><ol start="-2"><li><p>b</p></li></ol>');
    expect(body.child(0).attrs.order).toBe(4);
    expect(body.child(1).attrs.order).toBe(1);
  });
});
