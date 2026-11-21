#!/usr/bin/env node
/*
 * wasmcart-play - run a .wasc cart (or a dev-mode cart DIRECTORY) right in
 * the terminal, no native host required. Video renders as text through chafa
 * (ASCII on black by default; --symbols picks the glyph set) or as wasmcart's
 * own ANSI half-blocks (--symbols halfblock); the keyboard drives pad 0.
 * Also a headless runner for scripting: step N frames, dump a PNG
 * screenshot and/or a WAV of the audio, exit.
 *
 * Usage: wasmcart-play <cart.wasc | cart-dir | https://.../cart.wasc> [options]
 *
 * Options:
 *   --frames <n>     Headless: run n frames, then exit (no terminal UI)
 *   --shot <out.png> Write the final framebuffer as a PNG (implies headless
 *                    when --frames is given; in interactive mode, saved on quit)
 *   --wav <out.wav>  Headless: write the run's audio as a 16-bit stereo WAV
 *   --seed <n>       Deterministic run: fixed clock + wc_set_seed(n)
 *   --scale <cols>   Terminal width in columns (default: fit the window)
 *   --term-fps <n>   Terminal refresh rate (default 30; logic always runs 60);
 *                    --fps is the same option
 *   --frame-skip <n> Draw every nth frame to the terminal (60/n fps)
 *   --symbols <set>  Glyphs: ascii (default), block, half, ascii+block, solid,
 *                    stipple, quad, sextant, octant, braille, matrix, halfblock
 *   --colors <mode>  true (default), 256, 16, 2
 *   --fg-only        Foreground colour only, on black (the default's look)
 *   --dither         Floyd-Steinberg dithering
 *   --contrast <n>   Contrast boost, 1.0 = unchanged
 *   --stats          Print measured frame rate every second (stderr)
 *
 * Keys: arrows/WASD = d-pad, x=A z=B a=X s=Y, Enter=Start, Tab=Select,
 *       [ ]=L R, q or Ctrl-C = quit.
 *
 * GL carts work here too. Rendering on the GPU and displaying as ANSI are
 * orthogonal: the cart gets an OFFSCREEN WebGL2 context, the result is read
 * back, and every path below sees the same XRGB framebuffer a 2D cart
 * produces. The glBackend factory is only invoked when the cart's imports say
 * it is a GL cart, so a 2D cart never pays for it.
 */

import { CartHost } from '../src/CartHost.js';
import { BUTTON } from '../src/abi.js';
import { savPathFor, loadSave, makeSaver } from '../src/save.js';
import { downloadRemoteCart, isRemoteCart } from '../src/remoteCart.js';
import { writeFileSync } from 'fs';
import { DEFAULT_TERM, checkTermOptions, fitCells } from '../src/term/options.js';
import { createTermRenderer } from '../src/term/renderer.js';
import { deflateSync } from 'zlib';

