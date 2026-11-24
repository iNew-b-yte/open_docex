/**
 * The header and footer of a text document (LLD Part 3 §11, CL-9; §0 PO-21, S-1, S-5).
 *
 * The real `header` and `footer` nodes are editable once, inside the single `EditorView`, so
 * their steps flow through the same OT stream. They are shown read-only on every other page
 * as copies, which the {@link PaginationPlugin} puts into its spacer widgets. A copy is built
 * with a `DOMSerializer` and never uses `innerHTML`.
 *
 * @module
 */
import { textSchema } from '@open-docex/shared/text';
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import { Plugin, type Command, type EditorState } from 'prosemirror-state';
import type { NodeViewConstructor } from 'prosemirror-view';
import type { AssetCache } from '../assets/AssetCache.js';
import type { Labels } from '../labels.js';
import { isEditable } from './commands.js';
import { readHeight, type HeightReader } from './geometry.js';

const N = textSchema.nodes;

/** `header` or `footer`. */
export type RegionKind = 'header' | 'footer';

/** What {@link HeaderFooterRegions} needs. */
export interface RegionsDeps {
  assets: AssetCache;
  labels: Labels;
  /** The §0 S-1 height read. Tests stub it, as jsdom has no layout. Default: {@link readHeight}. */
  readHeight?: HeightReader;
}

/** The document's header node, or null. */
export function headerOf(doc: PMNode): PMNode | null {
  return doc.firstChild?.type === N.header ? doc.firstChild : null;
}

/** The document's footer node, or null. */
export function footerOf(doc: PMNode): PMNode | null {
  return doc.lastChild?.type === N.footer ? doc.lastChild : null;
}

/**
 * Sets the text of every page field under `root` (`page_field` renders as
 * `span[data-page-field]`): `number` shows `page`, `count` shows `count` (PO-21).
 */
export function fillFields(root: ParentNode, page: number, count: number): void {
  for (const f of root.querySelectorAll<HTMLElement>('[data-page-field]')) {
    const t = String(f.dataset.pageField === 'count' ? count : page);
    if (f.textContent !== t) f.textContent = t;
  }
}

/** Header and footer node views, read-only copies, and the add/remove commands. */
export class HeaderFooterRegions {
  readonly #deps: RegionsDeps;
  readonly #read: HeightReader;
  readonly #serializer: DOMSerializer;
  readonly #copyCache = new WeakMap<PMNode, DocumentFragment>();
  readonly #observer: ResizeObserver | undefined;
  readonly #contents: Record<RegionKind, HTMLElement | null> = { header: null, footer: null };
  #destroyed = false;

  /** Called when a real region changes size. The pagination plugin sets it. */
  onResize: (() => void) | null = null;
  /** Called when an image a copy needs has loaded, so the copies must be rebuilt. */
  onCopyStale: (() => void) | null = null;

  constructor(deps: RegionsDeps) {
    this.#deps = deps;
    this.#read = deps.readHeight ?? readHeight;
    const nodes = DOMSerializer.nodesFromSchema(textSchema);
    nodes.page_field = (n) => {
      const s = document.createElement('span');
      s.className = 'odx-page-field';
      s.dataset.pageField = n.attrs.kind as string;
      return s;
    };
    nodes.image = (n) => this.#copyImage(n);
    this.#serializer = new DOMSerializer(nodes, DOMSerializer.marksFromSchema(textSchema));
    this.#observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.onResize?.()) : undefined;
  }

  /** The content element of the real region, or null while it is not rendered. */
  content(kind: RegionKind): HTMLElement | null {
    return this.#contents[kind];
  }

  /** A plugin that installs the node views. This is the editor's `regions` slot. */
  plugin(): Plugin {
    return new Plugin({ props: { nodeViews: this.nodeViews() } });
  }

