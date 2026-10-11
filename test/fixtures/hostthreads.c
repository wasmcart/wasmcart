/* Host-info hardware_threads (SPEC.md, "wc_host_info_t").
 *
 * Built twice:
 *   hostthreads.wasc        sets WC_FLAG_HOST_THREADS; wc_init copies
 *                           host_info.hardware_threads into a debug field
 *   hostthreads_legacy.wasc a cart from before the field: a 20-byte host-info
 *                           struct with a sentinel word right after it and no
 *                           flag, so the host must leave the sentinel alone
 *
 *   clang --target=wasm32 -nostdlib -O2 -I../../include -Wl,--no-entry \
 *     [-DLEGACY] hostthreads.c -o cart.wasm
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH 64
#define HEIGHT 64

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;

#ifdef LEGACY
/* the host-info struct as wasmcart.h defined it before hardware_threads, and
 * the cart's own memory right after it */
static struct { uint32_t host_info[5]; uint32_t sentinel; } mem = { { 0 }, 0x5e771e15u };
#define HOST_INFO_PTR ((uint32_t)mem.host_info)
#define FLAGS WC_FLAG_DEBUG
#else
static wc_host_info_t host_info;
#define HOST_INFO_PTR ((uint32_t)&host_info)
#define FLAGS (WC_FLAG_DEBUG | WC_FLAG_HOST_THREADS)
#endif

static uint32_t threads_at_init, sentinel_at_init;

WC_DEBUG_FIELDS(
    WC_DBG("threads", threads_at_init, WC_DBG_U32),
    WC_DBG("sentinel", sentinel_at_init, WC_DBG_U32)
)

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = (uint32_t)framebuffer;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = HOST_INFO_PTR;
    info.flags = FLAGS;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
#ifdef LEGACY
    sentinel_at_init = mem.sentinel;
#else
    threads_at_init = host_info.hardware_threads;
#endif
}

__attribute__((export_name("wc_render")))
void wc_render(void) {}
