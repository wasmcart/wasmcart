import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGLImports } from '../src/webgl_imports.js';

// Put the payload at the end of memory: an oversized upload must fail here,
// rather than silently reading unrelated heap data as it did in Pugball.
for (const [format, channels, internal] of [[0x8D94, 1, 0x8236], [0x8228, 2, 0x823C], [0x8D98, 3, 0x8D71], [0x8D99, 4, 0x8D70]]) {
  test(`integer texture format ${format.toString(16)} respects its payload bounds`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const count = 8 * 4 * channels;
    const ptr = memory.buffer.byteLength - count * 4;
    const pixels = new Uint32Array(memory.buffer, ptr, count);
    pixels.fill(0x12345678);
    const uploads = [];
    const ctx = {
      getExtension: () => null, getSupportedExtensions: () => [], getParameter: () => 0,
      texImage2D: (...args) => uploads.push(args.at(-1)),
      texSubImage2D: (...args) => uploads.push(args.at(-1)),
    };
    const gl = createWebGLImports({ getMemory: () => memory, ctx });
    gl.glTexImage2D(0x0DE1, 0, internal, 8, 4, 0, format, 0x1405, ptr);
    gl.glTexSubImage2D(0x0DE1, 0, 0, 0, 8, 4, format, 0x1405, ptr);
    assert.equal(uploads.length, 2);
    for (const upload of uploads) {
      assert.ok(upload instanceof Uint32Array);
      assert.equal(upload.length, count);
      assert.deepEqual(upload, pixels);
    }
  });
}
