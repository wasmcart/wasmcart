/*
 * Terminal player options, shared by the CLI, the chafa worker and the tests.
 *
 * The names and values match retroemu's terminal player (--symbols, --colors,
 * --fg-only, --dither, --contrast, --term-fps, --frame-skip), so the same
 * flags work in both tools. `halfblock` is wasmcart's own renderer (no chafa):
 * one '▀' per cell with the nearest pixel's colours as foreground (top) and
 * background (bottom).
 */

// chafa symbol tags (chafa-symbol-map.h)
export const CHAFA_SYMBOL_TAG = {
  SPACE: 0x1, SOLID: 0x2, STIPPLE: 0x4, BLOCK: 0x8, BORDER: 0x10,
  QUAD: 0x80, VHALF: 0x200, BRAILLE: 0x800, ASCII: 0x4000,
  SEXTANT: 0x400000, OCTANT: 0x4000000,
};

const T = CHAFA_SYMBOL_TAG;
/** chafa symbol classes per --symbols value (retroemu's table). */
export const CHAFA_SYMBOL_SETS = {
  block: T.SPACE | T.BLOCK | T.BORDER,
  half: T.SPACE | T.VHALF,
  ascii: T.SPACE | T.ASCII,
  'ascii+block': T.SPACE | T.BLOCK | T.ASCII,
  solid: T.SPACE,
  stipple: T.SPACE | T.SOLID | T.STIPPLE,
  quad: T.SPACE | T.QUAD,
  sextant: T.SPACE | T.SEXTANT,
  octant: T.SPACE | T.OCTANT,
  braille: T.BRAILLE,
  // matrix: custom glyphs, built in the renderer
};

export const SYMBOLS = [...Object.keys(CHAFA_SYMBOL_SETS), 'matrix', 'halfblock'];
export const COLORS = ['true', '256', '16', '2'];

/**
 * The default: ASCII glyphs, foreground colour only, on a black background.
 * It reads as text art in any terminal and font, needs no block or braille
 * glyphs, and the black background keeps a terminal's own theme out of the
 * picture.
 */
export const DEFAULT_TERM = Object.freeze({
  symbols: 'ascii', colors: 'true', fgOnly: true, dither: false, contrast: 1.0, fps: 30,
});

/**
 * Validate a terminal option set; throws with the accepted values.
 * @param {{symbols:string, colors:string, contrast:number, fps:number}} o
 */
export function checkTermOptions(o) {
  if (!SYMBOLS.includes(o.symbols)) throw new Error(`--symbols ${o.symbols}: expected one of ${SYMBOLS.join(', ')}`);
  if (!COLORS.includes(o.colors)) throw new Error(`--colors ${o.colors}: expected one of ${COLORS.join(', ')}`);
  if (!(o.contrast > 0)) throw new Error(`--contrast ${o.contrast}: expected a number above 0 (1.0 = unchanged)`);
  if (!(o.fps >= 1 && o.fps <= 60)) throw new Error(`--term-fps ${o.fps}: expected 1 to 60`);
}

/**
 * The cell grid a frame fills in a terminal, keeping its aspect ratio
 * (a terminal cell is about twice as tall as it is wide). `cols` forces the
 * width (--scale); the height is capped at `maxRows`.
 */
export function fitCells(width, height, maxCols, maxRows, cols = 0) {
  const aspect = width / height;
  if (cols > 0) return { cols, rows: Math.max(1, Math.min(maxRows, Math.round(cols / aspect / 2))) };
  const rowsForWidth = maxCols / (aspect * 2);
  if (rowsForWidth <= maxRows) return { cols: maxCols, rows: Math.max(1, Math.floor(rowsForWidth)) };
  return { cols: Math.max(1, Math.floor(maxRows * aspect * 2)), rows: maxRows };
}

/** Contrast around mid-grey (retroemu's formula), in place on RGBA bytes. */
export function applyContrast(rgba, contrast) {
  if (contrast === 1) return rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = (rgba[i + c] - 128) * contrast + 128;
      rgba[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return rgba;
}
