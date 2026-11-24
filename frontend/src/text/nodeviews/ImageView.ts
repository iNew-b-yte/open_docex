/**
 * The `image` node view (LLD Part 3 §9; HLD §14; §0 PO-24, S-7).
 *
 * - The `<img>` gets its `src` only from the `AssetCache`, and only when it is a `blob:` URL.
 *   The document's own attributes never become a `src`.
 * - While the asset loads, a placeholder of the saved size shows; a failed load shows a
 *   broken-image box with the alt text.
 * - Width and height are pt (LLD Part 1 §8.1) and are applied as CSS lengths.
 * - When the image is selected in an editable view, three handles (right edge, bottom edge,
 *   corner) resize it. The corner keeps the aspect ratio. Releasing a handle saves `width` and
 *   `height` with attribute steps (PO-24).
 * - A `ResizeObserver` reports every size change of the view to the {@link BlockResizeSignal},
 *   so pagination can re-measure the block (S-7).
 *
 * @module
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import type { AssetCache } from '../../assets/AssetCache.js';
import { isBlobUrl } from '../../security/href.js';
import type { BlockResizeSignal } from './BlockResizeSignal.js';

/** CSS px → pt. */
const PX_TO_PT = 0.75;
/** The smallest size a handle drag can make, in pt (LLD choice; the schema allows ≥ 1). */
export const MIN_IMAGE_PT = 8;
/** The largest size the schema allows, in pt (LLD Part 1 §8.1). */
export const MAX_IMAGE_PT = 10_000;
/** The placeholder size, in pt, for an image with no saved size that has not loaded yet. */
const PLACEHOLDER_PT = 48;

/** The resize handles: right edge, bottom edge and corner. */
export type ImageHandle = 'e' | 's' | 'se';
const HANDLES: readonly ImageHandle[] = ['e', 's', 'se'];

/** What an {@link ImageView} needs. */
export interface ImageViewDeps {
  assets: Pick<AssetCache, 'url' | 'load'>;
  resize: BlockResizeSignal;
}

const clampPt = (v: number): number => Math.round(Math.min(MAX_IMAGE_PT, Math.max(MIN_IMAGE_PT, v)) * 100) / 100;

/** The ResizeObserver constructor of `win`, if the environment has one. */
function resizeObserverOf(win: (Window & typeof globalThis) | null): typeof ResizeObserver | undefined {
  return win !== null && typeof win.ResizeObserver === 'function' ? win.ResizeObserver : undefined;
}

interface Drag {
  handle: ImageHandle;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  w: number;
  h: number;
}

/** The node view for `image` nodes. */
export class ImageView implements NodeView {
  /** The outer block element. */
  readonly dom: HTMLElement;
  readonly #frame: HTMLElement;
  readonly #img: HTMLImageElement;
  readonly #handles: HTMLElement[];
  readonly #view: EditorView;
  readonly #getPos: () => number | undefined;
  readonly #deps: ImageViewDeps;
  readonly #observer: ResizeObserver | undefined;
  #node: PMNode;
  #drag: Drag | null = null;
  #destroyed = false;
  /** Bumped on every asset change, so a late load for an old asset is ignored. */
  #loadToken = 0;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, deps: ImageViewDeps) {
    this.#node = node;
    this.#view = view;
    this.#getPos = getPos;
    this.#deps = deps;
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = 'odx-image';
    this.#frame = doc.createElement('span');
    this.#frame.className = 'odx-image-frame';
    this.#frame.style.position = 'relative';
    this.#frame.style.display = 'inline-block';
    this.#img = doc.createElement('img');
    this.#img.draggable = false;
    this.#frame.appendChild(this.#img);
    this.#handles = HANDLES.map((h) => this.#makeHandle(h));
    this.dom.appendChild(this.#frame);
    this.#applyAttrs();
    this.#loadAsset();
    const RO = resizeObserverOf(doc.defaultView);
    if (RO) {
      this.#observer = new RO(() => this.#reportResize());
      this.#observer.observe(this.dom);
    }
  }

  /** Accepts a changed `image` node in place; another node type rebuilds the view. */
  update(node: PMNode): boolean {
    if (node.type !== this.#node.type) return false;
    const assetChanged = node.attrs.assetId !== this.#node.attrs.assetId;
    this.#node = node;
    this.#applyAttrs();
    if (assetChanged) this.#loadAsset();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
    this.#showHandles(this.#view.editable);
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
    this.#showHandles(false);
  }

  /** Events on the handles belong to the view, not to ProseMirror. */
  stopEvent(e: Event): boolean {
    const t = e.target;
    return this.#handles.some((h) => h === t);
  }

  /** The view manages its own DOM. */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#loadToken += 1;
    this.#observer?.disconnect();
    this.#endDrag(false);
  }

  /** The `<img>` element (for tests and the header/footer copies). */
  get img(): HTMLImageElement {
    return this.#img;
  }

