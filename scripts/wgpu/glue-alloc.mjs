// Routes every allocation the generated WebGPU glue makes in cart memory
// through the host's cart allocator (the cart's wc_alloc/wc_free exports;
// src/cartMemory.js, SPEC.md "Cart memory the host writes").
//
// Emscripten's glue allocates in three ways, all of which reach into the cart:
//   - _malloc / _free: adapter info strings, feature lists, compilation info
//     (the cart's webgpu.cpp releases these with free());
//   - _memalign(16, n) / _free: mapped buffer ranges, freed at unmap;
//   - stackSave / stackAlloc / stackRestore: strings and small structs passed
//     to a callback (error messages, device-lost reasons), released when the
//     callback returns.
// Each becomes a call on the Module object, which src/wgpu/host.js fills in
// per cart: wcAlloc(size, align) / wcFree(ptr), and a scope stack for the
// stack helpers (wcScopeOpen / wcScopeAlloc / wcScopeClose), so a stack
// allocation is a heap allocation freed at the matching restore.
//
// The edit is exact: each line must appear once, or the glue changed shape and
// this throws rather than leaving an allocation on the old path.

const SWAPS = [
  ['  var stackSave = () => _emscripten_stack_get_current();\n',
    "  var stackSave = () => Module['wcScopeOpen']();\n"],
  ['  var stackRestore = (val) => __emscripten_stack_restore(val);\n',
    "  var stackRestore = (val) => Module['wcScopeClose'](val);\n"],
  ['  var stackAlloc = (sz) => __emscripten_stack_alloc(sz);\n',
    "  var stackAlloc = (sz) => Module['wcScopeAlloc'](sz);\n"],
  ["var _free = wasmExports['free']\n",
    "var _free = (ptr) => Module['wcFree'](ptr);\n"],
  ["var _malloc = wasmExports['malloc']\n",
    "var _malloc = (size) => Module['wcAlloc'](size, 16);\n"],
  ["var _memalign = wasmExports['memalign']\n",
    "var _memalign = (align, size) => Module['wcAlloc'](size, align);\n"],
  // A refused allocation inside an async callback has no caller to throw to;
  // the host keeps it and stops the cart at its next frame instead of the
  // glue rethrowing it into a promise nobody awaits.
  ['        return EXITSTATUS;\n      }\n      quit_(1, e);\n',
    "        return EXITSTATUS;\n      }\n      if (Module['wcAsyncError']?.(e)) return;\n      quit_(1, e);\n"],
  ["var __emscripten_stack_restore = wasmExports['_emscripten_stack_restore']\n", ''],
  ["var __emscripten_stack_alloc = wasmExports['_emscripten_stack_alloc']\n", ''],
  ["var _emscripten_stack_get_current = wasmExports['emscripten_stack_get_current']\n", ''],
];

const GONE = /wasmExports\['(malloc|free|memalign|_emscripten_stack_alloc|_emscripten_stack_restore|emscripten_stack_get_current)'\]|__emscripten_stack_(alloc|restore)\(|_emscripten_stack_get_current\(/;

/** Rewrite generated glue so it allocates through the host's cart allocator. */
export function routeGlueAllocation(js) {
  for (const [from, to] of SWAPS) {
    const n = js.split(from).length - 1;
    if (n !== 1) throw new Error(`generated glue changed shape: expected one ${JSON.stringify(from.trim())}, found ${n}`);
    js = js.replace(from, () => to);
  }
  const left = js.match(GONE);
  if (left) throw new Error(`generated glue still allocates in the cart outside wc_alloc: ${left[0]}`);
  return js;
}

/** The cart exports the glue needs besides the emwgpu* callbacks. */
export const ALLOCATOR_EXPORTS = ['wc_alloc', 'wc_free'];
