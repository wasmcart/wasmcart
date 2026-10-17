// The windowed player's controllers (src/padSlots.js): up to four, each in its
// own pad slot. It used to open one controller and report pad 0 only, so a
// second, third or fourth controller never reached a cart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPadSlots } from '../src/padSlots.js';
import { BUTTON } from '../src/abi.js';

/** a stand-in for @kmamal/sdl's sdl.controller */
function fakeSdl(ids) {
  const sdl = new EventEmitter();
  sdl.devices = ids.map((id) => ({ id, name: `pad ${id}` }));
  sdl.opened = [];
  sdl.openDevice = (dev) => {
    const c = new EventEmitter();
    c.device = dev; c.closed = false; c.hasRumble = true;
    c.buttons = {}; c.axes = {};
    c.close = () => { c.closed = true; };
    c.press = (button) => { c.buttons[button] = true; c.emit('buttonDown', { button }); };
    c.stick = (axis, value) => { c.axes[axis] = value; c.emit('axisMotion', { axis, value }); };
    sdl.opened.push(c);
    return c;
  };
  sdl.plug = (id) => { const dev = { id, name: `pad ${id}` }; sdl.devices.push(dev); sdl.emit('deviceAdd', { device: dev }); return dev; };
  // as @kmamal/sdl 0.11 does: the gone device's controllers close, the list drops it, and the
  // event can name another device
  sdl.unplug = (id) => {
    for (const c of sdl.opened) if (c.device.id === id) c.closed = true;
    sdl.devices = sdl.devices.filter((d) => d.id !== id);
    sdl.emit('deviceRemove', { device: sdl.devices[sdl.devices.length - 1] });
  };
  return sdl;
}
const ctl = (sdl, id) => sdl.opened.filter((c) => c.device.id === id && !c.closed)[0];
const view = (pads) => pads.map((p) => (p.connected ? p.buttons : '-')).join(' ');

test('four controllers: each its own pad, the keyboard on pad 0', () => {
  const sdl = fakeSdl([10, 11]);
  const slots = createPadSlots(sdl);
  sdl.plug(12); sdl.plug(13);
  ctl(sdl, 10).press('a'); ctl(sdl, 11).press('b'); ctl(sdl, 12).press('x'); ctl(sdl, 13).press('y');
  ctl(sdl, 12).stick('leftStickX', -1);
  const pads = slots.pads(BUTTON.START);
  assert.equal(view(pads), [BUTTON.A | BUTTON.START, BUTTON.B, BUTTON.X, BUTTON.Y].join(' '));
  assert.equal(pads[2].leftX, -32767);
  assert.equal(slots.controller(3), ctl(sdl, 13));
});

test('a controller reported twice is opened once', () => {
  const sdl = fakeSdl([10]);
  const slots = createPadSlots(sdl);
  sdl.emit('deviceAdd', { device: sdl.devices[0] }); // SDL also announces a controller present at start
  ctl(sdl, 10).press('a');
  assert.equal(sdl.opened.length, 1);
  assert.equal(view(slots.pads()), `${BUTTON.A} - - -`);
});

test('a button held before the controller opens counts', () => {
  const sdl = fakeSdl([]);
  const slots = createPadSlots(sdl);
  const real = sdl.openDevice;
  sdl.openDevice = (dev) => { const c = real(dev); c.buttons.a = true; return c; };
  sdl.plug(10);
  assert.equal(view(slots.pads()), `${BUTTON.A} - - -`);
});

test('one going away leaves the others in their slots; a new one takes the free slot', () => {
  const sdl = fakeSdl([10, 11, 12]);
  const slots = createPadSlots(sdl);
  ctl(sdl, 12).press('y');
  sdl.unplug(11);
  assert.equal(view(slots.pads()), `0 - ${BUTTON.Y} -`);
  sdl.plug(14); ctl(sdl, 14).press('b');
  assert.equal(view(slots.pads()), `0 ${BUTTON.B} ${BUTTON.Y} -`);
  sdl.plug(15); sdl.plug(16); // a fifth waits
  assert.equal(slots.device(3).id, 15);
  assert.equal(sdl.opened.filter((c) => c.device.id === 16).length, 0);
});

test('with no controller pad 0 is the keyboard and pads 1-3 are empty', () => {
  const slots = createPadSlots(fakeSdl([]));
  assert.equal(view(slots.pads(BUTTON.A)), `${BUTTON.A} - - -`);
  assert.equal(slots.controller(0), null);
});

// Use SDL's documented axis keys, not the cartridge ABI's different names.
test('SDL stick axes reach the cartridge and report the active input device', () => {
  const sdl = fakeSdl([10]), used = [];
  const slots = createPadSlots(sdl, { used: (slot) => used.push(slot) });
  for (const [axis, value] of Object.entries({
    leftStickX: 0.75, leftStickY: -0.5, rightStickX: -1, rightStickY: 0.25,
    leftTrigger: 0.8, rightTrigger: 0.6,
  })) ctl(sdl, 10).stick(axis, value);
  const [p] = slots.pads();
  assert.deepEqual([p.leftX, p.leftY, p.rightX, p.rightY, p.leftTrigger, p.rightTrigger],
    [24575, -16383, -32767, 8192, 26214, 19660]);
  assert.equal(used.length, 4); // two sticks plus both triggers exceed .5
  assert(used.every((slot) => slot === 0));
  slots.close();
});
