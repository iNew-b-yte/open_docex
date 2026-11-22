// LLD P3 §11 HeaderFooterRegions, spike version.
// Real header/footer are editable node views; copies are read-only DOM built with DOMSerializer.
import { DOMSerializer } from 'prosemirror-model';

export class HeaderFooterRegions {
  constructor(schema) {
    this.contents = { header: null, footer: null }; // inner contentDOM of the real regions
    this.onResize = () => {};
    this.copyCache = new WeakMap(); // node → serialized fragment
    this.copiesBuilt = 0;
    const nodes = DOMSerializer.nodesFromSchema(schema);
    nodes.page_field = (n) => {
      const s = document.createElement('span');
      s.className = 'odx-page-field';
      s.dataset.pageField = n.attrs.kind;
      return s;
    };
    this.serializer = new DOMSerializer(nodes, DOMSerializer.marksFromSchema(schema));
    this.ro = new ResizeObserver(() => this.onResize());
  }

  nodeViews() {
    const make = (kind) => (node) => {
      const dom = document.createElement(kind);
      dom.className = 'odx-' + kind;
      const contentDOM = document.createElement('div');
      contentDOM.className = 'odx-region-content';
      dom.appendChild(contentDOM);
      this.contents[kind] = contentDOM;
      this.ro.observe(contentDOM);
      return {
        dom,
        contentDOM,
        destroy: () => {
          this.ro.unobserve(contentDOM);
          if (this.contents[kind] === contentDOM) this.contents[kind] = null;
        },
      };
    };
    return {
      header: make('header'),
      footer: make('footer'),
      page_field: (node) => {
        const dom = document.createElement('span');
        dom.className = 'odx-page-field';
        dom.dataset.pageField = node.attrs.kind;
        dom.contentEditable = 'false';
        dom.textContent = '#';
        return { dom, ignoreMutation: () => true };
      },
    };
  }

  measuredHeight(kind) {
    const c = this.contents[kind];
    return c && c.isConnected ? c.getBoundingClientRect().height : 0;
  }

  /** Read-only copy of `node` (header or footer) for page `page` of `count`. */
  renderCopy(kind, node, page, count) {
    const root = document.createElement('div');
    root.className = 'odx-copy odx-copy-' + kind;
    root.setAttribute('contenteditable', 'false');
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    if (!node) return root;
    let frag = this.copyCache.get(node);
    if (!frag) {
      frag = this.serializer.serializeFragment(node.content);
      this.copyCache.set(node, frag);
    }
    root.appendChild(frag.cloneNode(true));
    fillFields(root, page, count);
    this.copiesBuilt++;
    return root;
  }
}

export function fillFields(root, page, count) {
  for (const f of root.querySelectorAll('[data-page-field]')) {
    const t = String(f.dataset.pageField === 'count' ? count : page);
    if (f.textContent !== t) f.textContent = t;
  }
}
