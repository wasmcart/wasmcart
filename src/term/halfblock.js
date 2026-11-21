/*
 * wasmcart's built-in terminal renderer (--symbols halfblock): one '▀' per
 * cell, the nearest pixel of the cell's top half as the foreground colour and
 * of its bottom half as the background, in 24-bit colour. No chafa, no
 * worker: the fastest mode, and an exact picture of the pixels it samples.
 */

/**
 * @param {Uint8Array} rgba top-down RGBA bytes
 * @returns {string} `rows` lines of ANSI, joined by '\n'
 */
export function renderHalfblock(rgba, width, height, cols, rows) {
  const out = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    let lastFg = -1, lastBg = -1;
    const syT = Math.floor((ry * 2 * height) / (rows * 2));
    const syB = Math.floor(((ry * 2 + 1) * height) / (rows * 2));
    for (let cx = 0; cx < cols; cx++) {
      const sx = Math.floor((cx * width) / cols);
      const t = (syT * width + sx) * 4, b = (syB * width + sx) * 4;
      const fg = (rgba[t] << 16) | (rgba[t + 1] << 8) | rgba[t + 2];
      const bg = (rgba[b] << 16) | (rgba[b + 1] << 8) | rgba[b + 2];
      if (fg !== lastFg) { line += `\x1b[38;2;${rgba[t]};${rgba[t + 1]};${rgba[t + 2]}m`; lastFg = fg; }
      if (bg !== lastBg) { line += `\x1b[48;2;${rgba[b]};${rgba[b + 1]};${rgba[b + 2]}m`; lastBg = bg; }
      line += '▀';
    }
    out.push(line + '\x1b[0m');
  }
  return out.join('\n');
}
