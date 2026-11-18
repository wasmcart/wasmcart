// A GLSL ES 1.00 fragment shader with no `precision` statement is legal when
// every float it declares carries its own qualifier (`lowp vec4 color;`).
// The host upgrades #version 100 to 300 es and turns gl_FragColor into a
// declared `out vec4 FragColor`. That output needs a precision too: ES 3.00
// has no default float precision in a fragment shader, so a bare
// `out vec4 FragColor;` fails to compile and the cart gets no program.
// miniquad's shaders (macroquad) are written exactly this way.
//
// Real GL only: whether a shader compiles is the driver's answer, not ours.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGLImports } from '../src/webgl_imports.js';

const glDep = await (async () => {
  try {
    const m = await import('webgl-node');
    return m.createWebGL2Context ? m : null;
  } catch { return null; }
})();

const GL_FRAGMENT_SHADER = 0x8b30;
const GL_COMPILE_STATUS = 0x8b81;

/** Compile `src` through the cart-facing imports; returns the compile status. */
function compileThroughHost(gl, src) {
  const mem = new WebAssembly.Memory({ initial: 1 });
  const imports = createWebGLImports({ getMemory: () => mem, ctx: gl });
  const u8 = new Uint8Array(mem.buffer);
  const bytes = new TextEncoder().encode(src);
  const SRC = 1024, PTRS = 64, OUT = 128;
  u8.set(bytes, SRC); u8[SRC + bytes.length] = 0;
  new Uint32Array(mem.buffer)[PTRS >> 2] = SRC;
  const id = imports.glCreateShader(GL_FRAGMENT_SHADER);
  const origError = console.error;
  console.error = () => {};
  try {
    imports.glShaderSource(id, 1, PTRS, 0);
    imports.glCompileShader(id);
  } finally { console.error = origError; }
  imports.glGetShaderiv(id, GL_COMPILE_STATUS, OUT);
  return new Int32Array(mem.buffer)[OUT >> 2];
}

const opts = { skip: !glDep && 'no webgl-node/GL stack' };

test('#version 100 fragment shader without a precision statement compiles', opts, () => {
  const { gl } = glDep.createWebGL2Context(16, 16);
  const src = '#version 100\nvarying lowp vec4 color;\nvoid main() {\n  gl_FragColor = color;\n}\n';
  assert.equal(compileThroughHost(gl, src), 1);
});

test('#version 100 fragment shader with a precision statement still compiles', opts, () => {
  const { gl } = glDep.createWebGL2Context(16, 16);
  const src = '#version 100\nprecision highp float;\nvarying vec4 color;\nvoid main() {\n  gl_FragColor = color;\n}\n';
  assert.equal(compileThroughHost(gl, src), 1);
});

test('CONTROL: a broken shader still reports a failed compile', opts, () => {
  const { gl } = glDep.createWebGL2Context(16, 16);
  const src = '#version 100\nvarying lowp vec4 color;\nvoid main() {\n  gl_FragColor = colour;\n}\n';
  assert.equal(compileThroughHost(gl, src), 0);
});
