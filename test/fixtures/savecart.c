/*
 * savecart — save-region fixture cart.
 * Writes a counter into its save region every frame and exposes it as a debug
 * field, so a test can prove a save survived an exit path and was reloaded.
 *
 * Rebuild (emcc + the wasmcart repo checkout for wc_cart.h):
 *   emcc savecart.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o savecart.wasm
 *   npx wasmcart-pack --wasm savecart.wasm --name savecart -o savecart.wasc
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

/* The save blob: a magic word plus a counter. */
static uint32_t save_blob[2];

static uint32_t loaded_counter;

WC_DEBUG_FIELDS(
    WC_DBG("loaded",  loaded_counter, WC_DBG_U32),
    WC_DBG("counter", save_blob[1],   WC_DBG_U32)
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
    info.save_ptr = (uint32_t)save_blob;
    info.save_size = sizeof(save_blob);
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    info.flags = WC_FLAG_DEBUG;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    /* The host has already copied any existing save into save_blob. */
    if (save_blob[0] == 0x5A5EDA7A) {
        loaded_counter = save_blob[1];
    } else {
        save_blob[0] = 0x5A5EDA7A;
        save_blob[1] = 0;
        loaded_counter = 0;
    }
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    save_blob[1]++;
    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = 0x00303030;
}
