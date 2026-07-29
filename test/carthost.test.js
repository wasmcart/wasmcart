// CartHost reference-host integration - load a real cart and drive it. Uses the
// tiny vendored hello.wasc fixture (a 2D, no-GL cart) so this runs headless in CI
// with no GL backend, no sibling-dir dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { CartHost } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO = join(HERE, 'fixtures', 'hello.wasc');

test('loads a .wasc cart and reports info', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  const info = cart.getInfo();
  assert.equal(cart.usesGL, false, 'hello is a 2D cart');
  assert.ok(info.width > 0 && info.height > 0);
  assert.ok(info.version >= 1 && info.version <= 3);
  cart.destroy();
});

test('runFrame returns a correctly-sized framebuffer', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  const { width, height } = cart.getInfo();
  const frame = cart.runFrame([]);
  assert.ok(frame.framebuffer instanceof Uint8Array);
  assert.equal(frame.framebuffer.length, width * height * 4, 'ARGB8888 = w*h*4 bytes');
  assert.equal(frame.width, width);
  assert.equal(frame.height, height);
  cart.destroy();
});

test('runs many frames without throwing', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  for (let i = 0; i < 60; i++) cart.runFrame([]);
  cart.destroy();
});

test('loads from a Uint8Array of the .wasc bytes', async () => {
  const bytes = readFileSync(HELLO);
  const cart = new CartHost();
  await cart.load(bytes);
  assert.ok(cart.getInfo().width > 0);
  cart.destroy();
});

test('rejects non-wasc buffer data', async () => {
  const cart = new CartHost();
  await assert.rejects(
    () => cart.load(new Uint8Array([1, 2, 3, 4])),
    /wasc|ZIP|Invalid/i,
  );
});

// ── Debug ABI (opt-in) — the reader logic against hand-laid memory (no compiler
// needed; a real debug cart is built from C but the reader is what we test here).

test('debug ABI: readDebugState/readDebugValue/writeDebugValue round-trip', async () => {
  const host = new CartHost();
  const mem = new WebAssembly.Memory({ initial: 1 });
  host.memory = mem;
  host._u8 = new Uint8Array(mem.buffer);
  host._u32 = new Uint32Array(mem.buffer);
  host.info = { hasDebug: true, flags: 1 << 5 };
  const dv = new DataView(mem.buffer);
  // name "hp" @0x100, value u8=42 @0x200, table @0x300 (one entry + terminator)
  host._u8.set(new TextEncoder().encode('hp\0'), 0x100);
  host._u8[0x200] = 42;
  dv.setUint32(0x300, 0x100, true); // name_ptr
  dv.setUint32(0x304, 0x200, true); // value_ptr
  host._u8[0x308] = 0;              // type U8
  dv.setUint32(0x30C, 1, true);     // len
  dv.setUint32(0x310, 0, true);     // terminator (name_ptr = 0)
  host.instance = { exports: { wc_debug_state: () => 0x300 } };

  const fields = host.readDebugState();
  assert.equal(fields.length, 1);
  assert.deepEqual(fields[0], { name: 'hp', type: 0, typeName: 'u8', valuePtr: 0x200, len: 1 });
  assert.deepEqual(host.readDebugValue('hp'), { name: 'hp', type: 'u8', value: 42 });
  host.writeDebugValue('hp', 99);
  assert.equal(host.readDebugValue('hp').value, 99);
  assert.throws(() => host.readDebugValue('nope'), /not found/);
});

test('debug ABI: a non-debug cart returns null (default off, structurally absent)', () => {
  const host = new CartHost();
  host.info = { hasDebug: false, flags: 0 };
  host.instance = { exports: {} };
  assert.equal(host.readDebugState(), null);
});

test('debug ABI: FLAG_DEBUG set but no export → null (conformance catches it), no crash', () => {
  const host = new CartHost();
  host.info = { hasDebug: true, flags: 1 << 5 };
  host.instance = { exports: {} }; // claims debug but didn't export the table
  assert.equal(host.readDebugState(), null);
});

