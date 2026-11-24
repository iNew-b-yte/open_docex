import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAssetId } from '@open-docex/shared/ids';
import type { AssetPutMsg, AssetGetMsg } from '@open-docex/shared/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import { Slice } from 'prosemirror-model';
import { __parseFromClipboard, type EditorView } from 'prosemirror-view';
import type { AssetCache } from '../../src/assets/AssetCache.js';
import { findPlaceholder, imageUploadKey } from '../../src/text/imageUpload.js';
import { BlockResizeSignal, type BlockResizeEvent } from '../../src/text/nodeviews/BlockResizeSignal.js';
import { ImageView } from '../../src/text/nodeviews/ImageView.js';
import { ASSET_A, doc, makeEditor, n, p, posOf, select, selectNode } from './text-fixtures.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const file = (type = 'image/png', bytes: Uint8Array = PNG): File => new File([new Uint8Array(bytes)], 'x', { type });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const editors: { destroy(): void }[] = [];
function setup(d: PMNode, extra: Parameters<typeof makeEditor>[1] = {}, readOnly = false) {
  const e = makeEditor(d, { measureImage: () => Promise.resolve({ width: 800, height: 400 }), ...extra }, readOnly);
  editors.push(e.editor);
  const put = (): AssetPutMsg | undefined => e.sent.find((x): x is AssetPutMsg => (x as AssetPutMsg).type === 'asset-put');
  const confirm = async (): Promise<string> => {
    const req = put();
    if (!req) throw new Error('no asset-put sent');
    const assetId = await computeAssetId(req.bytes);
    e.assets.onAsset({ type: 'asset', reqId: req.reqId, assetId, mime: req.mime, size: req.bytes.length });
    await flush();
    return assetId;
  };
  return { ...e, put, confirm };
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const images = (v: EditorView): PMNode[] => {
  const out: PMNode[] = [];
  v.state.doc.descendants((node) => {
    if (node.type === n.image) out.push(node);
  });
  return out;
};
const placeholders = (v: EditorView): number => imageUploadKey.getState(v.state)?.find().length ?? 0;

describe('image insertion (PO-24)', () => {
  it('uploads, then inserts the image scaled to the content width', async () => {
    const { view, editor, confirm, put } = setup(doc(p('hello')));
    select(view, 7);
    const done = editor.commands().get('insertImage')?.run(view, file());
    await flush();
    expect(put()).toMatchObject({ type: 'asset-put', mime: 'image/png' });
    expect(placeholders(view)).toBe(1);
    expect(images(view)).toHaveLength(0);
    const assetId = await confirm();
    await expect(done).resolves.toBe(true);
    expect(placeholders(view)).toBe(0);
    const [img] = images(view);
    expect(img?.attrs).toEqual({ assetId, alt: '', width: 451.28, height: 225.64 });
    expect(view.dom.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
  });

  it('maps the placeholder through a concurrent insert above it', async () => {
    const { view, editor, confirm } = setup(doc(p('hello')));
    select(view, 7);
    void editor.commands().get('insertImage')?.run(view, file());
    await flush();
    view.dispatch(view.state.tr.insertText('XYZ', 2));
    const id = [...(imageUploadKey.getState(view.state)?.find() ?? [])][0]?.spec.id as string;
    expect(findPlaceholder(view.state, id)).toBe(10);
    await confirm();
    const body = view.state.doc.child(0);
    expect(body.child(0).textContent).toBe('XYZhello');
    expect(body.child(1).type).toBe(n.image);
  });

  it('inserts nothing when the upload fails, and reports the server code', async () => {
    const { view, editor, put, errors, assets } = setup(doc(p('hello')));
    select(view, 7);
    const done = editor.commands().get('insertImage')?.run(view, file());
    await flush();
    const before = view.state.doc;
    assets.onAssetError({ type: 'error', code: 'DOCUMENT_TOO_LARGE', retryable: false, message: 'x', reqId: put()?.reqId as number });
    await expect(done).resolves.toBe(false);
    expect(placeholders(view)).toBe(0);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(errors).toMatchObject([{ code: 'DOCUMENT_TOO_LARGE', terminal: false }]);
  });

  it('inserts nothing when the placeholder’s surroundings were deleted', async () => {
    const { view, editor, confirm } = setup(doc(p('keep'), p('gone')));
    select(view, posOf(view.state.doc, 'gone') + 2);
    void editor.commands().get('insertImage')?.run(view, file());
    await flush();
    const from = posOf(view.state.doc, 'gone') - 1;
    view.dispatch(view.state.tr.delete(from, from + 6));
    await confirm();
    expect(images(view)).toHaveLength(0);
    expect(placeholders(view)).toBe(0);
  });

  it('enforces PNG, JPEG and GIF (CLIENT_IMAGE_TYPE_UNSUPPORTED)', async () => {
    const { view, editor, sent, errors } = setup(doc(p('a')));
    for (const type of ['image/svg+xml', 'image/webp', 'image/tiff', 'text/html']) {
      await expect(editor.commands().get('insertImage')?.run(view, file(type))).resolves.toBe(false);
    }
    expect(sent).toHaveLength(0);
    expect(placeholders(view)).toBe(0);
    expect(errors.map((e) => e.code)).toEqual(Array(4).fill('CLIENT_IMAGE_TYPE_UNSUPPORTED'));
  });

  it('rejects bytes that do not decode as an image', async () => {
    const { view, editor, sent, errors } = setup(doc(p('a')), { measureImage: () => Promise.reject(new Error('bad')) });
    await expect(editor.commands().get('insertImage')?.run(view, file())).resolves.toBe(false);
    expect(sent).toHaveLength(0);
    expect(errors.map((e) => e.code)).toEqual(['CLIENT_IMAGE_TYPE_UNSUPPORTED']);
  });

  it('enforces the size limit (CLIENT_ASSET_TOO_LARGE)', async () => {
    const { view, editor, sent, errors, assets } = setup(doc(p('a')));
    assets.setMaxAssetBytes(PNG.length - 1);
    await expect(editor.commands().get('insertImage')?.run(view, file())).resolves.toBe(false);
    expect(sent).toHaveLength(0);
    expect(errors).toMatchObject([{ code: 'CLIENT_ASSET_TOO_LARGE', terminal: false }]);
  });

  it('opens the file picker without a file, and does nothing when read-only', async () => {
    const pickFile = vi.fn(() => Promise.resolve(null));
    const { view, editor } = setup(doc(p('a')), { pickFile });
    await expect(editor.commands().get('insertImage')?.run(view)).resolves.toBe(false);
    expect(pickFile).toHaveBeenCalledTimes(1);
    editor.setReadOnly(true);
    await expect(editor.commands().get('insertImage')?.run(view, file())).resolves.toBe(false);
  });

  it('pastes image files, but pastes text when the clipboard has text', async () => {
    const { view, put } = setup(doc(p('a')));
    select(view, 3);
    const ev = (text: string): ClipboardEvent => {
      const e = new Event('paste') as ClipboardEvent;
      Object.defineProperty(e, 'clipboardData', { value: { files: [file('image/gif')], getData: (t: string) => (t === 'text/plain' ? text : '') } });
      return e;
    };
    expect(view.someProp('handlePaste', (f) => f(view, ev('words'), Slice.empty))).toBeFalsy();
    expect(view.someProp('handlePaste', (f) => f(view, ev(''), Slice.empty))).toBe(true);
    await flush();
    expect(put()).toMatchObject({ mime: 'image/gif' });
  });

  it('inserts dropped files at the drop point', async () => {
    const { view, confirm } = setup(doc(p('one'), p('two')));
    select(view, 2);
    const at = posOf(view.state.doc, 'two') + 3;
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: at, inside: -1 });
    const e = new Event('drop', { cancelable: true }) as DragEvent;
    Object.defineProperty(e, 'dataTransfer', { value: { files: [file('image/jpeg')] } });
    expect(view.someProp('handleDrop', (f) => f(view, e, Slice.empty, false))).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    await flush();
    await confirm();
    const body = view.state.doc.child(0);
    expect(body.child(2).type).toBe(n.image);
  });

  it('pasted HTML cannot bring an external image or a script', () => {
    const { view } = setup(doc(p('a')));
    const html = '<p>x</p><img src="http://evil.example/x.png"><script>alert(1)</script><img src="javascript:1" data-asset-id="nope">';
    const slice = __parseFromClipboard(view, '', html, false, view.state.doc.resolve(2));
    const names: string[] = [];
    slice?.content.descendants((node) => {
      names.push(node.type.name);
    });
    expect(names).not.toContain('image');
    expect(slice?.content.textBetween(0, slice.content.size)).toBe('x');
  });
});

