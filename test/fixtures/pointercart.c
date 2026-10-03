/*
 * pointercart — pointer/wheel ABI fixture cart.
 *
 * Records both halves of the pointer contract so a host can be checked
 * against either: the per-frame STATE block (position, button bitmask,
 * active flag) and the EVENT callbacks (wc_ptr_on_down/move/up). A host that
 * writes state but never delivers events, or delivers events without
 * updating state, fails here rather than in a game.
 *
 * It also paints the pointer position into the framebuffer, so the same cart
 * is usable by hand in a window: the cursor should track under the real mouse
 * with no offset at any window size.
 *
 * Rebuild (emcc + the wasmcart repo checkout for wc_cart.h):
 *   emcc pointercart.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state","_wc_ptr_on_down","_wc_ptr_on_move","_wc_ptr_on_up"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o pointercart.wasm
 *   npx wasmcart-pack --wasm pointercart.wasm --name pointercart -o pointercart.wasc
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH  160
#define HEIGHT 120

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;
static wc_pointer_t pointers[10];
static wc_wheel_t wheel;

static uint32_t frame_n;

/* live state, re-read every frame from the pointer block */
static uint32_t ptr_x, ptr_y, ptr_buttons, ptr_active;

/* event tallies, so a dropped callback is visible as a zero */
static uint32_t n_down, n_move, n_up;
/* coordinates carried by the LAST event of each kind: a host that scales
   wrongly shows up here as a position that disagrees with where it clicked */
static uint32_t down_x, down_y, down_btn;
static uint32_t move_x, move_y;
static uint32_t up_btn;
/* accumulated wheel, in 1/120 notch units */
static int32_t wheel_dx_total, wheel_dy_total;

WC_DEBUG_FIELDS(
    WC_DBG("frame_n",        frame_n,        WC_DBG_U32),
    WC_DBG("ptr_x",          ptr_x,          WC_DBG_U32),
    WC_DBG("ptr_y",          ptr_y,          WC_DBG_U32),
    WC_DBG("ptr_buttons",    ptr_buttons,    WC_DBG_U32),
    WC_DBG("ptr_active",     ptr_active,     WC_DBG_U32),
    WC_DBG("n_down",         n_down,         WC_DBG_U32),
    WC_DBG("n_move",         n_move,         WC_DBG_U32),
    WC_DBG("n_up",           n_up,           WC_DBG_U32),
    WC_DBG("down_x",         down_x,         WC_DBG_U32),
    WC_DBG("down_y",         down_y,         WC_DBG_U32),
    WC_DBG("down_btn",       down_btn,       WC_DBG_U32),
    WC_DBG("move_x",         move_x,         WC_DBG_U32),
    WC_DBG("move_y",         move_y,         WC_DBG_U32),
    WC_DBG("up_btn",         up_btn,         WC_DBG_U32),
    WC_DBG("wheel_dx_total", wheel_dx_total, WC_DBG_I32),
    WC_DBG("wheel_dy_total", wheel_dy_total, WC_DBG_I32)
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
    info.pointer_ptr = (uint32_t)pointers;
    info.wheel_ptr = (uint32_t)&wheel;
    /* WC_FLAG_POINTER is what makes the host write the block at all. */
    info.flags = WC_FLAG_DEBUG | WC_FLAG_POINTER;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    frame_n = 0;
}

/* --- event callbacks ---------------------------------------------------- */

__attribute__((export_name("wc_ptr_on_down")))
void wc_ptr_on_down(int32_t id, int32_t x, int32_t y, int32_t button) {
    if (id != 0) return;            /* mouse only, so a stray touch cannot inflate the count */
    n_down++; down_x = (uint32_t)x; down_y = (uint32_t)y; down_btn = (uint32_t)button;
}

__attribute__((export_name("wc_ptr_on_move")))
void wc_ptr_on_move(int32_t id, int32_t x, int32_t y) {
    if (id != 0) return;
    n_move++; move_x = (uint32_t)x; move_y = (uint32_t)y;
}

__attribute__((export_name("wc_ptr_on_up")))
void wc_ptr_on_up(int32_t id, int32_t button) {
    if (id != 0) return;
    n_up++; up_btn = (uint32_t)button;
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    frame_n++;

    /* STATE half of the contract: read straight out of the host-written block. */
    ptr_x       = (uint32_t)(int32_t)pointers[0].x;
    ptr_y       = (uint32_t)(int32_t)pointers[0].y;
    ptr_buttons = pointers[0].buttons;
    ptr_active  = pointers[0].active;

    /* The host zeroes the wheel after every frame, so accumulate to see it. */
    wheel_dx_total += wheel.dx;
    wheel_dy_total += wheel.dy;

    /* Dark background; brighter once a button is held, so a press is visible
       by eye as well as in the debug state. */
    uint32_t bg = pointers[0].buttons ? 0x00303060 : 0x00101010;
    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = bg;

    /* Crosshair at the pointer, drawn only while it is active. A cursor that
       sits in the corner when the mouse is mid-window, or lags behind it, is
       a coordinate bug visible without reading any numbers. */
    if (pointers[0].active) {
        int px = pointers[0].x, py = pointers[0].y;
        if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) {
            for (int x = 0; x < WIDTH; x++)  framebuffer[py * WIDTH + x] = 0x0000FF00;
            for (int y = 0; y < HEIGHT; y++) framebuffer[y * WIDTH + px] = 0x0000FF00;
        }
    }
}
