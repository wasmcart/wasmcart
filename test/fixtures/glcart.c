/*
 * glcart — GL-detection fixture: imports glClearColor/glClear from the "gl"
 * module and calls them every frame, while keeping a tiny 2D framebuffer
 * (hybrid) so no-backend hosts still load it. Exists to pin the glBackend
 * FACTORY contract: invoked once for GL carts, never for 2D carts.
 *
 * Rebuild (emcc, no headers needed — self-contained):
 *   emcc glcart.c -O2 -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o glcart.wasm
 *   node bin/wasmcart-pack.js --wasm glcart.wasm --name glcart -o test/fixtures/glcart.wasc
 */
#include <stdint.h>

#define WC_EXPORT __attribute__((visibility("default"), used))

__attribute__((import_module("gl"), import_name("glClearColor")))
extern void glClearColor(float r, float g, float b, float a);
__attribute__((import_module("gl"), import_name("glClear")))
extern void glClear(uint32_t mask);

enum { W = 64, H = 64, AUDIO_CAP = 512 };

static uint32_t fb[W * H];
static float    audio[AUDIO_CAP * 2];
static uint32_t audio_write;
static uint8_t  input[4 * 16];
static double   time_ms;
static uint8_t  host_info[128];
static uint32_t info[20];

WC_EXPORT uint32_t *wc_get_info(void) {
  info[0]  = 3;                            /* version */
  info[1]  = W;
  info[2]  = H;
  info[3]  = (uint32_t)(uintptr_t)fb;
  info[4]  = (uint32_t)(uintptr_t)audio;
  info[5]  = AUDIO_CAP;
  info[6]  = (uint32_t)(uintptr_t)&audio_write;
  info[7]  = (uint32_t)(uintptr_t)input;
  info[8]  = 0;                            /* save_ptr */
  info[9]  = 0;                            /* save_size */
  info[10] = (uint32_t)(uintptr_t)&time_ms;
  info[11] = (uint32_t)(uintptr_t)host_info;
  info[12] = 0;                            /* flags */
  info[13] = 0;                            /* audio_sample_rate */
  info[14] = 0;                            /* pointer_ptr */
  info[15] = 0;                            /* keys_ptr */
  info[16] = 1;                            /* gpu_api = WebGL2/GLES3 */
  return info;
}

WC_EXPORT void wc_init(void) {}

WC_EXPORT void wc_render(void) {
  glClearColor(0.0f, 0.5f, 1.0f, 1.0f);
  glClear(0x4000); /* GL_COLOR_BUFFER_BIT */
  fb[0] = 0xff0000ffu; /* hybrid: also touch the 2D framebuffer */
}