describe('ImageView', () => {
  const imageDoc = (attrs: Record<string, unknown> = {}): PMNode =>
    doc(p('a'), n.image.create({ assetId: ASSET_A, alt: 'pic', width: 100, height: 50, ...attrs }), p('b'));
  const imagePos = (v: EditorView): number => {
    let at = -1;
    v.state.doc.descendants((node, pos) => {
      if (node.type === n.image) at = pos;
    });
    return at;
  };

  it('requests an uncached asset and sets a blob src when it arrives', async () => {
    const { view, sent, assets } = setup(imageDoc());
    const img = view.dom.querySelector('img') as HTMLImageElement;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.alt).toBe('pic');
    expect(img.style.width).toBe('100pt');
    expect(img.closest('.odx-image')?.classList.contains('odx-image-loading')).toBe(true);
    const get = sent.find((x): x is AssetGetMsg => (x as AssetGetMsg).type === 'asset-get');
    expect(get?.assetId).toBe(ASSET_A);
    assets.onAsset({ type: 'asset', reqId: get?.reqId as number, assetId: ASSET_A, mime: 'image/png', size: 9, bytes: PNG });
    await flush();
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  it('never sets a non-blob src, and shows a broken box on failure', async () => {
    const { view } = setup(doc(p('x')));
    const make = (load: () => Promise<string>) =>
      new ImageView(n.image.create({ assetId: ASSET_A }), view, () => 1, {
        assets: { url: () => 'https://evil.example/x.png', load } as unknown as AssetCache,
        resize: new BlockResizeSignal(),
      });
    const a = make(() => Promise.resolve('https://evil.example/x.png'));
    const b = make(() => Promise.reject(new Error('gone')));
    await flush();
    for (const v of [a, b]) {
      expect(v.img.hasAttribute('src')).toBe(false);
      expect(v.dom.classList.contains('odx-image-broken')).toBe(true);
    }
  });

  it('shows handles when selected and saves width and height on a drag', () => {
    const { view } = setup(imageDoc());
    selectNode(view, imagePos(view));
    const handle = (k: string) => view.dom.querySelector(`[data-handle="${k}"]`) as HTMLElement;
    expect(handle('se').style.display).toBe('block');
    handle('se').dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 0 }));
    expect((view.dom.querySelector('img') as HTMLImageElement).style.width).toBe('130pt');
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 40, clientY: 0 }));
    expect(view.state.doc.nodeAt(imagePos(view))?.attrs).toMatchObject({ width: 130, height: 65 });
    selectNode(view, imagePos(view));
    handle('s').dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: -20 }));
    expect(view.state.doc.nodeAt(imagePos(view))?.attrs).toMatchObject({ width: 130, height: 50 });
  });

  it('has no working handles when read-only', () => {
    const { view } = setup(imageDoc(), {}, true);
    selectNode(view, imagePos(view));
    const handle = view.dom.querySelector('[data-handle="se"]') as HTMLElement;
    expect(handle.style.display).toBe('none');
    handle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 50 }));
    expect(view.state.doc.nodeAt(imagePos(view))?.attrs.width).toBe(100);
  });

  it('reports its size changes through the S-7 signal', () => {
    const observers: { cb: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
    class FakeResizeObserver {
      disconnect = vi.fn();
      constructor(cb: () => void) {
        observers.push({ cb, disconnect: this.disconnect });
      }
      observe(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const signal = new BlockResizeSignal();
    const seen: BlockResizeEvent[] = [];
    signal.subscribe((e) => seen.push(e));
    const { view, editor } = setup(imageDoc(), { blockResize: signal });
    expect(editor.blockResize).toBe(signal);
    expect(observers).toHaveLength(1);
    observers[0]?.cb();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pos).toBe(imagePos(view));
    expect(seen[0]?.node.type).toBe(n.image);
    editor.destroy();
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  it('revokes the blob URLs it showed when the asset cache is destroyed', async () => {
    const { view, editor, confirm, assets } = setup(doc(p('hello')));
    select(view, 7);
    void editor.commands().get('insertImage')?.run(view, file());
    await flush();
    await confirm();
    const src = view.dom.querySelector('img')?.getAttribute('src');
    expect(src).toMatch(/^blob:/);
    editor.destroy();
    assets.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(src);
  });
});
