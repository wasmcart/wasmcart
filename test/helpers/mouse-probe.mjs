/*
 * Child process for test/mouse.test.js.
 *
 * Boots the REAL runWindowed() against a fake @kmamal/sdl, emits SDL-shaped
 * mouse events on the window object the player registered its handlers on,
 * and prints what the CART saw as JSON on stdout.
 *
 * It runs as a subprocess for two reasons, both properties of the player
 * rather than choices: runWindowed owns a self-scheduling frame loop with no
 * stop handle, and its quit path calls process.exit -- so an in-process test
 * would never let the test runner finish. Module mocking also refuses to
 * re-mock a specifier, and one window per process keeps each scenario clean.
 *
 * Usage: node mouse-probe.mjs <scenario> [scale]
 */
import { register } from 'node:module';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SCENARIO = process.argv[2];
const SCALE = Number(process.argv[3] || 1);

/* Replace @kmamal/sdl with a stub. A loader hook rather than node's test
   mocking, because this has to work in a plain `node` process. */
register(pathToFileURL(join(HERE, 'sdl-stub-loader.mjs')));

/** Logical size W x H backed by a drawable SCALE times larger, which is what
    makes the HiDPI path testable without a Retina display. */
class FakeWindow extends EventEmitter {
  constructor(w, h, scale) {
    super();
    this.setMaxListeners(0);
    this._w = w; this._h = h; this._scale = scale;
  }
  get width() { return this._w; }
  get height() { return this._h; }
  get pixelWidth() { return this._w * this._scale; }
  get pixelHeight() { return this._h * this._scale; }
  setSize(w, h) { this._w = w; this._h = h; }
  setFullscreen() {}
  destroy() {}
  async render() {}
}

const window = new FakeWindow(160, 120, SCALE);
globalThis.__WASMCART_TEST_SDL__ = {
  video: {
    createWindow: () => window,
    get windows() { return [window]; },
  },
  audio: { devices: [], openDevice: () => { throw new Error('no audio device in test'); } },
  controller: { devices: [] },
  mouse: { BUTTON: { LEFT: 1, MIDDLE: 2, RIGHT: 3 } },
};

const { CartHost } = await import(join(ROOT, 'index.js'));
const { runWindowed } = await import(join(ROOT, 'bin', 'play-window.js'));

let host = null;
class Spy extends CartHost {
  constructor(...a) { super(...a); host = this; }
}

let bootError = null;
runWindowed(join(ROOT, 'test', 'fixtures', 'pointercart.wasc'),
  { width: null, height: null, zoom: 1, seed: null, resizable: true,
    stretch: SCENARIO === 'stretch' },
  { CartHost: Spy, toInt16: () => null,
    saveIdentity: join(ROOT, 'test', 'fixtures', '.mouse-probe-cart') })
  .catch((e) => { bootError = e; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the handlers to exist. Their ABSENCE is the original bug, so this
// is reported as a result rather than as a timeout.
for (let i = 0; i < 500; i++) {
  if (bootError) break;
  if (host && window.listenerCount('mouseMove') > 0) break;
  await sleep(10);
}
if (bootError) {
  console.log(JSON.stringify({ error: bootError.message }));
  process.exit(0);
}

const handlers = ['mouseMove', 'mouseButtonDown', 'mouseButtonUp', 'mouseWheel']
  .filter((e) => window.listenerCount(e) > 0);

await sleep(150);

const read = async () => {
  await sleep(120);
  const v = (n) => host.readDebugValue(n).value;
  return {
    x: v('ptr_x'), y: v('ptr_y'), buttons: v('ptr_buttons'), active: v('ptr_active'),
    nDown: v('n_down'), nMove: v('n_move'), nUp: v('n_up'),
    downX: v('down_x'), downY: v('down_y'), downBtn: v('down_btn'),
    wheelDx: v('wheel_dx_total'), wheelDy: v('wheel_dy_total'),
  };
};
const move = (x, y) => window.emit('mouseMove', { type: 'mouseMove', x, y, touch: false });
const down = (x, y, b) => window.emit('mouseButtonDown', { type: 'mouseButtonDown', x, y, button: b, touch: false });
const up = (x, y, b) => window.emit('mouseButtonUp', { type: 'mouseButtonUp', x, y, button: b, touch: false });
const wheel = (dx, dy, flipped = false) => window.emit('mouseWheel', { type: 'mouseWheel', x: 0, y: 0, dx, dy, flipped, touch: false });

const info = host.getInfo();
const out = { handlers, cart: { width: info.width, height: info.height }, steps: {} };

switch (SCENARIO) {
  case 'handlers':
    break;

  case 'position': {
    move(80, 60);
    out.steps.centre = await read();
    // bottom-right BEFORE top-left, so a (0,0) reading proves the event
    // arrived rather than echoing the uninitialized state.
    move(159, 119);
    out.steps.bottomRight = await read();
    move(0, 0);
    out.steps.topLeft = await read();
    break;
  }

  case 'buttons': {
    move(80, 60);
    await read();
    for (const [name, sdlButton] of [['left', 1], ['right', 3], ['middle', 2]]) {
      down(80, 60, sdlButton);
      out.steps[`${name}Down`] = await read();
      up(80, 60, sdlButton);
      out.steps[`${name}Up`] = await read();
    }
    // A button the ABI has no bit for must be ignored, not aliased onto one.
    down(80, 60, 8);
    out.steps.extraButton = await read();
    up(80, 60, 8);
    break;
  }

  case 'presspos': {
    down(12, 34, 1);
    out.steps.press = await read();
    up(12, 34, 1);
    break;
  }

  case 'letterbox': {
    // Three times the cart's aspect: real bars left and right. The frame
    // occupies the middle third, logical x in [160, 320).
    window.setSize(info.width * 3, info.height);
    move(240, 60);
    out.steps.insideCentre = await read();
    move(10, 60);
    out.steps.inBar = await read();
    down(10, 60, 1);
    out.steps.clickInBar = await read();
    up(10, 60, 1);
    move(160, 60);
    out.steps.frameLeftEdge = await read();
    move(319, 60);
    out.steps.frameRightEdge = await read();
    // Press inside, release over a bar: must not stick down.
    move(240, 60);
    down(240, 60, 1);
    out.steps.pressedInside = await read();
    up(10, 60, 1);
    out.steps.releasedOverBar = await read();
    break;
  }

  case 'stretch': {
    window.setSize(info.width * 3, info.height);
    move(0, 60);
    out.steps.leftEdge = await read();
    move(window.width - 1, 60);
    out.steps.rightEdge = await read();
    break;
  }

  case 'wheel': {
    wheel(0, 1);
    out.steps.up = await read();
    wheel(0, -1);
    out.steps.backToZero = await read();
    wheel(1, 0);
    out.steps.right = await read();
    wheel(0, 1, true);
    out.steps.flipped = await read();
    break;
  }

  default:
    out.error = `unknown scenario ${SCENARIO}`;
}

console.log(JSON.stringify(out));
process.exit(0);
