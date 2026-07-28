/**
 * Aspect-preserving fit for scaling a cart's frame into a resizable window.
 *
 * A cart declares its resolution and that declaration is an authorial choice
 * about SHAPE, not just size: a 480x600 game is portrait on purpose. So the
 * window may be resized freely, but the frame is never stretched to match it.
 * The largest rect with the cart's aspect ratio is centred in the window and
 * whatever is left over stays black.
 *
 * The declared size remains the DEFAULT window size; this only governs what
 * happens after the user drags a corner.
 *
 * @param {number} srcW  cart frame width
 * @param {number} srcH  cart frame height
 * @param {number} dstW  window (or drawable) width
 * @param {number} dstH  window (or drawable) height
 * @returns {{x: number, y: number, width: number, height: number}}
 *   integer destination rect, centred; SDL's dstRect rejects non-integers.
 */
export function fitRect(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  // Clamp to >=1: a window dragged to near-zero would otherwise produce a
  // zero-width rect, which SDL rejects outright.
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  return {
    x: Math.round((dstW - width) / 2),
    y: Math.round((dstH - height) / 2),
    width,
    height,
  };
}
