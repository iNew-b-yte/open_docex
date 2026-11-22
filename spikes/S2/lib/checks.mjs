// Spike S2: per-feature checks against the expected content of the `features` fixtures.
// Each check returns { feature, id, pass, detail } where detail is the observed value.
const near = (a, b, tol = 0.3) => typeof a === 'number' && Math.abs(a - b) <= tol;
const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
const LEFT = new Set([undefined, 'start', 'left']);
const RIGHT = new Set(['end', 'right']);

export const FEATURES = [
  ['F01', 'Page size, orientation, margins (CL-9)'],
  ['F02', 'Header/footer with page number + page count (PO-21)'],
  ['F03', 'Document default font family/size/colour (R-14)'],
  ['F04', 'Headings 1-6 (+ heading align/spacing, L-2)'],
  ['F05', 'Paragraph alignment'],
  ['F06', 'Spacing before/after (PO-20)'],
  ['F07', 'Line height (PO-20)'],
  ['F08', 'Indent left/right/first-line (PO-20)'],
  ['F09', 'Marks bold/italic/underline/strike'],
  ['F10', 'text_style fontFamily/fontSize/color'],
  ['F11', 'Links http(s)/mailto'],
  ['F12', 'hard_break, tab, multiple/leading spaces'],
  ['F13', 'Bullet/ordered lists, nested'],
  ['F14', 'Table: header row, colspan, rowspan'],
  ['F15', 'Table column widths (PO-25)'],
  ['F16', 'Images PNG/JPEG/GIF + width/height/alt (PO-24)'],
  ['F17', 'Page break (before/after)'],
];

