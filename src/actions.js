// Input actions (SPEC.md, "Input actions"), shared by CartHost and CartHostWeb.
//
// Steam Input style: the cart declares named actions in action sets, each with
// a DEFAULT binding to a logical pad input; the host owns the binding (user
// remaps, per device) and answers what physical input an action is on, so a
// cart's prompts say "Press [A] to Pedal" and never "Press K".
//
// Carts own every buffer they hand over, so nothing here needs wc_alloc. All
// state lives on the host side of the instance; a state restore keeps it.

export const ACTION_DIGITAL = 0;
export const ACTION_ANALOG = 1;

// Logical pad inputs an action binds to. 0-20 are the WC_BTN_* bit indexes.
export const IN = {
  A: 0, B: 1, X: 2, Y: 3, L: 4, R: 5, START: 6, SELECT: 7,
  UP: 8, DOWN: 9, LEFT: 10, RIGHT: 11, L3: 12, R3: 13,
  GUIDE: 14, MISC1: 15, PADDLE1: 16, PADDLE2: 17, PADDLE3: 18, PADDLE4: 19, TOUCHPAD: 20,
  LSTICK: 32, RSTICK: 33, LTRIGGER: 34, RTRIGGER: 35, DPAD: 36,
};
export const IN_NONE = -1;

export const DEVICE = { UNKNOWN: 0, KEYBOARD_MOUSE: 1, GAMEPAD: 2, TOUCH: 3, REMOTE: 4 };

// A glyph id is (family << 8) | element. For the pad families the element is
// the IN_* id (the button's POSITION; Nintendo's south button is labelled B),
// for KEY the HID scancode, for MOUSE 0 left 1 right 2 middle 3 wheel 4 motion,
// for TOUCH 0 tap 1 drag/stick 2 on-screen button. 0 means no glyph.
export const GLYPH = { XBOX: 1, PLAYSTATION: 2, NINTENDO: 3, GAMEPAD: 4, KEY: 5, MOUSE: 6, TOUCH: 7 };
export const glyphId = (family, element) => ((family & 0xff) << 8) | (element & 0xff);

export const MAX_ACTIONS = 64;
export const MAX_ACTION_SETS = 16;
export const MAX_ACTION_NAME = 64;   // bytes of UTF-8
export const MAX_PLAYERS = 4;

const isInput = (i) => (i >= 0 && i <= 20) || (i >= 32 && i <= 36);

// Labels by pad family, indexed by IN id; null = this family has no such input.
const PAD_LABELS = {
  [GLYPH.XBOX]: (['A', 'B', 'X', 'Y', 'LB', 'RB', 'Menu', 'View', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right',
    'LS', 'RS', 'Xbox', 'Share', 'P1', 'P2', 'P3', 'P4', null]),
  [GLYPH.PLAYSTATION]: (['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'Options', 'Share', 'D-pad Up', 'D-pad Down',
    'D-pad Left', 'D-pad Right', 'L3', 'R3', 'PS', 'Mic', 'RB', 'LB', 'RB2', 'LB2', 'Touchpad']),
  [GLYPH.NINTENDO]: (['B', 'A', 'Y', 'X', 'L', 'R', '+', '-', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right',
    'L Stick', 'R Stick', 'Home', 'Capture', 'GR', 'GL', 'GR2', 'GL2', null]),
  [GLYPH.GAMEPAD]: (['A', 'B', 'X', 'Y', 'L', 'R', 'Start', 'Select', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right',
    'L3', 'R3', 'Guide', 'Misc', 'P1', 'P2', 'P3', 'P4', 'Touchpad']),
};
const PAD_AXES = {
  [GLYPH.XBOX]: ['Left Stick', 'Right Stick', 'LT', 'RT', 'D-pad'],
  [GLYPH.PLAYSTATION]: ['Left Stick', 'Right Stick', 'L2', 'R2', 'D-pad'],
  [GLYPH.NINTENDO]: ['L Stick', 'R Stick', 'ZL', 'ZR', 'D-pad'],
  [GLYPH.GAMEPAD]: ['Left Stick', 'Right Stick', 'LT', 'RT', 'D-pad'],
};

/**
 * Origin of a logical input on a pad of the given family, for describers.
 * @param {number} family GLYPH.XBOX / PLAYSTATION / NINTENDO / GAMEPAD
 * @param {number} input IN.* id
 * @returns {{label: string, glyph: number} | null} null: the pad has no such input
 */
