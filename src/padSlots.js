/*
 * padSlots - up to four SDL game controllers as wasmcart's four pads, for the
 * windowed player (bin/play-window.js; test/pad-slots.test.js).
 *
 * A controller takes the first free slot when it appears (pad N is player
 * N + 1) and keeps it until it goes away; one going away leaves the others in
 * their slots. The player used to open one controller and report pad 0 only,
 * so a second, third or fourth controller never reached a cart.
 *
 * `controller` is @kmamal/sdl's sdl.controller: `devices`, `openDevice(dev)`
 * and its deviceAdd / deviceRemove events. A pad's state is read from its
 * controller each frame (`buttons`, `axes`), so a button already held when the
 * controller is opened counts. Removal goes by what is still plugged in (the
 * `devices` list, a controller closed with its device): @kmamal/sdl 0.11's
 * deviceRemove event can name another device than the one that went. The
 * keyboard plays pad 0 too: its buttons are OR'ed into pad 0, which is
 * connected even with no controller.
 */
import { BUTTON } from './abi.js';

/** SDL's controller button names -> wasmcart BUTTON names */
export const CONTROLLER_BUTTONS = {
  dpadUp: 'UP', dpadDown: 'DOWN', dpadLeft: 'LEFT', dpadRight: 'RIGHT',
  a: 'A', b: 'B', x: 'X', y: 'Y',
  leftShoulder: 'L', rightShoulder: 'R',
  start: 'START', back: 'SELECT', guide: 'SELECT',
};

// SDL's trigger axes. Same width as the sticks (int16) as of ABI v4, but
// unsigned: a trigger travels one way, so its float is taken as magnitude.
const TRIGGER_AXES = new Set(['leftTrigger', 'rightTrigger']);
// @kmamal/sdl calls the stick axes leftStickX/Y and rightStickX/Y.
// The cartridge ABI uses leftX/Y and rightX/Y; keep that conversion explicit.
const AXES = {
  leftStickX: 'leftX', leftStickY: 'leftY',
  rightStickX: 'rightX', rightStickY: 'rightY',
  leftTrigger: 'leftTrigger', rightTrigger: 'rightTrigger',
};

export const MAX_PADS = 4;

/**
 * @param {object} controller  sdl.controller (or a stand-in with the same shape)
 * @param {object} [on]  callbacks: added(slot, dev), removed(slot, dev), used(slot) (a button, or a stick past half)
 */
export function createPadSlots(controller, on = {}) {
  // A slot keeps a copy of its device's id and name: @kmamal/sdl 0.11 reuses
  // device objects by list position, so when one goes away the object a slot
  // was opened from can turn into another device's.
  const slots = new Array(MAX_PADS).fill(null); // { id, name, dev, ctrl }
  const slotOf = (dev) => slots.findIndex((s) => s && dev && s.id === dev.id);

  function open(dev) {
    if (!dev || slotOf(dev) >= 0) return -1; // already open: SDL can report a present controller twice
    const slot = slots.indexOf(null);
    if (slot < 0) return -1; // four players already
    let ctrl;
    try { ctrl = controller.openDevice(dev); } catch { return -1; } // unplugged between the event and here
    slots[slot] = { id: dev.id, name: dev.name || '', dev: { ...dev }, ctrl };
    ctrl.on('buttonDown', (e) => { if (CONTROLLER_BUTTONS[e.button]) on.used?.(slot); });
    ctrl.on('axisMotion', (e) => { if (Object.hasOwn(AXES, e.axis) && Math.abs(e.value ?? 0) > 0.5) on.used?.(slot); });
    on.added?.(slot, dev);
    return slot;
  }

  // every slot whose controller is no longer plugged in is emptied (its held
  // buttons and sticks go with it: a cart must not keep walking because the
  // controller was yanked mid-press)
  function sync() {
    const present = controller.devices || [];
    slots.forEach((s, slot) => {
      if (!s || (!s.ctrl.closed && present.some((d) => d.id === s.id))) return;
      try { s.ctrl.close(); } catch { /* already gone with the hardware */ }
      slots[slot] = null;
      on.removed?.(slot, s.dev);
    });
  }

  // what arrived is read from the list too, in its order
  const onAdd = () => { sync(); for (const dev of controller.devices || []) open(dev); };
  const onRemove = () => sync();
  // already listed (Linux fills the list at import), plus anything that
  // arrives later (macOS fills it a second or two later; reconnects on both)
  for (const dev of controller.devices || []) open(dev);
  controller.on('deviceAdd', onAdd);
  controller.on('deviceRemove', onRemove);

  return {
    /** the four pads for runFrame; keyboardButtons (a BUTTON mask) plays pad 0 */
    pads(keyboardButtons = 0) {
      sync();
      return slots.map((s, i) => {
        if (!s) return i === 0 ? { connected: true, buttons: keyboardButtons } : { connected: false };
        let buttons = i === 0 ? keyboardButtons : 0;
        const held = s.ctrl.buttons || {}, ax = s.ctrl.axes || {};
        for (const [b, n] of Object.entries(CONTROLLER_BUTTONS)) if (held[b]) buttons |= BUTTON[n];
        const pad = { connected: true, name: s.name, buttons };
        // Every analog axis is int16 as of ABI v4, so sticks and triggers share
        // one scale factor. Triggers are UNSIGNED (0..32767, one direction),
        // which is the only thing separating them here: SDL hands both over as
        // a float, and a pad whose trigger rests near 0.5 would otherwise
        // report half-pressed as a negative stick value.
        for (const [sdlAxis, a] of Object.entries(AXES)) {
          const v = ax[sdlAxis] ?? 0;
          pad[a] = TRIGGER_AXES.has(a) ? Math.max(0, Math.min(32767, Math.round(Math.abs(v) * 32767)))
            : Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
        }
        return pad;
      });
    },
    /** the open controller in a slot (rumble), or null */
    controller(slot) { const s = slots[slot]; return s && !s.ctrl.closed ? s.ctrl : null; },
    /** the device in a slot, or null */
    device(slot) { return slots[slot]?.dev ?? null; },
    close() {
      controller.off?.('deviceAdd', onAdd);
      controller.off?.('deviceRemove', onRemove);
      for (const s of slots) if (s) { try { s.ctrl.close(); } catch { /* gone */ } }
      slots.fill(null);
    },
  };
}