export function runChecks(m) {
  const out = [];
  const ck = (feature, id, pass, detail) => out.push({ feature, id, pass: !!pass, detail });
  const blk = (prefix) => m.blocks.find((b) => b.text.trim().startsWith(prefix));
  const run = (txt) => m.blocks.flatMap((b) => b.runs).find((r) => r.text.trim() === txt);

  const p = m.page;
  ck('F01', 'size 210x148 landscape', near(p.width, 210, 0.5) && near(p.height, 148, 0.5) && p.orientation === 'landscape', `${r1(p.width)}x${r1(p.height)} ${p.orientation}`);
  ck('F01', 'margins t15 b20 l25 r30', near(p.top, 15) && near(p.bottom, 20) && near(p.left, 25) && near(p.right, 30),
    `t${r1(p.top)} b${r1(p.bottom)} l${r1(p.left)} r${r1(p.right)}; header min-h ${r1(p.headerMinHeight)} sp ${r1(p.headerSpacing)}; footer min-h ${r1(p.footerMinHeight)} sp ${r1(p.footerSpacing)}`);
  ck('F01', 'single master page', m.masterCount === 1, `${m.masterCount} master page(s)`);

  const h = m.header.join('|').replace(/\s+/g, ' ').trim();
  const f = m.footer.join('|').replace(/\s+/g, ' ').trim();
  ck('F02', 'header "HDR Page {PAGE} of {COUNT}"', h === 'HDR Page {PAGE} of {COUNT}', h);
  ck('F02', 'footer "FTR {PAGE}/{COUNT}"', f === 'FTR {PAGE}/{COUNT}', f);
  ck('F02', 'no first/left header-footer', m.otherHF.length === 0, m.otherHF.join(',') || 'none');

  const d = m.defaultText;
  ck('F03', 'default-style Liberation Sans 11pt #333333', d.fontFamily === 'Liberation Sans' && d.fontSize === '11pt' && d.color === '#333333', `${d.fontFamily} ${d.fontSize} ${d.color}`);
  const plain = run('PLAIN');
  ck('F03', 'plain run resolves to defaults', plain && plain.fontFamily === 'Liberation Sans' && plain.fontSize === '11pt' && plain.color === '#333333', plain && `${plain.fontFamily} ${plain.fontSize} ${plain.color}`);

  const names = ['one', 'two', 'three', 'four', 'five', 'six'];
  for (let i = 1; i <= 6; i++) {
    const b = blk(`H${i} Heading ${names[i - 1]}`);
    ck('F04', `H${i} is heading level ${i} (Heading_20_${i})`, b?.type === 'heading' && b.level === i && b.styleChain.includes(`Heading_20_${i}`), b && `${b.type} ${b.level} [${b.styleChain.join('>')}]`);
  }
  const h2c = blk('H2C');
  ck('F04', 'heading align center', h2c?.type === 'heading' && h2c.level === 2 && h2c.align === 'center', h2c && `${h2c.type} ${h2c.level} ${h2c.align}`);
  const h3s = blk('H3S');
  ck('F04', 'heading spacing-before 3 / indent-left 8', h3s?.level === 3 && near(h3s.spacingBefore, 3) && near(h3s.indentLeft, 8), h3s && `before ${r1(h3s.spacingBefore)} left ${r1(h3s.indentLeft)}`);

  const al = (t, ok) => { const b = blk(t); ck('F05', t, b && ok(b.align), b?.align ?? 'unset'); };
  al('ALIGN-LEFT', (a) => LEFT.has(a));
  al('ALIGN-CENTER', (a) => a === 'center');
  al('ALIGN-RIGHT', (a) => RIGHT.has(a));
  al('ALIGN-JUSTIFY', (a) => a === 'justify');

  const sp = blk('SPACING');
  ck('F06', 'before 4 after 6', sp && near(sp.spacingBefore, 4) && near(sp.spacingAfter, 6), sp && `${r1(sp.spacingBefore)}/${r1(sp.spacingAfter)}`);
  const plainP = blk('ALIGN-CENTER');
  ck('F06', 'unspaced paragraph has 0/unset', plainP && !(plainP.spacingBefore > 0.05) && !(plainP.spacingAfter > 0.05), plainP && `${r1(plainP.spacingBefore)}/${r1(plainP.spacingAfter)}`);

  const lh = blk('LINEHEIGHT');
  ck('F07', 'line-height 150%', lh?.lineHeight === '150%', lh?.lineHeight);

  const ind = blk('INDENT left');
  ck('F08', 'left 10 right 15 first 5', ind && near(ind.indentLeft, 10) && near(ind.indentRight, 15) && near(ind.indentFirst, 5), ind && `${r1(ind.indentLeft)}/${r1(ind.indentRight)}/${r1(ind.indentFirst)}`);
  const hang = blk('INDENT-HANG');
  ck('F08', 'hanging: left 20 first -5', hang && near(hang.indentLeft, 20) && near(hang.indentFirst, -5), hang && `${r1(hang.indentLeft)}/${r1(hang.indentFirst)}`);

  const mk = (txt, pred) => { const r = run(txt); ck('F09', txt, r && pred(r), r && ['bold', 'italic', 'underline', 'strike'].filter((k) => r[k]).join('+')); };
  mk('BOLD', (r) => r.bold && !r.italic);
  mk('ITALIC', (r) => r.italic && !r.bold);
  mk('UNDER', (r) => r.underline && !r.strike);
  mk('STRIKE', (r) => r.strike && !r.underline);
  mk('PLAIN', (r) => !r.bold && !r.italic && !r.underline && !r.strike);
  const combo = run('COMBO');
  ck('F09', 'COMBO bold+italic+#0070c0', combo?.bold && combo.italic && combo.color === '#0070c0', combo && `${combo.bold} ${combo.italic} ${combo.color}`);

  const fam = run('FONTFAM');
  ck('F10', 'fontFamily DejaVu Sans', fam?.fontFamily === 'DejaVu Sans', fam?.fontFamily);
  const fs = run('FONTSIZE');
  ck('F10', 'fontSize 18pt', fs?.fontSize === '18pt', fs?.fontSize);
  const col = run('COLOR');
  ck('F10', 'color #c00000', col?.color === '#c00000', col?.color);

  const lk = (txt, href) => { const r = run(txt); ck('F11', txt, r?.href === href, r?.href); };
  lk('LINK-HTTP', 'https://example.com/a?b=1&c=2');
  lk('LINK-MAIL', 'mailto:test@example.com');

  const tx = (prefix, want) => { const b = blk(prefix); ck('F12', JSON.stringify(want), b?.text === want, JSON.stringify(b?.text)); };
  tx('BREAK-A', 'BREAK-A\nBREAK-B');
  tx('TAB-A', 'TAB-A\tTAB-B');
  tx('SPACE-A', 'SPACE-A    SPACE-B');
  { const b = m.blocks.find((x) => x.text.includes('LEAD-SPACE')); ck('F12', '" LEAD-SPACE"', b?.text === ' LEAD-SPACE', JSON.stringify(b?.text)); }

  const li = (t, kind, depth) => { const b = blk(t); ck('F13', `${t} ${kind} depth ${depth}`, b?.list?.kind === kind && b.list.depth === depth, b?.list ? `${b.list.kind} ${b.list.depth} (${b.list.styleName})` : 'not in list'); };
  li('BUL-1', 'bullet', 1); li('BUL-1-1', 'bullet', 2); li('BUL-2', 'bullet', 1);
  li('NUM-1', 'number', 1); li('NUM-2', 'number', 1); li('NUM-2-1', 'number', 2);
  const b1 = blk('BUL-1'), b2 = blk('BUL-2'), n1 = blk('NUM-1');
  ck('F13', 'BUL-1/BUL-2 one list, NUM another', b1?.list && b1.list.listId === b2?.list?.listId && b1.list.listId !== n1?.list?.listId, `${b1?.list?.listId},${b2?.list?.listId},${n1?.list?.listId}`);

  const t = m.tables[0];
  const cell = (txt) => t?.rows.flatMap((r) => r.cells).find((c) => c.text === txt);
  ck('F14', 'one table, 4 rows', m.tables.length === 1 && t.rows.length === 4, `${m.tables.length} table(s), ${t?.rows.length} rows`);
  ck('F14', 'header row = TH-A,TH-B,TH-C', t?.rows[0]?.header && t.rows.filter((r) => r.header).length === 1 && t.rows[0].cells.map((c) => c.text).join(',') === 'TH-A,TH-B,TH-C', t?.rows.map((r) => (r.header ? 'H' : 'B')).join(''));
  ck('F14', 'MERGE-COL colspan 2', cell('MERGE-COL')?.colspan === 2, cell('MERGE-COL')?.colspan);
  ck('F14', 'MERGE-ROW rowspan 2', cell('MERGE-ROW')?.rowspan === 2, cell('MERGE-ROW')?.rowspan);
  ck('F14', 'cell grid 3 wide incl. covered', t?.rows.every((r) => r.cells.length === 3), t?.rows.map((r) => r.cells.length).join(','));
  ck('F15', 'col widths 30/50/70', t && t.cols.length === 3 && near(t.cols[0], 30) && near(t.cols[1], 50) && near(t.cols[2], 70), t?.cols.map(r1).join('/'));

  const im = (name, mime, w, hgt, alt) => {
    const fr = m.blocks.flatMap((b) => b.frames.map((x) => ({ ...x, alone: b.text.trim() === '' && b.frames.length === 1 }))).find((x) => x.title === alt || x.name === name);
    const mimes = fr?.images.map((i) => i.sniffed).join('+');
    ck('F16', `${alt} ${mime} ${w}x${hgt}mm as-char alone`, fr && fr.images.length === 1 && fr.images[0].sniffed === mime && near(fr.width, w) && near(fr.height, hgt) && fr.anchor === 'as-char' && fr.alone,
      fr ? `${mimes} ${r1(fr.width)}x${r1(fr.height)} ${fr.anchor}${fr.alone ? '' : ' NOT-ALONE'}` : 'missing');
    ck('F16', `${alt} title/desc kept`, fr?.title === alt && fr?.desc === `${alt} desc`, fr && `title=${JSON.stringify(fr.title)} desc=${JSON.stringify(fr.desc)}`);
  };
  im('ImgPng', 'image/png', 40, 20, 'ALT-PNG');
  im('ImgJpeg', 'image/jpeg', 30, 15, 'ALT-JPEG');
  im('ImgGif', 'image/gif', 20, 10, 'ALT-GIF');

  const pb = blk('PB-NEXT');
  ck('F17', 'PB-NEXT break-before page', pb?.breakBefore === 'page', pb?.breakBefore ?? 'none');
  const prev = blk('PB2-PREV'), next = blk('PB2-NEXT');
  ck('F17', 'break between PB2-PREV and PB2-NEXT', prev?.breakAfter === 'page' || next?.breakBefore === 'page', `prev.after=${prev?.breakAfter} next.before=${next?.breakBefore}`);
  const extra = m.blocks.filter((b) => b.text.trim() === '' && b.frames.length === 0 && !b.table);
  ck('F17', 'no extra empty paragraphs', extra.length === 0, `${extra.length} empty`);
  return out;
}
