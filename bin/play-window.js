/*
 * play-window - the SDL-windowed mode of `npx wasmcart`, on the org's own
 * native stack: @kmamal/sdl for window/input/audio, webgl-node for GL carts.
 *
 * Two paths:
 *   2D (default): plain SDL window, framebuffer blitted with
 *     window.render(..., 'bgra32', ...) (CartHost pixels are XRGB LE = BGRX).
 *   GL (auto-detected): opengl window + createWebGL2Context({nativeWindow}),
 *     created lazily by a glBackend FACTORY that CartHost invokes only if the
 *     cart imports from the "gl" module; present via swapBuffers. --gl forces
 *     the GL window up front.
 *
 * Pacing: audio-paced when the cart emits audio (keep the SDL queue topped
 * up, step frames as it drains — the anti-choppiness rule); 60fps timer
 * otherwise. Real keyDown/keyUp edges (no terminal hold emulation), plus the
 * first game controller if one is plugged in.
 */

import { BUTTON } from '../src/abi.js';
import { fitRect } from '../src/letterbox.js';
import { savPathFor, loadSave, makeSaver } from '../src/save.js';

const KEYMAP = {
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT',
  w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT',
  x: 'A', z: 'B', space: 'A', return: 'START', tab: 'SELECT',
  '[': 'L', ']': 'R',
};

const CONTROLLER_BUTTONS = {
  dpadUp: 'UP', dpadDown: 'DOWN', dpadLeft: 'LEFT', dpadRight: 'RIGHT',
  a: 'A', b: 'B', x: 'X', y: 'Y',
  leftShoulder: 'L', rightShoulder: 'R',
  start: 'START', back: 'SELECT', guide: 'SELECT',
};