export function padOrigin(family, input) {
  const f = PAD_LABELS[family] ? family : GLYPH.GAMEPAD;
  const label = input >= 32 ? PAD_AXES[f][input - 32] : PAD_LABELS[f][input];
  if (label == null) return null;
  return { label, glyph: glyphId(f, input) };
}

/** Pad family from a device name (Gamepad API id, SDL name or type). */
export function padFamily(name) {
  const s = String(name || '').toLowerCase();
  if (/xbox|xinput|x-box|microsoft|045e/.test(s)) return GLYPH.XBOX;
  if (/playstation|dualshock|dualsense|sony|054c|ps[345]/.test(s)) return GLYPH.PLAYSTATION;
  if (/nintendo|switch|joy-con|057e/.test(s)) return GLYPH.NINTENDO;
  return GLYPH.GAMEPAD;
}

const clamp1 = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);
const ax = (v) => clamp1((v || 0) / 32767);

/**
 * The action table of one cart instance, plus the embedder-facing controls.
 * `getPads()` returns the pad objects of the frame (CartHost.runFrame's
 * argument). `onRead(player)` lets the web host notice device changes lazily.
 */
export class ActionTable {
  /** @param {{getPads: () => Array<object>|undefined}} opts */
  constructor({ getPads }) {
    this._getPads = getPads;
    this._device = new Array(MAX_PLAYERS).fill(DEVICE.UNKNOWN);
    this._describer = null;
    this.revision = 1;
    this.reset();
  }

  /** A new cart: drop its declarations and remaps; device and describer stay. */
  reset() {
    this.sets = [];            // [{name}]
    this.actions = [];         // [{name, kind, set, defaultInput}]
    this._active = new Array(MAX_PLAYERS).fill(0);
    this._bind = Array.from({ length: MAX_PLAYERS }, () => new Map()); // action -> input (remap)
    this.bump();
  }

  // --- cart side (the imports) ---

  addSet(name) {
    if (!name) return -1;
    const found = this.sets.findIndex((s) => s.name === name);
    if (found >= 0) return found;
    if (this.sets.length >= MAX_ACTION_SETS) return -1;
    this.sets.push({ name });
    return this.sets.length - 1;
  }

  add(set, kind, defaultInput, name) {
    if (!name || set < 0 || set >= this.sets.length) return -1;
    if (kind !== ACTION_DIGITAL && kind !== ACTION_ANALOG) return -1;
    if (defaultInput !== IN_NONE && !isInput(defaultInput)) return -1;
    const found = this.actions.findIndex((a) => a.set === set && a.name === name);
    if (found >= 0) {
      const a = this.actions[found];
      return a.kind === kind && a.defaultInput === defaultInput ? found : -1;
    }
    if (this.actions.length >= MAX_ACTIONS) return -1;
    this.actions.push({ name, kind, set, defaultInput });
    return this.actions.length - 1;
  }

  activate(player, set) {
    if (player < 0 || player >= MAX_PLAYERS || set < 0 || set >= this.sets.length) return;
    this._active[player] = set;
  }

  /** The input in effect for an action and player (after remaps); -1 unbound. */
  binding(player, action) {
    const m = this._bind[player];
    return m.has(action) ? m.get(action) : this.actions[action].defaultInput;
  }

  _valid(player, action) {
    return player >= 0 && player < MAX_PLAYERS && action >= 0 && action < this.actions.length;
  }

  /** [x, y] of an action for a player this frame, 0 outside the active set. */
  value(player, action) {
    if (!this._valid(player, action)) return [0, 0];
    if (this.actions[action].set !== this._active[player]) return [0, 0];
    const input = this.binding(player, action);
    const pad = this._getPads()?.[player];
    if (input < 0 || !pad || !pad.connected) return [0, 0];
    if (input <= 20) return [((pad.buttons >>> 0) >>> input) & 1, 0];
    switch (input) {
      case IN.LSTICK: return [ax(pad.leftX), ax(pad.leftY)];
      case IN.RSTICK: return [ax(pad.rightX), ax(pad.rightY)];
      case IN.LTRIGGER: return [Math.max(0, ax(pad.leftTrigger)), 0];
      case IN.RTRIGGER: return [Math.max(0, ax(pad.rightTrigger)), 0];
      case IN.DPAD: {
        const b = pad.buttons >>> 0;
        return [((b >>> 11) & 1) - ((b >>> 10) & 1), ((b >>> 9) & 1) - ((b >>> 8) & 1)];
      }
      default: return [0, 0];
    }
  }

  digital(player, action) {
    const [x, y] = this.value(player, action);
    return x * x + y * y >= 0.25 ? 1 : 0;
  }

