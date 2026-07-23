/*
 * play-window - the SDL-windowed mode of `npx wasmcart`, on the org's own
 * native stack: @kmamal/sdl for window/input/audio, webgl-node for GL carts.
 *
 * Two paths:
 *   2D (default): plain SDL window, framebuffer blitted with
 *     window.render(..., 'bgra32', ...) (CartHost pixels are XRGB LE = BGRX).
 *   GL (--gl):    opengl window + createWebGL2Context({nativeWindow}) passed
 *     to CartHost as glBackend; present via swapBuffers.
 *
 * Pacing: audio-paced when the cart emits audio (keep the SDL queue topped
 * up, step frames as it drains — the anti-choppiness rule); 60fps timer
 * otherwise. Real keyDown/keyUp edges (no terminal hold emulation), plus the
 * first game controller if one is plugged in.
 */

import { BUTTON } from '../src/abi.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';

function savPathFor(cartPath) {
  try {
    return statSync(cartPath).isDirectory()
      ? cartPath.replace(/\/+$/, '') + '.sav'
      : cartPath + '.sav';
  } catch {
    return cartPath + '.sav';
  }
}

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

  const loadOpts = {};
  if (opt.seed !== null) loadOpts.deterministic = { seed: opt.seed };
  // cart SRAM: a .sav next to the cart, loaded before wc_init, written on quit
  const savPath = savPathFor(cartPath);
  try { loadOpts.saveData = new Uint8Array(readFileSync(savPath)); } catch { /* first run */ }

  if (opt.gl) {
    // GL cart: the context must exist BEFORE load, bound to a real window.
    const { createWebGL2Context } = await import('webgl-node');
    window = sdl.video.createWindow({
      title: 'wasmcart', width: opt.width || 1280, height: opt.height || 720,
      resizable: false, opengl: true,
    });
    const nativeGL = window.native?.gl;
    if (!nativeGL) throw new Error('no native GL window handle from SDL (try without --gl, or a different video driver)');
    const glResult = createWebGL2Context(window.pixelWidth, window.pixelHeight, { nativeWindow: nativeGL });
    loadOpts.glBackend = glResult.gl;
    swapBuffers = glResult.swapBuffers;
    glResult.setSwapInterval?.(0);
  }

  await host.load(cartPath, loadOpts);
  host.runFrame([{ connected: true, buttons: 0 }]); // settle: final resolution
  const info = host.getInfo();

  if (host.usesGL && !opt.gl) {
    throw new Error('GL cart — rerun with --gl (opens an OpenGL window via webgl-node).');
  }

  if (!window) {
    const zoom = opt.zoom || (info.height <= 400 ? 2 : 1);
    window = sdl.video.createWindow({
      title: 'wasmcart', width: info.width * zoom, height: info.height * zoom, resizable: true,
    });
  }

  // input: real press/release edges
  window.on('keyDown', (e) => {
    const k = (e.key ?? e.scancode ?? '').toString().toLowerCase();
    if (k === 'escape' || k === 'q') return quit();
    const name = KEYMAP[k];
    if (name) held.add(name);
  });
  window.on('keyUp', (e) => {
    const name = KEYMAP[(e.key ?? e.scancode ?? '').toString().toLowerCase()];
    if (name) held.delete(name);
  });
  window.on('close', quit);

  // first plugged-in game controller, if any
  try {
    const dev = sdl.controller.devices[0];
    if (dev) {
      const ctrl = sdl.controller.openDevice(dev);
      ctrl.on('buttonDown', (e) => { const n = CONTROLLER_BUTTONS[e.button]; if (n) held.add(n); });
      ctrl.on('buttonUp', (e) => { const n = CONTROLLER_BUTTONS[e.button]; if (n) held.delete(n); });
      ctrl.on('axisMotion', (e) => {
        const v = Math.round((e.value ?? 0) * 32767);
        if (e.axis in analog) analog[e.axis] = v;
      });
    }
  } catch { /* controllers are optional */ }

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
    frame = host.runFrame(pad());
    ticks++;
    if (audioDev && frame.audio && frame.audio.length) {
      const i16 = toInt16(frame.audio);
      if (i16) audioDev.enqueue(Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength));
    }
  };

  const present = async () => {
    if (swapBuffers) { swapBuffers(); return; }
    if (!frame) return;
    await window.render(frame.width, frame.height, frame.width * 4, 'bgra32',
      Buffer.from(frame.framebuffer.buffer, frame.framebuffer.byteOffset, frame.framebuffer.byteLength));
  };

  let closing = false;
  function quit() {
    if (closing) return;
    closing = true;
    try {
      const sav = host.getSaveData();
      if (sav && sav.some((b) => b !== 0)) writeFileSync(savPath, sav);
    } catch { /* save is best-effort */ }
    try { audioDev?.close(); } catch { /* already gone */ }
    try { window?.destroy(); } catch { /* already gone */ }
    host.destroy();
    process.exit(0);
  }

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
