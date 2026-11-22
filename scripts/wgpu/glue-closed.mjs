// No glue callback reaches the cart once its host has destroyed the session.
//
// Every async WebGPU result the glue hands the cart (mapAsync,
// onSubmittedWorkDone, popErrorScope, the async pipeline creations,
// getCompilationInfo, requestAdapter/requestDevice, device loss) runs through
// Emscripten's callUserCallback. Destroying the device settles the ones still
// pending (a pending mapAsync rejects with an AbortError), and their callbacks
// then allocated in, and called into, a cart whose host had already let go of
// its memory: in a browser that threw "Cannot read properties of null
// (reading 'buffer')" from the cart allocator into a promise nobody awaits,
// every time a page left a WebGPU cart with a frame's readback in flight.
// src/wgpu/host.js sets Module.wcClosed at destroy(); from then on such a
// callback is dropped before it touches the cart. While the session is open
// nothing changes: errors still go to handleException as before.
//
// The edit is exact: the guard must appear once, or the glue changed shape and
// this throws.

const FROM = '  var callUserCallback = (func) => {\n      if (ABORT) {\n        return;\n      }\n';
const TO = "  var callUserCallback = (func) => {\n      // wasmcart: dropped once the host destroyed the session (scripts/wgpu/glue-closed.mjs).\n      if (ABORT || Module['wcClosed']) {\n        return;\n      }\n";

/** Rewrite generated glue so its async callbacks stop at the host's destroy(). */
export function gateClosedCallbacks(js) {
  const n = js.split(FROM).length - 1;
  if (n !== 1) throw new Error(`generated glue changed shape: expected one callUserCallback ABORT guard, found ${n}`);
  return js.replace(FROM, () => TO);
}