  /**
   * @returns {{label: string, glyph: number} | null | undefined}
   *   null: unbound on the player's device; undefined: the host does not know
   */
  origin(player, action) {
    if (!this._valid(player, action)) return undefined;
    const input = this.binding(player, action);
    if (input < 0) return null;
    if (!this._describer) return undefined;
    try {
      const o = this._describer(player, input, this._device[player]);
      if (o === null) return null;
      if (!o || typeof o.label !== 'string' || !o.label) return undefined;
      return { label: o.label, glyph: o.glyph | 0 };
    } catch {
      return undefined;
    }
  }

  device(player) {
    return player >= 0 && player < MAX_PLAYERS ? this._device[player] : DEVICE.UNKNOWN;
  }

  // --- embedder side ---

  /** Something that changes an answer happened; carts re-read their prompts. */
  bump() { this.revision = (this.revision + 1) >>> 0 || 1; }

  setDevice(player, device) {
    if (player < 0 || player >= MAX_PLAYERS) return;
    if (this._device[player] !== (device | 0)) { this._device[player] = device | 0; this.bump(); }
  }

  setDescriber(fn) { this._describer = fn || null; this.bump(); }

  /** Remap: input is an IN.* id, null for unbound, undefined to restore the default. */
  setBinding(player, action, input) {
    if (!this._valid(player, action)) return;
    if (input === undefined) this._bind[player].delete(action);
    else this._bind[player].set(action, input === null ? IN_NONE : input);
    this.bump();
  }

  /** For host UI (remap screens, help): names, sets and the binding in effect. */
  list(player = 0) {
    return this.actions.map((a, id) => ({
      id, name: a.name, kind: a.kind === ACTION_ANALOG ? 'analog' : 'digital',
      set: a.set, setName: this.sets[a.set].name, defaultInput: a.defaultInput,
      input: this.binding(player, id), active: a.set === this._active[player],
    }));
  }

  /**
   * The env imports.
   * @param {() => Uint8Array} u8 current view of cart memory (refreshed per call)
   */
  imports(u8) {
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const str = (ptr, len) => {
      len >>>= 0;
      if (!len || len > MAX_ACTION_NAME) return '';
      return dec.decode(u8().slice(ptr >>> 0, (ptr >>> 0) + len));
    };
    return {
      wc_action_set_add: (ptr, len) => this.addSet(str(ptr, len)),
      wc_action_add: (set, kind, input, ptr, len) => this.add(set, kind, input, str(ptr, len)),
      wc_action_set_activate: (player, set) => this.activate(player, set),
      wc_action_digital: (player, action) => this.digital(player, action),
      wc_action_analog: (player, action, outPtr) => {
        const [x, y] = this.value(player, action);
        const m = u8();
        const dv = new DataView(m.buffer, m.byteOffset);
        dv.setFloat32(outPtr >>> 0, x, true);
        dv.setFloat32((outPtr >>> 0) + 4, y, true);
        return x !== 0 || y !== 0 ? 1 : 0;
      },
      wc_action_origin: (player, action, buf, cap) => {
        const o = this.origin(player, action);
        if (o === undefined) return -1;
        if (o === null) return 0;
        const bytes = enc.encode(o.label);
        cap >>>= 0;
        if (cap > 0) {
          let n = Math.min(bytes.length, cap - 1);
          while (n > 0 && n < bytes.length && (bytes[n] & 0xc0) === 0x80) n--; // whole codepoints only
          const m = u8();
          m.set(bytes.subarray(0, n), buf >>> 0);
          m[(buf >>> 0) + n] = 0;
        }
        return bytes.length;
      },
      wc_action_glyph: (player, action) => this.origin(player, action)?.glyph ?? 0,
      wc_input_device: (player) => this.device(player),
      wc_input_revision: () => this.revision,
    };
  }
}

/**
 * Thread (worker) imports. Input state belongs to the main thread; a thread
 * that calls these gets "unknown" and zero answers, but it must still link,
 * since a threaded cart instantiates the same module in every worker.
 */
export const WORKER_ACTION_IMPORTS = {
  wc_action_set_add: () => -1,
  wc_action_add: () => -1,
  wc_action_set_activate: () => {},
  wc_action_digital: () => 0,
  wc_action_analog: () => 0,
  wc_action_origin: () => -1,
  wc_action_glyph: () => 0,
  wc_input_device: () => DEVICE.UNKNOWN,
  wc_input_revision: () => 0,
};
