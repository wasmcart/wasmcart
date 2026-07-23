/*
 * wc_cart.h - Cart boilerplate macros for wasmcart
 *
 * Reduces the ~40 lines of buffer declarations + wc_get_info() that
 * every cart copy-pastes. Include this AFTER wasmcart.h.
 *
 * USAGE (GL cart):
 *
 *   #define WC_USE_GL
 *   #include "wasmcart.h"
 *   #include "wc_cart.h"
 *
 *   // Define your resolution and audio settings:
 *   #define DEFAULT_WIDTH  640
 *   #define DEFAULT_HEIGHT 480
 *   #define MAX_WIDTH  1920
 *   #define MAX_HEIGHT 1080
 *   #define AUDIO_CAP 4096
 *
 *   // Declare all cart buffers at once:
 *   WC_CART_BUFFERS;
 *
 *   // In your wc_get_info():
 *   WC_EXPORT wc_info_t *wc_get_info(void) {
 *       WC_FILL_INFO(0);
 *       return &wc_info;
 *   }
 *
 * USAGE (2D framebuffer cart):
 *
 *   #include "wasmcart.h"
 *   #include "wc_cart.h"
 *
 *   #define DEFAULT_WIDTH  320
 *   #define DEFAULT_HEIGHT 240
 *   #define MAX_WIDTH  320
 *   #define MAX_HEIGHT 240
 *   #define AUDIO_CAP 4096
 *
 *   WC_CART_BUFFERS;
 *
 *   WC_EXPORT wc_info_t *wc_get_info(void) {
 *       WC_FILL_INFO(0);
 *       return &wc_info;
 *   }
 *
 * WHAT THIS PROVIDES:
 *   WC_CART_BUFFERS   - declares all standard cart globals
 *   WC_FILL_INFO(f)   - fills wc_info struct fields
 *   WC_EXPORT         - shorthand for __attribute__((export_name(...)))
 *
 * You still write your own wc_init() and wc_render() - those have
 * game-specific logic that can't be templated.
 */

#ifndef WC_CART_H
#define WC_CART_H

#ifndef WASMCART_H
#error "Include wasmcart.h before wc_cart.h"
#endif

/* ── Export attribute shorthand ────────────────────────────────────── */

#ifndef WC_EXPORT
#define WC_EXPORT __attribute__((export_name("wc_get_info")))
#endif

/* Helper for other exports */
#define WC_EXPORT_INIT   __attribute__((export_name("wc_init")))
#define WC_EXPORT_RENDER __attribute__((export_name("wc_render")))

/* ── Audio sample type ────────────────────────────────────────────── */

/*
 * Default audio format is Float32 (WC_FLAG_AUDIO_F32 set automatically).
 * Define WC_AUDIO_FORMAT_I16 before including this header to use int16
 * ring buffers instead (legacy format).
 */
#ifdef WC_AUDIO_FORMAT_I16
  #define _WC_AUDIO_SAMPLE_T int16_t
#else
  #define _WC_AUDIO_SAMPLE_T float
#endif

/* ── Standard cart buffer declarations ────────────────────────────── */

/*
 * Declares all the standard globals every cart needs.
 * Uses DEFAULT_WIDTH, DEFAULT_HEIGHT, MAX_WIDTH, MAX_HEIGHT, AUDIO_CAP
 * which must be #defined before this macro.
 *
 * Names match the convention used across all existing carts.
 */
#define WC_CART_BUFFERS                                           \
    static uint32_t     wc_cur_width  = DEFAULT_WIDTH;            \
    static uint32_t     wc_cur_height = DEFAULT_HEIGHT;           \
    static uint32_t     wc_framebuffer[MAX_WIDTH * MAX_HEIGHT];   \
    static _WC_AUDIO_SAMPLE_T wc_audio_ring[AUDIO_CAP * 2];      \
    static uint32_t     wc_audio_write_cursor;                    \
    static wc_pad_t     wc_pads[4];                               \
    static wc_time_t    wc_time;                                  \
    static wc_info_t    wc_info;                                  \
    static wc_host_info_t wc_host_info;                           \
    static wc_pointer_t wc_pointers[10];                          \
    static uint8_t      wc_keys[32]

/* ── Fill info struct ─────────────────────────────────────────────── */

/*
 * Fills the wc_info struct with standard field values.
 * Call inside wc_get_info(). Pass flags like WC_FLAG_AUDIO_F32 or 0.
 *
 * For carts that don't use save data, save_ptr and save_size are set to 0.
 * Override them after this macro if you need save support.
 */
