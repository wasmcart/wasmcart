// Asset prefetch (SPEC.md, "Asset prefetch"): the host-side cache behind
// wc_asset_prefetch / wc_asset_prefetch_cancel, shared by the Node and web
// hosts. No Node or browser dependencies: each host hands in the function that
// produces an asset's bytes (an async archive read, a fetch) and the one that
// knows an asset's size up front, when it does.
//
// One entry per path. A prefetch is PENDING from the call until the bytes
// are in (READY), the asset turns out not to exist (MISSING), or the fetch
// fails (FAILED, sticky until cancelled). At most `concurrency` fetches run at
// once; the rest queue and start highest priority first. The cache is bounded
// by entries and by bytes, and a request past either bound is REFUSED at the
// call, never dropped silently.
//
// The host's wc_asset_size / wc_load_asset consult `bytes(path)` first, and a
// read that returns the asset's full size calls `take(path)`, which ends the
// prefetch: the cart has its own copy, the host drops its own.

import {
  PREFETCH_PENDING,
  PREFETCH_READY,
  PREFETCH_MISSING,
  PREFETCH_FAILED,
  PREFETCH_REFUSED,
} from './abi.js';

// The SPEC floors: at least 64 prefetches pending or ready at once, and at
// least one asset of the maximum asset size (256 MiB) held. Both hosts sit
// above them.
export const PREFETCH_LIMITS = Object.freeze({
  maxEntries: 256,
  maxBytes: 512 * 1024 * 1024,
  concurrency: 4,
});

/* The error a fetcher rejects with to say "no such asset": the prefetch then
 * answers MISSING, as wc_asset_size would answer -1 for the same path. Any
 * other rejection is FAILED. */
export class AssetMissingError extends Error {
  constructor(path) {
    super(`no such asset: ${path}`);
    this.missing = true;
  }
}

export class AssetPrefetcher {
  /**
   * @param {object} o
   * @param {(path: string, signal: AbortSignal|undefined, priority: number) => Promise<Uint8Array>} o.fetch
   *   the asset's whole, decompressed bytes; rejects with AssetMissingError
   *   for a path that does not exist. The priority is the cart's, for a host
   *   that can pass it on (a fetch priority hint).
   * @param {(path: string) => number|undefined} [o.size] the asset's size when
   *   it is known before the fetch (an archive entry, a stat), -1 when the
   *   path is known missing, undefined when unknown.
   * @param {number} [o.concurrency] fetches in flight at once
   * @param {number} [o.maxEntries] entries pending or ready at once
   * @param {number} [o.maxBytes] bytes held (ready) plus known sizes pending
   */
  constructor({ fetch, size = () => undefined, concurrency = PREFETCH_LIMITS.concurrency,
    maxEntries = PREFETCH_LIMITS.maxEntries, maxBytes = PREFETCH_LIMITS.maxBytes }) {
    this._fetch = fetch;
    this._size = size;
    this._concurrency = concurrency;
    this._maxEntries = maxEntries;
    this._maxBytes = maxBytes;
    this._entries = new Map();   // path -> entry
    this._inflight = 0;
    this._held = 0;              // bytes: ready bytes + pending known sizes
    this._disposed = false;
    // Counters a test or an embedder can read: fetches started, completions.
    this.stats = { started: 0, ready: 0, missing: 0, failed: 0, refused: 0 };
  }

  /** The number of entries pending or ready. */
  get size() { return this._entries.size; }

  /** Bytes the cache holds or has reserved. */
  get heldBytes() { return this._held; }

  /** True when `path` is pending or ready. */
  has(path) { return this._entries.has(path); }

  /** The state of `path` (a PREFETCH_* value), or undefined when unknown. */
  state(path) { return this._entries.get(path)?.state; }

  /** The READY bytes of `path`, or undefined. */
  bytes(path) {
    const e = this._entries.get(path);
    return e && e.state === PREFETCH_READY ? e.bytes : undefined;
  }

  /** The promise of a pending fetch's bytes (so a read can wait on the fetch
   *  already in flight instead of starting a second), or undefined. Resolves
   *  to the bytes; rejects as the fetch did. A fetch that has not started
   *  yet is started now, ahead of the queue: the cart is waiting on it. */
  pending(path) {
    const e = this._entries.get(path);
    if (!e || e.state !== PREFETCH_PENDING) return undefined;
    if (!e.promise) this._start(e);
    return e.promise;
  }

