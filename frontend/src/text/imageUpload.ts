/**
 * Image insertion: toolbar, paste and drag-and-drop (LLD Part 3 §9; §0 PO-24, L-16; C-7).
 *
 * `insertImage` checks the type (PNG, JPEG, GIF) and size, measures the image, shows an
 * upload placeholder, uploads through the `AssetCache` and only then inserts the `image`
 * node, so the step that references the asset exists only after the server stored it (C-7).
 * The placeholder is a widget decoration whose position maps through every transaction,
 * local or remote; if its surroundings are deleted meanwhile, nothing is inserted.
 *
 * @module
 */
import { ERROR_CATALOGUE, OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import { getPageSettings, textSchema } from '@open-docex/shared/text';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { AssetCache } from '../assets/AssetCache.js';
import { toClientErrorEvent } from '../errors/policy.js';
import type { ClientError } from '../events.js';
import { MAX_IMAGE_PT } from './nodeviews/ImageView.js';

/** The `accept` list for the image file picker (PO-24). */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif';

/** CSS px → pt. */
const PX_TO_PT = 0.75;

/** Plugin state: the upload placeholders. */
export const imageUploadKey = new PluginKey<DecorationSet>('odx-image-upload');

/** The placeholder metas (LLD Part 3 §9). */
export type ImageUploadMeta = { add: { id: string; pos: number } } | { remove: string };

/** A natural image size in CSS px. */
export interface NaturalSize {
  width: number;
  height: number;
}

/** What image insertion needs. */
export interface ImageUploadDeps {
  assets: Pick<AssetCache, 'put' | 'check'>;
  onError: (e: ClientError) => void;
  /**
   * Measures an image's natural size in CSS px. Rejects when the bytes can't be decoded.
   * Defaults to `createImageBitmap`; without it the image is inserted with no saved size.
   */
  measure?: (blob: Blob) => Promise<NaturalSize | null>;
}

let nextPlaceholder = 1;

/** Reports an asset failure to the adopter. Asset failures never stop the session (L-16). */
export function notifyAssetError(onError: (e: ClientError) => void, code: ErrorCode): void {
  onError(toClientErrorEvent({ code, retryable: ERROR_CATALOGUE[code].retryable }, 'asset-failed'));
}

/** The default {@link ImageUploadDeps.measure}: `createImageBitmap`, if the browser has it. */
async function measureWithBitmap(blob: Blob): Promise<NaturalSize | null> {
  if (typeof globalThis.createImageBitmap !== 'function') return null;
  const bmp = await globalThis.createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

/**
 * The size to save, in pt: the natural size, scaled down to the page's content width with the
 * ratio kept (LLD Part 3 §9). Null when the natural size is unknown.
 */
export function initialImageSize(natural: NaturalSize | null, doc: PMNode): { width: number; height: number } | null {
  if (natural === null || !(natural.width > 0) || !(natural.height > 0)) return null;
  const p = getPageSettings(doc);
  const pageWidth = p.orientation === 'landscape' ? p.size.height : p.size.width;
  const content = Math.max(1, pageWidth - p.margins.left - p.margins.right);
  let w = natural.width * PX_TO_PT;
  let h = natural.height * PX_TO_PT;
  if (w > content) {
    h = (h * content) / w;
    w = content;
  }
  const fit = (v: number): number => Math.min(MAX_IMAGE_PT, Math.max(1, Math.round(v * 100) / 100));
  return { width: fit(w), height: fit(h) };
}

/** The position of placeholder `id`, or null when it is gone (its surroundings were deleted). */
export function findPlaceholder(state: EditorState, id: string): number | null {
  const set = imageUploadKey.getState(state);
  const found = set?.find(undefined, undefined, (spec) => (spec as { id?: unknown }).id === id);
  return found !== undefined && found.length > 0 ? (found[0] as Decoration).from : null;
}

function placeholderDom(view: EditorView): HTMLElement {
  const el = view.dom.ownerDocument.createElement('span');
  el.className = 'odx-image-placeholder';
  el.setAttribute('aria-busy', 'true');
  el.contentEditable = 'false';
  el.style.display = 'inline-block';
  el.style.width = '48pt';
  el.style.height = '48pt';
  return el;
}

/**
 * Uploads `file` and inserts it as an `image` at `at` (default: the selection's start).
 * Resolves true when the image was inserted. Every failure is reported through `onError`
 * with a `CLIENT_*` or server code, and leaves the document unchanged.
 */
export async function insertImage(view: EditorView, file: File, deps: ImageUploadDeps, at?: number): Promise<boolean> {
  if (view.isDestroyed || !view.editable) return false;
  const problem = deps.assets.check(file.type, file.size);
  if (problem !== null) {
    notifyAssetError(deps.onError, problem);
    return false;
  }
  const mime = file.type;
  let bytes: Uint8Array<ArrayBuffer>;
  let natural: NaturalSize | null;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    natural = await (deps.measure ?? measureWithBitmap)(new Blob([bytes], { type: mime }));
  } catch {
    // An unreadable file, or bytes that don't decode, are not a PNG, JPEG or GIF, whatever
    // the file claims.
    notifyAssetError(deps.onError, 'CLIENT_IMAGE_TYPE_UNSUPPORTED');
    return false;
  }
  if (view.isDestroyed) return false;
  const size = initialImageSize(natural, view.state.doc);
  const id = `odx-img-${String(nextPlaceholder++)}`;
  const pos = Math.min(at ?? view.state.selection.from, view.state.doc.content.size);
  view.dispatch(view.state.tr.setMeta(imageUploadKey, { add: { id, pos } } satisfies ImageUploadMeta));
  let assetId: string;
  try {
    assetId = await deps.assets.put(bytes, mime);
  } catch (e) {
    if (view.isDestroyed) return false;
    view.dispatch(view.state.tr.setMeta(imageUploadKey, { remove: id } satisfies ImageUploadMeta));
    notifyAssetError(deps.onError, OpenDocexError.is(e) ? e.code : 'DOCUMENT_TOO_LARGE');
    return false;
  }
  if (view.isDestroyed) return false;
  const target = findPlaceholder(view.state, id);
  const tr = view.state.tr.setMeta(imageUploadKey, { remove: id } satisfies ImageUploadMeta);
  if (target === null || !view.editable) {
    view.dispatch(tr);
    return false;
  }
  const image = textSchema.nodes.image.create({
    assetId,
    alt: '',
    width: size?.width ?? null,
    height: size?.height ?? null,
  });
  tr.replaceRangeWith(target, target, image);
  view.dispatch(tr);
  return true;
}

/** The files of a clipboard or drop, if any. */
function filesOf(data: DataTransfer | null | undefined): File[] {
  return data ? Array.from(data.files) : [];
}

/**
 * The upload plugin (slot 3 of LLD Part 3 §9's order): placeholder decorations, plus paste
 * and drop of image files.
 *
 * - **Paste:** a clipboard with files and no plain text is a file paste. Each file goes
 *   through {@link insertImage}, so non-image files get `CLIENT_IMAGE_TYPE_UNSUPPORTED`.
 *   A clipboard with text (for example, from a word processor that also puts a picture of
 *   the text on the clipboard) is pasted as content (LLD choice).
 * - **Drop:** dropped files are inserted at the drop point. Moving content inside the
 *   editor is left to ProseMirror.
 */
export function imageUploadPlugin(deps: ImageUploadDeps): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: imageUploadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(imageUploadKey) as ImageUploadMeta | undefined;
        if (meta && 'add' in meta) {
          const { id, pos } = meta.add;
          const deco = Decoration.widget(pos, placeholderDom, { side: -1, key: id, id, ignoreSelection: true });
          next = next.add(tr.doc, [deco]);
        } else if (meta && 'remove' in meta) {
          next = next.remove(next.find(undefined, undefined, (spec) => (spec as { id?: unknown }).id === meta.remove));
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        return imageUploadKey.getState(state);
      },
      handlePaste(view, event) {
        const files = filesOf(event.clipboardData);
        if (files.length === 0 || !view.editable) return false;
        if ((event.clipboardData?.getData('text/plain') ?? '').trim() !== '') return false;
        for (const f of files) void insertImage(view, f, deps);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = filesOf(event.dataTransfer);
        if (files.length === 0 || !view.editable) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        for (const f of files) void insertImage(view, f, deps, at);
        return true;
      },
    },
  });
}
