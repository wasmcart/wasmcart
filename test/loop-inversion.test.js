// wc_frame_yield loop-inversion protocol: a cart that OWNS its main loop
// (asyncify-instrumented) is suspended at the yield and resumed there on the
// next runFrame - the port path for engines like Stratagus/DOOM that can't
// be restructured into a per-frame callback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CartHost } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOPCART = join(HERE, 'fixtures', 'loopcart.wasc');

const px = (f) => new DataView(f.framebuffer.buffer, f.framebuffer.byteOffset).getUint32(0, true) & 0xFFFFFF;
const PAD = (b = 0) => [{ connected: true, buttons: b }];

test('a blocking engine loop advances exactly one frame per runFrame', async () => {
  const c = new CartHost();
  await c.load(LOOPCART);
  const a = px(c.runFrame(PAD()));
  const b = px(c.runFrame(PAD()));
  const d = px(c.runFrame(PAD()));
  assert.equal(b - a, 3, 'one loop iteration per frame');
  assert.equal(d - b, 3, 'and again');
  c.destroy();
});

test('the suspended stack keeps its locals and still sees input', async () => {
  const c = new CartHost();
  await c.load(LOOPCART);
  c.runFrame(PAD());
  const before = px(c.runFrame(PAD()));
  px(c.runFrame(PAD(1))); // press A: local_state++ inside the nested loop frame
  const after = px(c.runFrame(PAD()));
  // two frames elapsed (+6) plus the local_state bump (+1)
  assert.equal(after - before, 7, 'locals deep in the suspended call stack survive and mutate');
  c.destroy();
});

test('non-asyncify carts are untouched by the protocol', async () => {
  const c = new CartHost();
  await c.load(join(HERE, 'fixtures', 'hello.wasc'));
  c.runFrame(PAD());
  c.runFrame(PAD());
  assert.equal(c.frameCount, 2, 'plain carts render normally');
  c.destroy();
});
