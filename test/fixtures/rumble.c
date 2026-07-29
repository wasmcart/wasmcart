/*
 * rumble — rumble ABI fixture cart.
 * Exercises wc_pad_has_rumble / wc_pad_rumble / wc_pad_rumble_stop, including
 * the host-side clamping of out-of-range magnitudes and over-long durations.
 *
 * Rebuild (emcc + the wasmcart repo checkout for wc_cart.h):
 *   emcc rumble.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o rumble.wasm
 *   npx wasmcart-pack --wasm rumble.wasm --name rumble -o rumble.wasc
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH  64
#define HEIGHT 64

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;

static uint32_t frame_n;
static uint32_t has_rumble;

WC_DEBUG_FIELDS(
    WC_DBG("frame_n",    frame_n,    WC_DBG_U32),
    WC_DBG("has_rumble", has_rumble, WC_DBG_U32)
)

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
    has_rumble = wc_pad_has_rumble(0);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    frame_n++;

    /* frame 1: a normal effect */
    if (frame_n == 1) wc_pad_rumble(0, 0.5f, 0.25f, 200);

    /* frame 2: out-of-range magnitudes and an over-long duration. The host
       clamps to 0..1 and WC_RUMBLE_MAX_MS rather than rejecting, so this must
       not fault and must not pin the motors. */
    if (frame_n == 2) wc_pad_rumble(0, 99.0f, -5.0f, 999999);

    /* frame 3: an out-of-range pad slot, which the host must ignore. */
    if (frame_n == 3) wc_pad_rumble(99, 1.0f, 1.0f, 100);

    /* frame 4: early cancel */
    if (frame_n == 4) wc_pad_rumble_stop(0);

    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = 0x00202020;
}
