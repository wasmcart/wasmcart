/*
 * The chafa renderer: RGBA frame in, ANSI text out, through chafa-wasm (the
 * upstream hectorm/chafa-wasm, LGPL-3.0). Runs in the terminal player's worker
 * (chafaWorker.js); the logic is here so it is one module either way.
 *
 * It follows retroemu's terminal renderer (src/video/videoWorker.js there):
 * the same symbol classes, colour modes, Floyd-Steinberg dither, contrast and
 * `matrix` glyphs, and --fg-only builds its own ANSI from the canvas cells
 * (fgOnlyAnsi below, which also keeps filled areas that retroemu's drops).
 */
import { CHAFA_SYMBOL_SETS, applyContrast } from './options.js';

const CANVAS_MODE = { true: 0, 256: 1, 16: 3, 2: 5 }; // TRUECOLOR, INDEXED_256, INDEXED_16, FGBG
const DITHER_DIFFUSION = 2;
const OPTIMIZATION_ALL = 7;

// --fg-only: a flat cell's glyph (see fgOnlyAnsi)
const FLAT = 24;          // fg/bg within this per channel: the cell has no edge
const RAMP = ' .:-=+*#%@'; // ASCII by ink coverage
// A flat cell darker than the blank level stays black. The level follows the
// frame: just above its commonest dark tone (40th percentile of HSV value,
// plus a margin), between 12 and 41, so a game's backdrop reads as black
// whether it is near-black or dark grey, and a dark scene's dim shapes still
// get ink.
const BLANK_MIN = 12, BLANK_MAX = 41, BLANK_MARGIN = 10;
export function blankLevel(rgba) {
  const hist = new Uint32Array(256);
  const n = rgba.length >> 2, step = Math.max(1, Math.floor(n / 16384));
  let count = 0;
  for (let p = 0; p < n; p += step) { const i = p << 2; hist[Math.max(rgba[i], rgba[i + 1], rgba[i + 2])]++; count++; }
  let acc = 0, v = 0;
  for (; v < 255; v++) { acc += hist[v]; if (acc >= count * 0.4) break; }
  return Math.max(BLANK_MIN, Math.min(BLANK_MAX, v + BLANK_MARGIN));
}
const FULL_CELL = { braille: 0x28ff };
/** The ASCII ramp glyph for an HSV value 0-255, given the blank level. */
export function rampGlyph(v, blank) {
  if (v < blank) return 32;
  return RAMP.charCodeAt(1 + Math.min(RAMP.length - 2, Math.floor(((v - blank) / (256 - blank)) * (RAMP.length - 1))));
}

const MATRIX_CHARS = ' ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789█';

// xterm's 16 colours (the palette chafa's INDEXED_16 mode quantises to)
const ANSI16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];

/** Nearest xterm-256 index for an RGB colour (6x6x6 cube or grey ramp). */
export function xterm256(r, g, b) {
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const ci = [q(r), q(g), q(b)];
  const cr = CUBE[ci[0]], cg = CUBE[ci[1]], cb = CUBE[ci[2]];
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const dc = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
  const dg = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return dg < dc ? 232 + grey : 16 + 36 * ci[0] + 6 * ci[1] + ci[2];
}

/** Nearest of the 16 ANSI colours, as its SGR foreground code. */
export function ansi16Fg(r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 16; i++) {
    const c = ANSI16[i];
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best < 8 ? 30 + best : 90 + best - 8;
}

/**
 * @param {object} chafa an initialised chafa-wasm module
 * @returns {(rgba: Uint8Array, width: number, height: number, cols: number, rows: number,
 *            o: {symbols: string, colors: string, fgOnly: boolean, dither: boolean, contrast: number}) => string}
 */