#define WC_FILL_INFO(_wc_flags) do {                                \
    wc_info.version       = WC_ABI_VERSION;                        \
    wc_info.width         = DEFAULT_WIDTH;                         \
    wc_info.height        = DEFAULT_HEIGHT;                        \
    wc_info.fb_ptr        = (uint32_t)(uintptr_t)wc_framebuffer;  \
    wc_info.audio_ptr     = (uint32_t)(uintptr_t)wc_audio_ring;   \
    wc_info.audio_cap     = AUDIO_CAP;                             \
    wc_info.audio_write_ptr = (uint32_t)(uintptr_t)&wc_audio_write_cursor; \
    wc_info.input_ptr     = (uint32_t)(uintptr_t)wc_pads;         \
    wc_info.save_ptr      = 0;                                     \
    wc_info.save_size     = 0;                                     \
    wc_info.time_ptr      = (uint32_t)(uintptr_t)&wc_time;        \
    wc_info.host_info_ptr = (uint32_t)(uintptr_t)&wc_host_info;   \
    wc_info.flags         = (_wc_flags)                            \
        _WC_FILL_INFO_AUDIO_FLAG;                                  \
    wc_info.audio_sample_rate = 0;  /* 0 = let host decide */     \
    wc_info.pointer_ptr   = (uint32_t)(uintptr_t)wc_pointers;    \
    wc_info.keys_ptr      = (uint32_t)(uintptr_t)wc_keys;        \
} while (0)

/* Auto-set WC_FLAG_AUDIO_F32 unless cart opts into legacy I16 */
#ifdef WC_AUDIO_FORMAT_I16
  #define _WC_FILL_INFO_AUDIO_FLAG
#else
  #define _WC_FILL_INFO_AUDIO_FLAG | WC_FLAG_AUDIO_F32
#endif

/* ── Debug ABI (OPT-IN, DEFAULT OFF) ─────────────────────────────
 *
 * SEPARATE from WC_CART on purpose: a cart that does NOT use WC_DEBUG_FIELDS
 * emits ZERO debug code and is byte-for-byte a non-debug cart (the governing rule
 * — default is no debugging, structurally absent). Adding the macro is the ONLY
 * opt-in, and it must be paired with setting WC_FLAG_DEBUG in your wc_get_info
 * flags: WC_FILL_INFO(WC_FLAG_DEBUG).
 *
 * A debug field NAMES one value you choose to expose to a host/harness by name
 * — player position, HP, game mode. The host reads it PULL-ONLY (never per
 * frame), so exposing fields costs nothing at runtime.
 *
 * Usage:
 *   WC_DEBUG_FIELDS(
 *     WC_DBG("player_x", player.x, WC_DBG_I16),
 *     WC_DBG("hp",       hp,       WC_DBG_U8),
 *     WC_DBG_ARR("tiles", tilemap, WC_DBG_U8, 256)
 *   )
 * Then set WC_FLAG_DEBUG in your info flags. */

typedef struct {
    uint32_t name_ptr;   /* NUL-terminated field name */
    uint32_t value_ptr;  /* value location in cart memory */
    uint8_t  type;       /* WC_DBG_* */
    uint8_t  _pad[3];
    uint32_t len;        /* element count (scalar=1, array>1, bytes=length) */
} wc_debug_field_t;

#define WC_DBG_U8  0
#define WC_DBG_I8  1
#define WC_DBG_U16 2
#define WC_DBG_I16 3
#define WC_DBG_U32 4
#define WC_DBG_I32 5
#define WC_DBG_F32 6
#define WC_DBG_F64 7
#define WC_DBG_BYTES 8

#ifndef WC_FLAG_DEBUG
#define WC_FLAG_DEBUG (1 << 5)  /* cart exports wc_debug_state() */
#endif

/* One scalar field. `expr` must be an lvalue whose address is taken. */
#define WC_DBG(name_str, expr, dbg_type) \
    { (uint32_t)(uintptr_t)(name_str), (uint32_t)(uintptr_t)&(expr), (dbg_type), {0,0,0}, 1 }
/* An array / byte-buffer field of `count` elements. */
#define WC_DBG_ARR(name_str, arr, dbg_type, count) \
    { (uint32_t)(uintptr_t)(name_str), (uint32_t)(uintptr_t)(arr), (dbg_type), {0,0,0}, (count) }

/* Emit the descriptor table + wc_debug_state(). Table is NUL-terminated by a
 * zero entry. Call OUTSIDE any function, once, listing your fields. */
#define WC_DEBUG_FIELDS(...) \
    static wc_debug_field_t wc_debug_table[] = { __VA_ARGS__, {0,0,0,{0,0,0},0} }; \
    __attribute__((export_name("wc_debug_state"))) \
    wc_debug_field_t *wc_debug_state(void) { return wc_debug_table; }

#endif /* WC_CART_H */
