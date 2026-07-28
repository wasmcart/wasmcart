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

test('CartHost SELF-PROVIDES a context rather than demanding one', async () => {
  // SPEC.md: "A host SHOULD satisfy this itself rather than requiring its
  // embedder to." webgl-node is already a dependency, so this host can make
  // its own offscreen context; 0.8.0 threw here instead, which enforced the
  // rule's letter while still failing carts the host was perfectly capable of
  // running. A caller-supplied glBackend still wins.
  const host = new CartHost();
  await host.load(GLCART, {});
  assert.equal(host.usesGL, true);
  host.runFrame([{ connected: true, buttons: 0 }]);
  host.destroy();
});

test('there is NO opt-out: stubbing a GL cart is never reachable', async () => {
  // GL is part of the host contract, not a capability a host advertises, so a
  // cart author can rely on it. There is deliberately no flag that re-enables
  // stubbing -- a stubbed GL cart renders black while reporting success, which
  // is undetectable from the cart's side. The flag is now simply ignored: the
  // host provides a real context either way.
  const host = new CartHost();
  await host.load(GLCART, { allowMissingGL: true });
  assert.equal(host.usesGL, true, 'a flag must not buy back the stub path');
  host.destroy();
});

test('a host-created context is released on destroy, a caller-supplied one is not', async () => {
  // The host owns only what it made. Losing a context the caller passed would
  // break a page that is still drawing into its own canvas.
  const h1 = new CartHost();
  await h1.load(GLCART, {});
  assert.ok(h1._ownedGl, 'self-provisioned context is tracked as owned');
  h1.destroy();
  assert.equal(h1._ownedGl, null, 'released on destroy');

  const calls = [];
  const h2 = new CartHost();
  await h2.load(GLCART, { glBackend: mockGl(calls) });
  assert.equal(h2._ownedGl, null, 'a caller-supplied context is never owned');
  h2.destroy();
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
test('CartHostWeb SELF-PROVIDES a context rather than demanding one', async () => {
  // Both hosts must satisfy "a GL cart always gets a real context", but they
  // satisfy it differently: node needs native-gles supplied, while a browser
  // can always create WebGL2 itself (shipped everywhere for over a decade), so
  // the web host makes its own offscreen context instead of pushing the
  // requirement onto the page. Under node --test there is no WebGL2 at all, so
  // what we can assert here is that it does NOT reject for lack of a caller-
  // supplied backend — it fails, if at all, on the context being unavailable.
  const { CartHostWeb: WebHost } = await import('../web.js');
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(GLCART));

  const host = new WebHost();
  await assert.rejects(
    host.load(bytes, {}),
    /WebGL2 context could not be created/,
    'must try to create its own context, not blame the caller for not passing one',
  );
});

// getGlContext() must report the live context REGARDLESS of who created it.
// bin/wasmcart-play.js needs it for GL readback, and it previously read the
// private _ownedGl — which is only set when the host self-provisions, so a
// caller passing its own glBackend silently disabled readback.
test('getGlContext() reports both host-created and caller-supplied contexts', async () => {
  const selfProvided = new CartHost();
  await selfProvided.load(GLCART, {});
  assert.ok(selfProvided.getGlContext(), 'host-created context must be reported');
  selfProvided.destroy();

  const calls = [];
  const supplied = mockGl(calls);
  const caller = new CartHost();
  await caller.load(GLCART, { glBackend: supplied });
  assert.equal(caller.getGlContext(), supplied,
    'a caller-supplied context must be reported too, not null');
  caller.destroy();

  const twoD = new CartHost();
  await twoD.load(HELLO, {});
  assert.equal(twoD.getGlContext(), null, '2D cart has no context');
  twoD.destroy();
});
