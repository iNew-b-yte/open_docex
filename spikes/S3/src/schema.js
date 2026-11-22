// Spike S3: a cut-down copy of the LLD Part 1 text schema, only what pagination needs.
// doc → header? body footer?  (CL-9); page settings in doc attrs, in pt.
import { Schema } from 'prosemirror-model';

export const schema = new Schema({
  nodes: {
    doc: {
      content: 'header? body footer?',
      attrs: { size: {}, orientation: {}, margins: {} },
    },
    header: { content: 'block+', isolating: true, toDOM: () => ['header', { class: 'odx-header' }, 0] },
    footer: { content: 'block+', isolating: true, toDOM: () => ['footer', { class: 'odx-footer' }, 0] },
    body: { content: '(block | page_break)+', isolating: true, toDOM: () => ['div', { class: 'odx-body' }, 0] },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      toDOM: (n) => ['h' + n.attrs.level, 0],
    },
    // Stand-in for `image` / a tall table: a fixed-size box (height in pt), so the
    // spike does not depend on asset loading. Real images need a ResizeObserver (see report).
    image: {
      group: 'block',
      atom: true,
      attrs: { height: { default: 200 } },
      toDOM: (n) => [
        'div',
        { class: 'odx-image', style: `height:${(n.attrs.height * 96) / 72}px` },
      ],
    },
    page_break: {
      atom: true,
      toDOM: () => ['div', { class: 'odx-page-break', 'data-page-break': 'true' }],
    },
    // PO-21 / R-17: only inside header/footer (the spike does not enforce that).
    page_field: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { kind: { default: 'number' } },
      toDOM: (n) => ['span', { class: 'odx-page-field', 'data-page-field': n.attrs.kind }, '#'],
    },
    text: { group: 'inline' },
  },
});
