// Hooks the generated WebGPU glue's object table, so the host can destroy the
// textures and buffers a cart released once nothing still uses them
// (src/wgpu/release.js; docs/webgpu.md, "GPU memory").
//
// The glue keeps every WebGPU object the cart can name in one table,
// WebGPU.Internals.jsObjects, keyed by the handle's address in cart memory.
// Three places touch it, and each gets a call on the Module object, which
// src/wgpu/host.js fills in per cart:
//   - every insertion (jsObjectInsert, and each importJs<Type>):
//     wcGpuMade(object);
//   - the one lookup, WebGPU.getJsObject: wcGpuUse(object), which returns it;
//   - _emwgpuDelete, which the cart's webgpu.cpp calls when the last
//     reference to a handle is released: wcGpuRelease(object), after the
//     entry is gone.
//
// The edit is exact: the lookup and the delete must appear once, every write
// to the table must be one of the insertions, and nothing else may read the
// table, or the glue changed shape and this throws rather than letting an
// object escape the tracking (an untracked holder could see its texture
// destroyed under it).

const LOOKUP = '        return WebGPU.Internals.jsObjects[ptr];\n';
const DELETE = '      delete WebGPU.Internals.jsObjects[ptr];\n';
const INSERT = /^( *)WebGPU\.Internals\.jsObjects\[ptr\] = (obj|jsObject);\n/gm;

/** Rewrite generated glue so the host sees every object made, used and released. */
export function hookGlueObjects(js) {
  for (const s of [LOOKUP, DELETE]) {
    const n = js.split(s).length - 1;
    if (n !== 1) throw new Error(`generated glue changed shape: expected one ${JSON.stringify(s.trim())}, found ${n}`);
  }
  const inserts = js.match(INSERT)?.length || 0;
  const touches = js.split('WebGPU.Internals.jsObjects[').length - 1;
  if (!inserts || touches !== inserts + 2) {
    throw new Error(`generated glue changed shape: ${touches} uses of the object table, expected ${inserts} insertions, one lookup and one delete`);
  }
  js = js.replace(INSERT, (_, indent, v) => `${indent}WebGPU.Internals.jsObjects[ptr] = ${v};\n${indent}Module['wcGpuMade'](${v});\n`);
  js = js.replace(LOOKUP, () => "        return Module['wcGpuUse'](WebGPU.Internals.jsObjects[ptr]);\n");
  js = js.replace(DELETE, () => "      var obj = WebGPU.Internals.jsObjects[ptr];\n      delete WebGPU.Internals.jsObjects[ptr];\n      Module['wcGpuRelease'](obj);\n");
  return js;
}