  #applyAttrs(): void {
    const { alt, width, height } = this.#node.attrs as { alt: string; width: number | null; height: number | null };
    this.#img.alt = alt;
    this.#setSize(width, height);
  }

  #setSize(width: number | null, height: number | null): void {
    const s = this.#img.style;
    s.width = width !== null ? `${String(width)}pt` : '';
    s.height = height !== null ? `${String(height)}pt` : '';
    // Without a saved width the image shows at its natural size, but never wider than the page.
    s.maxWidth = width === null ? '100%' : '';
    if (!this.#img.hasAttribute('src')) {
      // A sized placeholder while loading (or broken): the box keeps its place in the layout.
      s.minWidth = width === null ? `${String(PLACEHOLDER_PT)}pt` : '';
      s.minHeight = height === null ? `${String(PLACEHOLDER_PT)}pt` : '';
    } else {
      s.minWidth = '';
      s.minHeight = '';
    }
  }

  /** Sets `src` only for a `blob:` URL (HLD §14). Returns whether it was set. */
  #setSrc(url: string | undefined): boolean {
    if (url === undefined || !isBlobUrl(url)) return false;
    this.#img.src = url;
    this.dom.classList.remove('odx-image-loading', 'odx-image-broken');
    this.#setSize(this.#node.attrs.width as number | null, this.#node.attrs.height as number | null);
    return true;
  }

  #loadAsset(): void {
    const token = ++this.#loadToken;
    const assetId = this.#node.attrs.assetId as string;
    this.#img.removeAttribute('src');
    this.dom.classList.remove('odx-image-broken');
    if (this.#setSrc(this.#deps.assets.url(assetId))) return;
    this.dom.classList.add('odx-image-loading');
    this.#setSize(this.#node.attrs.width as number | null, this.#node.attrs.height as number | null);
    this.#deps.assets.load(assetId).then(
      (url) => {
        if (token !== this.#loadToken) return;
        if (!this.#setSrc(url)) this.#markBroken();
      },
      () => {
        if (token === this.#loadToken) this.#markBroken();
      },
    );
  }

  #markBroken(): void {
    this.dom.classList.remove('odx-image-loading');
    this.dom.classList.add('odx-image-broken');
  }

  #reportResize(): void {
    if (this.#destroyed) return;
    let pos: number | undefined;
    try {
      pos = this.#getPos();
    } catch {
      pos = undefined;
    }
    this.#deps.resize.emit({ node: this.#node, pos, dom: this.dom });
  }

  #makeHandle(kind: ImageHandle): HTMLElement {
    const h = this.dom.ownerDocument.createElement('span');
    h.className = `odx-image-handle odx-image-handle-${kind}`;
    h.dataset.handle = kind;
    const s = h.style;
    s.position = 'absolute';
    s.width = '8px';
    s.height = '8px';
    s.display = 'none';
    s.cursor = kind === 'e' ? 'ew-resize' : kind === 's' ? 'ns-resize' : 'nwse-resize';
    if (kind === 'e') {
      s.right = '-4px';
      s.top = 'calc(50% - 4px)';
    } else if (kind === 's') {
      s.bottom = '-4px';
      s.left = 'calc(50% - 4px)';
    } else {
      s.right = '-4px';
      s.bottom = '-4px';
    }
    h.addEventListener('pointerdown', (e) => this.#startDrag(kind, e));
    this.#frame.appendChild(h);
    return h;
  }

  #showHandles(show: boolean): void {
    for (const h of this.#handles) h.style.display = show ? 'block' : 'none';
  }

  /** The current size in pt: the saved attributes, else the natural size. Null when unknown. */
  #currentSizePt(): { w: number; h: number } | null {
    const attrs = this.#node.attrs as { width: number | null; height: number | null };
    const w = attrs.width ?? this.#img.naturalWidth * PX_TO_PT;
    const h = attrs.height ?? this.#img.naturalHeight * PX_TO_PT;
    return w > 0 && h > 0 ? { w, h } : null;
  }

  #startDrag(handle: ImageHandle, e: Event): void {
    const me = e as MouseEvent;
    if (!this.#view.editable || this.#drag !== null || me.button !== 0) return;
    const size = this.#currentSizePt();
    if (size === null) return;
    e.preventDefault();
    this.#drag = { handle, startX: me.clientX, startY: me.clientY, startW: size.w, startH: size.h, w: size.w, h: size.h };
    const win = this.dom.ownerDocument.defaultView;
    win?.addEventListener('pointermove', this.#onMove);
    win?.addEventListener('pointerup', this.#onUp);
    win?.addEventListener('pointercancel', this.#onCancel);
  }

  readonly #onMove = (e: Event): void => {
    const d = this.#drag;
    if (d === null) return;
    const me = e as MouseEvent;
    const dw = (me.clientX - d.startX) * PX_TO_PT;
    const dh = (me.clientY - d.startY) * PX_TO_PT;
    if (d.handle === 'e') {
      d.w = clampPt(d.startW + dw);
      d.h = clampPt(d.startH);
    } else if (d.handle === 's') {
      d.w = clampPt(d.startW);
      d.h = clampPt(d.startH + dh);
    } else {
      d.w = clampPt(d.startW + dw);
      d.h = clampPt((d.w * d.startH) / d.startW);
    }
    this.#setSize(d.w, d.h);
  };

  readonly #onUp = (e: Event): void => {
    this.#onMove(e);
    this.#endDrag(true);
  };

  readonly #onCancel = (): void => {
    this.#endDrag(false);
  };

  /** Ends a drag; when `commit`, saves `width` and `height` as two attribute steps. */
  #endDrag(commit: boolean): void {
    const d = this.#drag;
    if (d === null) return;
    this.#drag = null;
    const win = this.dom.ownerDocument.defaultView;
    win?.removeEventListener('pointermove', this.#onMove);
    win?.removeEventListener('pointerup', this.#onUp);
    win?.removeEventListener('pointercancel', this.#onCancel);
    const pos = commit && !this.#destroyed && this.#view.editable ? this.#getPos() : undefined;
    const node = pos === undefined ? null : this.#view.state.doc.nodeAt(pos);
    if (pos === undefined || node === null || node.type !== this.#node.type) {
      this.#applyAttrs();
      return;
    }
    if (node.attrs.width === d.w && node.attrs.height === d.h) return;
    this.#view.dispatch(this.#view.state.tr.setNodeAttribute(pos, 'width', d.w).setNodeAttribute(pos, 'height', d.h));
  }
}
