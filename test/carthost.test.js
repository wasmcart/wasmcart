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
