/*
 * gpuapi - a 2D cart that declares a gpu_api value it does not back.
 * Hosts must refuse it at load (SPEC.md, "WebGPU"), not guess.
 *
 *   -DGPU_API=2  gpuapi2.wasc: claims WebGPU, imports no WebGPU functions
 *   -DGPU_API=3  gpuapi3.wasc: claims the reserved Vulkan value
 *
 * Build: emcc gpuapi.c -O2 -I../../include -DGPU_API=N -sSTANDALONE_WASM=1 \
 *   --no-entry -sEXPORTED_FUNCTIONS=_wc_init,_wc_render,_wc_get_info -o gpuapiN.wasm
 */
#include "wasmcart.h"
#include "wc_cart.h"

static uint32_t fb[64 * 64];
static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = 64;
    info.height = 64;
    info.fb_ptr = (uint32_t)fb;
    info.gpu_api = GPU_API;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    return &info;
}

#ifdef FAKE_WGPU
/* -DGPU_API=2 -DFAKE_WGPU  wgpufake.wasc: imports a WebGPU-named function
   no glue provides, as a cart built against a newer emdawnwebgpu would. */
extern int wgpuDeviceDoesNotExistYet(int x);
__attribute__((export_name("wc_init"))) void wc_init(void) { wgpuDeviceDoesNotExistYet(1); }
#else
__attribute__((export_name("wc_init"))) void wc_init(void) {}
#endif
__attribute__((export_name("wc_render"))) void wc_render(void) {}
