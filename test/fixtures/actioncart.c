/*
 * actioncart -- input actions fixture and example (SPEC.md, "Input actions").
 *
 * Declares two action sets and three actions, plays in "driving", and prints
 * its prompts through wc_log whenever wc_input_revision() changes:
 *   "Press [A] to Pedal, [Left Stick] to Steer"
 *
 * Rebuild (emcc + the wasmcart repo checkout for wasmcart.h):
 *   emcc actioncart.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o actioncart.wasm
 *   npx wasmcart-pack --wasm actioncart.wasm --name actioncart -o actioncart.wasc
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

static int32_t set_menu, set_drive, act_confirm, act_pedal, act_steer;
static int32_t bad_kind, dup_pedal;
static int32_t pedal, steer_x1000, steer_ret;
static int32_t pedal_len, steer_len, pedal_glyph, device;
static uint32_t rev_seen, prompts;
static char pedal_label[16];
static char line[96];

WC_DEBUG_FIELDS(
    WC_DBG("set_menu",    set_menu,    WC_DBG_I32),
    WC_DBG("set_drive",   set_drive,   WC_DBG_I32),
    WC_DBG("act_confirm", act_confirm, WC_DBG_I32),
    WC_DBG("act_pedal",   act_pedal,   WC_DBG_I32),
    WC_DBG("act_steer",   act_steer,   WC_DBG_I32),
    WC_DBG("bad_kind",    bad_kind,    WC_DBG_I32),
    WC_DBG("dup_pedal",   dup_pedal,   WC_DBG_I32),
    WC_DBG("pedal",       pedal,       WC_DBG_I32),
    WC_DBG("steer_x1000", steer_x1000, WC_DBG_I32),
    WC_DBG("steer_ret",   steer_ret,   WC_DBG_I32),
    WC_DBG("pedal_len",   pedal_len,   WC_DBG_I32),
    WC_DBG("steer_len",   steer_len,   WC_DBG_I32),
    WC_DBG("pedal_glyph", pedal_glyph, WC_DBG_I32),
    WC_DBG("device",      device,      WC_DBG_I32),
    WC_DBG("rev_seen",    rev_seen,    WC_DBG_U32),
    WC_DBG("prompts",     prompts,     WC_DBG_U32),
    WC_DBG("pedal_label", pedal_label[0], WC_DBG_U32)
)

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = (uint32_t)framebuffer;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    info.flags = WC_FLAG_DEBUG;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    set_menu    = wc_action_set_new("menu");
    set_drive   = wc_action_set_new("driving");
    act_confirm = wc_action_new(set_menu,  WC_ACTION_DIGITAL, WC_IN_A,      "Confirm");
    act_pedal   = wc_action_new(set_drive, WC_ACTION_DIGITAL, WC_IN_A,      "Pedal");
    act_steer   = wc_action_new(set_drive, WC_ACTION_ANALOG,  WC_IN_LSTICK, "Steer");
    bad_kind    = wc_action_new(set_drive, 7, WC_IN_A, "Bad");
    dup_pedal   = wc_action_new(set_drive, WC_ACTION_DIGITAL, WC_IN_A, "Pedal");
    wc_action_set_activate(0, set_drive);
}

static char *put(char *p, const char *s) { while (*s && p < line + sizeof line - 1) *p++ = *s++; return p; }

__attribute__((export_name("wc_render")))
void wc_render(void) {
    pedal = wc_action_digital(0, act_pedal);
    float xy[2];
    steer_ret = wc_action_analog(0, act_steer, xy);
    steer_x1000 = (int32_t)(xy[0] * 1000.0f);

    uint32_t rev = wc_input_revision();
    if (rev != rev_seen) {            /* re-read prompts only on change */
        rev_seen = rev;
        pedal_len = wc_action_origin(0, act_pedal, pedal_label, sizeof pedal_label);
        steer_len = wc_action_origin(0, act_steer, 0, 0);
        pedal_glyph = wc_action_glyph(0, act_pedal);
        device = wc_input_device(0);
        char *p = put(line, "Press [");
        p = put(p, wc_action_label(0, act_pedal, WC_IN_A));
        p = put(p, "] to Pedal, [");
        p = put(p, wc_action_label(0, act_steer, WC_IN_LSTICK));
        p = put(p, "] to Steer");
        wc_log(line, (unsigned int)(p - line));
        prompts++;
    }
    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = pedal ? 0x00ffffff : 0x00202020;
}
