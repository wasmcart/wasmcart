// Deterministic replay + debug events (WS3 Parts B and C) against the REAL
// vendored detrng.wasc fixture (WC_DETERMINISTIC_RNG + WC_DEBUG_FIELDS +
// wc_debug_mark, RNG-noise framebuffer so determinism is visible in the hash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CartHost } from '../index.js';
import { FLAG_DETERMINISTIC, HOST_FLAG_DETERMINISTIC } from '../src/abi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DETRNG = join(HERE, 'fixtures', 'detrng.wasc');
const HELLO = join(HERE, 'fixtures', 'hello.wasc');

const PAD = [{ connected: true, buttons: 0 }];

function fbHash(fb) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < fb.length; i += 97) h = ((h ^ fb[i]) * 16777619) >>> 0;
  return h;
}

async function runFrames(path, options, frames) {
  const cart = new CartHost();
  await cart.load(path, options);
  let last;
  for (let i = 0; i < frames; i++) last = cart.runFrame(PAD);
  const out = { hash: fbHash(last.framebuffer), cart };
  return out;
}

// ── ABI constants ────────────────────────────────────────────────────────────

test('flag constants: FLAG_DETERMINISTIC=1<<6, HOST_FLAG_DETERMINISTIC=1<<0', () => {
  assert.equal(FLAG_DETERMINISTIC, 1 << 6);
  assert.equal(HOST_FLAG_DETERMINISTIC, 1 << 0);
});

// ── Part B: deterministic replay ─────────────────────────────────────────────

test('same seed → identical frame sequence (the replay guarantee)', async () => {
  const a = await runFrames(DETRNG, { deterministic: { seed: 1234 } }, 10);
  const b = await runFrames(DETRNG, { deterministic: { seed: 1234 } }, 10);
  assert.equal(a.hash, b.hash, 'two fresh loads with the same seed hash identically');
  a.cart.destroy(); b.cart.destroy();
});

test('different seed → the sequence diverges', async () => {
  const a = await runFrames(DETRNG, { deterministic: { seed: 1234 } }, 10);
  const b = await runFrames(DETRNG, { deterministic: { seed: 9999 } }, 10);
  assert.notEqual(a.hash, b.hash, 'a different seed produces a different frame sequence');
  a.cart.destroy(); b.cart.destroy();
});

test('deterministic load sets seed, fixed step, and the host-info flag', async () => {
  const cart = new CartHost();
  await cart.load(DETRNG, { deterministic: { seed: 42 } });
  assert.equal(cart.deterministicSeed, 42);
  assert.ok(cart._fixedStepMs > 0, 'fixed virtual clock engaged');
  assert.equal(cart.info.hasDeterministic, true, 'cart declares FLAG_DETERMINISTIC');
  // The host wrote HOST_FLAG_DETERMINISTIC into wc_host_info.flags (offset 16).
  const u32 = new Uint32Array(cart.memory.buffer);
  const flags = u32[(cart.info.hostInfoPtr + 16) >> 2];
  assert.ok(flags & HOST_FLAG_DETERMINISTIC, 'host-info flags carry the replay bit');
  cart.destroy();
});

test('normal load: no seed, no flag, wall-clock — determinism fully absent', async () => {
  const cart = new CartHost();
  await cart.load(DETRNG);
  assert.equal(cart.deterministicSeed, null);
  assert.equal(cart._fixedStepMs, 0, 'wall-clock path untouched');
  const u32 = new Uint32Array(cart.memory.buffer);
  const flags = u32[(cart.info.hostInfoPtr + 16) >> 2];
  assert.equal(flags & HOST_FLAG_DETERMINISTIC, 0, 'no replay bit on a normal run');
  cart.destroy();
});

test('a cart WITHOUT wc_set_seed still loads deterministically (fixed step only)', async () => {
  // hello has no WC_DETERMINISTIC_RNG — the optional export is simply absent.
  const cart = new CartHost();
  await cart.load(HELLO, { deterministic: { seed: 7 } });
  assert.equal(cart.info.hasDeterministic, false, 'hello never declared the flag');
  assert.ok(cart._fixedStepMs > 0, 'fixed step still applies');
  cart.runFrame(PAD); // and it runs
  cart.destroy();
});

test('input still drives a deterministic run (replay = seed + script)', async () => {
  const cart = new CartHost();
  await cart.load(DETRNG, { deterministic: { seed: 5 } });
  const before = cart.readDebugValue('player_x').value;
  for (let i = 0; i < 5; i++) cart.runFrame([{ connected: true, buttons: 1 << 11 /* RIGHT */ }]);
  assert.equal(cart.readDebugValue('player_x').value, before + 10, 'right held 5 frames = +10');
  cart.destroy();
});

// ── Part C: debug events (marks + captured log) ──────────────────────────────

test('wc_debug_mark and wc_log land in the event trace, frame-stamped', async () => {
  const cart = new CartHost();
  await cart.load(DETRNG, { deterministic: { seed: 1 } });
  for (let i = 0; i < 10; i++) cart.runFrame(PAD);
  const { log, marks } = cart.drainDebugEvents();
  assert.deepEqual(marks.map((m) => m.id), [1, 2], 'init mark + frame-5 milestone');
  assert.equal(marks[0].frame, 0, 'init mark stamped at frame 0');
  assert.equal(marks[1].frame, 4, 'milestone stamped on the frame it fired');
  assert.equal(log.length, 1);
  assert.match(log[0].text, /detrng init/);
});

test('drainDebugEvents clears the rings (pull-model)', async () => {
  const cart = new CartHost();
  await cart.load(DETRNG);
  cart.runFrame(PAD);
  cart.drainDebugEvents();
  const second = cart.drainDebugEvents();
  assert.equal(second.log.length, 0);
  assert.equal(second.marks.length, 0);
  cart.destroy();
});

test('event rings are capped — a chatty cart cannot grow host memory unbounded', () => {
  const cart = new CartHost();
  for (let i = 0; i < CartHost.MAX_DEBUG_EVENTS + 100; i++) {
    cart._pushDebugEvent(cart.debugMarks, { frame: i, id: i });
  }
  assert.equal(cart.debugMarks.length, CartHost.MAX_DEBUG_EVENTS);
  assert.equal(cart.debugMarks[0].frame, 100, 'oldest entries dropped first');
});

test('a cart that never logs or marks leaves the rings empty', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  for (let i = 0; i < 5; i++) cart.runFrame(PAD);
  const { log, marks } = cart.drainDebugEvents();
  assert.equal(marks.length, 0);
  // hello logs once at init via WC_LOG — that IS captured; marks stay empty.
  assert.ok(log.length <= 1);
  cart.destroy();
});
