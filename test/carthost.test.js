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
