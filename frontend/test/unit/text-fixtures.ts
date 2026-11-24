/**
 * Test helpers for the text editor under jsdom (LLD §0 S-27 (6): jsdom tests type their DOM
 * globals locally).
 *
 * jsdom has no layout: `Range.getClientRects`, `getBoundingClientRect` on ranges and
 * `elementFromPoint` are missing. {@link installDomStubs} adds inert versions, so ProseMirror's
 * scroll-into-view can run, and replaces `URL.createObjectURL`/`revokeObjectURL` with spies.
 */
import { textSchema } from '@open-docex/shared/text';
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { vi } from 'vitest';
import { AssetCache } from '../../src/assets/AssetCache.js';
import type { ClientError } from '../../src/events.js';
import { DEFAULT_LABELS } from '../../src/labels.js';
import { DEFAULT_FONT_FAMILIES, DEFAULT_FONT_SIZES, TEXT_TOOLBAR_ITEMS } from '../../src/options.js';
import { TextEditorView, type TextEditorDeps } from '../../src/text/TextEditorView.js';

export const n = textSchema.nodes;
export const m = textSchema.marks;

/** A4 portrait, 72 pt margins. Content width 595.28 − 144 = 451.28 pt. */
export const PAGE = {
  size: { width: 595.28, height: 841.89 },
  orientation: 'portrait',
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
} as const;

type Inline = string | PMNode;
const inline = (c: Inline[]): PMNode[] => c.map((x) => (typeof x === 'string' ? textSchema.text(x) : x));

export const p = (...c: Inline[]): PMNode => n.paragraph.create(null, inline(c));
export const h = (level: number, ...c: Inline[]): PMNode => n.heading.create({ level }, inline(c));
export const li = (...blocks: PMNode[]): PMNode => n.list_item.create(null, blocks);
export const ul = (...items: PMNode[]): PMNode => n.bullet_list.create(null, items);
export const cell = (attrs: Record<string, unknown> | null, ...blocks: PMNode[]): PMNode =>
  n.table_cell.create(attrs, blocks.length > 0 ? blocks : [p()]);
export const row = (...cells: PMNode[]): PMNode => n.table_row.create(null, cells);
export const table = (...rows: PMNode[]): PMNode => n.table.create(null, rows);
export const doc = (...blocks: PMNode[]): PMNode => n.doc.create(PAGE, [n.body.create(null, blocks)]);

/** A 64-character asset ID. */
export const ASSET_A = 'a'.repeat(64);

let urlCounter = 0;

/** Adds the jsdom stubs ProseMirror and the asset cache need. Safe to call more than once. */
export function installDomStubs(): void {
  const rangeProto = Range.prototype as unknown as Record<string, unknown>;
  rangeProto.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  rangeProto.getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  const d = document as unknown as Record<string, unknown>;
  d.elementFromPoint ??= () => null;
  // Always spies, so tests can count revocations and URLs are browser-like.
  const u = URL as unknown as Record<string, unknown>;
  if (!vi.isMockFunction(u.createObjectURL)) {
    u.createObjectURL = vi.fn(() => `blob:http://localhost/${String(++urlCounter)}`);
    u.revokeObjectURL = vi.fn();
  }
}

/** Places a text selection. */
export function select(view: EditorView, from: number, to = from): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Selects the node at `pos`. */
export function selectNode(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
}

/** The first position of `text` in the document, or −1. */
export function posOf(d: PMNode, text: string): number {
  let at = -1;
  d.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isText && node.text !== undefined) {
      const i = node.text.indexOf(text);
      if (i >= 0) at = pos + i;
    }
    return at < 0;
  });
  return at;
}

/** A sent-message log and an `AssetCache` over it. */
export function assetHarness(opts: { connected?: () => boolean } = {}) {
  const sent: unknown[] = [];
  const assets = new AssetCache({
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    connected: opts.connected ?? (() => true),
  });
  return { assets, sent };
}

/** An editor in a fresh host, with an asset cache and an error log. */
export function makeEditor(d: PMNode, extra: Partial<TextEditorDeps> = {}, readOnly = false) {
  installDomStubs();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { assets, sent } = assetHarness();
  const errors: ClientError[] = [];
  const editor = new TextEditorView(host, {
    assets,
    labels: DEFAULT_LABELS,
    toolbar: { items: TEXT_TOOLBAR_ITEMS, fontFamilies: DEFAULT_FONT_FAMILIES, fontSizes: DEFAULT_FONT_SIZES },
    onError: (e) => errors.push(e),
    ...extra,
  });
  editor.load(d, { readOnly });
  return { editor, view: editor.view, assets, sent, errors, host };
}
