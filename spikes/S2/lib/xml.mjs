// Spike S2: a minimal XML-to-tree reader for inspecting LibreOffice's flat ODF output.
// Spike-only (no dependency). It refuses DOCTYPE/ENTITY like the planned xml-reader (LLD §14.4)
// and decodes only predefined and numeric entities. Not namespace-aware: it relies on the
// prefixes LibreOffice writes, which the real reader must not do (LLD §14.4).
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m),
  );

export function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack.at(-1).children.push(decode(src.slice(i, lt)));
    if (src.startsWith('<?', lt)) { i = src.indexOf('?>', lt) + 2; continue; }
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      stack.at(-1).children.push(src.slice(lt + 9, e));
      i = e + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) throw new Error('DOCTYPE/ENTITY refused');
    const gt = src.indexOf('>', lt);
    let tag = src.slice(lt + 1, gt);
    if (tag[0] === '/') { stack.pop(); i = gt + 1; continue; }
    const selfClose = tag.endsWith('/');
    if (selfClose) tag = tag.slice(0, -1);
    const m = /^([^\s]+)/.exec(tag);
    const el = { name: m[1], attrs: {}, children: [] };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = re.exec(tag))) el.attrs[a[1]] = decode(a[3] ?? a[4]);
    stack.at(-1).children.push(el);
    if (!selfClose) stack.push(el);
    i = gt + 1;
  }
  return root;
}

export const kids = (el, name) => el.children.filter((c) => typeof c !== 'string' && (!name || c.name === name));
export const kid = (el, name) => kids(el, name)[0];
export function find(el, name, out = []) {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.name === name) out.push(c);
    find(c, name, out);
  }
  return out;
}
export const textOf = (el) => el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
