// Mouse and wheel input in the SDL-windowed player.
//
// WHY THESE TESTS DRIVE THE PLAYER AND NOT CartHost: the pointer ABI was
// complete and correct in CartHost for months while clicks did nothing in a
// window, because bin/play-window.js registered no mouse handlers at all --
// it had keyDown/keyUp/close/minimize/focus and nothing else. A test that
// calls host.pointerDown() directly PASSES against that bug, because it
// substitutes itself for the one layer that was missing. So each case here
// boots the real runWindowed(), emits SDL-shaped events on the window object
// the player attached its handlers to, and asserts on what the CART saw.
//
// Each case runs in a subprocess (test/helpers/mouse-probe.mjs). That is a
// property of the player, not a preference: runWindowed owns a
// self-scheduling frame loop with no stop handle and a quit path that calls
// process.exit, so in-process it would never let the runner finish.
//
// The contract being pinned:
//
//   * cart space, not window space -- an event is run backwards through the
//     same letterbox that put the frame on screen, so a click still lands on
//     the thing it looked like it was on after the window is resized
//   * TWO coordinate spaces -- SDL reports logical points while the letterbox
//     is computed in drawable pixels, and on HiDPI those differ by the
//     backing scale; the cart pixel must come out the same either way
//   * SDL's 1/2/3 (LEFT/MIDDLE/RIGHT) REMAPS onto bits 0/1/2 (primary/
//     secondary/middle) -- an offset would silently swap right and middle
//   * the letterbox bars are not part of the picture: inactive there, and a
//     click there is not a click on the cart
//   * a button released outside the frame still releases, so nothing sticks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'helpers', 'mouse-probe.mjs');

