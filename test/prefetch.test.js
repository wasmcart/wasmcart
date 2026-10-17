// Asset prefetch (SPEC.md, "Asset prefetch") on the Node host, and on the web
// host under Node, with fixtures/prefetch.wasc (source: fixtures/prefetch.c,
// built by fixtures/prefetch.build.mjs): big.bin is 8 MiB deflated, small.bin
// 4096 bytes stored, missing.bin does not exist. The cart reads the host-info
// flag in wc_init; with it, frame 1 prefetches all three, every frame polls,
// and the READY read is checked byte for byte; without it the cart reads
// synchronously on frame 1 and never calls the imports.
//
// Every claim has a control that must fail: the same cart on a host that
// leaves the imports out (load({assetPrefetch: false}), what a host built
// before 0.35 looks like to the cart) must see the flag clear, never call the
// imports, never see READY, and still read its assets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
import { CartHost } from '../index.js';
import { CartHostWeb } from '../src/CartHostWeb.js';
import {
  HOST_FLAG_ASSET_PREFETCH, HOST_FLAG_DETERMINISTIC, HOST_FLAG_GPU_WGPU, HOST_INFO_FIELDS,
  PREFETCH_PENDING, PREFETCH_READY, PREFETCH_MISSING, PREFETCH_FAILED, PREFETCH_REFUSED,
} from '../src/abi.js';
import { AssetPrefetcher, AssetMissingError, PREFETCH_LIMITS } from '../src/assetPrefetch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CART = join(HERE, 'fixtures', 'prefetch.wasc');
const BIG_SIZE = 8 << 20;
const FIELDS = ['has_flag', 'calls', 'frame', 'state_big', 'state_small', 'state_missing', 'state_small_re',
  'frames_to_ready', 'read_frame', 'read_bytes', 'size_big', 'size_small', 'hash', 'hash_ok', 'cancel_ok',
  'small_ok', 'small_read_frame', 'phase'];
const dbg = (h) => Object.fromEntries(FIELDS.map((k) => [k, h.readDebugValue(k).value]));
const tick = () => new Promise((r) => setTimeout(r, 1));

// FNV-1a of big.bin's pattern, computed here: the cart's `hash` must match.
function fnv1a() {
  let h = 0x811c9dc5;
  for (let i = 0; i < BIG_SIZE; i++) h = Math.imul(h ^ ((i * 31 + 7) & 255), 0x01000193) >>> 0;
  return h >>> 0;
}
const EXPECTED_HASH = fnv1a();

// The cart's directory form: prefetch.wasc unzipped into a temp dir.
function unpack() {
  const dir = mkdtempSync(join(tmpdir(), 'wasmcart-prefetch-'));
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(CART))))) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  return dir;
}

/* Run the cart until it is done (phase 4) or `max` frames, yielding to the
 * event loop between frames, and record each frame's state and wall time. */
async function run(host, max = 400) {
  const trace = [];
  for (let i = 0; i < max; i++) {
    const t0 = performance.now();
    await host.runFrame([]);
    const ms = performance.now() - t0;
    const d = dbg(host);
    trace.push({ ms, ...d });
    if (d.phase === 4) break;
    await tick();
  }
  return trace;
}

// The predicate every main test asserts and every control must fail.
const sawReady = (trace) => trace.some((f) => f.state_big === PREFETCH_READY);

function assertPrefetched(trace, what) {
  const last = trace.at(-1);
  assert.equal(last.has_flag, 1, `${what}: the cart read the flag`);
  assert.equal(trace[0].state_big, PREFETCH_PENDING, `${what}: frame 1 started the fetch`);
  assert.equal(trace[0].state_missing, PREFETCH_MISSING, `${what}: a missing asset is MISSING at once`);
  assert.ok(sawReady(trace), `${what}: big.bin reached READY`);
  assert.ok(last.frames_to_ready >= 1, `${what}: frames_to_ready set`);
  assert.equal(last.read_frame, last.frames_to_ready, `${what}: the read happened on the READY frame`);
  assert.equal(last.read_bytes, BIG_SIZE, `${what}: the whole asset was read`);
  assert.equal(last.size_big, BIG_SIZE, `${what}: wc_asset_size from the copy`);
  assert.equal(last.hash_ok, 1, `${what}: every byte matched the pattern`);
  assert.equal(last.hash, EXPECTED_HASH, `${what}: FNV-1a known answer`);
  assert.equal(last.state_small_re, PREFETCH_READY, `${what}: re-prefetch after cancel reached READY`);
  assert.equal(last.cancel_ok, 1, `${what}: cancel then prefetch again works`);
  assert.equal(last.small_ok, 1, `${what}: small.bin read whole and correct`);
  assert.equal(last.phase, 4, `${what}: the cart finished`);
  // Every frame before the read, and every one after, is cheap: nothing
  // blocked on the fetch. The read frame itself hashes 8 MiB in wasm.
  const waiting = trace.filter((f) => f.frame < f.frames_to_ready || f.frames_to_ready < 0);
  assert.ok(waiting.length >= 1, `${what}: at least one frame polled while pending (took ${last.frames_to_ready} frames)`);
}

