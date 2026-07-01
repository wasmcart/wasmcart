/*
 * wc_math.h - Math functions without libm for wasmcart carts
 *
 * Single-header library providing trig, sqrt, atan2, and utility math
 * functions that don't require linking against libm. Useful for WASM
 * carts compiled with -nostdlib or minimal libc.
 *
 * USAGE:
 *   #include "wc_math.h"
 *
 * All functions are static inline, so just include this header wherever
 * you need math. No separate .c file needed. No link dependencies.
 *
 * ACCURACY:
 *   - wc_sinf/wc_cosf: ~0.001 max error (Bhaskara I approximation)
 *   - wc_sqrtf: ~1e-6 relative error (10 Newton-Raphson iterations)
 *   - wc_atan2f: ~0.01 max error (polynomial approximation)
 *   - wc_tanf: limited near pi/2 (clamped denominator)
 *
 * If you need full libm precision, link against libm instead.
 */

#ifndef WC_MATH_H
#define WC_MATH_H

/* ── Constants ────────────────────────────────────────────────────── */

#define WC_PI       3.14159265358979f
#define WC_TWO_PI   6.28318530717959f
#define WC_HALF_PI  1.57079632679490f
#define WC_DEG2RAD  (WC_PI / 180.0f)
#define WC_RAD2DEG  (180.0f / WC_PI)

/* ── Basic utilities ──────────────────────────────────────────────── */

static inline float wc_fabsf(float x) {
    return x < 0.0f ? -x : x;
}

static inline float wc_fmodf(float a, float b) {
    return a - (int)(a / b) * b;
}

static inline float wc_floorf(float x) {
    int i = (int)x;
    return (float)(x < (float)i ? i - 1 : i);
}

static inline float wc_clampf(float v, float lo, float hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static inline float wc_lerpf(float a, float b, float t) {
    return a + (b - a) * t;
}

static inline float wc_signf(float x) {
    return x > 0.0f ? 1.0f : (x < 0.0f ? -1.0f : 0.0f);
}

static inline float wc_minf(float a, float b) { return a < b ? a : b; }
static inline float wc_maxf(float a, float b) { return a > b ? a : b; }

/* ── Trigonometry (Bhaskara I approximation) ──────────────────────── */

static inline float wc_sinf(float x) {
    x = wc_fmodf(x, WC_TWO_PI);
    if (x > WC_PI) x -= WC_TWO_PI;
    if (x < -WC_PI) x += WC_TWO_PI;
    float a = wc_fabsf(x);
    return 16.0f * x * (WC_PI - a) /
           (5.0f * WC_PI * WC_PI - 4.0f * x * (WC_PI - a));
}

static inline float wc_cosf(float x) {
    return wc_sinf(x + WC_HALF_PI);
}

static inline float wc_tanf(float x) {
    float c = wc_cosf(x);
    if (wc_fabsf(c) < 0.0001f) c = 0.0001f;
    return wc_sinf(x) / c;
}

/* ── Square root (Newton-Raphson, 10 iterations) ──────────────────── */

static inline float wc_sqrtf(float x) {
    if (x <= 0.0f) return 0.0f;
    float g = x * 0.5f;
    for (int i = 0; i < 10; i++)
        g = 0.5f * (g + x / g);
    return g;
}

/* ── Atan2 (polynomial approximation) ─────────────────────────────── */

static inline float wc_atan2f(float y, float x) {
    if (x == 0.0f) {
        if (y > 0.0f) return WC_HALF_PI;
        if (y < 0.0f) return -WC_HALF_PI;
        return 0.0f;
    }
    float abs_x = wc_fabsf(x);
    float abs_y = wc_fabsf(y);
    float a = (abs_x < abs_y) ? abs_x / abs_y : abs_y / abs_x;
    float s = a * a;
    float r = ((-0.0464964749f * s + 0.15931422f) * s - 0.327622764f) * s * a + a;
    if (abs_y > abs_x) r = WC_HALF_PI - r;
    if (x < 0.0f) r = WC_PI - r;
    if (y < 0.0f) r = -r;
    return r;
}

#endif /* WC_MATH_H */
