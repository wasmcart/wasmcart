// glBackend FACTORY contract — the launcher never needs to know a cart is GL
// before loading it. CartHost detects GL from the wasm import section (the
// ground truth; no manifest gate) and invokes the factory exactly once, only
// for GL carts. Fixtures: glcart.wasc (imports gl.glClear/glClearColor,
// hybrid fb) and hello.wasc (pure 2D).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, 'fixtures', 'glcart.wasc');
const HELLO = path.join(HERE, 'fixtures', 'hello.wasc');

/** Auto-stubbing WebGL2 mock: every method exists, records its name.
 *  Promise-protocol props must stay undefined — an auto-stubbed `then` turns
 *  the mock into a never-resolving thenable and `await factory()` hangs. */
function mockGl(calls) {
  return new Proxy({}, {
    get(t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      if (!(prop in t)) t[prop] = (...args) => { calls.push(String(prop)); return 0; };
      return t[prop];
    },
  });
}

test('GL cart: async factory invoked exactly once, usesGL true, GL calls flow', async () => {
  const calls = [];
  let invoked = 0;
  const host = new CartHost();
  await host.load(GLCART, {
    glBackend: async () => { invoked++; return mockGl(calls); },
  });
  assert.equal(invoked, 1, 'factory ran once');
  assert.equal(host.usesGL, true);
  host.runFrame([{ connected: true, buttons: 0 }]);
  assert.ok(calls.includes('clear'), `cart's glClear reached the backend (saw: ${calls.join(',')})`);
  host.destroy();
});

test('2D cart: factory is NEVER invoked', async () => {
  const host = new CartHost();
  await host.load(HELLO, {
    glBackend: () => { throw new Error('factory must not run for a 2D cart'); },
  });
  assert.equal(host.usesGL, false);
  host.runFrame([{ connected: true, buttons: 0 }]);
  host.destroy();
});

test('GL cart: factory returning nothing is a loud error, not a silent stub', async () => {
  const host = new CartHost();
  await assert.rejects(
    host.load(GLCART, { glBackend: () => null }),
    /glBackend factory returned no GL context/,
  );
});

test('GL cart with no glBackend at all: documented stub fallback (2D contract survives)', async () => {
  // Existing behavior, pinned: GL imports are stubbed at instantiation, but
  // the cart's own gpu_api=1 declaration is authoritative post-init, so
  // usesGL reports true (this is what launchers key "needs a GL window" off)
  // while the hybrid framebuffer path still runs against the stubs.
  const host = new CartHost();
  await host.load(GLCART, {});
  assert.equal(host.usesGL, true, 'gpu_api declaration is authoritative');
  const r = host.runFrame([{ connected: true, buttons: 0 }]);
  assert.ok(r.framebuffer && r.width === 64 && r.height === 64, 'fb path intact under stubs');
  host.destroy();
});

test('plain (non-factory) glBackend object still works as before', async () => {
  const calls = [];
  const host = new CartHost();
  await host.load(GLCART, { glBackend: mockGl(calls) });
  assert.equal(host.usesGL, true);
  host.runFrame([{ connected: true, buttons: 0 }]);
  assert.ok(calls.includes('clear'));
  host.destroy();
});
