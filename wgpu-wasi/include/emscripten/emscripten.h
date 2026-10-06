/* emscripten.h for wasi-sdk builds of Dawn's emdawnwebgpu webgpu.cpp.
 * The library uses one Emscripten function, emscripten_has_asyncify(), which
 * the host's WebGPU glue provides as an import (it returns 0: no Asyncify). */
#pragma once
#ifdef __cplusplus
extern "C" {
#endif
__attribute__((import_module("env"), import_name("emscripten_has_asyncify")))
int emscripten_has_asyncify(void);
#ifdef __cplusplus
}
#endif
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
