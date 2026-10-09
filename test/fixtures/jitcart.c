/*
 * jitcart - runtime code generation fixture (SPEC.md, "Runtime code generation").
 * Links a hand-assembled module that imports cart.jit_add1 and exports
 * f(x) = jit_add1(x) * 2, calls it through a function pointer (call_indirect),
 * unlinks it, and links it again (the freed slot is reused). Works whether the
 * host answers synchronously or with -2 (it polls the result cell per frame).
 *
 * Rebuild (emcc + the wasmcart repo checkout for wasmcart.h):
 *   emcc jitcart.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s ALLOW_TABLE_GROWTH=1 -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state","_jit_add1"]' \
 *     -o jitcart.wasm
 *   npx wasmcart-pack --wasm jitcart.wasm --name jitcart -o jitcart.wasc
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

/* f(x) = cart.jit_add1(x) * 2 */
static const unsigned char gen[] = {
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,0x01,0x06,0x01,0x60,0x01,0x7f,0x01,0x7f,
  0x02,0x11,0x01,0x04,0x63,0x61,0x72,0x74,0x08,0x6a,0x69,0x74,0x5f,0x61,0x64,0x64,
  0x31,0x00,0x00,0x03,0x02,0x01,0x00,0x07,0x05,0x01,0x01,0x66,0x00,0x01,0x0a,0x0b,
  0x01,0x09,0x00,0x20,0x00,0x10,0x00,0x41,0x02,0x6c,0x0b
};

static int32_t off, max_module, link_ret, cell = -2, call_result, relink_ret, cell2 = -2, done;

WC_DEBUG_FIELDS(
    WC_DBG("off",         off,         WC_DBG_I32),
    WC_DBG("max_module",  max_module,  WC_DBG_I32),
    WC_DBG("link_ret",    link_ret,    WC_DBG_I32),
    WC_DBG("cell",        cell,        WC_DBG_I32),
    WC_DBG("call_result", call_result, WC_DBG_I32),
    WC_DBG("relink_ret",  relink_ret,  WC_DBG_I32),
    WC_DBG("cell2",       cell2,       WC_DBG_I32),
    WC_DBG("done",        done,        WC_DBG_I32)
)

__attribute__((export_name("jit_add1"), noinline))
int jit_add1(int x) { return x + 1; }

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
    off = wc_jit_config(WC_JIT_CFG_OFF);
    max_module = wc_jit_config(WC_JIT_CFG_MAX_MODULE);
    link_ret = wc_jit_link(gen, sizeof gen, &cell);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    if (!done && cell >= 0) {
        int (*f)(int) = (int (*)(int))(uintptr_t)cell;
        call_result = f(5);
        wc_jit_unlink(cell);
        relink_ret = wc_jit_link(gen, sizeof gen, &cell2);
        done = 1;
    }
    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = 0x00202020;
}
