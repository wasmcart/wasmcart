#!/usr/bin/env node
/*
 * wasmcart-play - run a .wasc cart (or a dev-mode cart DIRECTORY) right in
 * the terminal, no native host required. Video renders as ANSI half-blocks;
 * the keyboard drives pad 0. Also a headless runner for scripting:
 * step N frames, dump a PNG screenshot and/or a WAV of the audio, exit.
 *
 * Usage: wasmcart-play <cart.wasc | cart-dir> [options]
 *
 * Options:
 *   --frames <n>     Headless: run n frames, then exit (no terminal UI)
 *   --shot <out.png> Write the final framebuffer as a PNG (implies headless
 *                    when --frames is given; in interactive mode, saved on quit)
 *   --wav <out.wav>  Headless: write the run's audio as a 16-bit stereo WAV
 *   --seed <n>       Deterministic run: fixed clock + wc_set_seed(n)
 *   --scale <cols>   Terminal width in columns (default: fit the window)
 *   --fps <n>        Terminal refresh rate (default 30; logic always runs 60)
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
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';

// ── args ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let cartPath = null;
// resizable + letterbox are the DEFAULTS; --no-resize and --stretch opt out.
const opt = { frames: 0, shot: null, wav: null, seed: null, scale: 0, fps: 30, term: false, window: false, gl: false, zoom: 0, resizable: true, stretch: false };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--frames': opt.frames = parseInt(argv[++i], 10) || 0; break;
    case '--shot':   opt.shot = argv[++i]; break;
    case '--wav':    opt.wav = argv[++i]; break;
    case '--seed':   opt.seed = parseInt(argv[++i], 10) >>> 0; break;
    case '--scale':  opt.scale = parseInt(argv[++i], 10) || 0; break;
    case '--fps':    opt.fps = Math.max(1, Math.min(60, parseInt(argv[++i], 10) || 30)); break;
    case '--term':   opt.term = true; break;
    case '--window': opt.window = true; break;
    case '--gl':     opt.gl = true; break;
    case '--zoom':   opt.zoom = parseInt(argv[++i], 10) || 0; break;
    case '--no-resize': opt.resizable = false; break;
    case '--stretch':   opt.stretch = true; break;
    case '-h': case '--help':
      console.log('Usage: wasmcart-play <cart.wasc | cart-dir> [--frames n] [--shot out.png] [--wav out.wav] [--seed n] [--term] [--window] [--gl] [--zoom n] [--scale cols] [--fps n] [--no-resize] [--stretch]');
      console.log('GL carts are auto-detected (the wasm imports tell the player); --gl only FORCES the GL window up front.');
      console.log('The window opens at the cart\'s declared size and is RESIZABLE by default; the frame is');
      console.log('letterboxed (black bars) to preserve the cart\'s aspect ratio. --no-resize pins the window');
      console.log('to the cart size; --stretch fills the window instead, distorting the frame.');
      process.exit(0);
    default:
      if (!cartPath && !a.startsWith('-')) cartPath = a;
  }
}

if (!cartPath) {
  console.error('wasmcart-play: pass a .wasc file or a dev-mode cart directory. --help for options.');
  process.exit(1);
}

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

export function encodePng(rgba, width, height) {
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
      // CartHost framebuffer bytes are little-endian XRGB words: B,G,R,X
      raw[d] = rgba[s + 2];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s];
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

// ── terminal renderer: half-blocks, 24-bit color ─────────────────────

function renderAnsi(fb, fbW, fbH, cols, rows) {
  // rows terminal rows = rows*2 pixel rows via '▀' (fg=top, bg=bottom)
  const out = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    let lastFg = -1, lastBg = -1;
    for (let cx = 0; cx < cols; cx++) {
      const sx = Math.floor((cx * fbW) / cols);
      const syT = Math.floor(((ry * 2) * fbH) / (rows * 2));
      const syB = Math.floor(((ry * 2 + 1) * fbH) / (rows * 2));
      const t = (syT * fbW + sx) * 4, b = (syB * fbW + sx) * 4;
      // bytes are B,G,R,X
      const fg = (fb[t + 2] << 16) | (fb[t + 1] << 8) | fb[t];
      const bg = (fb[b + 2] << 16) | (fb[b + 1] << 8) | fb[b];
      if (fg !== lastFg) { line += `\x1b[38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}m`; lastFg = fg; }
      if (bg !== lastBg) { line += `\x1b[48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}m`; lastBg = bg; }
      line += '▀';
    }
    out.push(line + '\x1b[0m');
  }
  return out.join('\n');
}

// ── key mapping (press = hold a few frames; terminals have no key-up) ─

const KEY_HOLD_FRAMES = 6;
const KEYMAP = {
  '\x1b[A': 'UP', '\x1b[B': 'DOWN', '\x1b[D': 'LEFT', '\x1b[C': 'RIGHT',
  w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT',
  x: 'A', z: 'B', ' ': 'A', q: null, '\r': 'START', '\t': 'SELECT',
  '[': 'L', ']': 'R',
};

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  // windowed player (default): SDL window + audio + real key edges, on the
  // org's own stack. --term skips it; headless --frames skips it; a failure
  // (no SDL, no display) falls back to the terminal player below.
  const headless = opt.frames > 0 && !opt.window;
  if (!opt.term && !headless) {
    try {
      const { runWindowed } = await import('./play-window.js');
      await runWindowed(cartPath, opt, { CartHost, toInt16 });
      return;
    } catch (e) {
      console.error(`wasmcart-play: windowed mode unavailable (${e.message}) — falling back to terminal.`);
    }
  }

  const host = new CartHost();
  const loadOpts = opt.seed !== null ? { deterministic: { seed: opt.seed } } : {};

  // GL carts render fine here. Rendering on the GPU and displaying as ANSI
  // are orthogonal: the frame is read back and every path below sees the same
  // XRGB framebuffer a 2D cart produces. CartHost supplies the context itself
  // for a cart that imports `gl`, so there is nothing to pass, and a 2D cart
  // never causes one to exist.
  try {
    await host.load(cartPath, loadOpts);
  } catch (e) {
    if (/WebGL2 context could not be created/.test(String(e.message))) {
      console.error(`wasmcart-play: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

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

  // GL frames live in the GPU's framebuffer, so read them back into the same
  // XRGB word layout CartHost hands out for a 2D cart. readPixels' origin is
  // bottom-left while the cart's is top-left, hence the row flip.
  const glCtx = host.getGlContext();
  let glReadback = null;
  if (host.usesGL && glCtx) {
    const gi = host.getInfo();
    const gw = gi.width, gh = gi.height;
    const rgba = new Uint8Array(gw * gh * 4);
    const out = new Uint8Array(gw * gh * 4);
    glReadback = () => {
      glCtx.finish();
      glCtx.readPixels(0, 0, gw, gh, glCtx.RGBA, glCtx.UNSIGNED_BYTE, rgba);
      for (let y = 0; y < gh; y++) {
        const src = (gh - 1 - y) * gw * 4, dst = y * gw * 4;
        for (let x = 0; x < gw * 4; x += 4) {
          out[dst + x]     = rgba[src + x + 2];   // B
          out[dst + x + 1] = rgba[src + x + 1];   // G
          out[dst + x + 2] = rgba[src + x];       // R
          out[dst + x + 3] = 255;
        }
      }
      return { framebuffer: out, width: gw, height: gh };
    };
  }

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
    // Importing `gl` is not the same as RENDERING through it. An SDK that
    // links a GL backend into every cart (the pygame shim does) makes
    // usesGL true even for a cart that only writes the CPU framebuffer, and
    // reading back the untouched context then yields a black frame over a
    // perfectly good one. Take the GL readback only when it actually drew.
    if (glReadback) {
      const gf = glReadback();
      if (hasContent(gf.framebuffer)) frame = { ...frame, ...gf };
    }
    if (opt.wav) {
      const a = toInt16(frame.audio);
      if (a) audioChunks.push(a);
    }
  };

  // headless mode (--frames without --window)
  if (opt.frames > 0 && !opt.window) {
    for (let i = 0; i < opt.frames; i++) step();
    if (opt.shot) writeFileSync(opt.shot, encodePng(frame.framebuffer, frame.width, frame.height));
    if (opt.wav) writeFileSync(opt.wav, encodeWav(audioChunks, info.audioSampleRate || 48000));
    const dbg = host.info?.hasDebug ? ` debug=[${(host.readDebugState() || []).map((f) => f.name).join(',')}]` : '';
    console.log(`ran ${opt.frames} frames  ${frame.width}x${frame.height}  abi=${info.version}${dbg}` +
      (opt.shot ? `  shot=${opt.shot}` : '') + (opt.wav ? `  wav=${opt.wav}` : ''));
    host.destroy();
    return;
  }

  // interactive terminal player
  if (!process.stdout.isTTY) {
    console.error('wasmcart-play: not a TTY — use --frames N (with --shot/--wav) for headless runs.');
    process.exit(1);
  }
  const cleanup = () => {
    process.stdout.write('\x1b[?25h\x1b[0m\x1b[2J\x1b[H'); // cursor back, clear
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    host.destroy();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const k = buf.toString('utf8');
    if (k === 'q' || k === '\x03') {
      if (opt.shot && frame) writeFileSync(opt.shot, encodePng(frame.framebuffer, frame.width, frame.height));
      cleanup();
      process.exit(0);
    }
    const name = KEYMAP[k];
    if (name) held.set(name, KEY_HOLD_FRAMES);
  });

  process.stdout.write('\x1b[?25l\x1b[2J'); // hide cursor, clear
  const framesPerRender = Math.max(1, Math.round(60 / opt.fps));
  let tickCount = 0;
  const interval = setInterval(() => {
    step();
    tickCount++;
    if (tickCount % framesPerRender !== 0) return;
    const cols = opt.scale || Math.min(process.stdout.columns || 80, 160);
    const rows = Math.min(
      (process.stdout.rows || 24) - 1,
      Math.max(1, Math.round((cols * frame.height) / frame.width / 2)),
    );
    process.stdout.write('\x1b[H' + renderAnsi(frame.framebuffer, frame.width, frame.height, cols, rows) +
      `\n\x1b[0m${frame.width}x${frame.height} f${tickCount}  arrows/wasd move  x/z=A/B  enter=start  q=quit `);
  }, 1000 / 60);
  void interval;
}

main().catch((e) => {
  console.error(`wasmcart-play: ${e.message}`);
  process.exit(1);
});
