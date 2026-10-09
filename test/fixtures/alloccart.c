/*
 * alloccart - fixture for "Cart memory the host writes" (SPEC.md): the
 * cart-exported allocator (wc_alloc/wc_free) the host writes GL strings and
 * buffer mappings into. One source, four builds (alloc/build.sh):
 *
 *   alloc_header.wasc  wasmcart.h's own wc_alloc/wc_free (and malloc exported
 *                      too: wc_alloc must win, with no deprecation warning)
 *   alloc_count.wasc   a counting wc_alloc/wc_free (alloc_count.h) that a test
 *                      can also make return bad pointers
 *   alloc_malloc.wasc  no wc_alloc; exports malloc/free (the deprecated path)
 *   alloc_none.wasc    no allocator at all
 *
 * Every build renders a plain GL clear each frame without touching cart
 * memory paths, so alloc_none must run fine until a test calls t_gl_string or
 * t_map, which hit glGetString and glMapBufferRange.
 */
#if !defined(ALLOC_HEADER)
#define WASMCART_NO_ALLOC
#endif
#define WC_USE_GL
#include <stdint.h>
#include "wasmcart.h"
#ifdef ALLOC_COUNT
#include "alloc_count.h"
#else
static inline void t_phase(int p) { (void)p; }
#endif

/* not declared by wasmcart.h; the host provides them */
__attribute__((import_module("gl"), import_name("glGetStringi")))
extern const unsigned char *glGetStringi(GLenum name, GLuint index);
__attribute__((import_module("gl"), import_name("glMapBufferRange")))
extern void *glMapBufferRange(GLenum target, intptr_t offset, intptr_t length, GLbitfield access);
__attribute__((import_module("gl"), import_name("glUnmapBuffer")))
extern GLboolean glUnmapBuffer(GLenum target);
#define GL_MAP_WRITE_BIT 0x0002

#define W 64
#define H 64

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;
static GLuint buf;

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION; info.width = W; info.height = H;
    info.input_ptr = (uint32_t)pads; info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info; info.gpu_api = 1;
    return &info;
}

__attribute__((export_name("wc_init"))) void wc_init(void) {}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    glClearColor(0.0f, 0.5f, 1.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
}

/* glGetString(name) through the host; returns the pointer it gave back. */
__attribute__((export_name("t_gl_string")))
const char *t_gl_string(unsigned name) {
    t_phase(1);
    const char *s = (const char *)glGetString(name);
    t_phase(0);
    return s;
}

__attribute__((export_name("t_gl_stringi")))
const char *t_gl_stringi(unsigned name, unsigned i) {
    t_phase(1);
    const char *s = (const char *)glGetStringi(name, i);
    t_phase(0);
    return s;
}

/* Map `len` bytes of a buffer for writing, fill them with `byte`, unmap.
   Returns the mapped pointer the host gave (0 if it gave none). */
__attribute__((export_name("t_map")))
uint32_t t_map(unsigned len, unsigned byte) {
    if (!buf) glGenBuffers(1, &buf);
    glBindBuffer(GL_ARRAY_BUFFER, buf);
    glBufferData(GL_ARRAY_BUFFER, len, 0, GL_DYNAMIC_DRAW);
    t_phase(2);
    uint8_t *p = (uint8_t *)glMapBufferRange(GL_ARRAY_BUFFER, 0, len, GL_MAP_WRITE_BIT);
    t_phase(0);
    if (!p) return 0;
    for (unsigned i = 0; i < len; i++) p[i] = (uint8_t)byte;
    glUnmapBuffer(GL_ARRAY_BUFFER);
    return (uint32_t)p;
}

__attribute__((export_name("t_buffer"))) unsigned t_buffer(void) { return buf; }
