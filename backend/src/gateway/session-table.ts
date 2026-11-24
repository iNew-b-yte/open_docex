/**
 * The Gateway's session table (LLD Part 2 §4.1): sessions by id, with indexes by document and by
 * user.
 *
 * @module
 */
import type { DocumentId } from '@open-docex/shared/ids';
import type { Session } from '../api/options.js';
import type { SendQueue } from './send-queue.js';

/** A selector for `engine.sessions.close` (LLD Part 2 §2.6). */
export interface SessionFilter {
  documentId?: DocumentId;
  userId?: string;
  sessionId?: string;
}

/** The socket operations the Gateway uses on a live connection. */
export interface GatewaySocket {
  close(code: number, reason: string): void;
  terminate(): void;
  ping(): void;
}

/** One connected client (LLD Part 2 §4.1). */
export interface GatewaySession extends Session {
  readonly ws: GatewaySocket;
  readonly send: SendQueue;
  /** The tail of this session's inbound chain (keeps order while `canSubmit` awaits). */
  inbound: Promise<void>;
  /** False between a ping and its pong. */
  alive: boolean;
  /** The read-only object handed to `canSubmit`: it carries no socket. */
  readonly view: Session;
  helloTimer?: unknown;
  /** Terminates the socket if a close handshake does not finish. */
  closeTimer?: unknown;
}

function add<K>(index: Map<K, Set<string>>, key: K, id: string): void {
  let set = index.get(key);
  if (set === undefined) {
    set = new Set();
    index.set(key, set);
  }
  set.add(id);
}

function drop<K>(index: Map<K, Set<string>>, key: K, id: string): void {
  const set = index.get(key);
  if (set === undefined) return;
  set.delete(id);
  if (set.size === 0) index.delete(key);
}

/** Sessions by id, document and user. */
export class SessionTable {
  readonly #byId = new Map<string, GatewaySession>();
  readonly #byDoc = new Map<DocumentId, Set<string>>();
  readonly #byUser = new Map<string, Set<string>>();

  get size(): number {
    return this.#byId.size;
  }

  add(s: GatewaySession): void {
    this.#byId.set(s.id, s);
    add(this.#byDoc, s.documentId, s.id);
    add(this.#byUser, s.userId, s.id);
  }

  /** Removes a session. Returns false when it was not in the table (already removed). */
  remove(s: GatewaySession): boolean {
    if (this.#byId.get(s.id) !== s) return false;
    this.#byId.delete(s.id);
    drop(this.#byDoc, s.documentId, s.id);
    drop(this.#byUser, s.userId, s.id);
    return true;
  }

  get(id: string): GatewaySession | undefined {
    return this.#byId.get(id);
  }

  all(): GatewaySession[] {
    return [...this.#byId.values()];
  }

  /** The sessions matching every field of `filter` that is set. An empty filter matches nothing. */
  match(filter: SessionFilter): GatewaySession[] {
    if (filter.sessionId === undefined && filter.documentId === undefined && filter.userId === undefined) return [];
    let candidates: Iterable<GatewaySession>;
    if (filter.sessionId !== undefined) {
      const s = this.#byId.get(filter.sessionId);
      candidates = s === undefined ? [] : [s];
    } else if (filter.documentId !== undefined) {
      candidates = this.#live(this.#byDoc.get(filter.documentId));
    } else {
      candidates = this.#live(this.#byUser.get(filter.userId as string));
    }
    const out: GatewaySession[] = [];
    for (const s of candidates) {
      if (filter.documentId !== undefined && s.documentId !== filter.documentId) continue;
      if (filter.userId !== undefined && s.userId !== filter.userId) continue;
      out.push(s);
    }
    return out;
  }

  /** Live session counts for one document. */
  count(documentId: DocumentId): { edit: number; view: number } {
    const out = { edit: 0, view: 0 };
    for (const s of this.#live(this.#byDoc.get(documentId))) out[s.access] += 1;
    return out;
  }

  clear(): void {
    this.#byId.clear();
    this.#byDoc.clear();
    this.#byUser.clear();
  }

  *#live(ids: Set<string> | undefined): Generator<GatewaySession> {
    if (ids === undefined) return;
    for (const id of ids) {
      const s = this.#byId.get(id);
      if (s !== undefined) yield s;
    }
  }
}
