/**
 * The client's image asset cache (LLD Part 3 §13; HLD §14; §0 PO-24, R-10, L-16).
 *
 * Every image the editor shows gets its `src` from here, and only ever as a `blob:` URL that
 * this cache created. A blob's MIME type is forced to the image allowlist or to
 * `application/octet-stream`, so a server or peer can never make the browser render HTML.
 *
 * Requests are correlated by `reqId` (§0 R-10). A successful `asset-put` is confirmed by an
 * `asset` message without `bytes`; an `asset-get` is answered by one with `bytes`. Errors for
 * either carry the same `reqId`.
 *
 * @module
 */
import { OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import { computeAssetId } from '@open-docex/shared/ids';
import type { AssetGetMsg, AssetMime, AssetMsg, AssetPutMsg, ErrorMsg } from '@open-docex/shared/protocol';
import { isKnownErrorCode } from '../errors/policy.js';
import { forcedBlobMime, isAllowedImageMime } from '../security/href.js';

/** Default number of `asset-get` requests in flight at once (LLD Part 3 §13). */
export const DEFAULT_MAX_CONCURRENT_GETS = 4;
/** How long `put` waits for the server's confirmation (LLD Part 3 §13). */
export const PUT_TIMEOUT_MS = 60_000;

/** What the cache needs from the session. */
export interface AssetCacheDeps {
  /** Sends a request. False when no socket is open; the request is re-sent by {@link AssetCache.onReconnected}. */
  send(m: AssetPutMsg | AssetGetMsg): boolean;
  /** True while a socket is open. */
  connected(): boolean;
  /** Default {@link DEFAULT_MAX_CONCURRENT_GETS}. */
  maxConcurrentGets?: number;
  /** Timer seam for tests. Defaults to the global `setTimeout`/`clearTimeout`. */
  timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

interface Deferred<T> {
  resolve(v: T): void;
  reject(e: unknown): void;
}

interface GetRequest {
  kind: 'get';
  reqId: number;
  assetId: string;
  /** True once it holds one of the `maxConcurrentGets` slots. */
  active: boolean;
  waiters: Deferred<string>[];
}

interface PutRequest {
  kind: 'put';
  reqId: number;
  assetId: string;
  mime: AssetMime;
  bytes: Uint8Array;
  timer: unknown;
  waiters: Deferred<string>[];
}

type Request = GetRequest | PutRequest;

/** A rejection for one asset operation. */
function assetError(code: ErrorCode): OpenDocexError {
  return new OpenDocexError(code);
}

/**
 * Caches image assets as `blob:` URLs and talks `asset-get` / `asset-put` (LLD Part 3 §13).
 *
 * Blob URLs are revoked only by {@link destroy} (LLD choice): assets are content-addressed,
 * stay valid across reloads, and their number is bounded by the document's images. The one
 * exception is a failed `put`: its URL was never placed in the document, so it is revoked at
 * once and a later `put` of the same bytes uploads again.
 *
 * `crypto.subtle` (for {@link computeAssetId}) exists only in secure contexts: HTTPS or localhost.
 */
export class AssetCache {
  readonly #deps: AssetCacheDeps;
  readonly #maxGets: number;
  readonly #urls = new Map<string, string>();
  /** Outstanding requests by `reqId`. */
  readonly #requests = new Map<number, Request>();
  /** The outstanding get for each asset ID, so concurrent loads share one request. */
  readonly #gets = new Map<string, GetRequest>();
  /** The outstanding put for each asset ID, so concurrent puts of the same bytes share one request. */
  readonly #puts = new Map<string, PutRequest>();
  /** Gets waiting for a free slot, oldest first. */
  readonly #queue: GetRequest[] = [];
  #activeGets = 0;
  #nextReqId = 1;
  #maxAssetBytes: number | undefined;
  #destroyed = false;

  constructor(deps: AssetCacheDeps) {
    this.#deps = deps;
    const n = deps.maxConcurrentGets ?? DEFAULT_MAX_CONCURRENT_GETS;
    this.#maxGets = Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_CONCURRENT_GETS;
  }

  /**
   * Sets the size limit from `LoadStartMsg.limits.maxAssetBytes` (§0 R-3). `undefined` means
   * no client-side limit; the server still enforces its own.
   */
  setMaxAssetBytes(n: number | undefined): void {
    this.#maxAssetBytes = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  /**
   * The client-side checks for an image of `size` bytes and type `mime` (PO-24, L-16).
   *
   * @returns null when the image may be uploaded, otherwise `CLIENT_IMAGE_TYPE_UNSUPPORTED`
   *   or `CLIENT_ASSET_TOO_LARGE`.
   */
  check(mime: unknown, size: number): ErrorCode | null {
    if (!isAllowedImageMime(mime)) return 'CLIENT_IMAGE_TYPE_UNSUPPORTED';
    if (this.#maxAssetBytes !== undefined && size > this.#maxAssetBytes) return 'CLIENT_ASSET_TOO_LARGE';
    return null;
  }

  /** The `blob:` URL for `assetId` if it is cached, else undefined. Synchronous. */
  url(assetId: string): string | undefined {
    return this.#urls.get(assetId);
  }

  /**
   * Resolves the `blob:` URL for `assetId`, fetching it with `asset-get` if needed. Concurrent
   * calls for one ID share one request, and at most `maxConcurrentGets` gets are in flight.
   * Rejects with the server's error code, or when the cache is destroyed.
   */
  load(assetId: string): Promise<string> {
    if (this.#destroyed) return Promise.reject(assetError('SESSION_CLOSED'));
    const cached = this.#urls.get(assetId);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise<string>((resolve, reject) => {
      const existing = this.#gets.get(assetId);
      if (existing) {
        existing.waiters.push({ resolve, reject });
        return;
      }
      const req: GetRequest = { kind: 'get', reqId: this.#reqId(), assetId, active: false, waiters: [{ resolve, reject }] };
      this.#requests.set(req.reqId, req);
      this.#gets.set(assetId, req);
      this.#queue.push(req);
      this.#pump();
    });
  }

  /**
   * Uploads an image and resolves its asset ID once the server confirms storage (C-7). The
   * inserting client can show the image at once: the blob URL is cached before the upload.
   *
   * Rejects with `CLIENT_IMAGE_TYPE_UNSUPPORTED` for a type outside PNG/JPEG/GIF,
   * `CLIENT_ASSET_TOO_LARGE` over `maxAssetBytes`, the server's error code, a plain `Error`
   * after {@link PUT_TIMEOUT_MS}, or `SESSION_CLOSED` when the cache is destroyed.
   */
  async put(bytes: Uint8Array, mime: string): Promise<string> {
    if (this.#destroyed) throw assetError('SESSION_CLOSED');
    const problem = this.check(mime, bytes.length);
    if (problem !== null) throw assetError(problem);
    const allowed = mime as AssetMime;
    const assetId = await computeAssetId(bytes);
    if (this.#destroyed) throw assetError('SESSION_CLOSED');
    const pending = this.#puts.get(assetId);
    if (pending) return new Promise<string>((resolve, reject) => pending.waiters.push({ resolve, reject }));
    // Already cached means already stored: it was fetched from the server or confirmed before.
    if (this.#urls.has(assetId)) return assetId;
    this.#urls.set(assetId, URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: allowed })));
    return new Promise<string>((resolve, reject) => {
      const req: PutRequest = {
        kind: 'put',
        reqId: this.#reqId(),
        assetId,
        mime: allowed,
        bytes,
        timer: undefined,
        waiters: [{ resolve, reject }],
      };
      this.#requests.set(req.reqId, req);
      this.#puts.set(assetId, req);
      req.timer = this.#timers().set(() => {
        this.#failPut(req, new Error('asset-put was not confirmed in time.'));
      }, PUT_TIMEOUT_MS);
      this.#send(req);
    });
  }

  /**
   * An `asset` message. With `bytes` it answers a get: the bytes become a blob URL with a
   * forced MIME type. Without `bytes` it confirms a put. An unknown `reqId` is ignored.
   */
  onAsset(m: AssetMsg): void {
    if (this.#destroyed) return;
    const req = this.#requests.get(m.reqId);
    if (!req) return;
    if (req.kind === 'get') {
      if (m.bytes === undefined || m.assetId !== req.assetId) return;
      this.#finishGet(req);
      let url = this.#urls.get(req.assetId);
      if (url === undefined) {
        url = URL.createObjectURL(new Blob([new Uint8Array(m.bytes)], { type: forcedBlobMime(m.mime) }));
        this.#urls.set(req.assetId, url);
      }
      for (const w of req.waiters) w.resolve(url);
      return;
    }
    if (m.bytes !== undefined) return;
    this.#finishPut(req);
    // The server names the stored asset. It is the same SHA-256 the client computed; if it
    // ever differs, the document must reference the server's ID, so the blob is cached under it too.
    const local = this.#urls.get(req.assetId);
    if (m.assetId !== req.assetId && local !== undefined && !this.#urls.has(m.assetId)) {
      this.#urls.set(m.assetId, local);
    }
    for (const w of req.waiters) w.resolve(m.assetId);
  }

  /** An `error` with `reqId` (§0 R-10): fails that one get or put. Others are ignored. */
  onAssetError(m: ErrorMsg): void {
    if (this.#destroyed || m.reqId === undefined) return;
    const req = this.#requests.get(m.reqId);
    if (!req) return;
    const err = assetError(isKnownErrorCode(m.code) ? m.code : 'PROTOCOL_INVALID_MESSAGE');
    if (req.kind === 'get') {
      this.#finishGet(req);
      for (const w of req.waiters) w.reject(err);
    } else {
      this.#failPut(req, err);
    }
  }

  /**
   * Fails every put in flight with `code` (default `DOCUMENT_TOO_LARGE`), for a 1009 close
   * (LLD Part 3 §4, `DocumentBinding.failAssetUpload`).
   */
  failPuts(code: ErrorCode = 'DOCUMENT_TOO_LARGE'): void {
    for (const req of [...this.#puts.values()]) this.#failPut(req, assetError(code));
  }

  /** After a reconnect: re-sends every outstanding request once, with its `reqId`. */
  onReconnected(): void {
    if (this.#destroyed) return;
    for (const req of this.#requests.values()) {
      if (req.kind === 'put' || req.active) this.#send(req);
    }
    this.#pump();
  }

  /** Revokes every blob URL and rejects every outstanding request with `SESSION_CLOSED`. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    this.#urls.clear();
    const err = assetError('SESSION_CLOSED');
    for (const req of this.#requests.values()) {
      if (req.kind === 'put') this.#timers().clear(req.timer);
      for (const w of req.waiters) w.reject(err);
    }
    this.#requests.clear();
    this.#gets.clear();
    this.#puts.clear();
    this.#queue.length = 0;
    this.#activeGets = 0;
  }

  #reqId(): number {
    return this.#nextReqId++;
  }

  #timers(): NonNullable<AssetCacheDeps['timers']> {
    return this.#deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as number) };
  }

  /** Sends gets from the queue while a slot is free. */
  #pump(): void {
    while (this.#activeGets < this.#maxGets && this.#queue.length > 0) {
      const req = this.#queue.shift() as GetRequest;
      req.active = true;
      this.#activeGets += 1;
      this.#send(req);
    }
  }

  /**
   * Sends a request if a socket is open. One that can't be sent stays outstanding (a get keeps
   * its slot) and goes out from {@link onReconnected}.
   */
  #send(req: Request): void {
    if (!this.#deps.connected()) return;
    const msg: AssetPutMsg | AssetGetMsg =
      req.kind === 'get'
        ? { type: 'asset-get', reqId: req.reqId, assetId: req.assetId }
        : { type: 'asset-put', reqId: req.reqId, mime: req.mime, bytes: req.bytes };
    this.#deps.send(msg);
  }

  #finishGet(req: GetRequest): void {
    this.#requests.delete(req.reqId);
    this.#gets.delete(req.assetId);
    if (req.active) this.#activeGets -= 1;
    else this.#queue.splice(this.#queue.indexOf(req), 1);
    this.#pump();
  }

  #finishPut(req: PutRequest): void {
    this.#timers().clear(req.timer);
    this.#requests.delete(req.reqId);
    this.#puts.delete(req.assetId);
  }

  /** Rejects a put and revokes its URL, which was never placed in the document. */
  #failPut(req: PutRequest, err: unknown): void {
    if (!this.#requests.has(req.reqId)) return;
    this.#finishPut(req);
    const url = this.#urls.get(req.assetId);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      this.#urls.delete(req.assetId);
    }
    for (const w of req.waiters) w.reject(err);
  }
}
