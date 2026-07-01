/*
 * wc_vec3.h - 3D vector operations for wasmcart carts
 *
 * Single-header library providing vec3 struct and common operations.
 * Uses wc_math.h for sqrt.
 *
 * USAGE:
 *   #include "wc_math.h"
 *   #include "wc_vec3.h"
 */

#ifndef WC_VEC3_H
#define WC_VEC3_H

#ifndef WC_MATH_H
#error "Include wc_math.h before wc_vec3.h"
#endif

typedef struct { float x, y, z; } wc_vec3;

static inline wc_vec3 wc_v3(float x, float y, float z) {
    wc_vec3 v = {x, y, z};
    return v;
}

static inline wc_vec3 wc_v3_add(wc_vec3 a, wc_vec3 b) {
    return wc_v3(a.x + b.x, a.y + b.y, a.z + b.z);
}

static inline wc_vec3 wc_v3_sub(wc_vec3 a, wc_vec3 b) {
    return wc_v3(a.x - b.x, a.y - b.y, a.z - b.z);
}

static inline wc_vec3 wc_v3_scale(wc_vec3 a, float s) {
    return wc_v3(a.x * s, a.y * s, a.z * s);
}

static inline wc_vec3 wc_v3_neg(wc_vec3 a) {
    return wc_v3(-a.x, -a.y, -a.z);
}

static inline float wc_v3_dot(wc_vec3 a, wc_vec3 b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

static inline wc_vec3 wc_v3_cross(wc_vec3 a, wc_vec3 b) {
    return wc_v3(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x
    );
}

static inline float wc_v3_length(wc_vec3 a) {
    return wc_sqrtf(a.x * a.x + a.y * a.y + a.z * a.z);
}

static inline float wc_v3_length_sq(wc_vec3 a) {
    return a.x * a.x + a.y * a.y + a.z * a.z;
}

static inline wc_vec3 wc_v3_normalize(wc_vec3 a) {
    float l = wc_v3_length(a);
    if (l < 0.0001f) return wc_v3(0, 0, 0);
    return wc_v3_scale(a, 1.0f / l);
}

static inline wc_vec3 wc_v3_lerp(wc_vec3 a, wc_vec3 b, float t) {
    return wc_v3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t
    );
}

static inline float wc_v3_distance(wc_vec3 a, wc_vec3 b) {
    return wc_v3_length(wc_v3_sub(a, b));
}

#endif /* WC_VEC3_H */