// ── Manifest is optional, and never gates a cart's own capabilities ──────────
// Two rules from SPEC "Manifest", both of which had silent-failure modes:
//   1. A cart with no manifest.json must run (it used to be refused outright).
//   2. A manifest field must never gate a capability the cart declares in
//      wc_info_t.flags. pointer/keyboard were double-gated: the flag AND the
//      manifest had to agree, so a cart with WC_FLAG_KEYBOARD whose manifest
//      omitted "keyboard" got no input and no error — the same silent failure
//      that GL detection was fixed for earlier.
test('a cart with NO manifest.json loads and runs', async () => {
  const bytes = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'nomanifest.wasc')));
  const host = new CartHost();
  await host.load(bytes, {});
  assert.equal(host.getManifest(), null, 'no manifest is reported as null, not an error');
  const r = host.runFrame([{ connected: true, buttons: 0 }]);
  assert.ok(r.width > 0 && r.height > 0, 'cart still reports its own resolution');
  assert.equal(r.framebuffer.length, r.width * r.height * 4);
  host.destroy();
});

test('pointer/keyboard are gated by the FLAG alone, not the manifest', async () => {
  // Guards against reintroducing the double gate. The delivery paths must
  // consult wc_info_t only; grep is the cheapest reliable check that no
  // manifest field crept back into them.
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    assert.ok(!/_manifest\?\.pointer/.test(src),
      `${f}: pointer delivery must not consult the manifest`);
    assert.ok(!/_manifest\?\.keyboard/.test(src),
      `${f}: keyboard delivery must not consult the manifest`);
  }
});

// --- Rumble (ABI v3) ---
// The fixture cart calls rumble on frames 1-4: a normal effect, one with
// out-of-range magnitudes and an over-long duration, one on an invalid pad
// slot, then a stop.

test('rumble reaches the device, clamped and slot-checked', async () => {
  const host = new CartHost();
  const calls = [];
  host.setRumbleHandler({
    hasRumble: (p) => p === 0,
    rumble: (p, low, high, ms) => calls.push({ p, low, high, ms }),
    stopRumble: (p) => calls.push({ p, stop: true }),
  });
  await host.load(join(HERE, 'fixtures/rumble.wasc'));
  for (let i = 0; i < 5; i++) host.runFrame([{ connected: true, buttons: 0 }]);

  assert.deepEqual(calls[0], { p: 0, low: 0.5, high: 0.25, ms: 200 },
    'in-range values pass through untouched');

  // 99.0 -> 1, -5.0 -> 0, 999999ms -> the 5s cap. Clamping (not rejecting)
  // matters because a cart deriving intensity from game state overshoots at
  // the edges, and a dropped rumble is harder to notice than a saturated one.
  assert.deepEqual(calls[1], { p: 0, low: 1, high: 0, ms: 5000 },
    'magnitudes clamp to 0..1 and duration caps at MAX_RUMBLE_MS');

  // The cart also asked pad 99 to rumble; that must never reach the device.
  assert.ok(!calls.some((c) => c.p !== 0), 'out-of-range pad slots are dropped');
  assert.deepEqual(calls[2], { p: 0, stop: true }, 'stop is delivered');
  host.destroy();
});

test('a cart that rumbles runs fine with no rumble handler at all', async () => {
  // Headless runs, --frames captures and tests wire no handler. Rumble must
  // degrade to a silent no-op rather than faulting the cart.
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/rumble.wasc'));
  for (let i = 0; i < 5; i++) host.runFrame([{ connected: true, buttons: 0 }]);
  host.destroy();
});

test('a throwing rumble handler cannot fault the cart', async () => {
  // A pad unplugged mid-effect makes SDL throw. That is the host's problem,
  // not the cart's.
  const host = new CartHost();
  host.setRumbleHandler({
    hasRumble: () => { throw new Error('unplugged'); },
    rumble: () => { throw new Error('unplugged'); },
    stopRumble: () => { throw new Error('unplugged'); },
  });
  await host.load(join(HERE, 'fixtures/rumble.wasc'));
  for (let i = 0; i < 5; i++) host.runFrame([{ connected: true, buttons: 0 }]);
  host.destroy();
});

test('both hosts expose the same three rumble imports', async () => {
  // Divergence between the node and web hosts is the failure mode here: a cart
  // that rumbles in the terminal but silently does not in the browser.
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const imp of ['wc_pad_has_rumble', 'wc_pad_rumble', 'wc_pad_rumble_stop']) {
      assert.ok(src.includes(imp), `${f} must provide ${imp}`);
    }
  }
});
