/*
 * alloc_count.h - a counting wc_alloc/wc_free for test fixtures.
 *
 * Replaces wasmcart.h's pair (define WASMCART_NO_ALLOC before including
 * wasmcart.h, then include this) so a test can see which host paths allocated
 * through it, and can make it misbehave to check the host's bounds checks.
 * SPEC.md, "Cart memory the host writes".
 *
 *   t_allocs(phase)  allocations made while the cart was in `phase`
 *                    (t_phase sets it; 0 = anything else)
 *   t_frees()        wc_free calls
 *   t_alloc_mode(m)  0 normal; 1 return a pointer past the end of memory;
 *                    2 return a misaligned pointer; 3 return 0 (out of memory)
 */
#ifndef ALLOC_COUNT_H
#define ALLOC_COUNT_H
#include <stdlib.h>
#include <stdint.h>

static volatile int ac_phase, ac_mode, ac_frees;
static volatile int ac_allocs[8];

__attribute__((export_name("wc_alloc")))
void *wc_alloc(size_t size, size_t align) {
    ac_allocs[ac_phase & 7]++;
    if (ac_mode == 1) return (void *)(uintptr_t)0xFFFFFFF0u;
    if (ac_mode == 3) return NULL;
    size_t a = align < sizeof(void *) ? sizeof(void *) : align;
    size_t n = size ? (size + a - 1) & ~(a - 1) : a;
    char *p = aligned_alloc(a, n + (ac_mode == 2 ? a : 0));
    return ac_mode == 2 && p ? p + 1 : p;
}

__attribute__((export_name("wc_free")))
void wc_free(void *p) { ac_frees++; free(p); }

__attribute__((export_name("t_allocs"))) int t_allocs(int phase) { return ac_allocs[phase & 7]; }
__attribute__((export_name("t_frees"))) int t_frees(void) { return ac_frees; }
__attribute__((export_name("t_alloc_mode"))) void t_alloc_mode(int m) { ac_mode = m; }
static inline void t_phase(int p) { ac_phase = p; }
#endif
