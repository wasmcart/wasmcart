/*
 * sjlj — WebAssembly exception-handling conformance fixture.
 *
 * This uses wasi-sdk's native Wasm SjLj implementation, not JavaScript
 * exception emulation. Rebuild with wasi-sdk 33:
 *
 *   $WASI_SDK/bin/clang --target=wasm32-wasip1-threads -pthread \
 *     -mllvm -wasm-enable-sjlj -I../../include -O2 -Wl,--no-entry \
 *     -Wl,--export=wc_get_info -Wl,--export=wc_init \
 *     -Wl,--export=wc_render -Wl,--export=wc_sjlj_result \
 *     -o sjlj.wasm sjlj.c -lsetjmp
 *   node ../../bin/wasmcart-pack.js --wasm sjlj.wasm --name sjlj -o sjlj.wasc
 */
#include <setjmp.h>
#include "wasmcart.h"

#define WIDTH  8
#define HEIGHT 8

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;
static jmp_buf jump_target;
static int sjlj_result;

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = (uint32_t)framebuffer;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    return &info;
}

static void jump(void) {
    longjmp(jump_target, 42);
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    sjlj_result = setjmp(jump_target);
    if (sjlj_result == 0) jump();
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    framebuffer[0] = sjlj_result == 42 ? 0x0000ff00u : 0x00ff0000u;
}

__attribute__((export_name("wc_sjlj_result")))
int wc_sjlj_result(void) {
    return sjlj_result;
}
