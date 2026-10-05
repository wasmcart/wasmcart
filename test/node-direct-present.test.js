// Node CartHost direct present (opt in): with directPresent the cart draws
// straight into the context's default framebuffer when that matches the
// cart's size, skipping the redirect FBO. It has to show the same picture,
// be readable through withRenderedFrame, and stay OFF unless asked for
// (embedders that scale the cart into a window need the redirect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLTRI = path.join(HERE, 'fixtures', 'gltri.wasc');

/* the cart's own resolution, so the host makes its context that size
 * (a mismatched context rightly stays redirected) */
let cartSize = null;
async function sized(t) {
  if (cartSize) return cartSize;
  const host = new CartHost();
  try { await host.load(GLTRI); } catch (e) { t.skip('no GL here: ' + e.message); return null; }
  const { width, height } = host.getInfo();
  host.destroy?.();
  cartSize = { preferredWidth: width, preferredHeight: height };
  return cartSize;
}

async function run(t, options) {
  const size = await sized(t);
  if (!size) return null;
  options = { ...size, ...options };
  const host = new CartHost();
  try {
    await host.load(GLTRI, options);
  } catch (e) {
    if (/GL|EGL|webgl/i.test(String(e.message))) { t.skip('no GL here: ' + e.message); return null; }
    throw e;
  }
  for (let i = 0; i < 3; i++) host.runFrame([{ connected: true, buttons: 0 }]);
  const gl = host.getGlContext();
  const { width, height } = host.getInfo();
  const px = new Uint8Array(width * height * 4);
  const read = host.withRenderedFrame(() => gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px));
  const out = { direct: !!host._glFuncs?._isDirectPresent?.(), read, px, msaa: !!gl.getContextAttributes?.()?.antialias };
  host.destroy?.();
  return out;
}

test('a context the wrong size stays redirected even when asked', async (t) => {
  const host = new CartHost();
  try { await host.load(GLTRI, { directPresent: true, preferredWidth: 333, preferredHeight: 222 }); } catch (e) { t.skip(String(e.message)); return; }
  host.runFrame([{ connected: true, buttons: 0 }]);
  assert.equal(!!host._glFuncs?._isDirectPresent?.(), false);
  host.destroy?.();
});

test('direct present is off unless asked for', async (t) => {
  const r = await run(t, {});
  if (!r) return;
  assert.equal(r.direct, false, 'default keeps the redirect FBO');
});

test('direct present: engaged on request, same pixels as the redirect path', async (t) => {
  const redirect = await run(t, {});
  if (!redirect) return;
  const direct = await run(t, { directPresent: true });
  assert.equal(direct.direct, true, 'directPresent: true engages it on a cart-sized context');
  assert.equal(direct.read, true, 'withRenderedFrame reads the default framebuffer');
  assert.ok(redirect.px.some((v, i) => (i & 3) !== 3 && v !== 0), 'the redirect frame is not empty');
  let diff = 0;
  for (let i = 0; i < redirect.px.length; i++) if (redirect.px[i] !== direct.px[i]) diff++;
  assert.equal(diff, 0, 'identical frame either way');
});

test('direct present refuses a multisampled context unless msaa is allowed', async (t) => {
  const plain = await run(t, { directPresent: true, antialias: true });
  if (!plain) return;
  if (!plain.msaa) { t.skip('this webgl-node cannot make a multisampled context (antialias needs webgl-node > 1.5.2 + native-gles samples)'); return; }
  assert.equal(plain.direct, false, 'antialias context + directPresent: true stays redirected');
  const msaa = await run(t, { directPresent: 'msaa', antialias: true });
  assert.equal(msaa.direct, true, "directPresent: 'msaa' takes the multisampled context");
  assert.equal(msaa.read, true);
});
