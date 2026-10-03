/*
 * dircart -- asset-loading fixture for cart DIRECTORIES (test/fixtures/dircart/).
 *
 * Loads assets everywhere a lazy (JSPI) host can have to suspend on a fetch:
 * in wc_init, in the middle of a wc_render, and inside a keyboard callback.
 * It also asks for a missing file and for _filelist.txt. Everything it saw is
 * recorded in `results` (exported via dc_results) so the test asserts on what
 * the CART observed, not on host internals.
 *
 * Rebuild (clang with a wasm32 target, from this directory):
 *   clang --target=wasm32 -O2 -nostdlib -I../../include \
 *     -Wl,--no-entry -Wl,--export-dynamic -Wl,--allow-undefined \
 *     -Wl,--initial-memory=1048576 -o dircart/cart.wasm dircart.c
 */
#include "wasmcart.h"

#define WIDTH  64
#define HEIGHT 48

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static uint8_t keys[32];   // key state bitmask (wc_info_t.keys_ptr)
static wc_info_t info;
static wc_host_info_t host_info;

/* What the cart observed. Field order is read by test/browser.test.mjs. */
static struct {
  int32_t init_size;      // wc_asset_size("hello.txt") in wc_init
  int32_t init_loaded;    // wc_load_asset("hello.txt") in wc_init
  int32_t missing_size;   // wc_asset_size("nope.txt")
  int32_t list_size;      // wc_asset_size("_filelist.txt")
  int32_t list_loaded;    // wc_load_asset("_filelist.txt")
  int32_t late_loaded;    // wc_load_asset("data/late.bin") on frame 3
  int32_t late_frame;     // the frame it was loaded on
  int32_t key_loaded;     // wc_load_asset("data/key.txt") in wc_kb_on_down
  int32_t frames;         // wc_render calls
  uint32_t late_sum;      // byte sum of late.bin
} results;

static char hello[64];
static char list[256];
static uint8_t late[4096];
static char keytxt[64];

__attribute__((export_name("dc_results")))
void* dc_results(void) { return &results; }
__attribute__((export_name("dc_hello")))
char* dc_hello(void) { return hello; }
__attribute__((export_name("dc_list")))
char* dc_list(void) { return list; }
__attribute__((export_name("dc_key")))
char* dc_key(void) { return keytxt; }

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
  info.version = WC_ABI_VERSION;
  info.width = WIDTH;
  info.height = HEIGHT;
  info.fb_ptr = (uint32_t)framebuffer;
  info.input_ptr = (uint32_t)pads;
  info.time_ptr = (uint32_t)&time_info;
  info.host_info_ptr = (uint32_t)&host_info;
  info.keys_ptr = (uint32_t)keys;
  info.flags = WC_FLAG_KEYBOARD;
  return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
  results.init_size = WC_ASSET_SIZE("hello.txt");
  results.init_loaded = WC_LOAD_ASSET("hello.txt", hello, sizeof(hello) - 1);
  results.missing_size = WC_ASSET_SIZE("nope.txt");
  results.list_size = WC_ASSET_SIZE("_filelist.txt");
  results.list_loaded = WC_LOAD_ASSET("_filelist.txt", list, sizeof(list) - 1);
  results.late_loaded = -2;   // not attempted yet
  results.key_loaded = -2;
}

__attribute__((export_name("wc_kb_on_down")))
void wc_kb_on_down(uint32_t keycode, uint32_t modifiers) {
  (void)keycode; (void)modifiers;
  results.key_loaded = WC_LOAD_ASSET("data/key.txt", keytxt, sizeof(keytxt) - 1);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
  results.frames++;
  if (results.frames == 3) {
    // Mid-frame: everything before this line already ran, and the pixels
    // below must still be written after the fetch completes.
    results.late_loaded = WC_LOAD_ASSET("data/late.bin", late, sizeof(late));
    results.late_frame = results.frames;
    uint32_t sum = 0;
    for (int i = 0; i < results.late_loaded; i++) sum += late[i];
    results.late_sum = sum;
  }
  // Green once late.bin arrived, red before: a frame that returned early
  // (or skipped the rest of wc_render) shows up as the wrong colour.
  uint32_t c = results.late_loaded > 0 ? 0xFF00FF00u : 0xFFFF0000u;
  for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = c;
}
