/* What a wasi-sdk WebGPU cart needs beyond the port's C++ half. The host's
 * WebGPU glue places adapter info, feature lists, mapped buffer ranges and
 * callback strings in the cart's memory, allocating them with the cart's
 * wc_alloc/wc_free exports (SPEC.md, "Cart memory the host writes"). This
 * file makes sure every cart built with the kit has them: wasmcart.h's weak
 * pair over aligned_alloc/free, which a cart's own definitions override.
 * (webgpu.cpp releases some of those blocks with free(), so a replacement
 * must stay free()-compatible.)
 *
 * Emscripten's stack helpers and memalign, which the glue used to call back
 * into, are no longer needed. */
#include "../include/wasmcart.h"
