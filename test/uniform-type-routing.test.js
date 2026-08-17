// glUniform1f is routed to the setter WebGL2 will actually accept.
//
// Desktop GL converts: glUniform1f on an `int` uniform, or on a vec, is taken
// and converted. WebGL2 enforces an exact type match and REJECTS the call with
// GL_INVALID_OPERATION, leaving the uniform at its previous value. Nothing
// throws and the cart cannot see it -- the only symptom is a wrong picture.
//
// That is not hypothetical: a 3D cart set `uniform int point_simple_count` --
// its LIGHT COUNT -- through the float entry point every frame, so the count
// kept whatever it happened to hold and the scene was lit wrong.
//
// So glGetUniformLocation records each location's declared type and array size
// once (getActiveUniform is a driver round trip; uniform setters run thousands
// of times a frame), and glUniform1f dispatches on it.
//
// TWO LAYERS, because they fail differently:
//
//   * the PREMISE, against real GL: WebGL2 really does reject the mismatched
//     call. If a driver quietly accepted it the routing would be pointless,
//     and this suite would be asserting a rule that does not exist.
//   * the ROUTING, against a recording mock: the right entry point is chosen
//     per declared type. A mock is the only way to assert WHICH call was made
//     -- real GL only shows the result, and several routings produce the same
//     pixels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGLImports } from '../src/webgl_imports.js';

// GLenum values the router keys on, spelled out so a typo in the table is a
// test failure rather than a silently wrong branch.
const GL_INT = 0x1404;
const GL_FLOAT = 0x1406;
const GL_BOOL = 0x8b56;
const GL_FLOAT_VEC2 = 0x8b50;
const GL_FLOAT_VEC3 = 0x8b51;
const GL_FLOAT_VEC4 = 0x8b52;
const GL_INT_VEC2 = 0x8b53;
const GL_INT_VEC3 = 0x8b54;
const GL_INVALID_OPERATION = 0x0502;

/**
 * A GL mock that answers the metadata queries the router needs and records
 * every uniform* call. `uniforms` is the shader's declared surface:
 * name -> { type, size }.
 */
function mockGl(uniforms) {
  const calls = [];
  const names = Object.keys(uniforms);
  const locs = new Map(names.map((n, i) => [n, { __loc: n, i }]));
  const ctx = {
    // The router reads these two to build its table.
    ACTIVE_UNIFORMS: 0x8b86,
    getProgramParameter: () => names.length,
    getActiveUniform: (_p, i) => {
      const n = names[i];
      return n ? { name: n, type: uniforms[n].type, size: uniforms[n].size ?? 1 } : null;
    },
    // Real GL resolves BOTH `a` and `a[0]` for `uniform float a[16]`
    // (verified against webgl-node), so the mock must too — a stricter mock
    // would fail the array cases for a reason the driver does not have.
    getUniformLocation: (_p, n) => locs.get(n) ?? locs.get(`${n}[0]`) ?? null,
    createProgram: () => ({}),
    getError: () => 0,
    // createWebGLImports probes extensions and the parameter surface at
    // construction; none of that is what these tests are about.
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getParameter: () => 0,
    useProgram: () => {},
  };
  for (const fn of [
    'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f',
    'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i',
    'uniform1fv', 'uniform1iv',
  ]) {
    ctx[fn] = (...args) => calls.push({ fn, args: args.slice(1) });
  }
  return { ctx, calls };
}

/** Bind a fake program + one uniform, then return { imports, calls, id }. */
function setup(uniforms, name) {
  const { ctx, calls } = mockGl(uniforms);
  const mem = new WebAssembly.Memory({ initial: 1 });
  const imports = createWebGLImports({ getMemory: () => mem, ctx });
  // The program id the import layer hands out for a created program.
  const progIds = new Int32Array(mem.buffer, 0, 1);
  const prog = imports.glCreateProgram();
  imports.glUseProgram(prog);
  // Write the uniform name into wasm memory for glGetUniformLocation.
  const bytes = new TextEncoder().encode(name + '\0');
  new Uint8Array(mem.buffer, 64, bytes.length).set(bytes);
  const id = imports.glGetUniformLocation(prog, 64);
  void progIds;
  return { imports, calls, id };
}

test('an int uniform set through the float path becomes uniform1i', () => {
  const { imports, calls, id } = setup({ u_count: { type: GL_INT } }, 'u_count');
  imports.glUniform1f(id, 3.0);
  assert.deepEqual(calls, [{ fn: 'uniform1i', args: [3] }],
    'glUniform1f on an int must be routed to uniform1i, not passed through');
});

test('a bool uniform also routes to the int setter', () => {
  const { imports, calls, id } = setup({ u_on: { type: GL_BOOL } }, 'u_on');
  imports.glUniform1f(id, 1.0);
  assert.deepEqual(calls, [{ fn: 'uniform1i', args: [1] }]);
});

