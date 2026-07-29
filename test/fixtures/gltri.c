/*
 * gltri — GL orientation probe.
 *
 * A clear-only GL cart cannot reveal a flip or a corner bug: every pixel is
 * identical. This one draws deliberately ASYMMETRIC geometry so the rendered
 * image says which way is up and whether the frame fills the drawable.
 *
 * Layout (in cart space, y DOWN like the framebuffer):
 *   - a RED bar across the TOP edge
 *   - a GREEN bar down the LEFT edge
 *   - a small WHITE square in the TOP-LEFT corner
 * on a dark blue background.
 *
 * So: red on top + green on left + white in the top-left = correct.
 * Red at the bottom = vertically flipped. Everything crammed into one corner
 * = the viewport/drawable is wrong.
 *
 * Rebuild (emcc + the wasmcart repo checkout for wc_cart.h):
 *   emcc gltri.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o gltri.wasm
 *   npx wasmcart-pack --wasm gltri.wasm --name gltri -o gltri.wasc
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH  256
#define HEIGHT 192

/* GL imports: enough to clear and scissor-fill rectangles, which needs no
   shaders and so cannot fail for shader-compilation reasons. */
__attribute__((import_module("gl"), import_name("glClearColor")))
extern void glClearColor(float r, float g, float b, float a);
__attribute__((import_module("gl"), import_name("glClear")))
extern void glClear(uint32_t mask);
__attribute__((import_module("gl"), import_name("glEnable")))
extern void glEnable(uint32_t cap);
__attribute__((import_module("gl"), import_name("glDisable")))
extern void glDisable(uint32_t cap);
__attribute__((import_module("gl"), import_name("glScissor")))
extern void glScissor(int x, int y, int w, int h);
__attribute__((import_module("gl"), import_name("glViewport")))
extern void glViewport(int x, int y, int w, int h);

#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_SCISSOR_TEST     0x0C11

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

/* Fill a rect given in CART space (y down from the top) by converting to GL's
   bottom-up scissor space. */
static void fill_rect_topdown(int x, int y_top, int w, int h,
                              float r, float g, float b) {
    int y_gl = HEIGHT - (y_top + h);
    glScissor(x, y_gl, w, h);
    glClearColor(r, g, b, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
}

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = 0;              /* GL cart: renders through the gl module */
    info.gpu_api = 1;
    info.audio_ptr = 0;
    info.audio_cap = 0;
    info.audio_write_ptr = 0;
    info.input_ptr = (uint32_t)pads;
    info.save_ptr = 0;
    info.save_size = 0;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    info.flags = 0;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) { }

__attribute__((export_name("wc_render")))
void wc_render(void) {
    glViewport(0, 0, WIDTH, HEIGHT);

    /* background: dark blue, whole drawable */
    glDisable(GL_SCISSOR_TEST);
    glClearColor(0.05f, 0.05f, 0.20f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    glEnable(GL_SCISSOR_TEST);
    /* RED bar across the TOP */
    fill_rect_topdown(0, 0, WIDTH, 24, 1.0f, 0.1f, 0.1f);
    /* GREEN bar down the LEFT */
    fill_rect_topdown(0, 0, 24, HEIGHT, 0.1f, 0.9f, 0.1f);
    /* WHITE square in the TOP-LEFT corner */
    fill_rect_topdown(32, 32, 32, 32, 1.0f, 1.0f, 1.0f);
    glDisable(GL_SCISSOR_TEST);
}
