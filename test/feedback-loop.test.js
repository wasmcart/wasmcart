// The FBO redirect makes "the screen" a texture, so returning to it can form a
// feedback loop the cart cannot see.
//
// Against a real default framebuffer, going back to the screen after an
// offscreen pass can never loop: the screen is not sampleable. Under the
// redirect it is -- the colour attachment is an ordinary 2D texture. If a
// sampler still holds that texture at draw time, the draw both reads and
// writes the same image, WebGL2 rejects it outright, and NOTHING renders.
//
// That is how a match-three cart came out with a board and no jewels: it bakes
// each sprite into its own canvas, and afterwards the engine's bind cache left
// a canvas texture on unit 0 -- the same object the driver had handed the
// redirect.
//
// CHECKED AT DRAW TIME, not when framebuffer 0 is bound. The cart binds its
// texture AFTER returning to the screen (measured order: bindFramebuffer
// redirect, then bindTexture unit 0), so clearing samplers at bind time fixes
// nothing -- the cart rebinds immediately and the loop is back. Draw time is
// the only point where both halves are known.
//
// Two layers, because they fail differently:
//
//   * the PREMISE, in a REAL BROWSER: WebGL2 rejects such a draw. This is the
//     one claim that cannot be checked on native-gles -- radeonsi accepts the
//     draw and renders it, so a node-only suite would "prove" the fix
//     unnecessary. The strict validator this exists for is the browser's.
//   * the BEHAVIOUR, against a recording mock: the loop is broken at draw
//     time, only the offending units are touched, and the active unit is left
//     exactly as the cart had it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGLImports } from '../src/webgl_imports.js';

const GL_TEXTURE_2D = 0x0de1;
const GL_TEXTURE0 = 0x84c0;
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_FRAMEBUFFER = 0x8d40;

/** Records bindTexture/activeTexture so the repair can be asserted precisely. */
function mockGl() {
  const calls = [];
  const objs = { fb: {}, tex: {} };
  const ctx = {
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getParameter: () => null,
    getError: () => 0,
    FRAMEBUFFER: GL_FRAMEBUFFER,
    COLOR_ATTACHMENT0: GL_COLOR_ATTACHMENT0,
    RENDERBUFFER: 0x8d41,
    DEPTH_STENCIL_ATTACHMENT: 0x821a,
    TEXTURE_2D: GL_TEXTURE_2D,
    createTexture: () => ({ id: 'tex' + Math.random() }),
    createFramebuffer: () => ({ id: 'fb' }),
    createRenderbuffer: () => ({ id: 'rb' }),
    bindTexture: (t, o) => calls.push({ fn: 'bindTexture', target: t, obj: o }),
    activeTexture: (u) => calls.push({ fn: 'activeTexture', unit: u - GL_TEXTURE0 }),
    bindFramebuffer: () => {},
    bindRenderbuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    renderbufferStorage: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    drawArrays: () => calls.push({ fn: 'drawArrays' }),
    drawElements: () => calls.push({ fn: 'drawElements' }),
    checkFramebufferStatus: () => 0x8cd5,
    viewport: () => {},
    clearColor: () => {},
  };
  return { ctx, calls, objs };
}

function setup() {
  const { ctx, calls } = mockGl();
  const mem = new WebAssembly.Memory({ initial: 1 });
  const imports = createWebGLImports({ getMemory: () => mem, ctx });
  return { imports, calls, mem, ctx };
}

/** Attach `texId` as COLOR_ATTACHMENT0 of a cart FBO and leave it bound. */
function bindCartFboWithColor(imports, mem) {
  const ids = new Uint32Array(mem.buffer, 0, 2);
  imports.glGenFramebuffers(1, 0);
  const fbo = ids[0];
  imports.glGenTextures(1, 4);
  const tex = new Uint32Array(mem.buffer, 4, 1)[0];
  imports.glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  imports.glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
  return { fbo, tex };
}

test('a draw whose target texture is on a sampler unbinds it first', () => {
  const { imports, calls, mem } = setup();
  const { tex } = bindCartFboWithColor(imports, mem);

  // The cart leaves its own render target on unit 0 -- the jewels shape.
  imports.glActiveTexture(GL_TEXTURE0);
  imports.glBindTexture(GL_TEXTURE_2D, tex);
  calls.length = 0;

  imports.glDrawArrays(0x0004, 0, 3);   // GL_TRIANGLES

  const unbinds = calls.filter((c) => c.fn === 'bindTexture' && c.obj === null);
  assert.equal(unbinds.length, 1, 'the looping sampler must be unbound exactly once');
  const drew = calls.findIndex((c) => c.fn === 'drawArrays');
  const unbound = calls.findIndex((c) => c.fn === 'bindTexture' && c.obj === null);
  assert.ok(unbound >= 0 && unbound < drew, 'the loop must be broken BEFORE the draw');
});

