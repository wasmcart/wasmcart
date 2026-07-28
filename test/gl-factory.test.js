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

test('GL cart with no glBackend at all is a load error, not a silent stub', async () => {
  // SPEC.md: "a factory that produces no context for a GL cart is a load
  // error, never a silent stub." This case used to stub instead, which is
  // fine for a hybrid cart that also fills a framebuffer but catastrophic
  // for a GL-RENDERING one: load() reports success and the player sees a
  // black screen with no error anywhere.
  const host = new CartHost();
  await assert.rejects(
    host.load(GLCART, {}),
    /no glBackend was provided/,
  );
});

test('there is NO opt-out: stubbing a GL cart is never reachable', async () => {
  // GL is part of the host contract, not a capability a host advertises, so a
  // cart author can rely on it. There is deliberately no flag that re-enables
  // stubbing -- a stubbed GL cart renders black while reporting success, which
  // is undetectable from the cart's side.
  const host = new CartHost();
  await assert.rejects(
    host.load(GLCART, { allowMissingGL: true }),
    /no glBackend was provided/,
    'a flag must not buy back the stub path',
  );
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

// ── Host parity ──────────────────────────────────────────────────────────────
// The browser host is the DEFAULT export for browsers, so a rule enforced only
// in CartHost silently doesn't apply to most consumers. 0.7.0 shipped exactly
// that divergence: node errored on a GL cart with no context while the web host
// still stubbed it. Pin both to the same contract.
test('CartHostWeb enforces the GL contract identically to CartHost', async () => {
  const { CartHostWeb: WebHost } = await import('../web.js');
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(GLCART));

  const host = new WebHost();
  await assert.rejects(
    host.load(bytes, {}),
    /no glBackend was provided/,
    'web host must reject a GL cart with no context, same as node',
  );

  const host2 = new WebHost();
  await assert.rejects(
    host2.load(bytes, { allowMissingGL: true }),
    /no glBackend was provided/,
    'and must not honor an opt-out flag either',
  );
});
