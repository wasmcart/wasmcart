/*
 * lifecycle — lifecycle-callback fixture cart.
 * Counts each lifecycle event and exposes the tallies as debug fields, so a
 * test can prove delivery and ordering rather than infer it.
 *
 * Rebuild (emcc + the wasmcart repo checkout for wc_cart.h):
 *   emcc lifecycle.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state","_wc_on_suspend","_wc_on_resume","_wc_on_focus_lost","_wc_on_focus_gained"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o lifecycle.wasm
 *   npx wasmcart-pack --wasm lifecycle.wasm --name lifecycle -o lifecycle.wasc
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

static uint32_t n_suspend, n_resume, n_focus_lost, n_focus_gained;
static uint32_t frames;
/* Sequence code: each event appends its digit, so ordering is verifiable.
   1=suspend 2=resume 3=focus_lost 4=focus_gained */
static uint32_t sequence;

WC_DEBUG_FIELDS(
    WC_DBG("suspend",      n_suspend,      WC_DBG_U32),
    WC_DBG("resume",       n_resume,       WC_DBG_U32),
    WC_DBG("focus_lost",   n_focus_lost,   WC_DBG_U32),
    WC_DBG("focus_gained", n_focus_gained, WC_DBG_U32),
    WC_DBG("frames",       frames,         WC_DBG_U32),
    WC_DBG("sequence",     sequence,       WC_DBG_U32)
)

static void note(uint32_t digit) {
    /* keep the low digits; plenty for a test */
    if (sequence < 100000000u) sequence = sequence * 10u + digit;
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
void wc_init(void) { }

__attribute__((export_name("wc_on_suspend")))
void wc_on_suspend(void) { n_suspend++; note(1); }

__attribute__((export_name("wc_on_resume")))
void wc_on_resume(void) { n_resume++; note(2); }

__attribute__((export_name("wc_on_focus_lost")))
void wc_on_focus_lost(void) { n_focus_lost++; note(3); }

__attribute__((export_name("wc_on_focus_gained")))
void wc_on_focus_gained(void) { n_focus_gained++; note(4); }

__attribute__((export_name("wc_render")))
void wc_render(void) {
    frames++;
    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = 0x00404040;
}
