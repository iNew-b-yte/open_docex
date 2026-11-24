/**
 * Hardened flat-XML reader (LLD Part 2 §14.4). Streams a file through `htmlparser2` in XML
 * mode. DTDs and entity declarations abort the parse, so external entities and expansion are
 * impossible; size, depth and attribute counts are capped; names are mapped to canonical ODF
 * prefixes; `office:binary-data` is base64-decoded incrementally.
 *
 * @module
 */
import { createReadStream, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { OpenDocexError } from '@open-docex/shared/errors';
import { Parser } from 'htmlparser2';
import { engineError } from '../errors/engine-error.js';

/** Maximum element nesting depth (§14.4). */
export const MAX_XML_DEPTH = 256;
/** Maximum attributes on one element (§14.4). */
export const MAX_XML_ATTRIBUTES = 256;

const NS = 'urn:oasis:names:tc:opendocument:xmlns:';
/** Namespace URI → canonical prefix. */
const CANONICAL: ReadonlyMap<string, string> = new Map([
  [`${NS}office:1.0`, 'office'],
  [`${NS}style:1.0`, 'style'],
  [`${NS}text:1.0`, 'text'],
  [`${NS}table:1.0`, 'table'],
  [`${NS}drawing:1.0`, 'draw'],
  [`${NS}xsl-fo-compatible:1.0`, 'fo'],
  [`${NS}svg-compatible:1.0`, 'svg'],
  ['http://www.w3.org/1999/xlink', 'xlink'],
  [`${NS}datastyle:1.0`, 'number'],
  [`${NS}config:1.0`, 'config'],
  ['urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0', 'calcext'],
  ['urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0', 'loext'],
  [`${NS}of:1.2`, 'of'],
]);

/** A small tree for the style and settings sections. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text. */
  text: string;
}

/** Receives parse events. Names and attribute names are canonical (`text:p`, `fo:color`). */
export interface XmlHandlers {
  open?(name: string, attrs: Record<string, string>, depth: number): void;
  text?(text: string): void;
  close?(name: string, depth: number): void;
  /** The decoded bytes of one `office:binary-data` element. May return a promise. */
  binary?(bytes: Uint8Array): void | Promise<void>;
  /** A finished subtree of one of {@link XmlReadOptions.treeElements}; its events are not streamed. */
  tree?(node: XmlNode): void;
}

/** Options for {@link parseXmlFile}. */
export interface XmlReadOptions {
  /** `DOCUMENT_TOO_LARGE` above this many bytes (`maxFlatXmlBytes`, §0.5 S-15). */
  maxBytes: number;
  /** Canonical element names to build as trees, such as `office:styles`. */
  treeElements?: ReadonlySet<string>;
}

/** Incremental base64 decoder that skips whitespace (LibreOffice wraps the lines). */
export class Base64Decoder {
  #carry = '';
  readonly #out: Buffer[] = [];

  /** Adds text. Throws `CONVERSION_FAILED` on a character outside the base64 alphabet. */
  push(s: string): void {
    const clean = s.replace(/[ \t\r\n]/g, '');
    if (/[^A-Za-z0-9+/=]/.test(clean)) throw engineError('CONVERSION_FAILED', { message: 'Invalid base64 image data' });
    const all = this.#carry + clean;
    const usable = all.length - (all.length % 4);
    if (usable > 0) this.#out.push(Buffer.from(all.slice(0, usable), 'base64'));
    this.#carry = all.slice(usable);
  }