test('a vec3 uniform is broadcast across uniform3f', () => {
  const { imports, calls, id } = setup({ u_tint: { type: GL_FLOAT_VEC3 } }, 'u_tint');
  imports.glUniform1f(id, 0.5);
  assert.deepEqual(calls, [{ fn: 'uniform3f', args: [0.5, 0.5, 0.5] }]);
});

test('vec2 and vec4 broadcast to their own widths', () => {
  const a = setup({ u_v2: { type: GL_FLOAT_VEC2 } }, 'u_v2');
  a.imports.glUniform1f(a.id, 2);
  assert.deepEqual(a.calls, [{ fn: 'uniform2f', args: [2, 2] }]);

  const b = setup({ u_v4: { type: GL_FLOAT_VEC4 } }, 'u_v4');
  b.imports.glUniform1f(b.id, 3);
  assert.deepEqual(b.calls, [{ fn: 'uniform4f', args: [3, 3, 3, 3] }]);
});

test('int vectors truncate to ints rather than passing floats', () => {
  const a = setup({ u_iv2: { type: GL_INT_VEC2 } }, 'u_iv2');
  a.imports.glUniform1f(a.id, 2.7);
  assert.deepEqual(a.calls, [{ fn: 'uniform2i', args: [2, 2] }],
    'an int vector must receive ints — 2.7 becomes 2, not 2.7');

  const b = setup({ u_iv3: { type: GL_INT_VEC3 } }, 'u_iv3');
  b.imports.glUniform1f(b.id, -1.9);
  assert.deepEqual(b.calls, [{ fn: 'uniform3i', args: [-1, -1, -1] }]);
});

test('a plain float uniform is passed straight through', () => {
  const { imports, calls, id } = setup({ u_a: { type: GL_FLOAT } }, 'u_a');
  imports.glUniform1f(id, 0.25);
  assert.deepEqual(calls, [{ fn: 'uniform1f', args: [0.25] }],
    'the common case must not gain an indirection');
});

test('an ARRAY uniform uses the *v entry point even for one element', () => {
  // WebGL2 requires the array form for a declared array. Desktop GL accepts
  // glUniform1f on `uniform float a[16]` and writes element 0.
  const f = setup({ 'u_atten[0]': { type: GL_FLOAT, size: 16 } }, 'u_atten');
  f.imports.glUniform1f(f.id, 0.5);
  assert.deepEqual(f.calls, [{ fn: 'uniform1fv', args: [[0.5]] }]);

  const i = setup({ 'u_ids[0]': { type: GL_INT, size: 8 } }, 'u_ids');
  i.imports.glUniform1f(i.id, 4);
  assert.deepEqual(i.calls, [{ fn: 'uniform1iv', args: [[4]] }]);
});

test('the name→declared-uniform match tolerates the [0] suffix', () => {
  // getActiveUniform reports `u_atten[0]` for `uniform float u_atten[16]`,
  // while the cart asks for `u_atten`. If the lookup did not strip the
  // subscript the type would be unknown and the routing would silently fall
  // through to the default — the exact silent failure this fix is about.
  const { imports, calls, id } = setup({ 'u_atten[0]': { type: GL_FLOAT, size: 16 } }, 'u_atten');
  imports.glUniform1f(id, 1.5);
  assert.equal(calls[0].fn, 'uniform1fv', 'subscripted declaration must still match');
});

test('an unknown location is a no-op, not a throw', () => {
  const { imports, calls } = setup({ u_a: { type: GL_FLOAT } }, 'u_a');
  assert.doesNotThrow(() => imports.glUniform1f(9999, 1.0));
  assert.equal(calls.length, 0);
});

// ── the premise, against real GL ──
//
// Skipped when there is no GPU/GL stack (CI containers, headless boxes without
// EGL). A skip is honest; asserting the rule with no driver would be theatre.
const glDep = await (async () => {
  try {
    const m = await import('webgl-node');
    return m.createWebGL2Context ? m : null;
  } catch { return null; }
})();

test('PREMISE: WebGL2 rejects glUniform1f on an int uniform', { skip: !glDep && 'no webgl-node/GL stack' }, () => {
  const { gl } = glDep.createWebGL2Context(32, 32);
  const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){ gl_Position=vec4(0,0,0,1); }'));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER,
    '#version 300 es\nprecision mediump float;\nuniform int u_count;\nout vec4 o;\nvoid main(){ o=vec4(float(u_count)); }'));
  gl.linkProgram(p);
  assert.ok(gl.getProgramParameter(p, gl.LINK_STATUS), gl.getProgramInfoLog(p));
  gl.useProgram(p);
  const loc = gl.getUniformLocation(p, 'u_count');

  gl.uniform1i(loc, 7);                      // establish a known value
  while (gl.getError() !== 0) { /* drain */ }

  gl.uniform1f(loc, 3.0);                    // the mismatched call
  assert.equal(gl.getError(), GL_INVALID_OPERATION,
    'if this passes, WebGL2 accepted the mismatch and the routing is unnecessary');
  assert.equal(gl.getUniform(p, loc), 7,
    'the rejected call must leave the OLD value — that is why the bug is silent');
});
