// HLD §10.1 "Open and first load", §10.6 "Blank document" and read-only content.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { MAX_ASSET_BYTES } from '../../../../src/core/load-streamer.js';
import { waitFor } from '../../../wait-for.js';
import { isType, TestClient } from '../../test-client.js';
import { appendOp, loadedText } from '../doc-helpers.js';
import { id, readOnlyNotice } from '../helpers.js';
import type { Scenario } from '../register.js';

export const openScenarios: Scenario[] = [
  {
    name: '10.1 opens a document: load-start, load-chunks and load-done, in order',
    run: async (rig) => {
      await rig.addFile('doc', 'Hello\nWorld');
      const { c, load } = await rig.join('doc', 'alice');
      expect(load.start).toMatchObject({ type: 'load-start', kind: 'text', access: 'edit', readOnly: false, rev: 0 });
      expect(load.start.unsupported ?? []).toEqual([]);
      expect(load.start.limits).toEqual({ maxAssetBytes: MAX_ASSET_BYTES });
      expect(load.doneRev).toBe(0);
      expect(load.start.totalChunks).toBe(load.chunkMessages.length);
      expect(load.chunkMessages.map((m) => m.seq)).toEqual(load.chunkMessages.map((_, i) => i));
      expect(loadedText(load)).toBe('Hello\nWorld');
      const types = c.messages.map((m) => m.type);
      expect(types[0]).toBe('load-start');
      expect(types.at(-1)).toBe('load-done');

      // A second session gets the same instance (same epoch) and its own access.
      const viewer = await rig.join('doc', 'vera', { access: 'view' });
      expect(viewer.load.start).toMatchObject({ access: 'view', epoch: load.start.epoch, rev: 0 });
      expect(await rig.engine.shareInfo(id('doc'))).toEqual({ documentId: 'doc', loaded: true, kind: 'text', sessions: { edit: 1, view: 1 } });
      await waitFor(() => {
        const e = rig.events.document.find((d) => d.state === 'loaded');
        expect(e).toMatchObject({ documentId: 'doc', state: 'loaded', source: 'storage', rev: 0, epoch: load.start.epoch });
      });
    },
  },
  {
    name: '10.1 streams a document that needs more chunks than the load window',
    rig: { config: { load: { chunk: { textBlocks: 2 } } } },
    run: async (rig) => {
      const text = Array.from({ length: 21 }, (_, i) => `line ${String(i)}`).join('\n');
      await rig.addFile('doc', text);
      const { load } = await rig.join('doc', 'alice');
      expect(load.chunkMessages.length).toBeGreaterThan(5); // the Core keeps at most 4 chunks unwritten at once
      expect(load.start.totalChunks).toBe(load.chunkMessages.length);
      expect(loadedText(load)).toBe(text);
    },
  },
  {
    name: '10.1 refuses an upgrade that is not authorized: 401, 403, and 400 without a document',
    run: async (rig) => {
      await rig.addFile('doc', 'x');
      await expect(TestClient.open(rig.url('doc'))).rejects.toThrow('HTTP 401'); // no credentials
      await expect(TestClient.open(rig.url('unknown'), { headers: { authorization: 'Bearer edit:eve' } })).rejects.toThrow('HTTP 403');
      await expect(TestClient.open(rig.url(''), { headers: { authorization: 'Bearer edit:eve' } })).rejects.toThrow('HTTP 400');
    },
  },
  {
    name: '10.1 a local copy newer than storage wins after a restart without a flush',
    rig: { config: { flush: { quietMs: 60_000, maxIntervalMs: 300_000 } } },
    run: async (rig) => {
      await rig.addFile('doc', 'base');
      const first = await rig.join('doc', 'alice');
      expect((await first.c.submit([appendOp('base', ' + local')])).rev).toBe(1);

      await rig.crash(); // nothing was flushed: the quiet period is a minute
      expect(await rig.storedText('doc')).toBe('base');

      const again = await rig.join('doc', 'alice');
      expect(loadedText(again.load)).toBe('base + local'); // from the journal, not from storage
      expect(again.load.start.rev).toBe(1);
      expect(again.load.start.epoch).not.toBe(first.load.start.epoch);
      expect((await rig.metaOnDisk('doc')).lastFlushedRev).toBe(0);
      expect(await rig.storedText('doc')).toBe('base');
    },
  },
  {
    name: '10.1 a storage file changed outside while the engine was down wins, and the rev never goes back',
    run: async (rig) => {
      await rig.addFile('doc', 'base');
      const first = await rig.join('doc', 'alice');
      expect((await first.c.submit([appendOp('base', '!')])).rev).toBe(1);
      await rig.stop(); // a clean stop flushes
      expect(await rig.storedText('doc')).toBe('base!');

      await rig.outsideEdit('doc', 'edited by someone else');
      await rig.start();
      const again = await rig.join('doc', 'alice');
      expect(loadedText(again.load)).toBe('edited by someone else'); // nothing local is newer, so storage wins
      expect(again.load.start.rev).toBeGreaterThanOrEqual(1);
    },
  },
  {
    name: '10.1 unsupported content opens read-only until documents.allowUnsupportedEdit, and stays editable after a crash',
    run: async (rig) => {
      await rig.addFile('doc', 'UNSUPPORTED report');
      const { c, load } = await rig.join('doc', 'alice');
      expect(load.start).toMatchObject({ readOnly: true, access: 'edit', unsupported: [{ feature: 'comments', count: 1 }] });
      await waitFor(() => {
        expect(rig.events.document.find((d) => d.state === 'unsupported')).toMatchObject({
          documentId: 'doc',
          findings: [{ feature: 'comments', count: 1 }],
        });
      });

      // An edit is refused with DOCUMENT_READ_ONLY; the connection stays open.
      const from = c.mark();
      const refused = c.sendSubmit([appendOp('UNSUPPORTED report', '!')]);
      expect(await c.errorFor(refused, from)).toMatchObject({ code: 'DOCUMENT_READ_ONLY', clientSeq: refused });
      expect(c.closeInfo).toBeUndefined();

      // The adopter allows editing: the session is told, and edits are accepted.
      await rig.engine.documents.allowUnsupportedEdit(id('doc'));
      await c.waitFor(readOnlyNotice(false), { from });
      const ack = await c.submit([appendOp('UNSUPPORTED report', '!')]);
      expect(ack.rev).toBe(1);

      // The permission is part of the document's local state.
      await rig.crash();
      const again = await rig.join('doc', 'alice');
      expect(again.load.start.readOnly).toBe(false);
      expect(again.load.start.unsupported).toEqual([{ feature: 'comments', count: 1 }]);
      expect(loadedText(again.load)).toBe('UNSUPPORTED report!');
    },
  },
  {
    name: '10.6 creates a blank document in storage, and users edit and save it',
    run: async (rig) => {
      const ref = await rig.createBlank('blank');
      expect(typeof ref).toBe('string');
      expect(await rig.storedText('blank')).toBe(''); // the fake codec's empty document

      const { c, load } = await rig.join('blank', 'alice');
      expect(load.start).toMatchObject({ kind: 'text', rev: 0, readOnly: false });
      expect(loadedText(load)).toBe('');
      expect((await c.submit([appendOp('', 'First words')])).rev).toBe(1);
      await rig.stop();
      expect(await rig.storedText('blank')).toBe('First words');
    },
  },
  {
    name: '10.6 creates a blank document in the local storage (target: local)',
    run: async (rig) => {
      const ref = await rig.createBlank('blank', 'local');
      // An adopter storage is configured, so a local document gets an opaque `{ $local }` ref.
      const local = (ref as { $local: string }).$local;
      expect(Object.keys(ref)).toEqual(['$local']);
      expect(local).toMatch(/\.docx$/);
      const file = path.join(rig.dataDir, 'local-storage', local);
      expect(existsSync(file)).toBe(true);

      const { c, load } = await rig.join('blank', 'alice');
      expect(loadedText(load)).toBe('');
      await c.submit([appendOp('', 'kept locally')]);
      await rig.stop();
      expect(new TextDecoder().decode(await readFile(file))).toBe('kept locally');
    },
  },
  {
    name: '10.6 documents.create rejects a kind and format that do not match, and spreadsheets in V1',
    run: async (rig) => {
      await expect(rig.engine.documents.create({ kind: 'text', format: 'xlsx', name: 'x', target: 'storage' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      await expect(rig.engine.documents.create({ kind: 'sheet', format: 'xlsx', name: 'x', target: 'storage' })).rejects.toMatchObject({
        code: 'DOCUMENT_UNSUPPORTED_CONTENT',
      });
      await expect(rig.engine.documents.create({ kind: 'text', format: 'docx', name: '', target: 'storage' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    },
  },
  {
    name: '10.1 a document that does not exist closes the session with a load error',
    run: async (rig) => {
      rig.refs.set('missing', 'missing.docx'); // authorized, but nothing is in storage
      const c = await rig.connect('missing', 'alice');
      c.sendHello();
      const error = await c.waitFor(isType('error'));
      expect(error.code).toBe('DOCUMENT_NOT_FOUND');
      expect(await c.whenClosed()).toMatchObject({ code: 4008 }); // LOAD_FAILED
    },
  },
];
