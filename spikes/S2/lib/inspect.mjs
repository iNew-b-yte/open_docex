// Spike S2: reads a flat ODF text document into a small feature model (HLD §8.1) so that the
// fixture checks can compare what LibreOffice produced. Not the FodtMapper; spike-only.
import { find, kid, kids, parseXml, textOf } from './xml.mjs';

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 };
export function mm(v) {
  if (v == null) return undefined;
  const m = /^(-?[\d.]+)(mm|cm|in|pt|pc|px)$/.exec(v);
  if (!m) throw new Error(`unit not handled: ${v}`);
  return Number(m[1]) * UNIT_MM[m[2]];
}

export function sniff(bytes) {
  const hex = bytes.subarray(0, 4).toString('hex');
  if (hex === '89504e47') return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex === '47494638') return 'image/gif';
  if (hex === '49492a00' || hex === '4d4d002a') return 'image/tiff';
  if (hex === 'd7cdc69a' || hex === '01000900' || hex === '02000900') return 'image/x-wmf';
  if (hex === '01000000' && bytes.subarray(40, 44).toString('latin1') === ' EMF') return 'image/x-emf';
  if (/^\s*(<\?xml|<svg)/.test(bytes.subarray(0, 64).toString('utf8'))) return 'image/svg+xml';
  return `unknown:${hex}`;
}

const MAPPED = new Set([
  'text:p', 'text:h', 'text:span', 'text:a', 'text:line-break', 'text:tab', 'text:s', 'text:list', 'text:list-item',
  'table:table', 'table:table-column', 'table:table-header-rows', 'table:table-row', 'table:table-cell',
  'table:covered-table-cell', 'draw:frame', 'draw:image', 'office:binary-data', 'svg:title', 'svg:desc',
]);
const IGNORABLE = new Set(['text:soft-page-break', 'text:sequence-decls', 'text:sequence-decl', 'text:bookmark', 'text:bookmark-start', 'text:bookmark-end']);

