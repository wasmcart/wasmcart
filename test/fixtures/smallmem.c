/*
 * smallmem - scratch-aliasing regression fixture.
 *
 * A cart linked at the wasm-ld default 128KB whose statics run PAST the 64KB
 * mark, with its memory maximum pinned so the host cannot grow a scratch page.
 * That combination is what made the old host corrupt cart memory: it staged
 * host->cart payloads in the top 64KB of existing memory, which for a cart this
 * size is the middle of its own data.
 *
 * guard[] is filled with 0xAB at init. If a delivered payload lands on it, the
 * bytes change, and the test sees it.
 *
 * Rebuild:
 *   emcc smallmem.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s INITIAL_MEMORY=131072 -s TOTAL_STACK=8192 \
 *     -s EXPORTED_FUNCTIONS=[...] -o smallmem.wasm
 */
#include "wasmcart.h"
#include "wc_cart.h"
#define W 128
#define H 96
static uint32_t framebuffer[W*H];      /* 48KB */
static uint8_t  guard[24576];          /* pushes statics past 64KB */
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;
static uint32_t received;
WC_DEBUG_FIELDS(
  WC_DBG("received", received, WC_DBG_U32),
  WC_DBG("guard0",   guard[0],  WC_DBG_U32)
)
__attribute__((export_name("wc_get_info"))) wc_info_t* wc_get_info(void){
  info.version=WC_ABI_VERSION; info.width=W; info.height=H;
  info.fb_ptr=(uint32_t)framebuffer; info.input_ptr=(uint32_t)pads;
  info.time_ptr=(uint32_t)&time_info; info.host_info_ptr=(uint32_t)&host_info;
  info.flags=WC_FLAG_DEBUG; return &info; }
__attribute__((export_name("wc_init"))) void wc_init(void){
  for(int i=0;i<24576;i++) guard[i]=0xAB; }
__attribute__((export_name("wc_begin"))) void wc_begin(void){ wc_text_input_begin(); }
__attribute__((export_name("wc_on_text"))) void wc_on_text(const char* t,uint32_t n){ (void)t; received+=n; }
__attribute__((export_name("wc_render"))) void wc_render(void){}
