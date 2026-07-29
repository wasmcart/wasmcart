/*
 * yieldcart — loop-inversion (asyncify) fixture cart.
 *
 * Models a ported engine that owns its main loop: wc_render() never returns
 * on its own, it runs an infinite loop and calls wc_frame_yield() once per
 * iteration. The host unwinds the whole engine stack out of wc_render and
 * rewinds back to the same point next frame.
 *
 * `counter` increments once per loop iteration, so a working host shows it
 * advancing by exactly 1 per runFrame(). A host that re-entered wc_render from
 * the top each frame would reset the engine state instead.
 *
 * Rebuild (emcc + the wasmcart repo checkout for wc_cart.h):
 *   emcc yieldcart.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s ASYNCIFY=1 -s ASYNCIFY_IMPORTS=wc_frame_yield \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state","_wc_yield_buffer"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o yieldcart.wasm
 *   npx wasmcart-pack --wasm yieldcart.wasm --name yieldcart -o yieldcart.wasc
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH  32
#define HEIGHT 32

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;

static uint32_t counter;
static uint32_t entered_render; /* how many times wc_render was entered fresh */

WC_DEBUG_FIELDS(
    WC_DBG("counter", counter,        WC_DBG_U32),
    WC_DBG("entered", entered_render, WC_DBG_U32)
)

/* The asyncify unwind stack. The host reads this descriptor via
   wc_yield_buffer(): a {current, end} pair followed by the stack area. */
static uint8_t yield_stack[4096];
static uint32_t yield_desc[2];

/* wc_frame_yield now comes from wasmcart.h */

__attribute__((export_name("wc_yield_buffer")))
uint32_t wc_yield_buffer(void) {
    yield_desc[0] = (uint32_t)yield_stack;
    yield_desc[1] = (uint32_t)yield_stack + sizeof(yield_stack);
    return (uint32_t)yield_desc;
}

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = (uint32_t)framebuffer;
    info.audio_ptr = 0;
    info.audio_cap = 0;
    info.audio_write_ptr = 0;
    info.input_ptr = (uint32_t)pads;
    info.save_ptr = 0;
    info.save_size = 0;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    info.flags = WC_FLAG_DEBUG;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    counter = 0;
    entered_render = 0;
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    /* A real engine's main loop: this never returns. Reaching the top of this
       function more than once means the host restarted the engine rather than
       resuming it. */
    entered_render++;
    for (;;) {
        counter++;
        for (int i = 0; i < WIDTH * HEIGHT; i++) {
            framebuffer[i] = 0x00100000u + counter;
        }
        wc_frame_yield();
    }
}
