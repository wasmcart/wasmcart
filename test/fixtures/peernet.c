/*
 * peernet — peer-connection ABI fixture cart (ABI v3).
 * Exercises wc_peer_open/send/broadcast/count/id/name/state/transport and the
 * four on_* callbacks. Records what it observed into debug-visible statics so
 * the host test can assert on cart-side behaviour, not just host internals.
 *
 * Rebuild (clang with a wasm32 target, from this directory):
 *   clang --target=wasm32 -O2 -nostdlib -I../../include \
 *     -DWC_USE_NET_PEER -Wl,--no-entry -Wl,--export-dynamic \
 *     -Wl,--allow-undefined -Wl,--initial-memory=1048576 \
 *     -o peernet.wasm peernet.c
 *
 * The --initial-memory is load-bearing: the host stages callback payloads in
 * the TOP 64KB of linear memory (_withTempWasmData). At the 128KB the linker
 * defaults to, that window starts at 65536 -- exactly where this cart's statics
 * begin -- so every delivered message overwrote wc_info_t and the host read back
 * garbage resolution. 1MB puts the statics well clear of it.
 *   npx wasmcart-pack --wasm peernet.wasm --name peernet -o peernet.wasc
 */
#include "wasmcart.h"

#define WIDTH  32
#define HEIGHT 32

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;

// Observations, readable by the host via exported getters.
static int   n_connect, n_message, n_disconnect, n_error;
static int   last_peer;
static int   last_msg_len;
static char  last_name[64];
static unsigned char last_msg[64];
// Separate scratch for host-written strings. Sharing last_msg let a test's
// string land in memory wc_render reads back as resolution fields, which
// produced spurious "cart requested 6647407x32" warnings.
static unsigned char scratch[256];

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version    = WC_ABI_VERSION;
    info.width      = WIDTH;
    info.height     = HEIGHT;
    info.fb_ptr     = (uint32_t)(uintptr_t)framebuffer;
    info.input_ptr  = (uint32_t)(uintptr_t)pads;
    info.time_ptr   = (uint32_t)(uintptr_t)&time_info;
    info.flags      = WC_FLAG_NET_PEER;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    for (int i = 0; i < WIDTH * HEIGHT; i++) framebuffer[i] = 0xFF000000u;
}

// --- peer callbacks (host calls into cart) ---

__attribute__((export_name("wc_peer_on_connect")))
void wc_peer_on_connect(int peer_id, const char* name, unsigned int name_len) {
    n_connect++;
    last_peer = peer_id;
    unsigned int n = name_len < sizeof(last_name) - 1 ? name_len : sizeof(last_name) - 1;
    for (unsigned int i = 0; i < n; i++) last_name[i] = name[i];
    last_name[n] = 0;
}

__attribute__((export_name("wc_peer_on_message")))
void wc_peer_on_message(int peer_id, const void* data, unsigned int len) {
    n_message++;
    last_peer = peer_id;
    const unsigned char* p = (const unsigned char*)data;
    unsigned int n = len < sizeof(last_msg) ? len : sizeof(last_msg);
    for (unsigned int i = 0; i < n; i++) last_msg[i] = p[i];
    last_msg_len = (int)len;
}

__attribute__((export_name("wc_peer_on_disconnect")))
void wc_peer_on_disconnect(int peer_id) { n_disconnect++; last_peer = peer_id; }

__attribute__((export_name("wc_peer_on_error")))
void wc_peer_on_error(int peer_id) { n_error++; last_peer = peer_id; }

// --- getters so the test can read cart-side state ---

__attribute__((export_name("t_connects")))    int t_connects(void)    { return n_connect; }
__attribute__((export_name("t_messages")))    int t_messages(void)    { return n_message; }
__attribute__((export_name("t_disconnects"))) int t_disconnects(void) { return n_disconnect; }
__attribute__((export_name("t_errors")))      int t_errors(void)      { return n_error; }
__attribute__((export_name("t_last_peer")))   int t_last_peer(void)   { return last_peer; }
__attribute__((export_name("t_last_msg_len"))) int t_last_msg_len(void) { return last_msg_len; }
__attribute__((export_name("t_last_name_ptr"))) int t_last_name_ptr(void) { return (int)(uintptr_t)last_name; }
__attribute__((export_name("t_last_msg_ptr")))  int t_last_msg_ptr(void)  { return (int)(uintptr_t)last_msg; }

// --- cart-initiated calls into the host ---

__attribute__((export_name("t_open")))
int t_open(int addr_ptr, int addr_len) {
    return wc_peer_open((const char*)(uintptr_t)addr_ptr, (unsigned int)addr_len);
}
__attribute__((export_name("t_count")))     int t_count(void) { return wc_peer_count(); }
__attribute__((export_name("t_id_at")))     int t_id_at(int i) { return wc_peer_id((unsigned int)i); }
__attribute__((export_name("t_state")))     int t_state(int id) { return wc_peer_state(id); }
__attribute__((export_name("t_transport"))) int t_transport(int id) { return wc_peer_transport(id); }
__attribute__((export_name("t_name")))
int t_name(int id, int dest, int max) {
    return wc_peer_name(id, (char*)(uintptr_t)dest, (unsigned int)max);
}
__attribute__((export_name("t_send")))
int t_send(int id, int ptr, int len) {
    return wc_peer_send(id, (const void*)(uintptr_t)ptr, (unsigned int)len);
}
__attribute__((export_name("t_broadcast")))
int t_broadcast(int ptr, int len) {
    return wc_peer_broadcast((const void*)(uintptr_t)ptr, (unsigned int)len);
}
__attribute__((export_name("t_scratch")))
int t_scratch(void) { return (int)(uintptr_t)scratch; }
