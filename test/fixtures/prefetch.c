/*
 * prefetch - asset prefetch fixture (SPEC.md, "Asset prefetch").
 *
 * Assets: big.bin (8 MiB of (i * 31 + 7) & 255, deflated in the archive),
 * small.bin (4096 bytes of (i * 7 + 3) & 255, stored), and no missing.bin.
 *
 * In wc_init it reads WC_HOST_FLAG_ASSET_PREFETCH. With the flag: frame 1
 * prefetches all three (big at priority 2); every frame polls; on READY it
 * reads big in one wc_load_asset, checks every byte against the pattern and
 * records its FNV-1a. Then it prefetches small again, cancels it on the next
 * frame, prefetches it once more and must see READY later (cancel_ok), and
 * reads it. Without the flag it never calls the imports (calls stays 0), reads
 * both synchronously on frame 1 and sets hash_ok the same way: the fallback
 * path is the test's own control.
 *
 *   clang --target=wasm32 -nostdlib -O2 -I../../include -Wl,--no-entry \
 *     prefetch.c -o cart.wasm
 * then test/fixtures/prefetch.build.mjs packs prefetch.wasc and the
 * prefetch-dir directory.
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH  64
#define HEIGHT 64
#define BIG_SIZE   (8u << 20)
#define SMALL_SIZE 4096u

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;

static uint8_t big[BIG_SIZE];
static uint8_t small[SMALL_SIZE];

/* 99 = never set: a cart without the flag leaves every state alone */
static int32_t has_flag, calls, frame;
static int32_t state_big = 99, state_small = 99, state_missing = 99;
static int32_t frames_to_ready = -1, read_frame = -1, read_bytes = -1;
static int32_t hash_ok, cancel_ok, small_ok, small_read_frame = -1;
static int32_t state_small_re = 99, size_big = -1, size_small = -1;
static uint32_t hash;
static int32_t phase;   /* 0 waiting for big, 1 small re-prefetched, 2 cancelled, 3 waiting for small, 4 done */

WC_DEBUG_FIELDS(
    WC_DBG("has_flag",        has_flag,        WC_DBG_I32),
    WC_DBG("calls",           calls,           WC_DBG_I32),
    WC_DBG("frame",           frame,           WC_DBG_I32),
    WC_DBG("state_big",       state_big,       WC_DBG_I32),
    WC_DBG("state_small",     state_small,     WC_DBG_I32),
    WC_DBG("state_missing",   state_missing,   WC_DBG_I32),
    WC_DBG("state_small_re",  state_small_re,  WC_DBG_I32),
    WC_DBG("frames_to_ready", frames_to_ready, WC_DBG_I32),
    WC_DBG("read_frame",      read_frame,      WC_DBG_I32),
    WC_DBG("read_bytes",      read_bytes,      WC_DBG_I32),
    WC_DBG("size_big",        size_big,        WC_DBG_I32),
    WC_DBG("size_small",      size_small,      WC_DBG_I32),
    WC_DBG("hash",            hash,            WC_DBG_U32),
    WC_DBG("hash_ok",         hash_ok,         WC_DBG_I32),
    WC_DBG("cancel_ok",       cancel_ok,       WC_DBG_I32),
    WC_DBG("small_ok",        small_ok,        WC_DBG_I32),
    WC_DBG("small_read_frame", small_read_frame, WC_DBG_I32),
    WC_DBG("phase",           phase,           WC_DBG_I32)
)

static int32_t prefetch(const char *s, unsigned int len, int prio) {
    calls++;
    return wc_asset_prefetch(s, len, prio);
}

static void read_big(void) {
    size_big = WC_ASSET_SIZE("big.bin");
    read_bytes = WC_LOAD_ASSET("big.bin", big, BIG_SIZE);
    read_frame = frame;
    uint32_t h = 2166136261u;
    int ok = read_bytes == (int32_t)BIG_SIZE;
    for (uint32_t i = 0; i < BIG_SIZE; i++) {
        if (big[i] != (uint8_t)((i * 31u + 7u) & 255u)) ok = 0;
        h = (h ^ big[i]) * 16777619u;
    }
    hash = h;
    hash_ok = ok;
}

static void read_small(void) {
    size_small = WC_ASSET_SIZE("small.bin");
    int32_t n = WC_LOAD_ASSET("small.bin", small, SMALL_SIZE);
    small_read_frame = frame;
    int ok = n == (int32_t)SMALL_SIZE;
    for (uint32_t i = 0; i < SMALL_SIZE; i++)
        if (small[i] != (uint8_t)((i * 7u + 3u) & 255u)) ok = 0;
    small_ok = ok;
}

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
    has_flag = (host_info.flags & WC_HOST_FLAG_ASSET_PREFETCH) ? 1 : 0;
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    frame++;
    if (!has_flag) {
        /* an older host: read synchronously, as a cart did before the flag */
        if (frame == 1) { read_big(); read_small(); phase = 4; }
    } else if (phase == 0) {
        state_big = prefetch("big.bin", 7, frame == 1 ? 2 : 0);
        state_small = prefetch("small.bin", 9, 0);
        state_missing = prefetch("missing.bin", 11, 0);
        if (state_big == WC_PREFETCH_READY) {
            frames_to_ready = frame;
            read_big();
            phase = 1;
        }
    } else if (phase == 1) {
        state_small = prefetch("small.bin", 9, 0);
        phase = 2;
    } else if (phase == 2) {
        WC_ASSET_PREFETCH_CANCEL("small.bin");
        state_small_re = prefetch("small.bin", 9, 1);
        phase = 3;
    } else if (phase == 3) {
        state_small_re = prefetch("small.bin", 9, 1);
        if (state_small_re == WC_PREFETCH_READY) {
            cancel_ok = 1;
            read_small();
            phase = 4;
        }
    }
    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = phase == 4 ? 0xff00ff00u : 0xff202020u;
}
