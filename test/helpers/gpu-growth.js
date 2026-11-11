// GPU-memory growth checks for the plateau test (test/wgpu-claim.test.js).
//
// Driver and Dawn pools finish growing at different frames on different GPUs
// (anywhere from frame ~750 to well past the half-way mark), so the check is a
// rate, not a level: the least-squares slope of memory against frame over the
// last 40% of the samples. A leak is ~1.3 MiB a frame; a late pool step of
// 70 MiB across 2400 frames is ~0.03.

/** Slope (MiB per frame) above which memory counts as still growing. */
export const MAX_SLOPE_MIB_PER_FRAME = 0.1;
/** A real leak ends thousands of MiB past the plateau; this is far above any pool. */
export const MAX_LAST_OVER_LEVEL_MIB = 256;

/**
 * Least-squares slope of `mib` against `frame` over the last `fraction` of the samples.
 * @param {{frame: number, mib: number}[]} samples - in frame order
 * @param {number} [fraction]
 * @returns {number} MiB per frame
 */
export function tailSlope(samples, fraction = 0.4) {
  const tail = samples.slice(samples.length - Math.max(2, Math.ceil(samples.length * fraction)));
  const n = tail.length;
  const mx = tail.reduce((a, s) => a + s.frame, 0) / n;
  const my = tail.reduce((a, s) => a + s.mib, 0) / n;
  let sxy = 0, sxx = 0;
  for (const s of tail) { sxy += (s.frame - mx) * (s.mib - my); sxx += (s.frame - mx) ** 2; }
  return sxy / sxx;
}

/**
 * The plateau verdict for a run: null when memory levelled off, else why not.
 * @param {{frame: number, mib: number}[]} samples - in frame order
 * @returns {string|null}
 */
export function plateauProblem(samples) {
  const slope = tailSlope(samples);
  if (slope > MAX_SLOPE_MIB_PER_FRAME) {
    return `GPU memory is still growing at ${slope.toFixed(3)} MiB per frame over the last 40% of the run (limit ${MAX_SLOPE_MIB_PER_FRAME})`;
  }
  const half = samples.filter(s => s.frame <= samples.at(-1).frame / 2);
  const level = Math.max(...half.map(s => s.mib)), last = samples.at(-1).mib;
  if (last - level >= MAX_LAST_OVER_LEVEL_MIB) return `GPU memory ${level.toFixed(0)} -> ${last.toFixed(0)} MiB`;
  return null;
}

/** The rule this replaced: peak of the second half within 64 MiB of the first half's high-water mark. */
export function oldRuleProblem(samples) {
  const end = samples.at(-1).frame;
  const half = samples.filter(s => s.frame <= end / 2), rest = samples.filter(s => s.frame > end / 2);
  const level = Math.max(...half.map(s => s.mib)), peak = Math.max(...rest.map(s => s.mib));
  return peak - level < 64 ? null : `peak ${peak.toFixed(0)} vs level ${level.toFixed(0)}`;
}
