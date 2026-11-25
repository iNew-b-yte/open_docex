// Text helpers for the integration suite: read a document back from a load, and compute the
// positions of text ops. The fake codec makes every line a paragraph, so a document is a body of
// paragraphs and the position of line `p`, offset `n` is `1 + Σ(len + 2) + 1 + n`.
import { assembleText, type TextChunkData, type TextSnapshot } from '@open-docex/shared/text';
import type { Loaded } from '../test-client.js';

/** The body's blocks joined by a newline (the inverse of the fake codec's import). */
export function docText(doc: TextSnapshot): string {
  const out: string[] = [];
  doc.forEach((region) => {
    if (region.type.name === 'body') region.forEach((block) => out.push(block.textContent));
  });
  return out.join('\n');
}

/** The document a load carried. */
export function loadedDoc(loaded: Loaded): TextSnapshot {
  return assembleText(loaded.chunkMessages as Array<{ seq: number; data: TextChunkData }>);
}

/** The text a load carried. */
export function loadedText(loaded: Loaded): string {
  return docText(loadedDoc(loaded));
}

/** The document position of `offset` characters into line `line` (0-based) of `text`. */
export function posIn(text: string, line: number, offset: number): number {
  const lines = text.split('\n');
  let pos = 1; // inside the body
  for (let i = 0; i < line; i++) pos += (lines[i] as string).length + 2;
  return pos + 1 + offset; // inside the paragraph, then `offset` characters in
}

/** A text op that inserts `text` at `pos`. */
export function insertOp(pos: number, text: string): Record<string, unknown> {
  return { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } };
}

/** An op that appends `text` to the single-paragraph document `current`. */
export function appendOp(current: string, text: string): Record<string, unknown> {
  return insertOp(posIn(current, 0, current.length), text);
}