// ── args ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let cartPath = null;
// resizable + letterbox are the DEFAULTS; --no-resize and --stretch opt out.
const opt = { frames: 0, shot: null, wav: null, seed: null, scale: 0, fps: DEFAULT_TERM.fps, stats: false,
  symbols: null, colors: DEFAULT_TERM.colors, fgOnly: false, dither: false, contrast: DEFAULT_TERM.contrast, term: false, window: false, gl: false, zoom: 0, width: 0, height: 0, resizable: true, stretch: false, fullscreen: false };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--frames': opt.frames = parseInt(argv[++i], 10) || 0; break;
    case '--shot':   opt.shot = argv[++i]; break;
    case '--wav':    opt.wav = argv[++i]; break;
    case '--seed':   opt.seed = parseInt(argv[++i], 10) >>> 0; break;
    case '--scale':  opt.scale = parseInt(argv[++i], 10) || 0; break;
    case '--fps': case '--term-fps': opt.fps = Number(argv[++i]); break;
    case '--frame-skip': opt.fps = 60 / Math.max(1, parseInt(argv[++i], 10) || 1); break;
    case '--symbols': opt.symbols = argv[++i]; break;
    case '--colors': opt.colors = argv[++i]; break;
    case '--fg-only': opt.fgOnly = true; break;
    case '--dither': opt.dither = true; break;
    case '--contrast': opt.contrast = Number(argv[++i]); break;
    case '--stats':  opt.stats = true; break;
    case '--term':   opt.term = true; break;
    case '--window': opt.window = true; break;
    case '--gl':     opt.gl = true; break;
    case '--zoom':   opt.zoom = parseInt(argv[++i], 10) || 0; break;
    case '--width':  opt.width = parseInt(argv[++i], 10) || 0; break;
    case '--height': opt.height = parseInt(argv[++i], 10) || 0; break;
    case '--no-resize': opt.resizable = false; break;
    case '--stretch':   opt.stretch = true; break;
    case '--fullscreen': case '-f': opt.fullscreen = true; break;
    case '-h': case '--help':
      console.log('Usage: wasmcart-play <cart.wasc | cart-dir | URL> [--frames n] [--shot out.png] [--wav out.wav] [--seed n] [--term] [--window] [--gl] [--zoom n] [--width px] [--height px] [--no-resize] [--stretch] [--fullscreen] [--stats]');
      console.log('Terminal player (--term) options, the same names and values as retroemu\'s:');
      console.log('  --symbols <set>    ascii (default), block, half, ascii+block, solid, stipple, quad,');
      console.log('                     sextant, octant, braille, matrix, halfblock');
      console.log('                     The default is ASCII in foreground colour on a black background.');
      console.log('                     halfblock is wasmcart\'s own renderer: one \u2580 per cell with exact');
      console.log('                     pixel colours, the fastest mode; --colors/--fg-only/--dither do not apply.');
      console.log('  --colors <mode>    true (default), 256, 16, 2');
      console.log('  --fg-only          Foreground colour only, on black (on by default; with --symbols, off');
      console.log('                     unless given, as in retroemu)');
      console.log('  --dither           Floyd-Steinberg dithering');
      console.log('  --contrast <n>     Contrast boost, 1.0 = unchanged (default 1.0)');
      console.log('  --term-fps <n>     Terminal refresh rate, 1-60 (default 30; --fps is the same); logic runs at 60');
      console.log('  --frame-skip <n>   Draw every nth frame (60/n fps)');
      console.log('  --scale <cols>     Width in columns (default: fit the terminal)');
      console.log('GL carts are auto-detected (the wasm imports tell the player); --gl only FORCES the GL window up front.');
      console.log('The window opens at the cart\'s declared size and is RESIZABLE by default; the frame is');
      console.log('letterboxed (black bars) to preserve the cart\'s aspect ratio. --no-resize pins the window');
      console.log('to the cart size; --stretch fills the window instead, distorting the frame.');
      console.log('--fullscreen (-f) fills the display; the frame is letterboxed into it, so the');
      console.log('cart\'s aspect ratio holds on a screen of any shape.');
      process.exit(0);
    default:
      if (!cartPath && !a.startsWith('-')) cartPath = a;
  }
}

// No --symbols: the default look (ASCII, foreground only, on black). An
// explicit --symbols gets retroemu's behaviour: fg-only only when asked.
if (opt.symbols === null) { opt.symbols = DEFAULT_TERM.symbols; opt.fgOnly = true; }
try { checkTermOptions(opt); } catch (e) { console.error(`wasmcart-play: ${e.message}`); process.exit(1); }

if (!cartPath) {
  console.error('wasmcart-play: pass a .wasc file, URL, or dev-mode cart directory. --help for options.');
  process.exit(1);
}

let remoteCart = null;

// ── minimal PNG encoder (RGB8, filter 0, node zlib) ──────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {'bgrx'|'rgba'} order the bytes: CartHost's XRGB words (B,G,R,X) or RGBA */
export function encodePng(rgba, width, height, order = 'bgrx') {
  const ri = order === 'rgba' ? 0 : 2, bi = 2 - ri;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = row + 1 + x * 3;
      raw[d] = rgba[s + ri];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + bi];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── minimal WAV encoder (16-bit interleaved stereo) ──────────────────

