// Dynamic bind-group offsets as a plain array, not (HEAPU32, start, count).
//
// The generated glue calls setBindGroup(index, group, HEAPU32, start, count),
// the Uint32Array overload. Dawn's Node binding tries the sequence overload
// first, fails on the typed array, builds the failure's error strings, then
// converts again for the second overload: about 14% of a WebGPU cart's
// main-thread CPU in measurements (pugball, rider). An array of the offsets
// matches the first overload, and a browser accepts it as well. One array per
// offset count is reused: setBindGroup copies the offsets before it returns.
//
// The edit is exact: the call must appear once per encoder kind (compute
// pass, render bundle, render pass), or the glue changed shape and this throws.

const CALL = /(\w+)\.setBindGroup\(groupIndex, group, HEAPU32, \(\(dynamicOffsetsPtr\)>>2\), dynamicOffsetCount\);/g;
const ANCHOR = '  var _wgpuComputePassEncoderSetBindGroup = ';
const HELPER = `  // wasmcart: dynamic offsets as a reused array (scripts/wgpu/glue-offsets.mjs).
  var wcOffsetArrays = [];
  var wcDynamicOffsets = (ptr, count) => {
      var a = wcOffsetArrays[count] ??= new Array(count);
      var p = ptr >>> 2;
      for (var i = 0; i < count; i++) a[i] = HEAPU32[p + i];
      return a;
    };

`;

/** Rewrite generated glue so setBindGroup gets its dynamic offsets as an array. */
export function arrayDynamicOffsets(js) {
  const n = js.match(CALL)?.length || 0;
  if (n !== 3) throw new Error(`generated glue changed shape: expected 3 setBindGroup calls with HEAPU32 offsets, found ${n}`);
  if (js.split(ANCHOR).length !== 2) throw new Error('generated glue changed shape: cannot find _wgpuComputePassEncoderSetBindGroup');
  js = js.replace(CALL, (_, recv) => `${recv}.setBindGroup(groupIndex, group, wcDynamicOffsets(dynamicOffsetsPtr, dynamicOffsetCount));`);
  return js.replace(ANCHOR, () => HELPER + ANCHOR);
}
