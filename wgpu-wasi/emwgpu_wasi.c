/* What an Emscripten link gives a WebGPU cart and wasi-sdk does not. The
 * host's WebGPU glue (generated from emdawnwebgpu) calls back into the cart
 * for these, so a wasi-sdk cart compiles this file in (wasmcart-wgpu-wasi.cmake
 * does it) and exports the names in exports.txt.
 *
 * - memalign: the glue places mapped buffer ranges in the cart's memory with
 *   it. wasi-libc declares it in <malloc.h> but does not define it.
 * - Emscripten's three stack helpers: the glue passes strings and small
 *   structs on the cart's stack. They only move __stack_pointer, which under
 *   wasi-threads is per thread, as it should be. */
#include <stdlib.h>

__attribute__((export_name("memalign")))
void *memalign(size_t alignment, size_t size) {
    void *p = NULL;
    if (alignment < sizeof(void *)) alignment = sizeof(void *);
    return posix_memalign(&p, alignment, size) == 0 ? p : NULL;
}

__asm__(".globaltype __stack_pointer, i32\n");

__attribute__((export_name("emscripten_stack_get_current")))
void *emscripten_stack_get_current(void) {
    void *sp;
    __asm__ volatile("global.get __stack_pointer\n\tlocal.set %0" : "=r"(sp));
    return sp;
}

__attribute__((export_name("_emscripten_stack_restore")))
void _emscripten_stack_restore(void *sp) {
    __asm__ volatile("local.get %0\n\tglobal.set __stack_pointer" : : "r"(sp));
}

__attribute__((export_name("_emscripten_stack_alloc")))
void *_emscripten_stack_alloc(size_t size) {
    void *sp;
    __asm__ volatile(
        "global.get __stack_pointer\n\t"
        "local.get %1\n\t"
        "i32.sub\n\t"
        "i32.const -16\n\t"
        "i32.and\n\t"
        "local.tee %0\n\t"
        "global.set __stack_pointer"
        : "=r"(sp) : "r"(size));
    return sp;
}
