// The scenarios that need real LibreOffice: real .docx files go through import, edit, flush and
// re-open, and a crash is recovered with the real export. Plain-text edits on blank documents or
// on the fixture's text only: LibreOffice round-trip details (alignment and the like) differ
// between versions (LLD §0.5 S-46) and are the codec suites' business, not this suite's.
import path from 'node:path';
import { expect } from 'vitest';
import { appendOp, firstParagraphStart, insertOp, loadedDoc, loadedText } from '../doc-helpers.js';
import { id } from '../helpers.js';
import type { Scenario } from '../register.js';

const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'fixtures', 'text');
/** No flush before a crash: the quiet period is a minute. */
const NO_FLUSH = { flush: { quietMs: 60_000, maxIntervalMs: 300_000 } };

/** A .docx is a zip: `PK`. */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export const loScenarios: Scenario[] = [
  {
    name: 'opens a real .docx, edits it, flushes it, and the saved file re-opens in a fresh engine',
    run: async (rig) => {
      await rig.addFixture('doc', path.join(FIXTURES, 'features.docx'));
      const original = await rig.storedBytes('doc');
      const { c, load } = await rig.join('doc', 'alice');
      expect(load.start).toMatchObject({ kind: 'text', access: 'edit', readOnly: false, rev: 0 });
      expect(load.start.unsupported ?? []).toEqual([]);
      expect(loadedText(load)).toContain('ALIGN-LEFT paragraph');

      const at = firstParagraphStart(loadedDoc(load));
      expect(at).toBeGreaterThan(0);
      expect((await c.submit([insertOp(at, 'EDIT: ')])).rev).toBe(1);

      // The quiet period passes and the Core exports a real .docx over the file.
      await rig.waitMeta('doc', (m) => m.lastFlushedRev === 1 && m.storageState === 'NORMAL');
      const saved = await rig.storedBytes('doc');
      expect(isZip(saved)).toBe(true);
      expect(Buffer.from(saved).equals(Buffer.from(original))).toBe(false);

      // A fresh data folder has no local copy: the saved file is imported again.
      await rig.stop();
      await rig.start({ freshData: true });
      const again = await rig.join('doc', 'alice');
      const text = loadedText(again.load);
      expect(text).toContain('EDIT: ');
      expect(text).toContain('ALIGN-LEFT paragraph');
      expect(again.load.start.unsupported ?? []).toEqual([]);
    },
  },
  {
    name: 'a crash before the flush is recovered from the journal, and the real export then saves the edit',
    rig: { config: NO_FLUSH },
    run: async (rig) => {
      await rig.createBlank('doc');
      const blank = await rig.storedBytes('doc');
      const { c } = await rig.join('doc', 'alice');
      await c.submit([appendOp('', 'Written before the crash')]);

      await rig.crash();
      expect(Buffer.from(await rig.storedBytes('doc')).equals(Buffer.from(blank))).toBe(true); // nothing was flushed

      const again = await rig.join('doc', 'alice');
      expect(loadedText(again.load)).toBe('Written before the crash'); // the journal, not storage
      expect(again.load.start.rev).toBe(1);

      await rig.stop(); // the real export, now
      expect(isZip(await rig.storedBytes('doc'))).toBe(true);
      await rig.start({ freshData: true });
      expect(loadedText((await rig.join('doc', 'alice')).load)).toBe('Written before the crash');
    },
  },
  {
    name: 'a failed storage write keeps a real local copy, and retry() writes a real .docx',
    run: async (rig) => {
      await rig.createBlank('doc');
      const { c } = await rig.join('doc', 'alice');
      rig.storageDown(['write']);
      await c.submit([appendOp('', 'Written while storage was down')]);
      await rig.waitRecovery('doc', 'LOCAL');

      const copy = await rig.engine.recovery.readLocalCopy(id('doc'));
      expect(isZip(copy.bytes)).toBe(true); // a real export of the local model
      expect(copy).toMatchObject({ format: 'docx', rev: 1 });

      rig.storageUp();
      expect(await rig.engine.recovery.retry(id('doc'))).toMatchObject({ state: 'NORMAL' });
      expect(isZip(await rig.storedBytes('doc'))).toBe(true);

      await rig.stop();
      await rig.start({ freshData: true });
      expect(loadedText((await rig.join('doc', 'alice')).load)).toBe('Written while storage was down');
    },
  },
];