export async function runWindowed(cartPath, opt, { CartHost, toInt16 }) {
  const sdl = (await import('@kmamal/sdl')).default;

  const host = new CartHost();
  const held = new Set();
  const analog = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, leftTrigger: 0, rightTrigger: 0 };
  let window = null;
  let swapBuffers = null;
  // GL letterboxing: the viewport is only recomputed when the drawable size
  // actually changes, so the steady-state frame costs nothing.
  let glForResize = null;
  let glLastW = -1, glLastH = -1;

  const loadOpts = {};
  if (opt.seed !== null) loadOpts.deterministic = { seed: opt.seed };
  // cart SRAM: a .sav next to the cart, loaded before wc_init, written on quit
  const savPath = savPathFor(cartPath);
  loadOpts.saveData = loadSave(savPath);

  // GL is AUTO-DETECTED: this factory is handed to CartHost, which invokes it
  // only if the cart's wasm actually imports from the "gl" module - the
  // launcher never needs to know what kind of cart it's launching. It's a
  // callback (not a post-load branch) because the GL context must exist
  // before wasm instantiation, bound to a real opengl window - and a 2D cart
  // must NOT get an opengl window (separate-GL-context fights, see playtest).
  const makeGlWindow = async () => {
    const { createWebGL2Context } = await import('webgl-node');
    // Size from the cart's own declaration, not a fixed 720p. The cart draws
    // at its declared resolution and wc_gl_blit's viewport is the context, so
    // a mismatch here puts the frame in a corner rather than scaling it.
    const m = host.getManifest() || {};
    const w = opt.width || m.width || 1280;
    const h = opt.height || m.height || 720;
    window = sdl.video.createWindow({
      title: 'wasmcart', width: w, height: h,
      resizable: opt.resizable !== false, opengl: true,
    });
    const nativeGL = window.native?.gl;
    if (!nativeGL) throw new Error('no native GL window handle from SDL (try a different video driver)');
    const glResult = createWebGL2Context(window.pixelWidth, window.pixelHeight, { nativeWindow: nativeGL });
    swapBuffers = glResult.swapBuffers;
    glResult.setSwapInterval?.(0);
    glForResize = glResult.gl;
    return glResult.gl;
  };
  // --gl forces the GL window up front (hybrid carts, debugging); default is lazy.
  loadOpts.glBackend = opt.gl ? await makeGlWindow() : makeGlWindow;

  await host.load(cartPath, loadOpts);
  host.runFrame([{ connected: true, buttons: 0 }]); // settle: final resolution
  const info = host.getInfo();

  const zoom = opt.zoom || (info.height <= 400 ? 2 : 1);
  if (!window) {
    window = sdl.video.createWindow({
      title: 'wasmcart', width: info.width * zoom, height: info.height * zoom,
      resizable: opt.resizable !== false,
    });
  } else if (!opt.width && !opt.height) {
    // A GL cart's window had to be created during load(), before wc_get_info
    // could say how big the cart actually is -- so it opened at a guess. Now
    // that the cart has answered, adopt its size. The cart is the authority
    // on resolution; the host only asks. Skipped when the user named an
    // explicit --width/--height, since that IS the host asking.
    const want = [info.width * zoom, info.height * zoom];
    if (window.width !== want[0] || window.height !== want[1]) {
      try { window.setSize(want[0], want[1]); } catch { /* compositor said no */ }
    }
  }

  // Fullscreen is just another window size: the frame is letterboxed into
  // whatever the drawable turns out to be, so the cart's aspect ratio holds
  // on a display of any shape.
  if (opt.fullscreen) {
    try { window.setFullscreen(true); } catch { /* not supported here */ }
  }

  // input: real press/release edges
  window.on('keyDown', (e) => {
    const k = (e.key ?? e.scancode ?? '').toString().toLowerCase();
    // While the cart is taking text, keys are CHARACTERS, not controls: typing
    // "q" into a name field must not quit the player, and "w" must not also
    // walk the player forward. Escape still works, as the universal "get me
    // out of here" -- a cart that wants it for its own field can read it
    // through the keyboard ABI.
    if (host.textInputActive) {
      if (k === 'escape') return quit();
      return;
    }
    if (k === 'escape' || k === 'q') return quit();
    const name = KEYMAP[k];
    if (name) held.add(name);
  });

  // Committed text from SDL: already layout-, shift- and IME-processed. The
  // host forwards unconditionally; CartHost drops it unless the cart asked.
  window.on('textInput', (e) => {
    if (typeof e.text === 'string') host.textInput(e.text);
  });

  // Anything held when a text field opens would otherwise stick: keyDown is
  // suppressed during text input, and the matching keyUp arrives while the
  // cart is still typing, so the pad would report the key held forever. Clear
  // on the transition into text input rather than trying to reconcile later.
  let textWasActive = false;
  const syncTextInputState = () => {
    const now = host.textInputActive;
    if (now && !textWasActive) held.clear();
    textWasActive = now;
  };
  window.on('keyUp', (e) => {
    const name = KEYMAP[(e.key ?? e.scancode ?? '').toString().toLowerCase()];
    if (name) held.delete(name);
  });
  // Split out of quit() so every exit path can reach it: a save that only
  // survives a graceful window close is not a save. Defined HERE, above the
  // lifecycle handlers, because those reference it -- a `const` declared later
  // in the same scope would throw a TDZ ReferenceError if a minimize arrived
  // before initialization.
  const persistSave = makeSaver(host, savPath);

  window.on('close', quit);

  // Lifecycle. minimize/hide means the host stops driving frames entirely;
  // focus/blur means the game is still rendering but is not the active window,
  // which is what lets a cart auto-pause on alt-tab without going dark.
  //
  // Persisting on suspend is the point of having it: a backgrounded app can be
  // killed by the OS without ever reaching quit(), so this is often the last
  // moment a save can be written at all.
  window.on('minimize', () => { host.suspend(); persistSave(); });
  window.on('hide',     () => { host.suspend(); persistSave(); });
  window.on('restore',  () => host.resume());
  window.on('show',     () => host.resume());
  window.on('blur',     () => host.blur());
  window.on('focus',    () => host.focus());

  // first plugged-in game controller, if any
  let ctrl = null;
  try {
    const dev = sdl.controller.devices[0];
    if (dev) {
      ctrl = sdl.controller.openDevice(dev);
      ctrl.on('buttonDown', (e) => { const n = CONTROLLER_BUTTONS[e.button]; if (n) held.add(n); });
      ctrl.on('buttonUp', (e) => { const n = CONTROLLER_BUTTONS[e.button]; if (n) held.delete(n); });
      ctrl.on('axisMotion', (e) => {
        const v = Math.round((e.value ?? 0) * 32767);
        if (e.axis in analog) analog[e.axis] = v;
      });
    }
  } catch { /* controllers are optional */ }

  // Route cart rumble to the SDL device. Only pad 0 is wired, matching the
  // single controller this player opens; other slots report no rumble, which
  // is the honest answer rather than a silent no-op the cart cannot detect.
  // `closed` is checked because SDL throws on a device unplugged mid-effect.
  host.setRumbleHandler({
    hasRumble: (padId) => padId === 0 && !!ctrl && !ctrl.closed && ctrl.hasRumble,
    rumble: (padId, low, high, ms) => {
      if (padId !== 0 || !ctrl || ctrl.closed || !ctrl.hasRumble) return;
      ctrl.rumble(low, high, ms);
    },
    stopRumble: (padId) => {
      if (padId !== 0 || !ctrl || ctrl.closed || !ctrl.hasRumble) return;
      ctrl.stopRumble();
    },
  });

  const pad = () => {
    let buttons = 0;
    for (const name of held) buttons |= BUTTON[name];
    return [{ connected: true, buttons, ...analog }];
  };

  // audio sink (SDL playback queue)
  const rate = info.audioSampleRate || 48000;
  let audioDev = null;
  try {
    audioDev = sdl.audio.openDevice({ type: 'playback' }, {
      channels: 2, frequency: rate, format: 's16lsb', buffered: 2048,
    });
    audioDev.play();
  } catch { /* no audio device (headless server) — video still runs */ }

  let frame = null;
  let ticks = 0;
  const step = () => {
    syncTextInputState();
    frame = host.runFrame(pad());
    ticks++;
    if (audioDev && frame.audio && frame.audio.length) {
      const i16 = toInt16(frame.audio);
      if (i16) audioDev.enqueue(Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength));
    }
  };

  /*
   * Present the frame scaled into the current window.
   *
   * The window opens at the cart's declared size and is resizable; the frame
   * is letterboxed so the cart's aspect ratio survives the resize. A cart that
   * declares 480x600 is making a choice about SHAPE, so the leftover area goes
   * black rather than the frame being stretched to fit. --stretch opts out,
   * --no-resize pins the window to the cart's size (making this a no-op).
   */
  const present = async () => {
    if (swapBuffers) {
      // The cart rendered into a context sized to ITS resolution, and
      // wc_gl_blit's viewport is the context, so scaling to a resized window
      // is a viewport concern: shrink the viewport to the letterboxed rect and
      // clear the bars around it. Recomputed only when the drawable size
      // actually changes, so a steady-state frame costs nothing extra.
      if (glForResize && !opt.stretch) {
        const gl = glForResize;
        const pw = window.pixelWidth, ph = window.pixelHeight;
        if (pw !== glLastW || ph !== glLastH) {
          glLastW = pw; glLastH = ph;
          const r = fitRect(info.width, info.height, pw, ph);
          gl.viewport(r.x, r.y, r.width, r.height);
          gl.disable(gl.SCISSOR_TEST);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }
      swapBuffers();
      return;
    }
    if (!frame) return;
    const opts = opt.stretch ? undefined
      : { dstRect: fitRect(frame.width, frame.height, window.width, window.height) };
    await window.render(frame.width, frame.height, frame.width * 4, 'bgra32',
      Buffer.from(frame.framebuffer.buffer, frame.framebuffer.byteOffset, frame.framebuffer.byteLength),
      opts);
  };


  let closing = false;
  function quit() {
    if (closing) return;
    closing = true;
    persistSave();
    try { audioDev?.close(); } catch { /* already gone */ }
    try { window?.destroy(); } catch { /* already gone */ }
    host.destroy();
    process.exit(0);
  }

  // Ctrl-C and `kill` are ordinary ways to stop a game, not crashes, so they
  // must not cost the player their progress. quit() is idempotent via `closing`.
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  // Last-ditch: an uncaught throw still gets one attempt at the save before the
  // process dies. Best-effort by definition -- the host may be mid-corruption --
  // but losing a save on top of a crash is strictly worse than trying.
  process.on('uncaughtException', (err) => {
    console.error(err);
    quit();
  });

  // pacing: audio-paced when the cart has an audio ring, timer otherwise
  const hasAudio = !!(audioDev && info.audioCap > 0);
  const TARGET_QUEUED = rate * 4 * 0.08; // ~80ms of s16 stereo
  if (hasAudio) {
    const tick = async () => {
      if (closing) return;
      let n = 0;
      while (audioDev.queued < TARGET_QUEUED && n < 5) { step(); n++; }
      if (n > 0) await present();
      if (opt.frames > 0 && ticks >= opt.frames) return quit();
      setTimeout(tick, 4);
    };
    tick();
  } else {
    const tick = async () => {
      if (closing) return;
      step();
      await present();
      if (opt.frames > 0 && ticks >= opt.frames) return quit();
      setTimeout(tick, 1000 / 60);
    };
    tick();
  }
}
