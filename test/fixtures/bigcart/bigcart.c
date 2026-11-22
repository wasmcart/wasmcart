/*
 * bigcart - a threaded cart in a very large archive, for the web host's
 * large-cart path (a cart read from a File or a URL by random access, its
 * threads reading assets without a copy of the archive).
 *
 * The archive (bigcart.build.mjs) holds cart.wasm, any amount of stored
 * filler (fill/NNN.bin), then song.pcm (4 MiB of int16 stereo, a ~430 Hz saw
 * whose every sample the cart checks) and tail.bin (4096 bytes of
 * (i * 13 + 5) & 255) as the LAST entry, at the far end of the file.
 *
 * wc_init spawns THREADS threads (wasi thread-spawn); thread 1 reads tail.bin.
 * Frame 2 reads song.pcm whole on the main thread and checks it; from then on
 * each frame plays 800 frames of it into the audio ring.
 *
 *   WASM_CLANG=<clang with wasm-ld> node bigcart.build.mjs --wasm   (bigcart.wasm), i.e.
 *   clang --target=wasm32 -nostdlib -O2 -matomics -mbulk-memory -I../../../include \
 *     -Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory \
 *     -Wl,--initial-memory=8388608 -Wl,--max-memory=16777216 \
 *     -Wl,--export=wasi_thread_start bigcart.c -o bigcart.wasm
 */
#define WC_AUDIO_FORMAT_I16
#include "wasmcart.h"
#include "wc_cart.h"

#define DEFAULT_WIDTH  64
#define DEFAULT_HEIGHT 64
#define MAX_WIDTH  64
#define MAX_HEIGHT 64
#define AUDIO_CAP  4096
#define THREADS    4
#define SONG_FRAMES (1u << 20)
#define TAIL_SIZE  4096u

WC_CART_BUFFERS;

__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t thread_spawn(void *arg);

static int16_t song[SONG_FRAMES * 2];
static uint8_t tail[TAIL_SIZE];

static int32_t spawned, threads_ran, tail_bytes = -99, tail_ok;
static int32_t frame, song_size = -99, song_bytes = -99, song_ok, played;
static uint32_t song_pos;

WC_DEBUG_FIELDS(
    WC_DBG("spawned",     spawned,     WC_DBG_I32),
    WC_DBG("threads_ran", threads_ran, WC_DBG_I32),
    WC_DBG("tail_bytes",  tail_bytes,  WC_DBG_I32),
    WC_DBG("tail_ok",     tail_ok,     WC_DBG_I32),
    WC_DBG("frame",       frame,       WC_DBG_I32),
    WC_DBG("song_size",   song_size,   WC_DBG_I32),
    WC_DBG("song_bytes",  song_bytes,  WC_DBG_I32),
    WC_DBG("song_ok",     song_ok,     WC_DBG_I32),
    WC_DBG("played",      played,      WC_DBG_I32),
    WC_DBG("tail_head",   tail,        WC_DBG_U32)
)

static inline int16_t song_sample(uint32_t i, uint32_t ch) {
    return (int16_t)(((int32_t)((i * 37u + ch * 11u) & 0xFFFu) - 2048) * 4);
}

/* no locals in memory: a spawned thread here has no C stack of its own */
void wasi_thread_start(int32_t tid, void *arg) {
    (void)tid;
    if ((uintptr_t)arg == 1) {
        int32_t n = WC_LOAD_ASSET("tail.bin", tail, TAIL_SIZE);
        int32_t ok = n == (int32_t)TAIL_SIZE;
        for (uint32_t i = 0; i < TAIL_SIZE; i++)
            if (tail[i] != (uint8_t)((i * 13u + 5u) & 255u)) ok = 0;
        __atomic_store_n(&tail_bytes, n, __ATOMIC_SEQ_CST);
        __atomic_store_n(&tail_ok, ok, __ATOMIC_SEQ_CST);
    }
    __atomic_fetch_add(&threads_ran, 1, __ATOMIC_SEQ_CST);
}

WC_EXPORT wc_info_t *wc_get_info(void) {
    WC_FILL_INFO(WC_FLAG_DEBUG);
    return &wc_info;
}

WC_EXPORT_INIT void wc_init(void) {
    for (uintptr_t i = 1; i <= THREADS; i++)
        if (thread_spawn((void *)i) > 0) spawned++;
}

WC_EXPORT_RENDER void wc_render(void) {
    frame++;
    if (frame == 2) {
        song_size = WC_ASSET_SIZE("song.pcm");
        song_bytes = WC_LOAD_ASSET("song.pcm", song, sizeof song);
        int32_t ok = song_bytes == (int32_t)sizeof song;
        for (uint32_t i = 0; ok && i < SONG_FRAMES; i++)
            if (song[i * 2] != song_sample(i, 0) || song[i * 2 + 1] != song_sample(i, 1)) ok = 0;
        song_ok = ok;
    }
    if (song_ok) {
        for (uint32_t n = 0; n < 800; n++) {
            uint32_t at = wc_audio_write_cursor % AUDIO_CAP;
            wc_audio_ring[at * 2] = song[song_pos * 2];
            wc_audio_ring[at * 2 + 1] = song[song_pos * 2 + 1];
            wc_audio_write_cursor = (wc_audio_write_cursor + 1) % AUDIO_CAP;
            song_pos = (song_pos + 1) % SONG_FRAMES;
        }
        played += 800;
    }
    int32_t good = song_ok && __atomic_load_n(&tail_ok, __ATOMIC_SEQ_CST);
    uint32_t c = good ? 0xFF00C000u : frame < 3 ? 0xFF404040u : 0xFF0000C0u;
    for (uint32_t i = 0; i < DEFAULT_WIDTH * DEFAULT_HEIGHT; i++) wc_framebuffer[i] = c;
}
