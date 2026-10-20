// The test cart (testcart/): what it shows a person is only worth something
// if it is right, so each panel is checked here through its debug fields,
// each with a control that must read differently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CartHost } from '../index.js';
import { savPathFor } from '../src/save.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CART = join(HERE, '..', 'testcart', 'testcart.wasc');

const BTN = { A: 1, B: 2, X: 4, Y: 8, L: 0x10, R: 0x20, START: 0x40, SELECT: 0x80, PADDLE1: 0x10000, TOUCHPAD: 0x100000 };
const SAVE = { FRESH: 0, OK: 1, CORRUPT: 2, TRUNCATED: 3 };

const value = (cart, name) => { const v = cart.readDebugValue(name); return v.values ?? v.value; };

// Run `frames` frames with these pads; returns the cart (caller destroys) and
// the peak of each audio channel.
async function run({ pads = [], frames = 30, save, before } = {}) {
  const cart = new CartHost();
  await cart.load(CART, save ? { saveData: save } : {});
  cart.setFixedStep(1000 / 60);
  before?.(cart);
  let peakL = 0, peakR = 0, audioFrames = 0;
  for (let f = 0; f < frames; f++) {
    const { audio } = cart.runFrame(pads);
    if (!audio) continue;
    audioFrames += audio.length / 2;
    for (let i = 0; i < audio.length; i += 2) {
      peakL = Math.max(peakL, Math.abs(audio[i]));
      peakR = Math.max(peakR, Math.abs(audio[i + 1]));
    }
  }
  return { cart, peakL, peakR, audioFrames };
}

test('pads: buttons, sticks and triggers reach the cart per slot', async () => {
  const { cart } = await run({
    pads: [
      { connected: true, buttons: BTN.A | BTN.PADDLE1, leftX: 20000, leftY: -12000, rightTrigger: 32767 },
      null,
      { connected: true, buttons: BTN.TOUCHPAD, rightX: -32768 },
    ],
  });
  assert.deepEqual(value(cart, 'pad.connected'), [1, 0, 1, 0]);
  assert.deepEqual(value(cart, 'pad.buttons'), [BTN.A | BTN.PADDLE1, 0, BTN.TOUCHPAD, 0]);
  assert.deepEqual(value(cart, 'pad.lx'), [20000, 0, 0, 0]);
  assert.deepEqual(value(cart, 'pad.ly'), [-12000, 0, 0, 0]);
  assert.deepEqual(value(cart, 'pad.rx'), [0, 0, -32768, 0]);
  assert.deepEqual(value(cart, 'pad.rt'), [32767, 0, 0, 0]);
  cart.destroy();
});

test('sound: each face button sounds its own voice, L and R pan to one channel', async () => {
  const quiet = await run({ pads: [{ connected: true, buttons: 0 }] });
  assert.equal(value(quiet.cart, 'audio.tones'), 0);
  assert.equal(quiet.peakL + quiet.peakR, 0, 'control: no button, no sound');
  assert.equal(quiet.audioFrames, 30 * 800, '800 stereo frames a 60 Hz frame at 48 kHz');
  quiet.cart.destroy();

  const chord = await run({ pads: [{ connected: true, buttons: BTN.A | BTN.Y }, { connected: true, buttons: BTN.B }] });
  // bit pad*4+face: P1 A (0), P1 Y (3), P2 B (5)
  assert.equal(value(chord.cart, 'audio.tones'), (1 << 0) | (1 << 3) | (1 << 5));
  assert.ok(chord.peakL > 0.1 && chord.peakR > 0.1, 'both channels sound with no pan');
  chord.cart.destroy();

  const left = await run({ pads: [{ connected: true, buttons: BTN.A | BTN.L }] });
  assert.equal(value(left.cart, 'audio.pan'), -1);
  assert.ok(left.peakL > 0.1, 'left channel sounds');
  assert.equal(left.peakR, 0, 'right channel is silent');
  left.cart.destroy();

  const right = await run({ pads: [{ connected: true, buttons: BTN.A | BTN.R }] });
  assert.equal(value(right.cart, 'audio.pan'), 1);
  assert.equal(right.peakL, 0, 'left channel is silent');
  assert.ok(right.peakR > 0.1, 'right channel sounds');
  right.cart.destroy();
});