  /**
   * wc_asset_prefetch: start fetching `path`, or report its state. Returns a
   * PREFETCH_* value. A repeat call with a higher priority raises a queued
   * fetch; a lower one is ignored.
   */
  request(path, priority = 0) {
    priority |= 0;
    const e = this._entries.get(path);
    if (e) {
      if (priority > e.priority) e.priority = priority;
      return e.state;
    }
    if (this._disposed) return PREFETCH_REFUSED;
    const known = this._size(path);
    if (known === -1) return PREFETCH_MISSING; // never held: nothing to cancel
    if (this._entries.size >= this._maxEntries) { this.stats.refused++; return PREFETCH_REFUSED; }
    const reserve = known > 0 ? known : 0;
    if (this._held + reserve > this._maxBytes) { this.stats.refused++; return PREFETCH_REFUSED; }
    const entry = {
      path, priority, state: PREFETCH_PENDING,
      bytes: null, reserved: reserve, promise: null, controller: null,
    };
    this._held += reserve;
    this._entries.set(path, entry);
    this._pump();
    return entry.state;
  }

  /**
   * wc_asset_prefetch_cancel: drop `path`, aborting a fetch in flight (or
   * letting it finish and discarding the bytes). Unknown paths are ignored.
   */
  cancel(path) {
    const e = this._entries.get(path);
    if (!e) return;
    this._drop(e);
    this._pump();
  }

  /**
   * A whole read of `path` by the cart: the prefetch ends. Returns the READY
   * bytes if there were any (the caller has usually copied them already).
   */
  take(path) {
    const e = this._entries.get(path);
    if (!e) return undefined;
    const bytes = e.state === PREFETCH_READY ? e.bytes : undefined;
    this._drop(e);
    this._pump();
    return bytes;
  }

  /** Drop everything: on destroy(). */
  dispose() {
    this._disposed = true;
    for (const e of [...this._entries.values()]) this._drop(e);
  }

  _drop(e) {
    if (!this._entries.has(e.path)) return;
    this._entries.delete(e.path);
    this._held -= e.state === PREFETCH_READY ? e.bytes.length : e.reserved;
    e.bytes = null;
    if (e.state === PREFETCH_PENDING && e.promise) {
      e.cancelled = true;
      try { e.controller?.abort(); } catch { /* an abort never throws */ }
    }
  }

  /* Start queued fetches, highest priority first, up to the concurrency. */
  _pump() {
    while (this._inflight < this._concurrency) {
      let best = null;
      for (const e of this._entries.values()) {
        if (e.state !== PREFETCH_PENDING || e.promise) continue;
        if (!best || e.priority > best.priority) best = e;
      }
      if (!best) return;
      this._start(best);
    }
  }

  _start(e) {
    this._inflight++;
    this.stats.started++;
    e.controller = typeof AbortController === 'function' ? new AbortController() : null;
    let p;
    try {
      p = Promise.resolve(this._fetch(e.path, e.controller?.signal, e.priority));
    } catch (err) {
      p = Promise.reject(err);
    }
    e.promise = p.then((data) => {
      this._settle(e, data, null);
      return data;
    }, (err) => {
      this._settle(e, null, err);
      throw err;
    });
    // The state lives in the entry; a rejected promise nobody awaits is not
    // an unhandled rejection.
    e.promise.catch(() => {});
  }

  _settle(e, data, err) {
    this._inflight--;
    const live = this._entries.get(e.path) === e && !e.cancelled;
    if (live) {
      this._held -= e.reserved;
      e.reserved = 0;
      if (err) {
        e.state = err?.missing ? PREFETCH_MISSING : PREFETCH_FAILED;
        if (e.state === PREFETCH_MISSING) this.stats.missing++; else this.stats.failed++;
      } else if (!(data instanceof Uint8Array)) {
        e.state = PREFETCH_FAILED;
        this.stats.failed++;
      } else if (this._held + data.length > this._maxBytes) {
        // The size was not known up front and the bytes do not fit: the host
        // could not hold them.
        e.state = PREFETCH_FAILED;
        this.stats.failed++;
      } else {
        e.state = PREFETCH_READY;
        e.bytes = data;
        this._held += data.length;
        this.stats.ready++;
      }
      // A failed or missing entry holds nothing but its state, so it costs no
      // bytes; it still counts toward maxEntries until cancelled, which is the
      // SPEC's "held until the cart cancels the path".
    }
    e.promise = null;
    e.controller = null;
    if (live && e.state === PREFETCH_MISSING) {
      // MISSING takes no room and has nothing to retry, so it leaves the
      // table: the next call answers from the host's own knowledge of the
      // miss (its index, a cached 404) through `size`, without a fetch.
      this._entries.delete(e.path);
    }
    this._pump();
  }
}
