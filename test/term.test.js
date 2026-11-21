// The terminal player (--term): every renderer mode, and the frame it shows
// for 2D, GL and WebGPU carts.
//
// The frame checks run the real CLI in a pseudo-terminal and decode its last
// frame back into cells. With --symbols halfblock each cell carries exactly
// two sampled pixels, so the frame can be compared with the cart's headless
// --shot pixel for pixel. The control is the readback the player used before
// 0.42.0 for a WebGPU cart (runFrame's framebuffer, which a WebGPU cart does
// not have): it must fail the same comparison.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { CartHost } from '../src/CartHost.js';
import { createTermRenderer } from '../src/term/renderer.js';
import { renderHalfblock } from '../src/term/halfblock.js';
import { SYMBOLS, fitCells, checkTermOptions } from '../src/term/options.js';
import { parseCells, lastFrame, cellsToImage } from './helpers/ansi-image.js';
import { runTerm, hasPty, decodePng, PLAY } from './helpers/term-pty.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WGPU_HELLO = join(ROOT, 'examples', 'webgpu-hello', 'webgpu-hello.wasc');
const GLTRI = join(HERE, 'fixtures', 'gltri.wasc');
const HELLO2D = join(HERE, 'fixtures', 'hello.wasc');
// Always the low-power GPU: a plain `npm test` must never render on the GPU that
// drives the display. The CLI runs below inherit it.
process.env.WASMCART_WGPU_POWER = 'low-power';

// ── helpers ──────────────────────────────────────────────────────────

/** Share of halfblock cells whose two colours are within `tol` of the
 *  reference pixels they sample. */
function halfblockMatch(cells, ref, tol = 6) {
  const rows = cells.length, cols = cells[0].length;
  let ok = 0, n = 0;
  const near = (a, o) => Math.abs(a[0] - ref.rgba[o]) <= tol && Math.abs(a[1] - ref.rgba[o + 1]) <= tol && Math.abs(a[2] - ref.rgba[o + 2]) <= tol;
  for (let ry = 0; ry < rows; ry++) {
    const syT = Math.floor((ry * 2 * ref.height) / (rows * 2));
    const syB = Math.floor(((ry * 2 + 1) * ref.height) / (rows * 2));
    for (let cx = 0; cx < cols; cx++) {
      const c = cells[ry][cx];
      if (!c) continue;
      const sx = Math.floor((cx * ref.width) / cols);
      n++;
      if (c.ch === '▀' && near(c.fg, (syT * ref.width + sx) * 4) && near(c.bg, (syB * ref.width + sx) * 4)) ok++;
    }
  }
  return n ? ok / n : 0;
}

