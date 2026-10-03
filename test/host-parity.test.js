// CartHost (node) vs CartHostWeb (browser): the two hosts must not drift.
//
// WHY THIS EXISTS: the two hosts are separate implementations of the same
// ABI, and nothing structurally connected them. A feature added to
// CartHost.js simply never arrived in CartHostWeb.js, silently, and the
// browser suite could not notice because it only tests what it was written
// to test. Measured drift at the time this was written: the web host was 6
// weeks and 5 commits behind, and was missing the entire debug ABI, so a
// cart built with FLAG_DEBUG got a no-op stub in a browser and working
// introspection under node.
//
// WHAT THIS TEST IS FOR: the ABI is a promise to CART AUTHORS, and a cart
// does not know which host it will be run by. So anything a cart can
// DECLARE or CALL has to mean the same thing in both. Host-side plumbing
// does not -- a browser has no SDL surface to blit to and node has no DOM to
// wire lifecycle events from -- so platform-specific methods are listed
// explicitly, with the reason, rather than the test being loosened to let
// everything through.
//
// WHEN THIS FAILS: do not add the name to the allowlist to make it green.
// The allowlist is for things that CANNOT exist on the other side. If a
// cart-visible feature is missing, the fix is to implement it in the other
// host -- that is the entire point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

const nativeSrc = readFileSync(join(SRC, 'CartHost.js'), 'utf8');
const webSrc = readFileSync(join(SRC, 'CartHostWeb.js'), 'utf8');

/**
 * Public method names declared in a host's class body.
 *
 * Scoped to the `export class ...` body on purpose: scanning the whole file
 * picks up module-level helpers and even imported fs functions at the same
 * indentation, which is how an earlier cut of this test "found" readSync and
 * walk as host methods.
 */
function publicMethods(src) {
  const start = src.search(/^export class \w+/m);
  assert.ok(start >= 0, 'no exported host class found');
  const body = src.slice(start);
  const names = new Set();
  for (const m of body.matchAll(/^ {2}(?:async )?([a-zA-Z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('_') || name === 'constructor') continue;
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'get', 'set'].includes(name)) continue;
    names.add(name);
  }
  return names;
}

// Methods that exist in ONE host because the other platform has no such
// concept. Each entry needs a reason; "it isn't implemented yet" is not one.
const NODE_ONLY = new Map([
  ['presentToSurface', 'blits the redirect FBO onto an SDL window surface; a browser presents via canvas'],
  ['withRenderedFrame', 'lends the caller the node GL readback buffer; the browser path has no equivalent'],
]);

const WEB_ONLY = new Map([
  ['autoWireLifecycle', 'binds DOM visibility/focus events; node has no document'],
]);

// KNOWN DRIFT, not a platform difference. These are cart-visible features
// that exist under node and not in a browser, and they are listed here
// rather than in NODE_ONLY so the list reads as a debt to pay down, not as a
// decision that was made. Porting them is what makes these lines go away.
//
// The debug ABI (FLAG_DEBUG + wc_debug_state) is the big one: a cart built
// with debug fields gets working introspection under node and a no-op stub
// in a browser. CartHostWeb stubs wc_debug_mark and never reads FLAG_DEBUG.
test('every cart-visible host method exists in BOTH hosts', { todo: 'port the debug ABI and setFixedStep to CartHostWeb' }, () => {
  const native = publicMethods(nativeSrc);
  const web = publicMethods(webSrc);

  const missingFromWeb = [...native].filter((m) => !web.has(m) && !NODE_ONLY.has(m)).sort();
  const missingFromNative = [...web].filter((m) => !native.has(m) && !WEB_ONLY.has(m)).sort();

  assert.deepEqual(missingFromWeb, [],
    `CartHostWeb is missing: ${missingFromWeb.join(', ')}\n`
    + 'Implement them there, or add each to NODE_ONLY with the reason it cannot exist in a browser.');
  assert.deepEqual(missingFromNative, [],
    `CartHost is missing: ${missingFromNative.join(', ')}\n`
    + 'Implement them there, or add each to WEB_ONLY with the reason it cannot exist under node.');
});

test('the allowlists stay honest', () => {
  // An allowlist entry for a method that no longer exists, or that the other
  // host has since implemented, is stale and hides the next real drift.
  const native = publicMethods(nativeSrc);
  const web = publicMethods(webSrc);

  for (const [name] of NODE_ONLY) {
    assert.ok(native.has(name), `NODE_ONLY lists '${name}', which CartHost no longer has`);
    assert.ok(!web.has(name),
      `NODE_ONLY lists '${name}' but CartHostWeb implements it now -- drop the entry`);
  }
  for (const [name] of WEB_ONLY) {
    assert.ok(web.has(name), `WEB_ONLY lists '${name}', which CartHostWeb no longer has`);
    assert.ok(!native.has(name),
      `WEB_ONLY lists '${name}' but CartHost implements it now -- drop the entry`);
  }
});

test('both hosts decode every ABI flag a cart can set', { todo: 'CartHostWeb does not read FLAG_DEBUG' }, () => {
  // A cart sets these in wc_info_t.flags. A host that never reads one
  // silently ignores a capability the cart declared -- the exact shape of
  // the bug where a Defold cart's FLAG_DEBUG did nothing in a browser.
  for (const flag of ['FLAG_POINTER', 'FLAG_KEYBOARD', 'FLAG_DEBUG',
                      'FLAG_NET_PEER', 'FLAG_AUDIO_F32', 'FLAG_DETERMINISTIC']) {
    assert.ok(nativeSrc.includes(flag), `CartHost does not read ${flag}`);
    assert.ok(webSrc.includes(flag), `CartHostWeb does not read ${flag}`);
  }
});

test('both hosts read every pointer in wc_info_t', () => {
  // Each of these is an address the cart handed over expecting it to be
  // used. A host that parses the field but never writes through it leaves
  // the cart reading zeroes.
  for (const field of ['pointerPtr', 'keysPtr', 'wheelPtr', 'timePtr',
                       'hostInfoPtr', 'savePtr', 'audioPtr', 'inputPtr']) {
    assert.ok(nativeSrc.includes(field), `CartHost does not use info.${field}`);
    assert.ok(webSrc.includes(field), `CartHostWeb does not use info.${field}`);
  }
});

test('both hosts deliver every pointer and keyboard event export', () => {
  // The event half of the input ABI. A host that writes the state block but
  // never calls these breaks event-driven carts while looking fine in a
  // state-polling one.
  for (const exp of ['wc_ptr_on_down', 'wc_ptr_on_move', 'wc_ptr_on_up',
                     'wc_kb_on_down', 'wc_kb_on_up']) {
    assert.ok(nativeSrc.includes(exp), `CartHost never calls ${exp}`);
    assert.ok(webSrc.includes(exp), `CartHostWeb never calls ${exp}`);
  }
});
