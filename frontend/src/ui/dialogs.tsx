/**
 * Dialogs: Link, ImageAlt, PageSetup, TablePicker and Paragraph (LLD Part 3 §14; §0 S-39).
 *
 * They are controlled forms rendered in a portal inside `.odx-root`, so the adopter's page DOM
 * is not touched. Each applies its result through the editor's commands, or through
 * `TextEditorView.formatParagraph` for the Paragraph dialog.
 *
 * @module
 */
import { isAllowedHref } from '@open-docex/shared/text';
import type { LineHeight } from '@open-docex/shared/text';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_PAGE_PRESETS } from '../options.js';
import type { ParagraphFormat, TextEditorView } from '../text/TextEditorView.js';
import type { DialogId } from './dialogBus.js';
import { fill, useShell } from './useSession.js';

interface DialogProps {
  title: string;
  /** Returns an error label to keep the dialog open, or null when applied. */
  onSubmit: () => string | null;
  onClose: () => void;
  children: ReactNode;
}

function Dialog({ title, onSubmit, onClose, children }: DialogProps) {
  const { labels, container } = useShell();
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const err = onSubmit();
    if (err === null) onClose();
    else setError(err);
  };
  return createPortal(
    <div className="odx-dialog-backdrop">
      <form
        className="odx-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2>{title}</h2>
        {children}
        {error !== null && <p role="alert" className="odx-dialog-error">{error}</p>}
        <div className="odx-dialog-actions">
          <button type="submit" className="odx-btn">{labels.dialogs.ok}</button>
          <button type="button" className="odx-btn" onClick={onClose}>{labels.dialogs.cancel}</button>
        </div>
      </form>
    </div>,
    container,
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="odx-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

interface EditorDialogProps {
  editor: TextEditorView;
  onClose: () => void;
}

function LinkDialog({ editor, onClose }: EditorDialogProps) {
  const { labels } = useShell();
  const cmd = editor.commands().get('link');
  const [href, setHref] = useState(String(cmd?.value?.(editor.view.state) ?? ''));
  return (
    <Dialog
      title={labels.dialogs.linkTitle}
      onClose={onClose}
      onSubmit={() => {
        const v = href.trim();
        if (v !== '' && !isAllowedHref(v)) return labels.dialogs.linkInvalid;
        const ok = cmd?.run(editor.view, v);
        return ok === true ? null : labels.dialogs.linkInvalid;
      }}
    >
      <Field label={labels.dialogs.linkHref}>
        <input type="text" autoFocus value={href} onChange={(e) => setHref(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function ImageAltDialog({ editor, onClose }: EditorDialogProps) {
  const { labels } = useShell();
  const cmd = editor.commands().get('imageAlt');
  const [alt, setAlt] = useState(String(cmd?.value?.(editor.view.state) ?? ''));
  return (
    <Dialog
      title={labels.dialogs.imageAltTitle}
      onClose={onClose}
      onSubmit={() => (cmd?.run(editor.view, alt) === true ? null : labels.dialogs.invalidValue)}
    >
      <Field label={labels.dialogs.imageAlt}>
        <input type="text" autoFocus maxLength={1000} value={alt} onChange={(e) => setAlt(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function TablePicker({ editor, onClose }: EditorDialogProps) {
  const { labels } = useShell();
  const [rows, setRows] = useState('3');
  const [cols, setCols] = useState('3');
  return (
    <Dialog
      title={labels.dialogs.tableTitle}
      onClose={onClose}
      onSubmit={() => {
        const r = Number(rows);
        const c = Number(cols);
        return editor.commands().get('insertTable')?.run(editor.view, { rows: r, cols: c }) === true
          ? null
          : labels.dialogs.invalidValue;
      }}
    >
      <Field label={labels.dialogs.rows}>
        <input type="number" min={1} max={20} autoFocus value={rows} onChange={(e) => setRows(e.target.value)} />
      </Field>
      <Field label={labels.dialogs.columns}>
        <input type="number" min={1} max={20} value={cols} onChange={(e) => setCols(e.target.value)} />
      </Field>
      <p>{fill(labels.dialogs.tableSize, { rows, cols })}</p>
    </Dialog>
  );
}

function PageSetupDialog({ editor, onClose }: EditorDialogProps) {
  const { labels } = useShell();
  const attrs = editor.view.state.doc.attrs as {
    size: { width: number; height: number };
    orientation: 'portrait' | 'landscape';
    margins: { top: number; right: number; bottom: number; left: number };
  };
  const [f, setF] = useState({
    width: String(attrs.size.width),
    height: String(attrs.size.height),
    orientation: attrs.orientation,
    top: String(attrs.margins.top),
    right: String(attrs.margins.right),
    bottom: String(attrs.margins.bottom),
    left: String(attrs.margins.left),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (k: keyof typeof f) => (
    <input type="number" step="any" value={f[k]} onChange={set(k)} />
  );
  return (
    <Dialog
      title={labels.dialogs.pageSetupTitle}
      onClose={onClose}
      onSubmit={() => {
        const ok = editor.commands().get('pageSetup')?.run(editor.view, {
          size: { width: Number(f.width), height: Number(f.height) },
          orientation: f.orientation,
          margins: { top: Number(f.top), right: Number(f.right), bottom: Number(f.bottom), left: Number(f.left) },
        });
        return ok === true ? null : labels.dialogs.invalidPage;
      }}
    >
      <Field label={labels.dialogs.pageSize}>
        <select
          value=""
          onChange={(e) => {
            const p = DEFAULT_PAGE_PRESETS.find((x) => x.id === e.target.value);
            if (p) setF({ ...f, width: String(p.width), height: String(p.height) });
          }}
        >
          <option value="" />
          {DEFAULT_PAGE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.id}</option>
          ))}
        </select>
      </Field>
      <Field label={labels.dialogs.pageWidth}>{num('width')}</Field>
      <Field label={labels.dialogs.pageHeight}>{num('height')}</Field>
      <Field label={labels.dialogs.orientation}>
        <select value={f.orientation} onChange={(e) => setF({ ...f, orientation: e.target.value as 'portrait' | 'landscape' })}>
          <option value="portrait">{labels.dialogs.portrait}</option>
          <option value="landscape">{labels.dialogs.landscape}</option>
        </select>
      </Field>
      <fieldset>
        <legend>{labels.dialogs.margins}</legend>
        <Field label={labels.dialogs.marginTop}>{num('top')}</Field>
        <Field label={labels.dialogs.marginRight}>{num('right')}</Field>
        <Field label={labels.dialogs.marginBottom}>{num('bottom')}</Field>
        <Field label={labels.dialogs.marginLeft}>{num('left')}</Field>
      </fieldset>
    </Dialog>
  );
}

// --- Paragraph (PO-20, S-19, S-39) --------------------------------------------------------------

type LhKind = 'none' | LineHeight['kind'];

/** Parses a field: blank is `null` (clears the override), a non-number or out-of-range value is `undefined`. */
function parseField(text: string, min: number, max: number): number | null | undefined {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/**
 * Turns the Paragraph dialog's field text into a {@link ParagraphFormat} within the S-19 ranges:
 * spacing and left/right indent 0–1584 pt, first-line indent −1584–1584 pt (negative is a
 * hanging indent), line height a multiple 0.5–10 or exact/at-least 1–1584 pt. A blank field
 * clears that attribute. Returns null when any value is invalid.
 */
export function parseParagraphForm(f: {
  spacingBefore: string;
  spacingAfter: string;
  indentLeft: string;
  indentRight: string;
  indentFirstLine: string;
  lineKind: LhKind;
  lineValue: string;
}): ParagraphFormat | null {
  const spacingBefore = parseField(f.spacingBefore, 0, 1584);
  const spacingAfter = parseField(f.spacingAfter, 0, 1584);
  const indentLeft = parseField(f.indentLeft, 0, 1584);
  const indentRight = parseField(f.indentRight, 0, 1584);
  const indentFirstLine = parseField(f.indentFirstLine, -1584, 1584);
  if ([spacingBefore, spacingAfter, indentLeft, indentRight, indentFirstLine].includes(undefined)) return null;
  let lineHeight: LineHeight | null = null;
  if (f.lineKind === 'multiple') {
    const v = parseField(f.lineValue, 0.5, 10);
    if (v === undefined || v === null) return null;
    lineHeight = { kind: 'multiple', value: v };
  } else if (f.lineKind === 'exact' || f.lineKind === 'atLeast') {
    const v = parseField(f.lineValue, 1, 1584);
    if (v === undefined || v === null) return null;
    lineHeight = { kind: f.lineKind, pt: v };
  }
  return {
    spacingBefore: spacingBefore as number | null,
    spacingAfter: spacingAfter as number | null,
    indentLeft: indentLeft as number | null,
    indentRight: indentRight as number | null,
    indentFirstLine: indentFirstLine as number | null,
    lineHeight,
  };
}

function ParagraphDialog({ editor, onClose }: EditorDialogProps) {
  const { labels } = useShell();
  const attrs = editor.view.state.selection.$from.parent.attrs as Record<string, unknown>;
  const text = (k: string): string => (typeof attrs[k] === 'number' ? String(attrs[k]) : '');
  const lh = attrs.lineHeight as LineHeight | null | undefined;
  const kind0: LhKind = lh ? lh.kind : "none";
  const [f, setF] = useState({
    spacingBefore: text('spacingBefore'),
    spacingAfter: text('spacingAfter'),
    indentLeft: text('indentLeft'),
    indentRight: text('indentRight'),
    indentFirstLine: text('indentFirstLine'),
    lineKind: kind0,
    lineValue: lh ? String(lh.kind === 'multiple' ? lh.value : lh.pt) : '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (k: keyof typeof f, label: string, autoFocus = false) => (
    <Field label={label}>
      <input type="number" step="any" autoFocus={autoFocus} value={f[k]} onChange={set(k)} />
    </Field>
  );
  return (
    <Dialog
      title={labels.dialogs.paragraphTitle}
      onClose={onClose}
      onSubmit={() => {
        const format = parseParagraphForm(f);
        if (format === null) return labels.dialogs.invalidValue;
        return editor.formatParagraph(format) ? null : labels.dialogs.invalidValue;
      }}
    >
      {num('spacingBefore', labels.dialogs.spacingBefore, true)}
      {num('spacingAfter', labels.dialogs.spacingAfter)}
      <Field label={labels.dialogs.lineHeight}>
        <select value={f.lineKind} onChange={(e) => setF({ ...f, lineKind: e.target.value as LhKind })}>
          <option value="none">{labels.dialogs.lineHeightNone}</option>
          <option value="multiple">{labels.dialogs.lineHeightMultiple}</option>
          <option value="exact">{labels.dialogs.lineHeightExact}</option>
          <option value="atLeast">{labels.dialogs.lineHeightAtLeast}</option>
        </select>
      </Field>
      {f.lineKind !== 'none' && (
        <Field label={labels.dialogs.lineHeight}>
          <input type="number" step="any" value={f.lineValue} onChange={set('lineValue')} />
        </Field>
      )}
      {num('indentLeft', labels.dialogs.indentLeft)}
      {num('indentRight', labels.dialogs.indentRight)}
      {num('indentFirstLine', labels.dialogs.indentFirstLine)}
    </Dialog>
  );
}

/** Shows the dialog the bus asks for, over the current editor. */
export function DialogHost() {
  const { dialogs, getEditor } = useShell();
  const [open, setOpen] = useState<DialogId | null>(null);
  useEffect(() => dialogs.subscribe(setOpen), [dialogs]);
  const editor = getEditor();
  if (open === null || editor === null) return null;
  try {
    void editor.view;
  } catch {
    return null;
  }
  const props = { editor, onClose: () => setOpen(null) };
  switch (open) {
    case 'link': return <LinkDialog {...props} />;
    case 'imageAlt': return <ImageAltDialog {...props} />;
    case 'insertTable': return <TablePicker {...props} />;
    case 'pageSetup': return <PageSetupDialog {...props} />;
    case 'paragraph': return <ParagraphDialog {...props} />;
  }
}