function shot(cart) {
  const out = join(os.tmpdir(), `term-shot-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  execFileSync(process.execPath, [PLAY, cart, '--frames', '30', '--shot', out], { encoding: 'utf8' });
  return out;
}

async function framesFromPty(cart, args) {
  const raw = await runTerm(cart, args);
  const f = lastFrame(raw);
  assert.ok(f, `the player drew no complete frame; output began: ${JSON.stringify(raw.slice(0, 400))}`);
  return { cells: parseCells(f), raw };
}

// A synthetic frame: left half red, right half blue, green rising downward.
const W = 320, H = 240;
function synth(mirror = false) {
  const a = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, left = (x < W / 2) !== mirror;
    a[o] = left ? 220 : 20; a[o + 1] = ((mirror ? H - 1 - y : y) * 200 / H) | 0; a[o + 2] = left ? 30 : 210; a[o + 3] = 255;
  }
  return a;
}

/** Does a decoded frame look like synth(): red left, blue right, brighter at the bottom? */
async function looksLikeSynth(cells, colors, matrix) {
  const img = await cellsToImage(cells, 4, 8);
  const sum = (x0, x1, y0, y1) => {
    const s = [0, 0, 0];
    for (let y = Math.floor(y0 * img.height); y < y1 * img.height; y++) for (let x = Math.floor(x0 * img.width); x < x1 * img.width; x++) {
      const o = (y * img.width + x) * 3; s[0] += img.rgb[o]; s[1] += img.rgb[o + 1]; s[2] += img.rgb[o + 2];
    }
    return s;
  };
  const lum = (s) => s[0] + s[1] + s[2];
  // monochrome output (2 colours, matrix) can only show brightness
  const brighterBelow = (matrix ? sum(0, 1, 0.66, 1)[1] > sum(0, 1, 0, 0.33)[1] : lum(sum(0, 1, 0.66, 1)) > lum(sum(0, 1, 0, 0.33)));
  if (colors === '2' || matrix) return brighterBelow;
  const L = sum(0, 0.5, 0, 1), R = sum(0.5, 1, 0, 1);
  return L[0] > L[2] && R[2] > R[0] && brighterBelow;
}

const ASCII = (cp) => cp >= 0x20 && cp <= 0x7e;
const BLOCKS = (cp) => cp === 0x20 || (cp >= 0x2580 && cp <= 0x259f);
const BORDERS = (cp) => cp >= 0x2500 && cp <= 0x257f;
const LEGACY = (cp) => cp >= 0x1fb00 && cp <= 0x1fbff;
/** per mode: glyphs it may use, and a glyph test at least one cell must pass */
const GLYPHS = {
  ascii: { allow: ASCII, sign: (cp) => cp > 0x20 && cp <= 0x7e },
  block: { allow: (cp) => BLOCKS(cp) || BORDERS(cp), sign: (cp) => cp >= 0x2580 && cp <= 0x259f },
  half: { allow: (cp) => cp === 0x20 || cp === 0x2580 || cp === 0x2584 || cp === 0x2588, sign: (cp) => cp === 0x2580 || cp === 0x2584 },
  'ascii+block': { allow: (cp) => ASCII(cp) || BLOCKS(cp) || BORDERS(cp), sign: (cp) => cp > 0x20 },
  solid: { allow: (cp) => cp === 0x20 || cp === 0x2588, sign: (cp) => cp === 0x20 },
  stipple: { allow: (cp) => cp === 0x20 || cp === 0x2588 || (cp >= 0x2591 && cp <= 0x2593), sign: (cp) => cp >= 0x2591 && cp <= 0x2593 },
  quad: { allow: BLOCKS, sign: (cp) => cp >= 0x2596 && cp <= 0x259f || cp === 0x2580 || cp === 0x2584 || cp === 0x258c || cp === 0x2590 },
  sextant: { allow: (cp) => BLOCKS(cp) || LEGACY(cp), sign: (cp) => cp >= 0x1fb00 && cp <= 0x1fb3b },
  octant: { allow: (cp) => BLOCKS(cp) || LEGACY(cp) || (cp >= 0x1cc00 && cp <= 0x1cebf), sign: (cp) => cp >= 0x1cd00 && cp <= 0x1cde5 },
  braille: { allow: (cp) => cp >= 0x2800 && cp <= 0x28ff, sign: (cp) => cp > 0x2800 && cp <= 0x28ff },
  matrix: { allow: (cp) => cp === 0x20 || (cp >= 0x30 && cp <= 0x39) || (cp >= 0xff66 && cp <= 0xff9d) || cp === 0x2588, sign: (cp) => cp >= 0xff66 && cp <= 0xff9d },
  halfblock: { allow: (cp) => cp === 0x2580, sign: (cp) => cp === 0x2580 },
};

function glyphCheck(ansi, mode) {
  const g = GLYPHS[mode];
  const cps = [...ansi.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\n/g, '')].map((c) => c.codePointAt(0));
  const bad = cps.filter((cp) => !g.allow(cp));
  return { ok: bad.length === 0 && cps.some(g.sign), bad: [...new Set(bad)].slice(0, 8).map((cp) => cp.toString(16)) };
}

/** The colour escapes each --colors mode may emit (SGR parameter forms). */
function colourCheck(ansi, colors, fgOnly) {
  // every colour an SGR sets, as {kind: 'true'|'256'|'16', bg, value}
  const set = [];
  for (const m of ansi.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const p = m[1].split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if ((v === 38 || v === 48) && p[i + 1] === 2) { set.push({ kind: 'true', bg: v === 48, value: p.slice(i + 2, i + 5).join(',') }); i += 4; }
      else if ((v === 38 || v === 48) && p[i + 1] === 5) { set.push({ kind: '256', bg: v === 48, value: String(p[i + 2]) }); i += 2; }
      else if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) set.push({ kind: '16', bg: false, value: String(v) });
      else if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107)) set.push({ kind: '16', bg: true, value: String(v) });
    }
  }
  const blackBg = (c) => c.bg && ((c.kind === 'true' && c.value === '0,0,0') || (c.kind === '256' && (c.value === '0' || c.value === '16')) || (c.kind === '16' && c.value === '40'));
  if (fgOnly && set.some((c) => c.bg && !blackBg(c))) return false;
  const colour = set.filter((c) => !blackBg(c));
  if (colors === '2') return colour.length === 0;
  return colour.length > 0 && colour.every((c) => c.kind === colors);
}

// ── renderer modes (no GPU) ──────────────────────────────────────────

test('every --symbols mode draws only its own glyph class, and the picture', async (t) => {
  for (const symbols of SYMBOLS) {
    await t.test(symbols, async () => {
      const r = createTermRenderer({ symbols, colors: 'true', fgOnly: false, dither: false, contrast: 1 });
      try {
        const { cols, rows } = fitCells(W, H, 160, 49);
        const ansi = await r.render(synth(), W, H, cols, rows);
        const g = glyphCheck(ansi, symbols);
        assert.ok(g.ok, `${symbols}: glyphs outside the class: ${g.bad.join(',')}`);
        const cells = parseCells(ansi);
        assert.equal(cells.length, rows);
        assert.equal(cells[0].length, cols);
        assert.ok(await looksLikeSynth(cells, 'true', symbols === 'matrix'), `${symbols}: the picture is not the frame`);
        // control: the mirrored frame must fail the same picture check
        const mirrored = parseCells(await r.render(synth(true), W, H, cols, rows));
        assert.equal(await looksLikeSynth(mirrored, 'true', symbols === 'matrix'), false, `${symbols}: the picture check cannot fail`);
      } finally {
        await r.close();
      }
    });
  }
  // control: the glyph check rejects another class's output
  const r = createTermRenderer({ symbols: 'block', colors: 'true', fgOnly: false, dither: false, contrast: 1 });
  const blockAnsi = await r.render(synth(), W, H, 128, 48);
  await r.close();
  assert.equal(glyphCheck(blockAnsi, 'ascii').ok, false, 'block output must fail the ascii glyph check');
  assert.equal(glyphCheck(blockAnsi, 'braille').ok, false, 'block output must fail the braille glyph check');
});

test('every --colors mode, with and without --fg-only and --dither', async (t) => {
  for (const colors of ['true', '256', '16', '2']) for (const fgOnly of [false, true]) for (const dither of [false, true]) {
    await t.test(`ascii ${colors}${fgOnly ? ' fg-only' : ''}${dither ? ' dither' : ''}`, async () => {
      const r = createTermRenderer({ symbols: 'ascii', colors, fgOnly, dither, contrast: 1 });
      try {
        const ansi = await r.render(synth(), W, H, 128, 48);
        assert.ok(colourCheck(ansi, colors, fgOnly), `colour escapes do not fit --colors ${colors}${fgOnly ? ' --fg-only' : ''}`);
        assert.ok(glyphCheck(ansi, 'ascii').ok);
        const cells = parseCells(ansi);
        if (fgOnly) assert.ok(cells.flat().every((c) => c.bg.every((v) => v === 0)), 'fg-only: background must be black');
        assert.ok(await looksLikeSynth(cells, colors, false), 'the picture is not the frame');
      } finally {
        await r.close();
      }
    });
  }
  // controls: each mode's escapes fail the other modes' checks
  const r = createTermRenderer({ symbols: 'ascii', colors: 'true', fgOnly: false, dither: false, contrast: 1 });
  const tc = await r.render(synth(), W, H, 128, 48);
  await r.close();
  assert.equal(colourCheck(tc, '256', false), false);
  assert.equal(colourCheck(tc, '2', false), false);
  assert.equal(colourCheck(tc, 'true', true), false, 'a coloured background must fail the fg-only check');
});

test('--dither and --contrast change the output; contrast 1.0 does not', async () => {
  const render = async (o) => {
    const r = createTermRenderer({ symbols: 'block', colors: '16', fgOnly: false, dither: false, contrast: 1, ...o });
    try { return await r.render(synth(), W, H, 128, 48); } finally { await r.close(); }
  };
  const base = await render({});
  assert.equal(await render({ contrast: 1 }), base, 'same options, same frame');
  assert.notEqual(await render({ dither: true }), base, '--dither must change a 16-colour frame');
  assert.notEqual(await render({ contrast: 1.8 }), base, '--contrast must change the frame');
});

test('the default (ASCII, fg only) keeps dark scenes readable and a black backdrop black', async () => {
  // A dark scene: dim purple shapes on a near-black backdrop. Flat areas have
  // no edge for chafa to draw, so a background-stripping renderer shows them
  // as nothing; the default fills them from a density ramp and lifts the ink.
  const frame = () => {
    const a = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, shape = x >= 40 && x < 280 && y >= 60 && y < 180;
      a[o] = shape ? 50 : 8; a[o + 1] = shape ? 30 : 7; a[o + 2] = shape ? 70 : 12; a[o + 3] = 255;
    }
    return a;
  };
  const readable = (cells) => {
    const cols = cells[0].length, rows = cells.length;
    let inShape = 0, inkShape = 0, outside = 0, inkOutside = 0;
    cells.forEach((row, cy) => row.forEach((c, cx) => {
      const px = ((cx + 0.5) * W) / cols, py = ((cy + 0.5) * H) / rows;
      const shape = px >= 48 && px < 272 && py >= 70 && py < 170, edge = !shape && px >= 32 && px < 288 && py >= 50 && py < 190;
      const ink = c.ch !== ' ' && Math.max(...c.fg) >= 96;
      if (shape) { inShape++; if (ink) inkShape++; } else if (!edge) { outside++; if (c.ch !== ' ') inkOutside++; }
    }));
    return inkShape / inShape >= 0.9 && inkOutside / outside <= 0.02;
  };
  const r = createTermRenderer({ symbols: 'ascii', colors: 'true', fgOnly: true, dither: false, contrast: 1 });
  try {
    const cells = parseCells(await r.render(frame(), W, H, 130, 49));
    assert.ok(readable(cells), 'the dim shape must read as visible ink on a black backdrop');
  } finally {
    await r.close();
  }
  // controls: a blank frame and an all-ink frame both fail the check
  const blank = Array.from({ length: 49 }, () => Array.from({ length: 130 }, () => ({ ch: ' ', fg: [0, 0, 0], bg: [0, 0, 0] })));
  assert.equal(readable(blank), false);
  const all = Array.from({ length: 49 }, () => Array.from({ length: 130 }, () => ({ ch: '#', fg: [200, 200, 200], bg: [0, 0, 0] })));
  assert.equal(readable(all), false);
});

test('halfblock is exact: every cell carries its two sampled pixels', async () => {
  const img = synth();
  const cells = parseCells(renderHalfblock(img, W, H, 130, 49));
  assert.equal(halfblockMatch(cells, { width: W, height: H, rgba: img }, 0), 1);
  // control
  assert.ok(halfblockMatch(cells, { width: W, height: H, rgba: synth(true) }, 6) < 0.6);
});

test('option validation names the accepted values', () => {
  assert.throws(() => checkTermOptions({ symbols: 'pixels', colors: 'true', contrast: 1, fps: 30 }), /--symbols pixels: expected one of .*ascii/);
  assert.throws(() => checkTermOptions({ symbols: 'ascii', colors: '8', contrast: 1, fps: 30 }), /--colors 8: expected one of true, 256, 16, 2/);
  assert.throws(() => checkTermOptions({ symbols: 'ascii', colors: 'true', contrast: 1, fps: 0 }), /--term-fps/);
  const r = execFileSync(process.execPath, [PLAY, '--help'], { encoding: 'utf8' });
  for (const flag of ['--symbols', '--colors', '--fg-only', '--dither', '--contrast', '--term-fps', '--frame-skip']) assert.match(r, new RegExp(flag));
  assert.match(r, /default is ASCII in foreground colour on a black background/);
});

test('fitCells keeps the frame aspect inside the terminal', () => {
  assert.deepEqual(fitCells(320, 240, 160, 49), { cols: 130, rows: 49 });
  assert.deepEqual(fitCells(320, 240, 80, 49), { cols: 80, rows: 30 });
  assert.deepEqual(fitCells(1920, 1080, 160, 49), { cols: 160, rows: 45 });
  assert.deepEqual(fitCells(320, 240, 160, 49, 100), { cols: 100, rows: 38 });
});

// ── the real player in a pty: 2D, GL and WebGPU carts ────────────────

const ptyOpts = { skip: hasPty ? false : 'needs util-linux script (Linux)' };

test('--term shows a WebGPU cart\'s rendered frame (webgpu-hello)', ptyOpts, async (t) => {
  const png = shot(WGPU_HELLO);
  try {
    const ref = decodePng(png);
    const { cells } = await framesFromPty(WGPU_HELLO, ['--symbols', 'halfblock']);
    const match = halfblockMatch(cells, ref);
    t.diagnostic(`halfblock cells matching the --shot: ${(match * 100).toFixed(1)}%`);
    assert.ok(match >= 0.97, `the terminal frame is not the cart's frame (${(match * 100).toFixed(1)}% of cells match)`);

    // control: the readback 0.41 used, runFrame()'s 2D framebuffer, which a
    // WebGPU cart does not have (fb_ptr 0: the bytes at the start of memory)
    const host = new CartHost();
    await host.load(WGPU_HELLO);
    try {
      let f;
      for (let i = 0; i < 10; i++) { f = host.runFrame([]); await new Promise((r) => setImmediate(r)); }
      t.diagnostic(`adapter: ${JSON.stringify(host.getGpuAdapterInfo())}`);
      assert.equal(host.getGpuAdapterInfo().powerPreference, 'low-power', 'the test must run on the low-power GPU');
      const old = new Uint8Array(f.width * f.height * 4);
      for (let p = 0; p < old.length; p += 4) { old[p] = f.framebuffer[p + 2]; old[p + 1] = f.framebuffer[p + 1]; old[p + 2] = f.framebuffer[p]; old[p + 3] = 255; }
      const oldCells = parseCells(renderHalfblock(old, f.width, f.height, cells[0].length, cells.length));
      const oldMatch = halfblockMatch(oldCells, ref);
      t.diagnostic(`control (0.41 readback): ${(oldMatch * 100).toFixed(1)}%`);
      assert.ok(oldMatch < 0.5, `the control must fail (${(oldMatch * 100).toFixed(1)}%)`);
    } finally {
      host.destroy();
    }
  } finally {
    await rm(png, { force: true });
  }
});

