/*
 * loopcart - the wc_frame_yield loop-inversion fixture: a blocking engine
 * loop suspended/resumed by the host once per frame via binaryen asyncify.
 *
 * Rebuild (emcc + binaryen from emsdk):
 *   emcc loopcart.c -O2 -I<wasmcart>/include -sSTANDALONE_WASM=1 --no-entry \
 *     -sEXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_yield_buffer"]' \
 *     -sERROR_ON_UNDEFINED_SYMBOLS=0 -o pre.wasm
 *   wasm-opt --asyncify --pass-arg=asyncify-imports@env.wc_frame_yield -O2 pre.wasm -o loopcart.wasm
 *   npx wasmcart pack --wasm loopcart.wasm -o loopcart.wasc
 *
 * Pixel contract: fb[0] = frame_n*3 + local_state(1000+) + depth(7);
 * holding A adds +1 to local_state on the frame AFTER the yield.
 */
/* loopcart - proves the wc_frame_yield loop-inversion protocol.
 * The "engine" owns a classic blocking main loop; the host suspends and
 * resumes it once per frame via binaryen asyncify. */
#include "wasmcart.h"

#define W 128
#define H 128
static uint32_t framebuffer[W * H];
static float audio_ring[512 * 2];
static uint32_t audio_write_cursor;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;

__attribute__((import_module("env"), import_name("wc_frame_yield")))
extern void wc_frame_yield(void);

/* asyncify unwind stack: {current, end} descriptor then the stack area */
static struct { uint32_t cur; uint32_t end; uint8_t stack[65536]; } yield_buf;

__attribute__((export_name("wc_yield_buffer")))
uint32_t wc_yield_buffer(void) {
    yield_buf.cur = (uint32_t)(uintptr_t)yield_buf.stack;
    yield_buf.end = (uint32_t)(uintptr_t)(yield_buf.stack + sizeof(yield_buf.stack));
    return (uint32_t)(uintptr_t)&yield_buf;
}

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = W; info.height = H;
    info.fb_ptr = (uint32_t)framebuffer;
    info.audio_ptr = (uint32_t)audio_ring;
    info.audio_cap = 512;
    info.audio_write_ptr = (uint32_t)&audio_write_cursor;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    info.flags = WC_FLAG_AUDIO_F32;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) { WC_LOG("loopcart init"); }

/* the blocking "engine": deep call stack + locals that must survive suspend */
static uint32_t frame_n;

static void inner_loop(int depth, uint32_t local_state) {
    while (1) {
        for (int i = 0; i < W * H; i++)
            framebuffer[i] = (frame_n * 3 + local_state + depth) & 0xFFFFFF;
        frame_n++;
        wc_frame_yield();          /* host suspends the whole stack HERE */
        if (pads[0].buttons & 1) local_state++;  /* input still works */
    }
}

static void engine_main(void) {
    WC_LOG("engine main loop starting");
    inner_loop(7, 1000);           /* nested: proves full-stack unwind */
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    /* Called every frame. First call enters the engine loop; on resume
     * frames the asyncify rewind FAST-FORWARDS through this same call
     * chain back to the suspended yield point - so the call must be
     * unconditional (a started-guard would break the rewind path). */
    engine_main();
}
