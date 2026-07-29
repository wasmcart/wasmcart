// GL orientation — does a rendered frame come out the right way up, and does
// it fill the drawable?
//
// The existing GL fixture cannot answer this: glcart only calls glClearColor,
// so every pixel is identical and a vertical flip or a wrong viewport is
// invisible. gltri.wasc draws deliberately asymmetric geometry instead:
//
//     red bar across the TOP, green bar down the LEFT,
//     white square in the TOP-LEFT, dark blue everywhere else
//
// so the pixels themselves say which way is up. Red along the bottom means the
// frame is flipped; everything bunched in one corner means the viewport or
// drawable is wrong; a uniform frame means nothing rendered at all.
//
// GL carts render on the GPU, so reading host.runFrame().framebuffer is NOT
// how you inspect them -- it is all zeroes. The pixels have to come back via
// readPixels, bottom-up, exactly as bin/wasmcart-play.js does it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';
import { fitRect } from '../src/letterbox.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLTRI = path.join(HERE, 'fixtures', 'gltri.wasc');

/** Read the cart's GL output back top-down, the way the players do. */
function readFrame(host) {
  const gl = host.getGlContext();
  const { width, height } = host.getInfo();
  const raw = new Uint8Array(width * height * 4);
  gl.finish();
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);

  // GL is bottom-up; flip into scanline order so y=0 is the TOP row.
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * width * 4;
    out.set(raw.subarray(src, src + width * 4), dst);
  }
  return { pixels: out, width, height };
}

const at = (f, x, y) => {
  const i = (y * f.width + x) * 4;
  return { r: f.pixels[i], g: f.pixels[i + 1], b: f.pixels[i + 2] };
};
const isRed = (p) => p.r > 200 && p.g < 90 && p.b < 90;
const isGreen = (p) => p.g > 200 && p.r < 90;
const isWhite = (p) => p.r > 200 && p.g > 200 && p.b > 200;
const isBlue = (p) => p.b > p.r && p.b > p.g;

/** A host with no GL driver cannot run these; skip rather than fail. */
async function loadOrSkip(t) {
  const host = new CartHost();
  try {
    await host.load(GLTRI);
  } catch (e) {
    t.skip(`no GL context available: ${e.message}`);
    return null;
  }
  return host;
}

test('a GL frame renders right way up and fills the drawable', async (t) => {
  const host = await loadOrSkip(t);
  if (!host) return;
  host.runFrame([{ connected: true, buttons: 0 }]);
  const f = readFrame(host);

  const midX = Math.floor(f.width / 2);
  const midY = Math.floor(f.height / 2);

  assert.ok(isRed(at(f, midX, 8)),
    'the red bar must be along the TOP edge (red at the bottom = flipped)');
  assert.ok(!isRed(at(f, midX, f.height - 8)),
    'the bottom edge must NOT be red');
  assert.ok(isGreen(at(f, 8, midY)),
    'the green bar must be down the LEFT edge');
  assert.ok(isWhite(at(f, 44, 44)),
    'the white square must be in the TOP-LEFT quadrant');
  assert.ok(isBlue(at(f, f.width - 20, f.height - 20)),
    'the far corner must be background -- content bunched in one corner means ' +
    'the viewport or drawable is wrong');
  host.destroy();
});

test('the frame is not uniform, so a blank render cannot pass', async (t) => {
  // Guards the assertions above: if the cart silently stopped drawing, every
  // sample could still coincidentally satisfy a sloppy predicate. Requiring
  // several distinct colours means a blank frame fails.
  const host = await loadOrSkip(t);
  if (!host) return;
  host.runFrame([{ connected: true, buttons: 0 }]);
  const f = readFrame(host);

  const seen = new Set();
  for (let i = 0; i < f.pixels.length; i += 4) {
    seen.add(`${f.pixels[i]},${f.pixels[i + 1]},${f.pixels[i + 2]}`);
    if (seen.size > 3) break;
  }
  assert.ok(seen.size > 3, `expected several distinct colours, saw ${seen.size}`);
  host.destroy();
});

test('the letterbox viewport does not corrupt the cart frame', async (t) => {
  // bin/play-window.js letterboxes a resized window by calling
  // gl.viewport(...) on the CART's own context. That is only safe because the
  // cart sets its own viewport each frame and step() runs before present().
  // If either changes, a resized window starts rendering into a shrunken
  // corner of the drawable -- so pin it.
  const host = await loadOrSkip(t);
  if (!host) return;

  host.runFrame([{ connected: true, buttons: 0 }]);
  const before = readFrame(host);

  const gl = host.getGlContext();
  const { width, height } = host.getInfo();
  const r = fitRect(width, height, 800, 400); // a window that is not the cart's shape
  gl.viewport(r.x, r.y, r.width, r.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  host.runFrame([{ connected: true, buttons: 0 }]);
  const after = readFrame(host);

  assert.deepEqual(Array.from(after.pixels), Array.from(before.pixels),
    'a letterboxed resize must leave the next rendered frame identical');
  host.destroy();
});