test('--term default (ASCII, fg only, black) on a WebGPU cart shows its colours', ptyOpts, async () => {
  const { cells } = await framesFromPty(WGPU_HELLO, []);
  const flat = cells.flat();
  assert.ok(flat.every((c) => c.bg.every((v) => v === 0)), 'background must be black');
  assert.ok(flat.every((c) => c.ch.codePointAt(0) <= 0x7e), 'ASCII only');
  // the triangle samples red, green, blue and white texels; the background is blue-grey
  const ink = flat.filter((c) => c.ch !== ' ');
  const has = (fn) => ink.some((c) => fn(...c.fg));
  assert.ok(has((r, g, b) => r > 150 && g < 80 && b < 80), 'red texels');
  assert.ok(has((r, g, b) => g > 150 && r < 80 && b < 80), 'green texels');
  assert.ok(has((r, g, b) => b > 150 && r < 80 && g < 80), 'blue texels');
  // the triangle is filled (its solid quadrants are flat cells, which a
  // background-stripping renderer leaves blank) and the dark backdrop is black
  const rows = cells.length, cols = cells[0].length;
  const region = (x0, x1, y0, y1) => cells.slice(Math.floor(y0 * rows), Math.floor(y1 * rows)).flatMap((r) => r.slice(Math.floor(x0 * cols), Math.floor(x1 * cols)));
  const share = (cs) => cs.filter((c) => c.ch !== ' ').length / cs.length;
  assert.ok(share(region(0.3, 0.7, 0.6, 0.8)) >= 0.9, `the triangle's fill must be ink (${share(region(0.3, 0.7, 0.6, 0.8))})`);
  assert.ok(share(region(0, 0.12, 0, 0.12)) <= 0.05, 'the backdrop must stay black');
});

test('--term shows a GL cart\'s frame (gltri)', ptyOpts, async (t) => {
  const png = shot(GLTRI);
  try {
    const { cells } = await framesFromPty(GLTRI, ['--symbols', 'halfblock']);
    const match = halfblockMatch(cells, decodePng(png));
    t.diagnostic(`GL: ${(match * 100).toFixed(1)}%`);
    assert.ok(match >= 0.97, `GL frame mismatch (${(match * 100).toFixed(1)}%)`);
  } finally {
    await rm(png, { force: true });
  }
});

test('--term shows a 2D cart\'s frame (hello)', ptyOpts, async (t) => {
  const png = shot(HELLO2D);
  try {
    const { cells } = await framesFromPty(HELLO2D, ['--symbols', 'halfblock']);
    const match = halfblockMatch(cells, decodePng(png));
    t.diagnostic(`2D: ${(match * 100).toFixed(1)}%`);
    assert.ok(match >= 0.9, `2D frame mismatch (${(match * 100).toFixed(1)}%)`);
  } finally {
    await rm(png, { force: true });
  }
});