/** Boot the player in a child process and return what the cart saw. */
async function probe(scenario, scale = 1) {
  const { stdout } = await execFileAsync(
    process.execPath, [PROBE, scenario, String(scale)],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const line = stdout.trim().split('\n').pop();
  let out;
  try {
    out = JSON.parse(line);
  } catch {
    throw new Error(`probe '${scenario}' printed no result:\n${stdout}`);
  }
  assert.equal(out.error, undefined, `probe '${scenario}' failed: ${out.error}`);
  return out;
}

test('the windowed player registers mouse handlers at all', async () => {
  const { handlers } = await probe('handlers');
  // The regression guard for the shipped bug. Every one of these was absent,
  // so a click never reached a cart in a window no matter what CartHost did.
  for (const ev of ['mouseMove', 'mouseButtonDown', 'mouseButtonUp', 'mouseWheel']) {
    assert.ok(handlers.includes(ev), `the player registered no ${ev} handler`);
  }
});

test('a move lands on the matching cart pixel and activates the pointer', async () => {
  const { steps, cart } = await probe('position');

  assert.deepEqual([steps.centre.x, steps.centre.y], [80, 60]);
  // pointerMove updates position but does NOT set `active` -- only
  // pointerDown does. Entering the frame has to activate explicitly, or a
  // cart that gates its cursor on `active` draws nothing until the first
  // click. That was a real bug in the first cut of this code.
  assert.equal(steps.centre.active, 1, 'the pointer must be active once inside the frame');
  // The event has to reach the cart, not merely update the state block: a
  // host that writes state and drops wc_ptr_on_move breaks event-driven carts.
  assert.equal(steps.centre.nMove, 1);

  assert.deepEqual([steps.bottomRight.x, steps.bottomRight.y],
    [cart.width - 1, cart.height - 1], 'the far corner must not be off by one');
  // Checked after a non-zero position, so (0,0) proves the event arrived
  // rather than echoing the uninitialized state back.
  assert.deepEqual([steps.topLeft.x, steps.topLeft.y], [0, 0]);
  assert.equal(steps.topLeft.active, 1);
});

test('SDL button numbers remap onto the ABI bits rather than offsetting', async () => {
  const { steps } = await probe('buttons');

  // wasmcart.h: bit0 primary, bit1 secondary, bit2 middle. SDL sends
  // 1=LEFT 2=MIDDLE 3=RIGHT, so a plain button-1 would put middle and right
  // in each other's bits -- right-click would read as a middle-click.
  for (const [name, bit] of [['left', 0], ['right', 1], ['middle', 2]]) {
    const d = steps[`${name}Down`];
    assert.equal(d.buttons, 1 << bit, `${name} must set bit ${bit}`);
    assert.equal(d.downBtn, bit, `the ${name} event must carry button index ${bit}`);
    assert.equal(steps[`${name}Up`].buttons, 0, `${name} must clear on release`);
  }

  // A side button has no bit in the ABI, so it must be dropped rather than
  // aliased onto one (1 << 7 would land outside the byte entirely).
  assert.equal(steps.extraButton.buttons, 0, 'an unmapped button must not set a bit');
  assert.equal(steps.extraButton.nDown, steps.middleDown.nDown,
    'an unmapped button must not deliver a down event');
});

test('a press reports the position it was pressed at', async () => {
  const { steps } = await probe('presspos');
  assert.deepEqual([steps.press.downX, steps.press.downY], [12, 34]);
  // The event and the state block must agree; a cart may read either.
  assert.deepEqual([steps.press.x, steps.press.y], [12, 34]);
});

test('HiDPI: the cart sees the same pixel whatever the backing scale is', async () => {
  // This is the whole reason the handler scales by pixelWidth/width instead
  // of assuming one space: on Retina, SDL's logical point and the letterbox's
  // drawable pixel differ by 2x, and guessing wrong halves or doubles every
  // coordinate. Simulated here because this machine has no HiDPI display.
  const one = await probe('position', 1);
  const two = await probe('position', 2);

  for (const step of ['centre', 'bottomRight', 'topLeft']) {
    assert.deepEqual(
      [two.steps[step].x, two.steps[step].y],
      [one.steps[step].x, one.steps[step].y],
      `${step} must map to the same cart pixel at 1x and 2x`,
    );
  }
  assert.deepEqual([two.steps.centre.x, two.steps.centre.y], [80, 60]);
});

test('the letterbox bars are not part of the picture', async () => {
  for (const scale of [1, 2]) {
    const { steps, cart } = await probe('letterbox', scale);
    const at = `(scale ${scale})`;

    assert.equal(steps.insideCentre.active, 1, `inside the frame must be active ${at}`);
    assert.deepEqual([steps.insideCentre.x, steps.insideCentre.y], [80, 60],
      `the centre of the frame is the centre of the cart ${at}`);

    // Inactive rather than clamped: x/y are int16 on the wire, so a position
    // over the bars would be either a coordinate the cart cannot have or a
    // lie about being at the edge. `active` is the field a cart already checks.
    assert.equal(steps.inBar.active, 0, `over a bar the pointer must be INACTIVE ${at}`);
    assert.equal(steps.clickInBar.nDown, 0, `a click on a bar is not a click on the cart ${at}`);
    assert.equal(steps.clickInBar.buttons, 0);

    assert.equal(steps.frameLeftEdge.x, 0, `the frame's left edge is column 0 ${at}`);
    assert.equal(steps.frameRightEdge.x, cart.width - 1,
      `the frame's right edge must not overflow the cart ${at}`);

    assert.equal(steps.pressedInside.buttons, 1, `a press inside registers ${at}`);
    assert.equal(steps.releasedOverBar.buttons, 0,
      `a release outside the frame must still release, or the button sticks ${at}`);
  }
});

test('--stretch treats the whole window as cart space', async () => {
  const { steps, cart } = await probe('stretch');
  assert.equal(steps.leftEdge.x, 0);
  // With no letterbox there are no bars, so the far edge is the last column
  // rather than an inactive region.
  assert.equal(steps.rightEdge.active, 1, 'stretch has no bars to be inactive over');
  assert.equal(steps.rightEdge.x, cart.width - 1);
});

test('wheel notches convert to 1/120 units with up positive', async () => {
  const { steps } = await probe('wheel');

  // SDL's wheel.y is up-positive and so is the ABI's (wasmcart.h), so one
  // notch up is +120 and NOT -120. Getting this backwards inverts scrolling
  // in every cart at once.
  assert.equal(steps.up.wheelDy, 120);
  assert.equal(steps.up.wheelDx, 0);
  assert.equal(steps.backToZero.wheelDy, 0, 'a notch down must cancel a notch up');
  assert.equal(steps.right.wheelDx, 120, 'horizontal is right-positive');

  // `flipped` is SDL_MOUSEWHEEL_FLIPPED: the platform already inverted the
  // values for "natural" scrolling, so undoing it keeps one gesture meaning
  // one thing to every cart regardless of the user's OS setting.
  assert.equal(steps.flipped.wheelDy, -120);
});
