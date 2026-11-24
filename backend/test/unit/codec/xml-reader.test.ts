import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Base64Decoder, parseXmlFile, type XmlNode } from '../../../src/codec/xml-reader.js';

const dir = mkdtempSync(join(tmpdir(), 'docex-xml-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function file(xml: string): string {
  const p = join(dir, `f${String(n++)}.xml`);
  writeFileSync(p, xml);
  return p;
}
const MAX = 10_000_000;
const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

async function events(xml: string, treeElements?: ReadonlySet<string>) {
  const ev: string[] = [];
  const trees: XmlNode[] = [];
  const bins: Uint8Array[] = [];
  await parseXmlFile(
    file(xml),
    { maxBytes: MAX, ...(treeElements ? { treeElements } : {}) },
    {
      open: (name, attrs) => ev.push(`<${name}${Object.keys(attrs).map((k) => ` ${k}=${String(attrs[k])}`).join('')}>`),
      text: (t) => ev.push(t),
      close: (name) => ev.push(`</${name}>`),
      binary: (b) => void bins.push(b),
      tree: (t) => void trees.push(t),
    },
  );
  return { ev, trees, bins };
}

describe('parseXmlFile', () => {
  it('canonicalises namespace prefixes', async () => {
    const { ev } = await events(
      `<o:doc xmlns:o="${OFFICE}" xmlns:t="${TEXT}"><t:p t:style-name="P1">a &amp; b &#65;</t:p></o:doc>`,
    );
    expect(ev[0]).toBe('<office:doc>');
    expect(ev[1]).toBe('<text:p text:style-name=P1>');
    expect(ev.join('')).toContain('a & b A');
    expect(ev.at(-1)).toBe('</office:doc>');
  });
  it('keeps unknown namespaces as written and drops xmlns attributes', async () => {
    const { ev } = await events(`<a xmlns:z="urn:other"><z:b q="1"/></a>`);
    expect(ev).toEqual(['<a>', '<z:b q=1>', '</z:b>', '</a>']);
  });
  it('builds trees only for the requested elements', async () => {
    const { ev, trees } = await events(
      `<o:doc xmlns:o="${OFFICE}"><o:styles><o:s k="v">x</o:s></o:styles><o:body/></o:doc>`,
      new Set(['office:styles']),
    );
    expect(trees).toHaveLength(1);
    expect(trees[0]?.children[0]).toMatchObject({ name: 'office:s', attrs: { k: 'v' }, text: 'x' });
    expect(ev).toEqual(['<office:doc>', '<office:body>', '</office:body>', '</office:doc>']);
  });
  it('rejects a DOCTYPE with an entity (XXE) and an entity declaration', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d>&x;</d>`;
    await expect(events(xxe)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    await expect(events(`<!DOCTYPE d><d/>`)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    await expect(events(`<d><!ENTITY x "y"></d>`)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
  it('does not expand a billion-laughs style entity', async () => {
    const bomb = `<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><l>&b;</l>`;
    await expect(events(bomb)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
  it('caps depth, attributes and size', async () => {
    await expect(events('<a>'.repeat(300) + '</a>'.repeat(300))).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    const attrs = Array.from({ length: 257 }, (_, i) => `a${String(i)}="1"`).join(' ');
    await expect(events(`<a ${attrs}/>`)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    await expect(parseXmlFile(file('<a>' + 'x'.repeat(100) + '</a>'), { maxBytes: 50 }, {})).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
    });
  });
  it('accepts exactly the depth limit', async () => {
    await expect(events('<a>'.repeat(256) + '</a>'.repeat(256))).resolves.toBeDefined();
  });
  it('rejects truncated input', async () => {
    await expect(events('<a><b>')).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
  it('decodes office:binary-data incrementally across line breaks', async () => {
    const payload = Buffer.from('hello binary world, hello binary world!');
    const b64 = payload.toString('base64');
    const wrapped = b64.slice(0, 7) + '\n  ' + b64.slice(7, 20) + '\r\n' + b64.slice(20);
    const { bins, ev } = await events(`<o:d xmlns:o="${OFFICE}"><o:binary-data>${wrapped}</o:binary-data></o:d>`);
    expect(Buffer.from(bins[0] ?? new Uint8Array()).equals(payload)).toBe(true);
    expect(ev).toEqual(['<office:d>', '</office:d>']);
  });
  it('rejects invalid base64', async () => {
    await expect(events(`<o:d xmlns:o="${OFFICE}"><o:binary-data>@@@@</o:binary-data></o:d>`)).rejects.toMatchObject({
      code: 'CONVERSION_FAILED',
    });
    const d = new Base64Decoder();
    d.push('QUJD');
    d.push('RA');
    expect(() => d.finish()).toThrow();
  });
});
