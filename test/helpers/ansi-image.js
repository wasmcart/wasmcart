// Decode the terminal player's ANSI output back into pixels, for tests and for
// looking at a terminal frame as an image. Glyphs are drawn from 8x8
// coverage masks (below), so every symbol class the player
// emits (ASCII, blocks, sextants, octants, braille) comes back close to the
// coverage chafa matched it with.
import { readFileSync } from 'node:fs';

const ANSI16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function xterm(n) {
  if (n < 16) return ANSI16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v]; }
  const c = [0, 95, 135, 175, 215, 255], i = n - 16;
  return [c[Math.floor(i / 36)], c[Math.floor(i / 6) % 6], c[i % 6]];
}
const DEFAULT_FG = [229, 229, 229], DEFAULT_BG = [0, 0, 0];

/** The last complete frame in a pty capture: the text between the last two
 *  cursor-home sequences, without its status line. */
export function lastFrame(capture) {
  const parts = capture.replace(/\r/g, '').split('\x1b[H');
  if (parts.length < 3) return null;
  const lines = parts[parts.length - 2].split('\n');
  return lines.slice(0, -1).join('\n');
}

/** Parse ANSI rows into cells: [{ch, fg:[r,g,b], bg:[r,g,b]}][] */
export function parseCells(ansi) {
  const rows = [];
  for (const line of ansi.split('\n')) {
    const row = [];
    let fg = DEFAULT_FG, bg = DEFAULT_BG, inverse = false, last = null;
    const re = /\x1b\[([0-9;?]*)([A-Za-z])|([\s\S])/gu;
    let m;
    const push = (ch) => { const c = inverse ? { ch, fg: bg, bg: fg } : { ch, fg, bg }; row.push(c); last = c; };
    while ((m = re.exec(line))) {
      if (m[3] !== undefined) { push(m[3]); continue; }
      const p = m[1] === '' ? [0] : m[1].split(';').map(Number);
      if (m[2] === 'b') { for (let k = 0; k < (p[0] || 1) && last; k++) row.push({ ...last }); continue; }
      if (m[2] === 'C') { for (let k = 0; k < (p[0] || 1); k++) push(' '); continue; }
      if (m[2] !== 'm') continue;
      for (let i = 0; i < p.length; i++) {
        const v = p[i];
        if (v === 0) { fg = DEFAULT_FG; bg = DEFAULT_BG; inverse = false; }
        else if (v === 7) inverse = true;
        else if (v === 27) inverse = false;
        else if (v === 39) fg = DEFAULT_FG;
        else if (v === 49) bg = DEFAULT_BG;
        else if ((v === 38 || v === 48) && p[i + 1] === 2) { const c = p.slice(i + 2, i + 5); if (v === 38) fg = c; else bg = c; i += 4; }
        else if ((v === 38 || v === 48) && p[i + 1] === 5) { const c = xterm(p[i + 2]); if (v === 38) fg = c; else bg = c; i += 2; }
        else if (v >= 30 && v <= 37) fg = ANSI16[v - 30];
        else if (v >= 90 && v <= 97) fg = ANSI16[v - 82];
        else if (v >= 40 && v <= 47) bg = ANSI16[v - 40];
        else if (v >= 100 && v <= 107) bg = ANSI16[v - 92];
      }
    }
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

// ── glyph coverage: 8x8, 0..1 per pixel ──────────────────────────────
// ASCII from font8x8_basic (testcart/font8x8.h, public domain); block
// elements, quadrants, sextants, octants, braille and shades by their
// geometry; anything else (box drawing, matrix katakana) as half coverage.
const FONT = (() => {
  const src = readFileSync(new URL('../../testcart/font8x8.h', import.meta.url), 'utf8');
  return [...src.matchAll(/\{((?:\s*0x[0-9A-Fa-f]{2},?){8})\s*\}/g)].map((m) => m[1].match(/0x[0-9A-Fa-f]{2}/g).map(Number));
})();
const rect = (x0, y0, x1, y1) => { const c = new Float32Array(64); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) c[y * 8 + x] = 1; return c; };
const or = (...cs) => { const c = new Float32Array(64); for (const d of cs) for (let i = 0; i < 64; i++) c[i] = Math.max(c[i], d[i]); return c; };
const flat = (v) => new Float32Array(64).fill(v);
/** a 2-column grid pattern: bit n = cell n in row-major order, rows of 8/rowsN pixels */
const grid = (bits, rowsN) => { const c = new Float32Array(64), rh = 8 / rowsN; for (let n = 0; n < 2 * rowsN; n++) if (bits & (1 << n)) for (let y = Math.round((n >> 1) * rh); y < Math.round(((n >> 1) + 1) * rh); y++) for (let x = (n & 1) * 4; x < (n & 1) * 4 + 4; x++) c[y * 8 + x] = 1; return c; };
const QUAD = { 0x2596: 4, 0x2597: 8, 0x2598: 1, 0x2599: 13, 0x259a: 9, 0x259b: 7, 0x259c: 11, 0x259d: 2, 0x259e: 6, 0x259f: 14 };
// octant patterns encoded outside U+1CD00..1CDE5 (2x4, bit n = octant n+1)
const OCT_ELSEWHERE = new Set([0x00, 0xff, 0x55, 0xaa, 0x0f, 0xf0, 0x05, 0x0a, 0x50, 0xa0, 0x5f, 0xaf, 0xf5, 0xfa, 0xa5, 0x5a, 0x03, 0xc0, 0x3f, 0xfc, 0x01, 0x02, 0x40, 0x80, 0x14, 0x28]);
const OCTANTS = []; for (let p = 0; p < 256; p++) if (!OCT_ELSEWHERE.has(p)) OCTANTS.push(p);
const SUPPLEMENT = { 0x1cea8: 0x01, 0x1ceab: 0x02, 0x1cea3: 0x40, 0x1cea0: 0x80, 0x1fbe6: 0x14, 0x1fbe7: 0x28, 0x1fb82: 0x03, 0x1fb85: 0x3f };
const cache = new Map();
export function glyph(cp) {
  if (cache.has(cp)) return cache.get(cp);
  let c = null;
  if (cp >= 0x20 && cp < 0x80) { const rows = FONT[cp - 0x20]; c = new Float32Array(64); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) c[y * 8 + x] = (rows[y] >> x) & 1; }
  else if (cp === 0x2580) c = rect(0, 0, 8, 4);
  else if (cp >= 0x2581 && cp <= 0x2588) c = rect(0, 8 - (cp - 0x2580), 8, 8);
  else if (cp >= 0x2589 && cp <= 0x258f) c = rect(0, 0, 8 - (cp - 0x2588), 8);
  else if (cp === 0x2590) c = rect(4, 0, 8, 8);
  else if (cp >= 0x2591 && cp <= 0x2593) c = flat((cp - 0x2590) / 4);
  else if (cp === 0x2594) c = rect(0, 0, 8, 1);
  else if (cp === 0x2595) c = rect(7, 0, 8, 8);
  else if (QUAD[cp] !== undefined) c = grid(QUAD[cp], 2);
  else if (cp >= 0x1fb00 && cp <= 0x1fb3b) { let v = cp - 0x1fb00 + 1; if (v >= 21) v++; if (v >= 42) v++; c = grid(v, 3); }
  else if (cp >= 0x1cd00 && cp <= 0x1cde5) c = grid(OCTANTS[cp - 0x1cd00], 4);
  else if (SUPPLEMENT[cp] !== undefined) c = grid(SUPPLEMENT[cp], 4);
  else if (cp >= 0x2800 && cp <= 0x28ff) {
    // braille dots: bits 0-2 left column rows 0-2, 3-5 right column, 6 left row 3, 7 right row 3
    const pos = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]], v = cp - 0x2800;
    c = or(...pos.filter((_, i) => v & (1 << i)).map(([x, y]) => rect(x * 4 + 1, y * 2, x * 4 + 3, y * 2 + 2)), new Float32Array(64));
  }
  else c = flat(0.5);
  cache.set(cp, c);
  return c;
}

/**
 * Cells to an RGB image, `cw` x `ch` pixels per cell (8x16 looks like a
 * terminal). A glyph chafa has no bitmap for is drawn as its background.
 * @returns {{width:number, height:number, rgb:Uint8Array}}
 */
export function cellsToImage(cells, cw = 8, ch = 16) {
  const cols = Math.max(...cells.map((r) => r.length)), rows = cells.length;
  const width = cols * cw, height = rows * ch, rgb = new Uint8Array(width * height * 3);
  cells.forEach((row, cy) => row.forEach((c, cx) => {
    const cov = c.ch === ' ' ? null : glyph(c.ch.codePointAt(0));
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const a = cov ? cov[Math.floor((y * 8) / ch) * 8 + Math.floor((x * 8) / cw)] : 0;
      const o = ((cy * ch + y) * width + cx * cw + x) * 3;
      for (let k = 0; k < 3; k++) rgb[o + k] = Math.round(c.fg[k] * a + c.bg[k] * (1 - a));
    }
  }));
  return { width, height, rgb };
}