test('pointers, wheel and keyboard: state and events', async () => {
  const { cart } = await run({
    frames: 2,
    before(c) {
      c.setPointer(0, 300, 250, 0, 1);
      c.pointerDown(3, 500, 150, 0);
      c.setPointer(3, 500, 150, 1, 1);
      c.wheel(0, 240);
      c.keyDown(0x04, 0);
      c.keyDown(0x2c, 1);
      c.keyUp(0x04, 0);
    },
  });
  assert.equal(value(cart, 'ptr.active'), (1 << 0) | (1 << 3));
  assert.equal(value(cart, 'ptr.x')[3], 500);
  assert.equal(value(cart, 'ptr.buttons')[3], 1);
  assert.equal(value(cart, 'ptr.downs'), 1);
  assert.equal(value(cart, 'wheel.y'), 240);
  assert.equal(value(cart, 'key.downs'), 2);
  assert.equal(value(cart, 'key.ups'), 1);
  assert.deepEqual(value(cart, 'key.log').slice(0, 2), [0x2c, 0x04]);
  cart.destroy();
});

test('saves: FRESH, then OK with the start counted and the last session\'s frames', async () => {
  const first = await run({ frames: 90 });
  assert.equal(value(first.cart, 'save.status'), SAVE.FRESH);
  assert.equal(value(first.cart, 'save.boots'), 1);
  const save = first.cart.getSaveData();
  first.cart.destroy();
  assert.equal(save.length, 32768);

  const second = await run({ frames: 1, save });
  assert.equal(value(second.cart, 'save.status'), SAVE.OK);
  assert.equal(value(second.cart, 'save.boots'), 2);
  assert.equal(value(second.cart, 'save.prev_frames'), 90);
  second.cart.destroy();
});

test('saves: a truncated or altered save is named, not accepted', async () => {
  const first = await run({ frames: 10 });
  const save = first.cart.getSaveData();
  first.cart.destroy();

  const cut = await run({ frames: 1, save: save.subarray(0, 20000) });
  assert.equal(value(cut.cart, 'save.status'), SAVE.TRUNCATED);
  assert.equal(value(cut.cart, 'save.bad_at'), 20000);
  cut.cart.destroy();

  const flipped = save.slice();
  flipped[30000] ^= 0x40;
  const bad = await run({ frames: 1, save: flipped });
  assert.equal(value(bad.cart, 'save.status'), SAVE.CORRUPT);
  assert.equal(value(bad.cart, 'save.bad_at'), 30000);
  bad.cart.destroy();
});

test('saves: SELECT+START for 3 s clears the block, and the next start is FRESH', async () => {
  const first = await run({ frames: 10 });
  const kept = first.cart.getSaveData();
  first.cart.destroy();

  const clearing = await run({ frames: 185, save: kept, pads: [{ connected: true, buttons: BTN.SELECT | BTN.START }] });
  assert.equal(value(clearing.cart, 'save.cleared'), 1);
  const cleared = clearing.cart.getSaveData();
  clearing.cart.destroy();
  assert.ok(cleared.every((b) => b === 0), 'the whole block is zero');

  const after = await run({ frames: 1, save: cleared });
  assert.equal(value(after.cart, 'save.status'), SAVE.FRESH);
  after.cart.destroy();

  // Control: a host that skipped writing the zeroed block hands back the old
  // save, and the cart says OK, which is how a person sees that bug.
  const resurrected = await run({ frames: 1, save: kept });
  assert.equal(value(resurrected.cart, 'save.status'), SAVE.OK);
  resurrected.cart.destroy();
});

test('wasmcart test keeps its save below the data directory, not in the package', () => {
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = '/data-home';
  try {
    assert.equal(savPathFor(CART), '/data-home/wasmcart/saves/testcart.sav');
    assert.equal(savPathFor('/games/other.wasc'), '/games/other.wasc.sav');
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
});