  /** Returns every decoded byte. A dangling partial group is invalid. */
  finish(): Uint8Array {
    if (this.#carry.length > 0) throw engineError('CONVERSION_FAILED', { message: 'Truncated base64 image data' });
    const b = Buffer.concat(this.#out);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
}

type Scope = ReadonlyMap<string, string>;

function resolveName(raw: string, scope: Scope, isAttr: boolean): string {
  const i = raw.indexOf(':');
  if (i < 0) {
    if (isAttr) return raw;
    const uri = scope.get('');
    const canon = uri === undefined ? undefined : CANONICAL.get(uri);
    return canon === undefined ? raw : `${canon}:${raw}`;
  }
  const uri = scope.get(raw.slice(0, i));
  const canon = uri === undefined ? undefined : CANONICAL.get(uri);
  return canon === undefined ? raw : `${canon}:${raw.slice(i + 1)}`;
}

function failed(message: string, cause?: unknown): Error {
  return engineError('CONVERSION_FAILED', { message, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Parses the file at `path`. Throws `DOCUMENT_TOO_LARGE` over `maxBytes`, otherwise
 * `CONVERSION_FAILED` for a DTD/entity, excess depth or attributes, bad base64 or unbalanced
 * elements.
 */
export async function parseXmlFile(path: string, opts: XmlReadOptions, h: XmlHandlers): Promise<void> {
  if (statSync(path).size > opts.maxBytes) throw engineError('DOCUMENT_TOO_LARGE', { message: 'Flat XML too large' });

  const scopes: Scope[] = [new Map()];
  const names: string[] = [];
  let attrCount = 0;
  let ending = false;
  let tree: { root: XmlNode; stack: XmlNode[] } | undefined;
  let binary: Base64Decoder | undefined;
  const pending: Array<Promise<void>> = [];

  const parser = new Parser(
    {
      onprocessinginstruction(name) {
        const n = name.toLowerCase();
        if (n === '!doctype' || n === '!entity') throw failed('DTDs and entities are not allowed');
      },
      onopentagname() {
        attrCount = 0;
      },
      onattribute() {
        attrCount += 1;
        if (attrCount > MAX_XML_ATTRIBUTES) throw failed('Too many attributes on one element');
      },
      onopentag(rawName, rawAttrs) {
        if (names.length >= MAX_XML_DEPTH) throw failed('Elements nested too deeply');
        let scope = scopes[scopes.length - 1] as Scope;
        let declared: Map<string, string> | undefined;
        for (const [k, v] of Object.entries(rawAttrs)) {
          if (k === 'xmlns' || k.startsWith('xmlns:')) {
            declared ??= new Map(scope);
            declared.set(k === 'xmlns' ? '' : k.slice(6), v);
          }
        }
        if (declared !== undefined) scope = declared;
        scopes.push(scope);
        const name = resolveName(rawName, scope, false);
        const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [k, v] of Object.entries(rawAttrs)) {
          if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
          attrs[resolveName(k, scope, true)] = v;
        }
        names.push(name);
        const node: XmlNode = { name, attrs, children: [], text: '' };
        if (tree !== undefined) {
          (tree.stack[tree.stack.length - 1] as XmlNode).children.push(node);
          tree.stack.push(node);
        } else if (opts.treeElements?.has(name) === true) {
          tree = { root: node, stack: [node] };
        } else if (name === 'office:binary-data') {
          binary = new Base64Decoder();
        } else {
          h.open?.(name, attrs, names.length - 1);
        }
      },
      ontext(text) {
        if (binary !== undefined) binary.push(text);
        else if (tree !== undefined) (tree.stack[tree.stack.length - 1] as XmlNode).text += text;
        else h.text?.(text);
      },
      onclosetag() {
        if (ending) throw failed('Unbalanced XML'); // the input ended inside an element
        const name = names.pop();
        scopes.pop();
        if (name === undefined) throw failed('Unbalanced XML');
        if (tree !== undefined) {
          tree.stack.pop();
          if (tree.stack.length === 0) {
            const done = tree.root;
            tree = undefined;
            h.tree?.(done);
          }
        } else if (binary !== undefined && name === 'office:binary-data') {
          const bytes = binary.finish();
          binary = undefined;
          const r = h.binary?.(bytes);
          if (r instanceof Promise) pending.push(r);
        } else {
          h.close?.(name, names.length);
        }
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );

  const decoder = new StringDecoder('utf8');
  let read = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      const buf = chunk as Buffer;
      read += buf.length;
      if (read > opts.maxBytes) throw engineError('DOCUMENT_TOO_LARGE', { message: 'Flat XML too large' });
      parser.write(decoder.write(buf));
      if (pending.length > 0) await Promise.all(pending.splice(0));
    }
    parser.write(decoder.end());
    ending = true;
    parser.end();
    await Promise.all(pending.splice(0));
  } catch (e) {
    if (e instanceof OpenDocexError) throw e;
    throw failed('Malformed XML', e);
  }
  if (names.length !== 0) throw failed('Unbalanced XML');
}