export function createChafaRenderer(chafa) {
  let symbolMap = 0, config = 0, canvas = 0;
  let key = '', symbolsKey = '';
  let pixPtr = 0, pixLen = 0;
  const fgPtr = chafa._malloc(4), bgPtr = chafa._malloc(4);

  function addMatrixGlyphs() {
    const GW = 8, GH = 8, total = GW * GH, size = total * 4;
    const ptr = chafa._malloc(size);
    for (let i = 0; i < MATRIX_CHARS.length; i++) {
      const fill = Math.round((i / (MATRIX_CHARS.length - 1)) * total);
      const order = Array.from({ length: total }, (_, p) => p);
      for (let j = total - 1; j > 0; j--) {
        const k = (((j * 2654435761) + (i * 2246822519)) >>> 0) % (j + 1);
        [order[j], order[k]] = [order[k], order[j]];
      }
      const bmp = new Uint8Array(size);
      for (let f = 0; f < fill; f++) bmp.fill(255, order[f] * 4, order[f] * 4 + 4);
      chafa.HEAPU8.set(bmp, ptr);
      chafa._chafa_symbol_map_add_glyph(symbolMap, MATRIX_CHARS.codePointAt(i), 0, ptr, GW, GH, GW * 4);
    }
    chafa._free(ptr);
  }

  function setup(cols, rows, o) {
    const k = `${cols}x${rows}|${o.symbols}|${o.colors}|${o.dither}|${o.fgOnly}`;
    if (k === key && canvas) return;
    if (o.symbols !== symbolsKey) {
      if (symbolMap) chafa._chafa_symbol_map_unref(symbolMap);
      symbolMap = chafa._chafa_symbol_map_new();
      if (o.symbols === 'matrix') {
        chafa._chafa_symbol_map_add_by_range(symbolMap, 0x20, 0x20);
        chafa._chafa_symbol_map_add_by_range(symbolMap, 0xff66, 0xff9d);
        chafa._chafa_symbol_map_add_by_range(symbolMap, 0x30, 0x39);
        chafa._chafa_symbol_map_add_by_range(symbolMap, 0x2588, 0x2588);
        addMatrixGlyphs();
      } else {
        chafa._chafa_symbol_map_add_by_tags(symbolMap, CHAFA_SYMBOL_SETS[o.symbols]);
      }
      symbolsKey = o.symbols;
    }
    if (canvas) chafa._chafa_canvas_unref(canvas);
    if (config) chafa._chafa_canvas_config_unref(config);
    config = chafa._chafa_canvas_config_new();
    chafa._chafa_canvas_config_set_geometry(config, cols, rows);
    chafa._chafa_canvas_config_set_canvas_mode(config, CANVAS_MODE[o.colors]);
    chafa._chafa_canvas_config_set_symbol_map(config, symbolMap);
    chafa._chafa_canvas_config_set_optimizations(config, OPTIMIZATION_ALL);
    if (o.dither) chafa._chafa_canvas_config_set_dither_mode(config, DITHER_DIFFUSION);
    canvas = chafa._chafa_canvas_new(config);
    key = k;
  }

  /*
   * Foreground only, on black. chafa picks each cell's glyph from the full
   * foreground and background colours (which gives it the shapes of edges and
   * text), and the output keeps one colour per cell:
   *
   * - A flat cell (a space, or fg and bg within FLAT of each other) has no
   *   shape to show, and stripping its background would leave it black, so a
   *   filled area vanished. It is drawn instead: an ASCII set gets a glyph from
   *   a density ramp by the cell's brightness (HSV value, so saturated blue
   *   reads as bright as red), any other set its full-cell glyph.
   * - An edge cell keeps chafa's glyph, inked in the brighter of its two
   *   colours, so a light shape on a dark ground stays light.
   * - On an ASCII set the ink is lifted toward full brightness (colour times
   *   (255/max)^0.5): a glyph covers a fraction of its cell, so a dark colour
   *   on a thin glyph would otherwise disappear into the black. The ramp still
   *   carries the brightness. This keeps dark scenes readable.
   */
  function fgOnlyAnsi(cols, rows, colors, symbols, blank) {
    const H = chafa.HEAPU8;
    const matrix = symbols === 'matrix', ascii = symbols === 'ascii' || symbols === 'ascii+block';
    const full = FULL_CELL[symbols] || 0x2588;
    const lines = [];
    for (let y = 0; y < rows; y++) {
      let line = '\x1b[48;2;0;0;0m';
      let last = -1;
      for (let x = 0; x < cols; x++) {
        let ch = chafa._chafa_canvas_get_char_at(canvas, x, y);
        chafa._chafa_canvas_get_colors_at(canvas, x, y, fgPtr, bgPtr);
        // packed 0xRRGGBB, little-endian in memory
        let b = H[fgPtr], g = H[fgPtr + 1], r = H[fgPtr + 2];
        if (matrix) {
          if (g >= 252 && r === 0 && b === 0) { const w = (((g - 252) / 3) * 255) | 0; r = w; b = w; g = 255; }
        } else {
          const bb = H[bgPtr], bg = H[bgPtr + 1], br = H[bgPtr + 2];
          if (ch === 32 || Math.max(Math.abs(r - br), Math.abs(g - bg), Math.abs(b - bb)) < FLAT) {
            // a space's foreground is arbitrary: its colour is the background
            if (ch === 32) { r = br; g = bg; b = bb; } else { r = (r + br) >> 1; g = (g + bg) >> 1; b = (b + bb) >> 1; }
            ch = ascii ? rampGlyph(Math.max(r, g, b), blank) : (Math.max(r, g, b) < blank ? 32 : full);
          } else if (br * 77 + bg * 150 + bb * 29 > r * 77 + g * 150 + b * 29) {
            r = br; g = bg; b = bb;
          }
          if (ascii) {
            const mx = Math.max(r, g, b);
            if (mx > 0) { const k = Math.sqrt(255 / mx); r = Math.min(255, Math.round(r * k)); g = Math.min(255, Math.round(g * k)); b = Math.min(255, Math.round(b * k)); }
          }
        }
        const c = (r << 16) | (g << 8) | b;
        if (ch !== 32 && c !== last && colors !== '2') {
          if (colors === 'true') line += `\x1b[38;2;${r};${g};${b}m`;
          else if (colors === '256') line += `\x1b[38;5;${xterm256(r, g, b)}m`;
          else line += `\x1b[${ansi16Fg(r, g, b)}m`;
          last = c;
        }
        line += String.fromCodePoint(ch);
      }
      lines.push(line + '\x1b[0m');
    }
    return lines.join('\n');
  }

  function render(rgba, width, height, cols, rows, o) {
    if (o.contrast !== 1) applyContrast(rgba, o.contrast);
    const matrix = o.symbols === 'matrix';
    if (matrix) {
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i + 1] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
        rgba[i] = 0; rgba[i + 2] = 0;
      }
    }
    setup(cols, rows, o);
    const n = width * height * 4;
    if (n > pixLen) { if (pixPtr) chafa._free(pixPtr); pixPtr = chafa._malloc(n); pixLen = n; }
    chafa.HEAPU8.set(rgba.subarray(0, n), pixPtr);
    chafa._chafa_canvas_set_contents_rgba8(canvas, pixPtr, width, height, width * 4);
    if (matrix || o.fgOnly) return fgOnlyAnsi(cols, rows, o.colors, o.symbols, matrix ? 0 : blankLevel(rgba));
    const gs = chafa._chafa_canvas_build_ansi(canvas);
    const sp = chafa._g_string_free_and_steal(gs);
    const ansi = chafa.UTF8ToString(sp);
    chafa._free(sp);
    // one line per row, each ending in a reset, as halfblock's are
    return ansi.split('\n').map((l) => l + '\x1b[0m').join('\n');
  }

  return render;
}

/** Load and initialise chafa-wasm. */
export async function loadChafa() {
  const mod = await import('chafa-wasm');
  let chafa = mod.default || mod;
  if (typeof chafa === 'function') chafa = await chafa();
  return chafa;
}