function assertOldHost(trace, what) {
  const last = trace.at(-1);
  assert.equal(last.has_flag, 0, `${what}: the flag is clear`);
  assert.equal(last.calls, 0, `${what}: the cart never called the import`);
  assert.equal(sawReady(trace), false, `${what}: the control fails the READY predicate`);
  assert.equal(last.state_big, 99, `${what}: state never written`);
  assert.equal(last.read_frame, 1, `${what}: read synchronously on frame 1`);
  assert.equal(last.hash_ok, 1, `${what}: the fallback read is correct`);
  assert.equal(last.hash, EXPECTED_HASH);
  assert.equal(last.small_ok, 1);
  assert.equal(last.cancel_ok, 0);
  assert.equal(last.phase, 4);
}

// The flags word the host wrote before wc_init.
function hostFlags(host) {
  return new Uint32Array(host.memory.buffer, host.info.hostInfoPtr + HOST_INFO_FIELDS.FLAGS, 1)[0];
}

test('the ABI constants: flag 0x04, five states', () => {
  assert.equal(HOST_FLAG_ASSET_PREFETCH, 0x04);
  assert.equal(HOST_FLAG_ASSET_PREFETCH & (HOST_FLAG_DETERMINISTIC | HOST_FLAG_GPU_WGPU), 0);
  assert.deepEqual([PREFETCH_PENDING, PREFETCH_READY, PREFETCH_MISSING, PREFETCH_FAILED, PREFETCH_REFUSED], [0, 1, -1, -2, -3]);
  assert.ok(PREFETCH_LIMITS.maxEntries >= 64, 'the SPEC floor: 64 pending or ready');
  assert.ok(PREFETCH_LIMITS.maxBytes >= 256 * 1024 * 1024, 'the SPEC floor: one asset of the maximum size');
  assert.equal(HOST_INFO_FIELDS.FLAGS, 16);
});

test('the cart imports both functions (so a host without them must stub)', () => {
  const parts = unzipSync(new Uint8Array(readFileSync(CART)));
  const names = WebAssembly.Module.imports(new WebAssembly.Module(parts['cart.wasm'])).map((i) => `${i.module}.${i.name}`);
  assert.ok(names.includes('env.wc_asset_prefetch'));
  assert.ok(names.includes('env.wc_asset_prefetch_cancel'));
});

for (const [what, source] of [
  ['.wasc on disk', () => CART],
  ['.wasc in memory', () => new Uint8Array(readFileSync(CART))],
]) {
  test(`CartHost, ${what}: PENDING then READY across frames, missing is -1, hash and cancel`, async () => {
    const host = new CartHost();
    await host.load(source());
    assert.equal(hostFlags(host) & HOST_FLAG_ASSET_PREFETCH, HOST_FLAG_ASSET_PREFETCH, 'the flag is in the host info');
    const trace = await run(host);
    assertPrefetched(trace, what);
    assert.equal(host._prefetch.heldBytes, 0, 'every whole read released the host copy');
    assert.equal(host._prefetch.size, 0, 'nothing left pending or ready');
    assert.deepEqual(host._prefetch.stats, { started: 3, ready: 3, missing: 0, failed: 0, refused: 0 });
    host.destroy();
  });

  test(`CartHost, ${what}: the old-host control (imports left out) fails the READY predicate and still reads`, async () => {
    const host = new CartHost();
    await host.load(source(), { assetPrefetch: false });
    assert.equal(hostFlags(host) & HOST_FLAG_ASSET_PREFETCH, 0, 'the flag is clear');
    const trace = await run(host);
    assertOldHost(trace, what);
    assert.equal(host._prefetch, null, 'no cache was ever made');
    host.destroy();
  });
}

