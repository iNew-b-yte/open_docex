// SessionTable (LLD Part 2 §4.1): indexes by id, document and user, and the filter rules of
// `engine.sessions.close`.
import { asDocumentId } from '@open-docex/shared/ids';
import { describe, expect, it } from 'vitest';
import { SessionTable, type GatewaySession } from '../../../src/gateway/session-table.js';
import type { SendQueue } from '../../../src/gateway/send-queue.js';

function session(id: string, doc: string, user: string, access: 'edit' | 'view' = 'edit'): GatewaySession {
  const view = Object.freeze({ id, documentId: asDocumentId(doc), userId: user, access, openedAt: 1 });
  return {
    ...view,
    view,
    ws: { close: () => undefined, terminate: () => undefined, ping: () => undefined },
    send: {} as SendQueue,
    inbound: Promise.resolve(),
    alive: true,
  };
}

function ids(list: GatewaySession[]): string[] {
  return list.map((s) => s.id).sort();
}

describe('SessionTable', () => {
  function filled() {
    const t = new SessionTable();
    t.add(session('s1', 'docA', 'alice'));
    t.add(session('s2', 'docA', 'bob', 'view'));
    t.add(session('s3', 'docB', 'alice'));
    return t;
  }

  it('finds sessions by id', () => {
    const t = filled();
    expect(t.get('s2')?.userId).toBe('bob');
    expect(t.get('nope')).toBeUndefined();
    expect(t.size).toBe(3);
  });

  it('matches by document, by user and by session id', () => {
    const t = filled();
    expect(ids(t.match({ documentId: asDocumentId('docA') }))).toEqual(['s1', 's2']);
    expect(ids(t.match({ userId: 'alice' }))).toEqual(['s1', 's3']);
    expect(ids(t.match({ sessionId: 's2' }))).toEqual(['s2']);
  });

  it('combines fields with AND', () => {
    const t = filled();
    expect(ids(t.match({ documentId: asDocumentId('docA'), userId: 'alice' }))).toEqual(['s1']);
    expect(ids(t.match({ sessionId: 's1', userId: 'bob' }))).toEqual([]);
    expect(ids(t.match({ sessionId: 's1', documentId: asDocumentId('docB') }))).toEqual([]);
  });

  it('matches nothing for an empty filter', () => {
    expect(filled().match({})).toEqual([]);
  });

  it('counts live sessions of a document by access', () => {
    const t = filled();
    expect(t.count(asDocumentId('docA'))).toEqual({ edit: 1, view: 1 });
    expect(t.count(asDocumentId('docB'))).toEqual({ edit: 1, view: 0 });
    expect(t.count(asDocumentId('none'))).toEqual({ edit: 0, view: 0 });
  });

  it('removes a session from every index, and reports a second removal as false', () => {
    const t = filled();
    const s1 = t.get('s1') as GatewaySession;
    expect(t.remove(s1)).toBe(true);
    expect(t.remove(s1)).toBe(false);
    expect(ids(t.match({ documentId: asDocumentId('docA') }))).toEqual(['s2']);
    expect(ids(t.match({ userId: 'alice' }))).toEqual(['s3']);
    expect(t.count(asDocumentId('docA'))).toEqual({ edit: 0, view: 1 });
  });

  it('does not remove a different session that reuses an id', () => {
    const t = new SessionTable();
    const a = session('x', 'docA', 'alice');
    t.add(a);
    expect(t.remove(session('x', 'docA', 'alice'))).toBe(false);
    expect(t.size).toBe(1);
  });

  it('clears everything', () => {
    const t = filled();
    t.clear();
    expect(t.size).toBe(0);
    expect(t.all()).toEqual([]);
    expect(t.match({ userId: 'alice' })).toEqual([]);
  });
});