test('glDrawElements is guarded too, not just glDrawArrays', () => {
  const { imports, calls, mem } = setup();
  const { tex } = bindCartFboWithColor(imports, mem);
  imports.glActiveTexture(GL_TEXTURE0);
  imports.glBindTexture(GL_TEXTURE_2D, tex);
  calls.length = 0;
  imports.glDrawElements(0x0004, 3, 0x1403, 0);
  assert.ok(calls.some((c) => c.fn === 'bindTexture' && c.obj === null),
    'a cart drawing indexed geometry loops exactly as easily');
});

test('the ACTIVE UNIT is restored — engines cache it and skip redundant binds', () => {
  const { imports, calls, mem } = setup();
  const { tex } = bindCartFboWithColor(imports, mem);
  // The cart is working on unit 3, with the loop on unit 1.
  imports.glActiveTexture(GL_TEXTURE0 + 1);
  imports.glBindTexture(GL_TEXTURE_2D, tex);
  imports.glActiveTexture(GL_TEXTURE0 + 3);
  calls.length = 0;

  imports.glDrawArrays(0x0004, 0, 3);

  const active = calls.filter((c) => c.fn === 'activeTexture').map((c) => c.unit);
  assert.deepEqual(active, [1, 3],
    'must visit the offending unit then return to 3 — a stray active unit misroutes the cart\'s next bind');
});

test('a draw with no loop touches nothing', () => {
  const { imports, calls, mem } = setup();
  bindCartFboWithColor(imports, mem);
  // A DIFFERENT texture on the sampler: no loop.
  const ids = new Uint32Array(mem.buffer, 8, 1);
  imports.glGenTextures(1, 8);
  imports.glActiveTexture(GL_TEXTURE0);
  imports.glBindTexture(GL_TEXTURE_2D, ids[0]);
  calls.length = 0;

  imports.glDrawArrays(0x0004, 0, 3);

  assert.deepEqual(calls, [{ fn: 'drawArrays' }],
    'the guard must add NO calls on the common path — it runs on every draw');
});

test('drawing to the real default framebuffer is never guarded', () => {
  // With no redirect FBO, framebuffer 0 is the actual screen: not sampleable,
  // so it cannot loop and there is nothing to repair.
  const { imports, calls, mem } = setup();
  imports.glGenTextures(1, 0);
  const tex = new Uint32Array(mem.buffer, 0, 1)[0];
  imports.glBindFramebuffer(GL_FRAMEBUFFER, 0);
  imports.glActiveTexture(GL_TEXTURE0);
  imports.glBindTexture(GL_TEXTURE_2D, tex);
  calls.length = 0;
  imports.glDrawArrays(0x0004, 0, 3);
  assert.deepEqual(calls, [{ fn: 'drawArrays' }]);
});

// ── the premise, in a real browser ──
//
// REQUIRE_BROWSER=1 makes a missing Playwright a failure (CI), matching
// test/browser.test.mjs. Otherwise it skips: a machine without browsers should
// not go red, but a skip must not look like a pass either.
const required = process.env.REQUIRE_BROWSER === '1';
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }

test('PREMISE: a real browser REJECTS the looping draw', {
  skip: !chromium && !required && 'playwright not installed',
}, async () => {
  assert.ok(chromium, 'REQUIRE_BROWSER=1 but playwright is missing');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const r = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const gl = c.getContext('webgl2');
      if (!gl) return { skip: 'no webgl2 in this browser' };
      const mk = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){gl_Position=vec4(0.,0.,0.,1.);}'));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision mediump float;\nuniform sampler2D s;out vec4 o;\nvoid main(){o=texture(s,vec2(.5));}'));
      gl.linkProgram(p); gl.useProgram(p);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.uniform1i(gl.getUniformLocation(p, 's'), 0);
      const probe = () => { while (gl.getError() !== 0) { /* drain */ } gl.drawArrays(gl.POINTS, 0, 1); return gl.getError(); };
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      const withLoop = probe();
      gl.bindTexture(gl.TEXTURE_2D, null);
      const repaired = probe();
      return { withLoop, repaired, invalidOp: gl.INVALID_OPERATION };
    });
    if (r.skip) return;   // a browser build with no WebGL2 proves nothing either way
    assert.equal(r.withLoop, r.invalidOp,
      'if the browser accepted this draw, _breakFeedbackLoop would be unnecessary');
    assert.equal(r.repaired, 0,
      'unbinding the sampler must make the same draw legal — that is the repair');
  } finally {
    await browser.close();
  }
});
