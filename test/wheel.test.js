// The scroll wheel (ABI v3.1).
//
// What matters about this field is not that a number arrives -- it is the
// CONTRACT around the number, and every clause of it is a bug somebody will
// otherwise hit:
//
//   * accumulate between frames, so a trackpad flick (dozens of events) is
//     one delta and the cart behaves the same at 30fps as at 144
//   * CLEAR after the frame, or one flick scrolls forever
//   * zero is normal -- a device with no wheel never writes, exactly as a
//     desktop never fills touch slots 1-9
//   * an OLDER cart, built before the field existed, must be untouched
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CartHost } from '../index.js';
import { WHEEL_SIZE, WHEEL_DELTA, INFO_FIELDS_V3 } from '../src/abi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO = join(HERE, 'fixtures', 'hello.wasc');

test('wheel constants are the WHEEL_DELTA convention', () => {
  // 1/120 notch. If this ever changes, every cart's zoom speed changes with
  // it, so it is pinned here rather than left as a magic number.
  assert.equal(WHEEL_DELTA, 120);
  assert.equal(WHEEL_SIZE, 8);              // two int32s
  assert.equal(INFO_FIELDS_V3.WHEEL_PTR, 68); // u32 index 17
});

test('wheel() accumulates and the host clears it after a frame', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);

  // A burst, the way a trackpad delivers one gesture.
  cart.wheel(0, 40);
  cart.wheel(0, 40);
  cart.wheel(0, 40);
  assert.equal(cart._wheelAccum.dy, 120, 'three events add up to one notch');

  cart.runFrame(16);
  assert.equal(cart._wheelAccum.dy, 0,
    'cleared after the frame -- otherwise one flick scrolls forever');

  // And the next frame with no events reads zero, which is the normal state
  // on hardware that has no wheel at all.
  cart.runFrame(16);
  assert.equal(cart._wheelAccum.dy, 0);
  cart.destroy();
});

test('horizontal and vertical accumulate independently, and signs survive', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  cart.wheel(-30, 90);
  cart.wheel(10, -30);
  assert.equal(cart._wheelAccum.dx, -20);
  assert.equal(cart._wheelAccum.dy, 60);
  cart.destroy();
});

test('a cart built before the field exists is not written to', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  const info = cart.getInfo();

  // The hello fixture predates v3.1, so it declares no wheel buffer. The
  // host must notice that and write nowhere -- the range check on index 17
  // is the only thing standing between an older cart and a stray poke into
  // its heap, since whatever sits at that offset is arbitrary cart memory.
  if (!info.wheelPtr) {
    cart.wheel(0, 120);
    assert.doesNotThrow(() => cart.runFrame(16),
      'writing a wheel with no wheel_ptr must be a no-op, not a crash');
  } else {
    // If the fixture is ever rebuilt against new headers, the pointer must
    // at least be sane rather than silently bogus.
    assert.ok(info.wheelPtr > 0 && info.wheelPtr % 4 === 0,
      'wheel_ptr must be 4-byte aligned');
  }
  cart.destroy();
});