  /** The node views of the real, editable regions (and of `page_field`). */
  nodeViews(): { header: NodeViewConstructor; footer: NodeViewConstructor; page_field: NodeViewConstructor } {
    const region =
      (kind: RegionKind): NodeViewConstructor =>
      () => {
        const dom = document.createElement(kind);
        dom.className = 'odx-' + kind;
        dom.setAttribute('aria-label', this.#deps.labels.toolbar[kind]);
        // Flex column; the pagination plugin sets the box height. A header's content sits at the
        // bottom of its box and a footer's at the top (LLD Part 3 §10).
        dom.style.display = 'flex';
        dom.style.flexDirection = 'column';
        dom.style.boxSizing = 'border-box';
        dom.style.justifyContent = kind === 'header' ? 'flex-end' : 'flex-start';
        const contentDOM = document.createElement('div');
        contentDOM.className = 'odx-region-content';
        dom.appendChild(contentDOM);
        this.#contents[kind] = contentDOM;
        this.#observer?.observe(contentDOM);
        return {
          dom,
          contentDOM,
          destroy: () => {
            this.#observer?.unobserve(contentDOM);
            if (this.#contents[kind] === contentDOM) this.#contents[kind] = null;
          },
        };
      };
    return {
      header: region('header'),
      footer: region('footer'),
      page_field: (node) => {
        const dom = document.createElement('span');
        dom.className = 'odx-page-field';
        dom.dataset.pageField = node.attrs.kind as string;
        dom.contentEditable = 'false';
        dom.textContent = '#';
        return { dom, ignoreMutation: () => true };
      },
    };
  }

  /** The used height of the real region in px (§0 S-1), or 0 when it is absent. */
  measuredHeight(kind: RegionKind): number {
    const c = this.#contents[kind];
    return c !== null && c.isConnected ? this.#read(c) : 0;
  }

  /**
   * A read-only copy of the document's header or footer for page `page` of `count` (1-based).
   * The root is `contenteditable="false"`, `aria-hidden` and `inert`. An absent region gives an
   * empty copy. The serialized fragment is cached per node identity.
   */
  renderCopy(kind: RegionKind, state: EditorState, page = 1, count = 1): HTMLElement {
    const root = document.createElement('div');
    root.className = 'odx-copy odx-copy-' + kind;
    root.setAttribute('contenteditable', 'false');
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    const node = kind === 'header' ? headerOf(state.doc) : footerOf(state.doc);
    if (node === null) return root;
    let frag: DocumentFragment | undefined = this.#copyCache.get(node);
    if (frag === undefined) {
      frag = this.#serializer.serializeFragment(node.content) as DocumentFragment;
      // A copy with an image that has no blob URL yet is not cached: it is rebuilt once the
      // asset arrives.
      if (this.#allImagesReady(node)) this.#copyCache.set(node, frag);
    }
    root.appendChild(frag.cloneNode(true));
    fillFields(root, page, count);
    return root;
  }

  /** Commands that add or remove the header and footer. They are ordinary steps. */
  commands(): { addHeader: Command; removeHeader: Command; addFooter: Command; removeFooter: Command } {
    const add =
      (kind: RegionKind): Command =>
      (state, dispatch) => {
        if (!isEditable(state)) return false;
        const exists = kind === 'header' ? headerOf(state.doc) : footerOf(state.doc);
        if (exists !== null) return false;
        if (dispatch) {
          const node = N[kind].create(null, [N.paragraph.create()]);
          dispatch(state.tr.insert(kind === 'header' ? 0 : state.doc.content.size, node).scrollIntoView());
        }
        return true;
      };
    const remove =
      (kind: RegionKind): Command =>
      (state, dispatch) => {
        if (!isEditable(state)) return false;
        const node = kind === 'header' ? headerOf(state.doc) : footerOf(state.doc);
        if (node === null) return false;
        if (dispatch) {
          const from = kind === 'header' ? 0 : state.doc.content.size - node.nodeSize;
          dispatch(state.tr.delete(from, from + node.nodeSize));
        }
        return true;
      };
    return {
      addHeader: add('header'),
      removeHeader: remove('header'),
      addFooter: add('footer'),
      removeFooter: remove('footer'),
    };
  }

  /** Stops observing. The node views release themselves when the editor destroys them. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#observer?.disconnect();
    this.onResize = null;
    this.onCopyStale = null;
  }

  #allImagesReady(node: PMNode): boolean {
    let ready = true;
    node.descendants((n) => {
      if (n.type === N.image && this.#deps.assets.url(n.attrs.assetId as string) === undefined) ready = false;
      return ready;
    });
    return ready;
  }

  /** An `<img>` whose `src` is a blob URL from the asset cache, never anything else. */
  #copyImage(n: PMNode): HTMLElement {
    const img = document.createElement('img');
    const { assetId, alt, width, height } = n.attrs as {
      assetId: string;
      alt: string;
      width: number | null;
      height: number | null;
    };
    img.alt = alt;
    img.draggable = false;
    if (width !== null) img.style.width = `${String(width)}pt`;
    if (height !== null) img.style.height = `${String(height)}pt`;
    if (width === null) img.style.maxWidth = '100%';
    const url = this.#deps.assets.url(assetId);
    if (url !== undefined) {
      img.src = url;
    } else {
      this.#deps.assets.load(assetId).then(
        () => {
          if (!this.#destroyed) this.onCopyStale?.();
        },
        () => undefined,
      );
    }
    return img;
  }
}
