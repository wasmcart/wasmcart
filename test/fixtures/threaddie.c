/* A threaded cart whose thread dies right after it is spawned (it traps), for
 * the host's thread-death error (CartHost._threadDied): the cart's pool would
 * be a worker short, so the host stops the cart rather than log and go on.
 *
 *   clang --target=wasm32 -nostdlib -O2 -matomics -mbulk-memory -I../../include \
 *     -Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=1048576 \
 *     -Wl,--export=wasi_thread_start threaddie.c -o cart.wasm
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH 16
#define HEIGHT 16

__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t thread_spawn(void *arg);

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static int32_t spawned, frames;

WC_DEBUG_FIELDS(
    WC_DBG("spawned", spawned, WC_DBG_I32),
    WC_DBG("frames", frames, WC_DBG_I32)
)

/* the thread traps at once: no stack needed */
void wasi_thread_start(int32_t tid, void *arg) {
    (void)tid, (void)arg;
    __builtin_trap();
}

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = (uint32_t)framebuffer;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.flags = WC_FLAG_DEBUG;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) { spawned = thread_spawn(0); }

__attribute__((export_name("wc_render")))
void wc_render(void) { frames++; }
