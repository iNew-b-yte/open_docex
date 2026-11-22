import type { Node as PMNode } from 'prosemirror-model';
import { textSchema } from '../../src/text/schema.js';

export const ASSET = 'a'.repeat(64);

export const A4 = {
  size: { width: 595.28, height: 841.89 },
  orientation: 'portrait',
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
} as const;

/** JSON of a paragraph holding `text`. */
export function para(text: string, attrs?: Record<string, unknown>): Record<string, unknown> {
  return { type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text }] };
}

/** A document JSON that uses every node type, every mark and every non-default attribute. */
export function everythingJson(): Record<string, unknown> {
  return {
    type: 'doc',
    attrs: { ...A4, textDefaults: { fontFamily: 'Arial', fontSize: 11, color: '#112233' } },
    content: [
      {
        type: 'header',
        content: [
          {
            type: 'paragraph',
            attrs: { align: 'center' },
            content: [
              { type: 'text', text: 'Page ' },
              { type: 'page_field', attrs: { kind: 'number' } },
              { type: 'text', text: ' of ' },
              { type: 'page_field', attrs: { kind: 'count' } },
            ],
          },
        ],
      },
      {
        type: 'body',
        content: [
          {
            type: 'heading',
            attrs: {
              level: 2,
              align: 'right',
              spacingBefore: 12,
              spacingAfter: 6,
              lineHeight: { kind: 'exact', pt: 18 },
              indentLeft: 10,
              indentRight: 20,
              indentFirstLine: -14.5,
            },
            content: [{ type: 'text', text: 'Title' }],
          },
          {
            type: 'paragraph',
            attrs: { align: 'justify', lineHeight: { kind: 'multiple', value: 1.5 } },
            content: [
              { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
              {
                type: 'text',
                text: 'all',
                marks: [
                  { type: 'bold' },
                  { type: 'italic' },
                  { type: 'underline' },
                  { type: 'strike' },
                  { type: 'text_style', attrs: { fontFamily: 'Times New Roman', fontSize: 14, color: '#ff0000' } },
                ],
              },
              { type: 'hard_break' },
              { type: 'text', text: 'after break' },
            ],
          },
          { type: 'paragraph', attrs: { lineHeight: { kind: 'atLeast', pt: 20 } } },
          { type: 'bullet_list', content: [{ type: 'list_item', content: [para('bullet')] }] },
          {
            type: 'ordered_list',
            attrs: { order: 3 },
            content: [{ type: 'list_item', content: [para('one'), { type: 'bullet_list', content: [{ type: 'list_item', content: [para('nested')] }] }] }],
          },
          { type: 'page_break' },
          {
            type: 'table',
            content: [
              {
                type: 'table_row',
                content: [
                  { type: 'table_header', attrs: { colspan: 2, colwidth: [100, 150] }, content: [para('h')] },
                ],
              },
              {
                type: 'table_row',
                content: [
                  { type: 'table_cell', attrs: { colwidth: [100] }, content: [para('a')] },
                  { type: 'table_cell', content: [para('b')] },
                ],
              },
            ],
          },
          { type: 'image', attrs: { assetId: ASSET, alt: 'A picture', width: 200, height: 100.5 } },
        ],
      },
      { type: 'footer', content: [para('footer')] },
    ],
  };
}

/** A minimal body-only document with `n` paragraphs. */
export function docWithParagraphs(n: number, opts: { header?: boolean; footer?: boolean } = {}): PMNode {
  const body = Array.from({ length: n }, (_, i) => para(`paragraph ${String(i)}`));
  const content: unknown[] = [];
  if (opts.header) content.push({ type: 'header', content: [para('head')] });
  content.push({ type: 'body', content: body });
  if (opts.footer) content.push({ type: 'footer', content: [para('foot')] });
  return textSchema.nodeFromJSON({ type: 'doc', attrs: A4, content });
}
