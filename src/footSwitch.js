/*
 * footSwitch - USB foot pedals as extra face buttons on pad 0, for the
 * windowed player (bin/play-window.js; test/foot-switch.test.js).
 *
 * A pedal like Olympus's RS-series transcription foot switch is not a game
 * controller to SDL: it reports as a HID Consumer Control device (usage page
 * 0x0C), so sdl.controller never lists it. It is read raw through node-hid
 * (an optional dependency: without it, or without a pedal, nothing changes)
 * and its pedals are OR'ed into pad 0 next to the keyboard and the first
 * controller, so a pedal plays alongside whatever pad 0 already is.
 *
 * Pedals map by position to the face buttons in the same left-to-right order
 * they sit under the foot: left = west (X), middle = south (A), right = east (B).
 * BUTTON names are positional (SDL's a/b/x/y: A south, B east, X west, Y north).
 *
 * The device sends a report only when a pedal changes, so the last report is
 * the held state. A pedal plugged in after start is picked up (polled every
 * POLL_MS while none is open), and one unplugged mid-press releases its
 * buttons: the read error closes it and drops its state.
 */
import { BUTTON } from './abi.js';

/** Known pedals: which report byte holds the pedal bits, and each bit's button. */
export const FOOT_SWITCHES = [
  {
    name: 'Olympus RS-series foot switch',
    vendorId: 0x07b4, productId: 0x0218,
    byte: 2,
    // bit -> BUTTON name, measured on an RS foot switch: 0x04 left, 0x02 middle, 0x01 right
    bits: { 0x04: 'X', 0x02: 'A', 0x01: 'B' },
  },
];

const POLL_MS = 2000;

/** BUTTON mask for one report from `sw`. */
export function reportButtons(sw, report) {
  const v = report?.[sw.byte] ?? 0;
  let mask = 0;
  for (const [bit, name] of Object.entries(sw.bits)) if (v & Number(bit)) mask |= BUTTON[name];
  return mask;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.hid]  node-hid's module (tests pass a stand-in); loaded if omitted
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ buttons(): number, close(): void } | null>}  null when node-hid is unavailable
 */
export async function openFootSwitches({ hid, log = () => {}, pollMs = POLL_MS } = {}) {
  if (!hid) {
    try { hid = (await import('node-hid')).default; } catch { return null; } // optional dependency
  }
  const open = new Map(); // path -> { sw, dev, mask }
  let closed = false;

  function scan() {
    if (closed) return;
    let list;
    try { list = hid.devices(); } catch { return; }
    for (const info of list) {
      const sw = FOOT_SWITCHES.find((s) => s.vendorId === info.vendorId && s.productId === info.productId);
      if (!sw || !info.path || open.has(info.path)) continue;
      let dev;
      try { dev = new hid.HID(info.path); } catch { continue; } // busy or just unplugged
      const entry = { sw, dev, mask: 0 };
      open.set(info.path, entry);
      dev.on('data', (r) => { entry.mask = reportButtons(sw, r); });
      dev.on('error', () => {
        open.delete(info.path);
        try { dev.close(); } catch { /* gone with the hardware */ }
      });
      log(`wasmcart: ${sw.name} on pad 0 (left X, middle A, right B)`);
    }
  }

  scan();
  const timer = setInterval(() => { if (open.size === 0) scan(); }, pollMs);
  timer.unref?.();

  return {
    /** BUTTON mask of every held pedal on every open foot switch */
    buttons() {
      let m = 0;
      for (const e of open.values()) m |= e.mask;
      return m;
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const e of open.values()) { try { e.dev.close(); } catch { /* gone */ } }
      open.clear();
    },
  };
}