function encodeWav(chunks, sampleRate) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const data = Buffer.alloc(n * 2);
  let off = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) { data.writeInt16LE(c[i], off); off += 2; }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function toInt16(audio) {
  if (!audio || !audio.length) return null;
  if (audio instanceof Int16Array) return Int16Array.from(audio);
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// ── key mapping (press = hold a few frames; terminals have no key-up) ─

const KEY_HOLD_FRAMES = 6;
const KEYMAP = {
  '\x1b[A': 'UP', '\x1b[B': 'DOWN', '\x1b[D': 'LEFT', '\x1b[C': 'RIGHT',
  w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT',
  x: 'A', z: 'B', ' ': 'A', q: null, '\r': 'START', '\t': 'SELECT',
  '[': 'L', ']': 'R',
};

// The host's WebGPU device was lost (a driver reset, the GPU removed): the
// host has stopped the cart, which cannot continue (docs/webgpu.md, "Errors
// and device loss"). Every player says so and exits 4 rather than showing a
// black frame.
function gpuLostMessage({ reason, message }) {
  return `wasmcart-play: the GPU device was lost (${reason}${message ? `: ${message}` : ''}). ` +
    'The cart cannot continue; restart it to play again.';
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  let cartSource = cartPath;
  if (isRemoteCart(cartPath)) {
    console.error(`wasmcart-play: fetching ${cartPath}`);
    remoteCart = await downloadRemoteCart(cartPath);
    cartSource = remoteCart.path;
  }

  // windowed player (default): SDL window + audio + real key edges, on the
  // org's own stack. --term skips it; headless --frames skips it; a failure
  // (no SDL, no display) falls back to the terminal player below.
  const headless = opt.frames > 0 && !opt.window;
  if (!opt.term && !headless) {
    try {
      const { runWindowed } = await import('./play-window.js');
      await runWindowed(cartSource, opt, {
        CartHost,
        toInt16,
        gpuLostMessage,
        saveIdentity: cartPath,
        cleanupSource: remoteCart?.cleanup,
      });
      return;
    } catch (e) {
      console.error(`wasmcart-play: windowed mode unavailable (${e.message}) — falling back to terminal.`);
    }
  }

  const host = new CartHost();
  const loadOpts = opt.seed !== null ? { deterministic: { seed: opt.seed } } : {};

  // The terminal player used to neither load nor save, so a cart's progress was
  // invisible here in both directions and playing in the terminal silently
  // discarded it. Same .sav path as the windowed player, so a cart resumes
  // wherever it was last played.
  const savPath = savPathFor(cartPath);
  loadOpts.saveData = loadSave(savPath);
  // Declared here because EVERY exit path has to save, not just the
  // interactive one; assigned once the host exists.
  let persistSave = () => {};

  // GL carts render fine here. Rendering on the GPU and displaying as ANSI
  // are orthogonal: the frame is read back and every path below sees the same
  // XRGB framebuffer a 2D cart produces. CartHost supplies the context itself
  // for a cart that imports `gl`, so there is nothing to pass, and a 2D cart
  // never causes one to exist.
  try {
    await host.load(cartSource, loadOpts);
  } catch (e) {
    if (/WebGL2 context could not be created/.test(String(e.message))) {
      console.error(`wasmcart-play: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  // The cart's memory exists from here on, so the saver can read it.
  persistSave = makeSaver(host, savPath);

  /*
   * Did a GL readback actually capture a rendered frame?
   *
   * An untouched context reads back as pure black, so any non-black pixel
   * means the cart drew. A cart that deliberately renders a black frame is
   * indistinguishable from one that never drew at all -- but in that case
   * both buffers are black and either choice gives the same image, so the
   * ambiguity costs nothing. Sampled on a stride: this runs per frame, and
   * scanning two million pixels to answer a yes/no is not worth it.
   */
  const hasContent = (buf) => {
    for (let p = 0; p + 2 < buf.length; p += 4 * 64) {
      if (buf[p] > 8 || buf[p + 1] > 8 || buf[p + 2] > 8) return true;
    }
    return false;
  };

  // GL frames live in the GPU's framebuffer, so read them back as top-down
  // RGBA. readPixels' origin is bottom-left while the cart's is top-left,
  // hence the row flip.
  const glCtx = host.getGlContext();
  let glReadback = null;
  if (host.usesGL && glCtx) {
    const gi = host.getInfo();
    const gw = gi.width, gh = gi.height;
    const raw = new Uint8Array(gw * gh * 4);
    glReadback = () => {
      glCtx.finish();
      glCtx.readPixels(0, 0, gw, gh, glCtx.RGBA, glCtx.UNSIGNED_BYTE, raw);
      const out = new Uint8Array(gw * gh * 4);
      for (let y = 0; y < gh; y++) out.set(raw.subarray((gh - 1 - y) * gw * 4, (gh - y) * gw * 4), y * gw * 4);
      return { rgba: out, width: gw, height: gh };
    };
  }

  /*
   * The frame the cart showed last, as top-down RGBA, whatever it renders
   * with. A WebGPU cart's frame is a GPU texture (read back asynchronously),
   * a GL cart's is the context's framebuffer, a 2D cart's is the XRGB
   * framebuffer runFrame returns. A WebGPU cart has no 2D framebuffer at all:
   * its fb_ptr is 0, so runFrame's framebuffer is the bytes at the start of
   * its memory, and showing that is what drew one garbled row over black.
   *
   * Importing `gl` is not the same as RENDERING through it. An SDK that
   * links a GL backend into every cart (the pygame shim does) makes usesGL
   * true even for a cart that only writes the CPU framebuffer, and reading
   * back the untouched context then yields a black frame over a perfectly
   * good one. Take the GL readback only when it actually drew.
   */
  const grabRgba = async () => {
    if (host.usesWgpu) {
      const g = await host.readGpuFrame();
      return g ? { rgba: g.data, width: g.width, height: g.height } : null;
    }
    if (glReadback) {
      const gf = glReadback();
      if (hasContent(gf.rgba)) return gf;
    }
    if (!frame) return null;
    const fb = frame.framebuffer, out = new Uint8Array(frame.width * frame.height * 4);
    for (let p = 0; p < out.length; p += 4) {
      out[p] = fb[p + 2]; out[p + 1] = fb[p + 1]; out[p + 2] = fb[p]; out[p + 3] = 255;
    }
    return { rgba: out, width: frame.width, height: frame.height };
  };

  const info = host.getInfo();
  const held = new Map(); // button name → frames left
  const audioChunks = [];
  const pad = () => {
    let buttons = 0;
    for (const [name, left] of held) {
      if (left > 0) { buttons |= BUTTON[name]; held.set(name, left - 1); }
    }
    return [{ connected: true, buttons }];
  };

  let frame = null;
  const step = () => {
    frame = host.runFrame(pad());
    if (host.gpuLost) return;
    if (opt.wav) {
      const a = toInt16(frame.audio);
      if (a) audioChunks.push(a);
    }
  };

  // headless mode (--frames without --window)
  if (opt.frames > 0 && !opt.window) {
    for (let i = 0; i < opt.frames; i++) {
      step();
      if (host.gpuLost) {
        console.error(gpuLostMessage(host.gpuLost));
        persistSave();
        host.destroy();
        remoteCart?.cleanup();
        process.exit(4);
      }
      // A WebGPU cart's async results (maps, error scopes) arrive on the event
      // loop between frames (SPEC.md, "WebGPU"), so let it run.
      if (host.usesWgpu) await new Promise((resolve) => setImmediate(resolve));
    }
    if (opt.shot) {
      const g = await grabRgba();
      writeFileSync(opt.shot, encodePng(g.rgba, g.width, g.height, 'rgba'));
      frame = { ...frame, width: g.width, height: g.height };
    }
    if (opt.wav) writeFileSync(opt.wav, encodeWav(audioChunks, info.audioSampleRate || 48000));
    const dbg = host.info?.hasDebug ? ` debug=[${(host.readDebugState() || []).map((f) => f.name).join(',')}]` : '';
    console.log(`ran ${opt.frames} frames  ${frame.width}x${frame.height}  abi=${info.version}${dbg}` +
      (opt.shot ? `  shot=${opt.shot}` : '') + (opt.wav ? `  wav=${opt.wav}` : ''));
    // Persist BEFORE destroy(), exactly as the interactive and windowed
    // players do: getSaveData() reads the cart's linear memory, which is gone
    // afterwards. This branch used to return without saving at all, so a cart
    // calling its save API during a headless run kept the data for that run
    // and lost it on the next one -- and the load side worked, so a
    // save-then-load check inside ONE run passed while nothing persisted.
    persistSave();
    host.destroy();
    remoteCart?.cleanup();
    return;
  }

  // interactive terminal player
  if (!process.stdout.isTTY) {
    console.error('wasmcart-play: not a TTY — use --frames N (with --shot/--wav) for headless runs.');
    process.exit(1);
  }
  const renderer = createTermRenderer(opt);
  let lastShown = null; // the last frame drawn, for --shot on quit
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    persistSave(); // before destroy() -- getSaveData reads the cart's memory
    process.stdout.write('\x1b[?25h\x1b[0m\x1b[2J\x1b[H'); // cursor back, clear
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    renderer.close();
    host.destroy();
    remoteCart?.cleanup();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  // An uncaught throw still gets one attempt at the save. Losing progress on
  // top of a crash is strictly worse than trying and failing.
  process.on('uncaughtException', (err) => { console.error(err); cleanup(); process.exit(1); });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const k = buf.toString('utf8');
    if (k === 'q' || k === '\x03') {
      if (opt.shot && lastShown) writeFileSync(opt.shot, encodePng(lastShown.rgba, lastShown.width, lastShown.height, 'rgba'));
      cleanup();
      process.exit(0);
    }
    const name = KEYMAP[k];
    if (name) held.set(name, KEY_HOLD_FRAMES);
  });

  process.stdout.write('\x1b[?25l\x1b[2J'); // hide cursor, clear
  // The cart's logic runs at 60 Hz on its own timer. The terminal is drawn
  // on a second timer at --term-fps, decoupled from it: reading the frame
  // back and converting it to text never holds up a cart frame, and a draw
  // still in flight (a WebGPU readback, a chafa render in its worker) makes
  // the next tick skip rather than queue.
  let tickCount = 0;
  setInterval(() => {
    step();
    if (host.gpuLost) {
      cleanup();
      console.error(gpuLostMessage(host.gpuLost));
      process.exit(4);
    }
    tickCount++;
  }, 1000 / 60);

  const mode = opt.symbols === 'halfblock' ? 'halfblock' : `${opt.symbols} ${opt.colors}${opt.fgOnly ? ' fg' : ''}${opt.dither ? ' dither' : ''}`;
  let drawing = false, drawn = 0, shownFps = 0, fpsSince = performance.now();
  const draw = async () => {
    if (drawing || cleaned || !frame) return;
    drawing = true;
    try {
      const g = await grabRgba();
      if (!g || cleaned) return;
      if (opt.shot) lastShown = { ...g, rgba: g.rgba.slice() };
      const maxRows = Math.max(1, (process.stdout.rows || 24) - 1);
      const { cols, rows } = fitCells(g.width, g.height, process.stdout.columns || 80, maxRows, opt.scale);
      const ansi = await renderer.render(g.rgba, g.width, g.height, cols, rows);
      if (cleaned) return;
      drawn++;
      const now = performance.now();
      if (now - fpsSince >= 1000) {
        shownFps = Math.round((drawn * 1000) / (now - fpsSince));
        if (opt.stats) process.stderr.write(`term fps ${shownFps}\n`);
        drawn = 0; fpsSince = now;
      }
      process.stdout.write('\x1b[H' + ansi +
        `\n\x1b[0m\x1b[K${g.width}x${g.height} -> ${cols}x${rows} | ${shownFps}fps | ${mode} | f${tickCount}  arrows/wasd move  x/z=A/B  enter=start  q=quit\x1b[J`);
    } finally {
      drawing = false;
    }
  };
  setInterval(() => { draw().catch((e) => { cleanup(); console.error(`wasmcart-play: ${e.message}`); process.exit(1); }); }, 1000 / opt.fps);
}

main().catch((e) => {
  remoteCart?.cleanup();
  console.error(`wasmcart-play: ${e.message}`);
  process.exit(1);
});
