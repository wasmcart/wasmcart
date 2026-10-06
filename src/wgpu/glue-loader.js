// Loads the generated WebGPU glue on first use, so hosts running GL and 2D
// carts never parse it.
let loading = null;
export default function loadGlue() {
  loading ??= Promise.all([
    import('./emdawnwebgpu-glue.mjs'),
    import('./emdawnwebgpu-glue-manifest.js'),
  ]).then(([glue, manifest]) => ({ factory: glue.default, manifest: manifest.default }));
  return loading;
}
