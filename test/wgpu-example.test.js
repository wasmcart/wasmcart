// examples/webgpu-hello, the cart docs/webgpu.md walks through, on the Node host:
// the documented example must build (examples/webgpu-hello/build.sh) and run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cart = path.join(HERE, '..', 'examples', 'webgpu-hello', 'webgpu-hello.wasc');

// Points and the texel each must show (hello.c: a 2x2 texture on the triangle)
export const HELLO_PIXELS = [
  { at: [2, 2], rgb: [26, 26, 38], what: 'background' },
  { at: [155, 60], rgb: [255, 0, 0], what: 'red texel' },
  { at: [140, 160], rgb: [0, 0, 255], what: 'blue texel' },
  { at: [180, 160], rgb: [255, 255, 255], what: 'white texel' },
];

test('examples/webgpu-hello renders its textured triangle', async () => {
  const host = new CartHost();
  try {
    await host.load(cart);
    assert.equal(host.usesWgpu, true);
    for (let i = 0; i < 10; i++) { host.runFrame(); await new Promise((r) => setImmediate(r)); }
    const f = await host.readGpuFrame();
    assert.deepEqual([f.width, f.height], [320, 240]);
    for (const { at: [x, y], rgb, what } of HELLO_PIXELS) {
      const i = (y * f.width + x) * 4;
      const got = [...f.data.slice(i, i + 3)];
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - rgb[k]) <= 1, `${what} at ${x},${y}: got ${got}, want ${rgb}`);
    }
  } finally {
    host.destroy();
  }
});