export function inspect(src) {
  const root = parseXml(src);
  const doc = kid(root, 'office:document');
  const fonts = new Map();
  for (const f of find(doc, 'style:font-face')) fonts.set(f.attrs['style:name'], unq(f.attrs['svg:font-family']));

  const styles = new Map();
  const defaults = new Map();
  const listStyles = new Map();
  const pageLayouts = new Map();
  for (const sec of ['office:styles', 'office:automatic-styles']) {
    const s = kid(doc, sec);
    if (!s) continue;
    for (const st of kids(s, 'style:style')) styles.set(`${st.attrs['style:family']}/${st.attrs['style:name']}`, st);
    for (const st of kids(s, 'style:default-style')) defaults.set(st.attrs['style:family'], st);
    for (const st of kids(s, 'text:list-style')) listStyles.set(st.attrs['style:name'], st);
    for (const st of kids(s, 'style:page-layout')) pageLayouts.set(st.attrs['style:name'], st);
  }
  // A layer that sets one of style:font-name / fo:font-family overrides the other one from lower layers.
  const props = (st, kind) => {
    const a = { ...(kid(st, kind)?.attrs ?? {}) };
    if (kind === 'style:text-properties') {
      if (a['style:font-name'] && !a['fo:font-family']) a['fo:font-family'] = undefined;
      if (a['fo:font-family'] && !a['style:font-name']) a['style:font-name'] = undefined;
    }
    return a;
  };
  function chain(family, name) {
    const out = [];
    let st = styles.get(`${family}/${name}`);
    while (st) {
      out.unshift(st);
      const p = st.attrs['style:parent-style-name'];
      st = p ? styles.get(`${family}/${p}`) : undefined;
    }
    return out;
  }
  function resolve(family, name, kind) {
    const def = defaults.get(family);
    return Object.assign(def ? props(def, kind) : {}, ...chain(family, name).map((s) => props(s, kind)));
  }
  const textProps = (pStyleFamilyName, spanNames) => {
    const t = resolve('paragraph', pStyleFamilyName, 'style:text-properties');
    for (const n of spanNames) Object.assign(t, ...chain('text', n).map((s) => props(s, 'style:text-properties')));
    return t;
  };
  const runInfo = (t) => ({
    bold: t['fo:font-weight'] === 'bold' || Number(t['fo:font-weight']) >= 600,
    italic: t['fo:font-style'] === 'italic',
    underline: !!t['style:text-underline-style'] && t['style:text-underline-style'] !== 'none',
    strike: !!t['style:text-line-through-style'] && t['style:text-line-through-style'] !== 'none',
    fontFamily: t['style:font-name'] ? (fonts.get(t['style:font-name']) ?? t['style:font-name']) : unq(t['fo:font-family']),
    fontSize: t['fo:font-size'],
    color: t['fo:color']?.toLowerCase(),
  });

  // Page: the master page of the first body paragraph, else "Standard".
  const masters = find(kid(doc, 'office:master-styles') ?? { children: [] }, 'style:master-page');
  const office = kid(kid(doc, 'office:body'), 'office:text');
  const firstP = find(office, 'text:p')[0] ?? find(office, 'text:h')[0];
  const firstMaster = firstP && chain('paragraph', firstP.attrs['text:style-name']).map((s) => s.attrs['style:master-page-name']).filter(Boolean).at(-1);
  const master = masters.find((m) => m.attrs['style:name'] === (firstMaster || 'Standard')) ?? masters[0];
  const pl = pageLayouts.get(master?.attrs['style:page-layout-name']);
  const plp = pl ? props(pl, 'style:page-layout-properties') : {};
  const hf = (k) => kid(kid(pl ?? { children: [] }, k) ?? { children: [] }, 'style:header-footer-properties')?.attrs ?? {};
  const page = {
    width: mm(plp['fo:page-width']), height: mm(plp['fo:page-height']), orientation: plp['style:print-orientation'],
    top: mm(plp['fo:margin-top']), bottom: mm(plp['fo:margin-bottom']), left: mm(plp['fo:margin-left']), right: mm(plp['fo:margin-right']),
    headerMinHeight: mm(hf('style:header-style')['fo:min-height']), headerSpacing: mm(hf('style:header-style')['fo:margin-bottom']),
    footerMinHeight: mm(hf('style:footer-style')['fo:min-height']), footerSpacing: mm(hf('style:footer-style')['fo:margin-top']),
  };
  const fieldText = (el) => el.children.map((c) => {
    if (typeof c === 'string') return c.replace(/\s+/g, ' ');
    if (c.name === 'text:page-number') return '{PAGE}';
    if (c.name === 'text:page-count') return '{COUNT}';
    if (c.name === 'text:s') return ' '.repeat(Number(c.attrs['text:c'] ?? 1));
    return fieldText(c);
  }).join('');
  const hfText = (name) => (master ? kids(master, name).flatMap((h) => find(h, 'text:p').map(fieldText)) : []);
  const otherHF = master ? kids(master).map((c) => c.name).filter((n) => !['style:header', 'style:footer'].includes(n)) : [];

  // Body walk.
  const blocks = [];
  const unknown = new Map();
  const ignored = new Map();
  const note = (m, n) => m.set(n, (m.get(n) ?? 0) + 1);
  let listSeq = 0;
  function para(el, ctx) {
    const sname = el.attrs['text:style-name'];
    const pp = resolve('paragraph', sname, 'style:paragraph-properties');
    const runs = [];
    const frames = [];
    let text = '';
    const walk = (node, spans, href) => {
      for (const c of node.children) {
        if (typeof c === 'string') {
          if (/^\s*$/.test(c) && c.includes('\n')) continue;
          const s = c.replace(/[ \t\r\n]+/g, ' ');
          text += s;
          runs.push({ text: s, href, ...runInfo(textProps(sname, spans)) });
          continue;
        }
        if (!MAPPED.has(c.name)) note(IGNORABLE.has(c.name) ? ignored : unknown, c.name);
        if (c.name === 'text:span') walk(c, [...spans, c.attrs['text:style-name']].filter(Boolean), href);
        else if (c.name === 'text:a') walk(c, [...spans, c.attrs['text:style-name']].filter(Boolean), c.attrs['xlink:href']);
        else if (c.name === 'text:line-break') text += '\n';
        else if (c.name === 'text:tab') text += '\t';
        else if (c.name === 'text:s') text += ' '.repeat(Number(c.attrs['text:c'] ?? 1));
        else if (c.name === 'draw:frame') frames.push(frame(c));
        else if (!IGNORABLE.has(c.name)) walk(c, spans, href);
      }
    };
    walk(el, [], undefined);
    blocks.push({
      type: el.name === 'text:h' ? 'heading' : 'paragraph',
      level: el.name === 'text:h' ? Number(el.attrs['text:outline-level']) : undefined,
      styleChain: chain('paragraph', sname).map((s) => s.attrs['style:name']),
      text, runs, frames,
      align: pp['fo:text-align'],
      spacingBefore: mm(pp['fo:margin-top']), spacingAfter: mm(pp['fo:margin-bottom']),
      lineHeight: pp['fo:line-height'] ?? (pp['style:line-height-at-least'] ? `atLeast:${pp['style:line-height-at-least']}` : pp['style:line-spacing'] ? `spacing:${pp['style:line-spacing']}` : undefined),
      indentLeft: mm(pp['fo:margin-left']), indentRight: mm(pp['fo:margin-right']), indentFirst: mm(pp['fo:text-indent']),
      breakBefore: pp['fo:break-before'], breakAfter: pp['fo:break-after'],
      list: ctx.list, table: ctx.table,
      paraListStyle: chain('paragraph', sname).map((s) => s.attrs['style:list-style-name']).filter(Boolean).at(-1),
    });
  }
  function frame(f) {
    const images = find(f, 'draw:image').map((im) => {
      const bin = kid(im, 'office:binary-data');
      const bytes = bin ? Buffer.from(textOf(bin).replace(/\s+/g, ''), 'base64') : undefined;
      return { declared: im.attrs['draw:mime-type'], sniffed: bytes ? sniff(bytes) : undefined, href: im.attrs['xlink:href'], bytes };
    });
    const other = kids(f).map((c) => c.name).filter((n) => !['draw:image', 'svg:title', 'svg:desc'].includes(n));
    return {
      name: f.attrs['draw:name'], anchor: f.attrs['text:anchor-type'], width: mm(f.attrs['svg:width']), height: mm(f.attrs['svg:height']),
      title: kid(f, 'svg:title') ? textOf(kid(f, 'svg:title')) : undefined, desc: kid(f, 'svg:desc') ? textOf(kid(f, 'svg:desc')) : undefined,
      images, other,
    };
  }
  function listKind(styleName, depth) {
    const ls = listStyles.get(styleName);
    if (!ls) return `unknown-style:${styleName}`;
    const lvl = kids(ls).find((c) => Number(c.attrs['text:level']) === depth);
    if (!lvl) return 'no-level';
    return lvl.name === 'text:list-level-style-bullet' ? 'bullet' : lvl.name === 'text:list-level-style-number' ? 'number' : lvl.name;
  }
  function container(el, ctx) {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (!MAPPED.has(c.name)) note(IGNORABLE.has(c.name) ? ignored : unknown, c.name);
      if (c.name === 'text:p' || c.name === 'text:h') para(c, ctx);
      else if (c.name === 'text:list') {
        const depth = (ctx.list?.depth ?? 0) + 1;
        const styleName = c.attrs['text:style-name'] ?? ctx.list?.styleName;
        const listId = depth === 1 ? ++listSeq : ctx.list.listId;
        for (const item of kids(c, 'text:list-item')) {
          container(item, { ...ctx, list: { depth, styleName, listId, kind: listKind(styleName, depth) } });
        }
      } else if (c.name === 'table:table') table(c, ctx);
      else if (!IGNORABLE.has(c.name)) container(c, ctx);
    }
  }
  const tables = [];
  function table(t, ctx) {
    const cols = [];
    for (const col of find(t, 'table:table-column')) {
      const st = styles.get(`table-column/${col.attrs['table:style-name']}`);
      const w = st ? mm(props(st, 'style:table-column-properties')['style:column-width']) : undefined;
      for (let i = 0; i < Number(col.attrs['table:number-columns-repeated'] ?? 1); i++) cols.push(w);
    }
    const rows = [];
    const collect = (parent, header) => {
      for (const r of kids(parent)) {
        if (r.name === 'table:table-header-rows') collect(r, true);
        else if (r.name === 'table:table-row' || r.name === 'table:table-rows') {
          if (r.name === 'table:table-rows') { collect(r, header); continue; }
          rows.push({
            header,
            cells: kids(r).filter((c) => c.name === 'table:table-cell' || c.name === 'table:covered-table-cell').map((c) => ({
              covered: c.name === 'table:covered-table-cell', text: find(c, 'text:p').map(textOf).join('\n').trim(),
              colspan: Number(c.attrs['table:number-columns-spanned'] ?? 1), rowspan: Number(c.attrs['table:number-rows-spanned'] ?? 1),
            })),
          });
        }
      }
    };
    collect(t, false);
    const tb = { name: t.attrs['table:name'], cols, rows };
    tables.push(tb);
    for (const cell of find(t, 'table:table-cell')) container(cell, { ...ctx, table: tb.name });
  }
  container(office, {});

  return {
    defaultText: runInfo(resolve('paragraph', '__none__', 'style:text-properties')),
    page, masterCount: masters.length, header: hfText('style:header'), footer: hfText('style:footer'), otherHF,
    blocks, tables, unknown: Object.fromEntries(unknown), ignored: Object.fromEntries(ignored),
  };
}
const unq = (s) => s?.replace(/^['"]|['"]$/g, '');
