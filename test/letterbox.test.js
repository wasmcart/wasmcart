import test from 'node:test';
import assert from 'node:assert';
import { fitRect } from '../src/letterbox.js';

// The rule these all check: the returned rect fits inside the window, is
// centred, and has the SOURCE aspect ratio. Stretching to fill is the bug.
const ratioOf = (r) => r.width / r.height;

test('exact fit is the whole window', () => {
  assert.deepStrictEqual(fitRect(640, 480, 640, 480),
    { x: 0, y: 0, width: 640, height: 480 });
});

test('integer multiple scales with no bars', () => {
  assert.deepStrictEqual(fitRect(640, 480, 1280, 960),
    { x: 0, y: 0, width: 1280, height: 960 });
});

test('window wider than cart pillarboxes (bars left and right)', () => {
  const r = fitRect(640, 480, 1280, 480);
  assert.deepStrictEqual(r, { x: 320, y: 0, width: 640, height: 480 });
  assert.ok(r.x > 0 && r.y === 0, 'bars should be horizontal only');
});

test('window taller than cart letterboxes (bars top and bottom)', () => {
  const r = fitRect(640, 480, 640, 960);
  assert.deepStrictEqual(r, { x: 0, y: 240, width: 640, height: 480 });
  assert.ok(r.y > 0 && r.x === 0, 'bars should be vertical only');
});

test('portrait cart in a landscape window keeps its shape', () => {
  // The case that makes stretching obvious: a 480x600 game must not become
  // 1000x600.
  const r = fitRect(480, 600, 1000, 600);
  assert.deepStrictEqual(r, { x: 260, y: 0, width: 480, height: 600 });
});

test('shrinking preserves aspect ratio', () => {
  const r = fitRect(1600, 900, 800, 600);
  assert.deepStrictEqual(r, { x: 0, y: 75, width: 800, height: 450 });
});

test('rect always fits, stays centred, and keeps the source ratio', () => {
  const carts = [[320, 240], [640, 480], [480, 600], [1600, 900], [256, 224]];
  const windows = [[100, 100], [1920, 1080], [640, 480], [333, 977], [1000, 600]];
  for (const [sw, sh] of carts) {
    for (const [dw, dh] of windows) {
      const r = fitRect(sw, sh, dw, dh);
      const at = `${sw}x${sh} into ${dw}x${dh}`;
      assert.ok(r.width <= dw && r.height <= dh, `overflows window: ${at}`);
      assert.ok(r.x >= 0 && r.y >= 0, `negative offset: ${at}`);
      // centred to within the rounding of one pixel
      assert.ok(Math.abs(dw - r.width - 2 * r.x) <= 1, `not centred in x: ${at}`);
      assert.ok(Math.abs(dh - r.height - 2 * r.y) <= 1, `not centred in y: ${at}`);
      // aspect preserved; tolerance covers integer rounding at small sizes
      assert.ok(Math.abs(ratioOf(r) - sw / sh) < 0.02, `aspect distorted: ${at}`);
    }
  }
});

test('degenerate window never yields a zero-sized rect', () => {
  // SDL rejects a dstRect with width or height <= 0, so a window dragged to
  // nothing must still produce something renderable.
  for (const [dw, dh] of [[1, 1], [1, 400], [400, 1]]) {
    const r = fitRect(640, 480, dw, dh);
    assert.ok(r.width >= 1 && r.height >= 1, `zero-sized at ${dw}x${dh}`);
  }
});