test('CartHost, dev directory: the same, through readFile', async () => {
  const dir = unpack();
  try {
    const host = new CartHost();
    await host.load(dir);
    const trace = await run(host);
    assertPrefetched(trace, 'dir');
    assert.equal(host._prefetch.heldBytes, 0);
    host.destroy();

    const old = new CartHost();
    await old.load(dir, { assetPrefetch: false });
    assertOldHost(await run(old), 'dir, old host');
    old.destroy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CartHost: the read after READY is a copy (the frame does not inflate)', async () => {
  // The reading frame with a prefetch (copy + the cart's 8 MiB hash loop)
  // against the reading frame without one (inflate + copy + the same loop),
  // best of three each, so a scheduler hiccup cannot flip the comparison.
  const best = async (opts) => {
    let min = Infinity;
    for (let i = 0; i < 3; i++) {
      const host = new CartHost();
      await host.load(CART, opts);
      const trace = await run(host);
      const read = trace.find((f) => f.read_frame === f.frame);
      assert.ok(read, 'a frame did the read');
      min = Math.min(min, read.ms);
      host.destroy();
    }
    return min;
  };
  const withPrefetch = await best({});
  const without = await best({ assetPrefetch: false });
  assert.ok(withPrefetch < without,
    `the READY read (${withPrefetch.toFixed(2)} ms) is cheaper than the synchronous one (${without.toFixed(2)} ms)`);
});

test('CartHost: a cart that never prefetches gets no cache and no behaviour change', async () => {
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures', 'hello.wasc'));
  host.runFrame([]);
  assert.equal(host._prefetch, null);
  assert.equal(hostFlags(host) & HOST_FLAG_ASSET_PREFETCH, HOST_FLAG_ASSET_PREFETCH, 'the flag is still advertised');
  host.destroy();
});

test('CartHostWeb under Node, .wasc: DecompressionStream inflates the prefetch, and the old-host control', async () => {
  const bytes = new Uint8Array(readFileSync(CART));
  const host = new CartHostWeb();
  await host.load(bytes, {});
  assert.equal(hostFlags(host) & HOST_FLAG_ASSET_PREFETCH, HOST_FLAG_ASSET_PREFETCH);
  const trace = await run(host);
  assertPrefetched(trace, 'web .wasc');
  assert.equal(host._prefetch.heldBytes, 0);
  host.destroy();

  const old = new CartHostWeb();
  await old.load(bytes, { assetPrefetch: false });
  assert.equal(hostFlags(old) & HOST_FLAG_ASSET_PREFETCH, 0);
  assertOldHost(await run(old), 'web .wasc, old host');
  old.destroy();
});

// ─── the state machine both hosts share ────────────────────────────────────

/* A fetcher under test control: each path resolves when the test says so,
 * records the signal, and `missing/*` rejects as a 404 would. */
function fakeFetch() {
  const jobs = new Map();
  const fn = (path, signal, priority) => new Promise((resolve, reject) => {
    jobs.set(path, { resolve, reject, signal, priority });
    if (path.startsWith('missing/')) reject(new AssetMissingError(path));
    if (path.startsWith('bad/')) reject(new Error('network'));
  });
  fn.jobs = jobs;
  fn.finish = (path, n = 16) => { jobs.get(path).resolve(new Uint8Array(n)); return tick(); };
  return fn;
}

test('AssetPrefetcher: states, priority order, cancel, take, limits', async () => {
  const fetch = fakeFetch();
  const p = new AssetPrefetcher({ fetch, size: (path) => (path === 'known-missing' ? -1 : undefined),
    concurrency: 2, maxEntries: 4, maxBytes: 100 });

  assert.equal(p.request('a', 0), PREFETCH_PENDING);
  assert.equal(p.request('b', 5), PREFETCH_PENDING);
  assert.equal(p.request('c', 1), PREFETCH_PENDING);   // queued: two in flight
  assert.equal(p.request('d', 9), PREFETCH_PENDING);   // queued, higher
  assert.equal(p.request('e', 0), PREFETCH_REFUSED, 'a fifth entry is past maxEntries');
  assert.equal(p.request('known-missing', 0), PREFETCH_MISSING, 'a path the host knows is missing never enters');
  assert.equal(p.size, 4);
  assert.deepEqual([...fetch.jobs.keys()], ['a', 'b'], 'the first two started in call order');
  assert.equal(fetch.jobs.get('b').priority, 5, 'the fetcher sees the priority');

  assert.equal(p.request('a', 0), PREFETCH_PENDING, 'a repeat call is the poll');
  assert.equal(fetch.jobs.size, 2, 'and starts nothing');
  p.request('c', 20);   // raised above d while queued
  await fetch.finish('a', 10);
  assert.equal(p.request('a', 0), PREFETCH_READY);
  assert.equal(p.bytes('a').length, 10);
  assert.equal(p.heldBytes, 10);
  assert.deepEqual([...fetch.jobs.keys()], ['a', 'b', 'c'], 'the raised one started first');

  p.cancel('b');
  assert.equal(fetch.jobs.get('b').signal.aborted, true, 'cancel aborts the fetch in flight');
  assert.equal(p.has('b'), false);
  assert.deepEqual([...fetch.jobs.keys()], ['a', 'b', 'c'], 'the aborted fetch holds its slot until it settles');
  fetch.jobs.get('b').reject(new Error('aborted'));
  await tick();
  assert.equal(p.has('b'), false, 'a cancelled fetch leaves nothing behind');
  assert.deepEqual([...fetch.jobs.keys()], ['a', 'b', 'c', 'd'], 'and then its slot went to the next queued');

  assert.equal(p.take('a').length, 10, 'take hands back the bytes and ends the prefetch');
  assert.equal(p.has('a'), false);
  assert.equal(p.heldBytes, 0);
  assert.equal(p.request('a', 0), PREFETCH_PENDING, 'a later prefetch of the same path fetches again');

  await fetch.finish('c', 95);
  assert.equal(p.request('c', 0), PREFETCH_READY);
  await fetch.finish('d', 10);
  assert.equal(p.request('d', 0), PREFETCH_FAILED, 'bytes past maxBytes cannot be held');
  assert.equal(p.request('d', 0), PREFETCH_FAILED, 'and that is sticky');
  p.cancel('d');
  assert.equal(p.has('d'), false, 'until cancelled');
  p.dispose();
  assert.equal(p.size, 0);
  assert.equal(p.request('z', 0), PREFETCH_REFUSED, 'a disposed cache refuses');
});

test('AssetPrefetcher: MISSING and FAILED from the fetch, a known size reserved up front, pending() starts a queued fetch', async () => {
  const fetch = fakeFetch();
  const p = new AssetPrefetcher({ fetch, size: (path) => (path === 'sized' ? 80 : undefined), concurrency: 1, maxBytes: 100 });
  assert.equal(p.request('missing/x', 0), PREFETCH_PENDING, 'the host did not know');
  await tick();
  assert.equal(p.has('missing/x'), false, 'a 404 leaves the table');
  assert.equal(p.stats.missing, 1);
  assert.equal(p.request('bad/y', 0), PREFETCH_PENDING);
  await tick();
  assert.equal(p.request('bad/y', 0), PREFETCH_FAILED, 'a network error is FAILED');
  p.cancel('bad/y');

  assert.equal(p.request('sized', 0), PREFETCH_PENDING);
  assert.equal(p.heldBytes, 80, 'a known size is reserved at the call');
  assert.equal(p.request('other', 0), PREFETCH_PENDING, 'unknown size: accepted');
  assert.equal(p.request('sized2', 0), PREFETCH_PENDING);
  p.cancel('sized2');
  const q = new AssetPrefetcher({ fetch: fakeFetch(), size: () => 30, maxBytes: 100 });
  q.request('one'); q.request('two'); q.request('three');
  assert.equal(q.request('four'), PREFETCH_REFUSED, 'four known 30-byte assets do not fit in 100');

  // 'other' is queued behind 'sized' (concurrency 1); a read that wants it
  // now starts it ahead of the queue and waits on that one fetch.
  assert.equal(fetch.jobs.has('other'), false);
  const waited = p.pending('other');
  assert.ok(waited instanceof Promise);
  assert.equal(fetch.jobs.has('other'), true);
  assert.equal(p.pending('other'), waited, 'the same promise for a second reader');
  await fetch.finish('other', 5);
  assert.equal((await waited).length, 5);
  assert.equal(p.request('other', 0), PREFETCH_READY);
  await fetch.finish('sized', 80);
  assert.equal(p.heldBytes, 85);
  assert.equal(p.pending('sized'), undefined, 'nothing pending once READY');
});
