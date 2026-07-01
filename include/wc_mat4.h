/*
 * wc_mat4.h - 4x4 matrix operations for wasmcart GL carts
 *
 * Single-header library providing column-major 4x4 matrix operations
 * for OpenGL-style rendering. Uses wc_math.h for trig functions.
 *
 * USAGE:
 *   #include "wc_math.h"
 *   #include "wc_mat4.h"
 *
 * All functions are static inline. No separate .c file needed.
 *
 * CONVENTIONS:
 *   - Column-major layout (OpenGL convention)
 *   - mat4[col*4 + row], e.g. mat4[12] = translation X
 *   - Right-handed coordinate system
 *   - Angles in radians unless noted (wc_mat4_perspective takes radians)
 *   - wc_mat4_rotate takes degrees (matches glRotatef convention)
 */

#ifndef WC_MAT4_H
#define WC_MAT4_H

#ifndef WC_MATH_H
#error "Include wc_math.h before wc_mat4.h"
#endif

/* ── Type ─────────────────────────────────────────────────────────── */

typedef float wc_mat4[16];

/* ── Identity ─────────────────────────────────────────────────────── */

static inline void wc_mat4_identity(wc_mat4 m) {
    for (int i = 0; i < 16; i++) m[i] = 0.0f;
    m[0] = m[5] = m[10] = m[15] = 1.0f;
}

static inline int wc_mat4_is_identity(const wc_mat4 m) {
    const float e = 0.0001f;
    for (int i = 0; i < 16; i++) {
        float expected = (i == 0 || i == 5 || i == 10 || i == 15) ? 1.0f : 0.0f;
        float d = m[i] - expected;
        if (d > e || d < -e) return 0;
    }
    return 1;
}

/* ── Copy ─────────────────────────────────────────────────────────── */

static inline void wc_mat4_copy(wc_mat4 dst, const wc_mat4 src) {
    for (int i = 0; i < 16; i++) dst[i] = src[i];
}

/* ── Multiply: out = a * b ────────────────────────────────────────── */
/* out may alias a or b safely (uses temp buffer) */

static inline void wc_mat4_multiply(wc_mat4 out, const wc_mat4 a, const wc_mat4 b) {
    wc_mat4 tmp;
    for (int c = 0; c < 4; c++)
        for (int r = 0; r < 4; r++) {
            tmp[c*4+r] = 0.0f;
            for (int k = 0; k < 4; k++)
                tmp[c*4+r] += a[k*4+r] * b[c*4+k];
        }
    for (int i = 0; i < 16; i++) out[i] = tmp[i];
}

/* ── Transform operations (modify m in-place, post-multiply) ───── */

/* Translate: m = m * T(x,y,z) */
static inline void wc_mat4_translate(wc_mat4 m, float x, float y, float z) {
    m[12] += m[0]*x + m[4]*y + m[8]*z;
    m[13] += m[1]*x + m[5]*y + m[9]*z;
    m[14] += m[2]*x + m[6]*y + m[10]*z;
}

/* Scale: m = m * S(x,y,z) */
static inline void wc_mat4_scale(wc_mat4 m, float x, float y, float z) {
    m[0] *= x; m[1] *= x; m[2]  *= x; m[3]  *= x;
    m[4] *= y; m[5] *= y; m[6]  *= y; m[7]  *= y;
    m[8] *= z; m[9] *= z; m[10] *= z; m[11] *= z;
}

/* Rotate: m = m * R(angle_deg, ax, ay, az) - matches glRotatef */
static inline void wc_mat4_rotate(wc_mat4 m, float angle_deg, float ax, float ay, float az) {
    float rad = angle_deg * WC_DEG2RAD;
    float c = wc_cosf(rad), s = wc_sinf(rad), t = 1.0f - c;
    /* Normalize axis */
    float len = ax*ax + ay*ay + az*az;
    if (len > 0.0001f) {
        float il = 1.0f / wc_sqrtf(len);
        ax *= il; ay *= il; az *= il;
    }
    wc_mat4 rot;
    rot[0] = t*ax*ax+c;     rot[4] = t*ax*ay-s*az;  rot[8]  = t*ax*az+s*ay;  rot[12] = 0;
    rot[1] = t*ax*ay+s*az;  rot[5] = t*ay*ay+c;     rot[9]  = t*ay*az-s*ax;  rot[13] = 0;
    rot[2] = t*ax*az-s*ay;  rot[6] = t*ay*az+s*ax;  rot[10] = t*az*az+c;     rot[14] = 0;
    rot[3] = 0;             rot[7] = 0;              rot[11] = 0;             rot[15] = 1;
    wc_mat4 tmp;
    wc_mat4_copy(tmp, m);
    wc_mat4_multiply(m, tmp, rot);
}

/* ── Projection matrices (write from scratch, not in-place) ──────── */

/* Perspective projection: fovy in radians, outputs to m */
static inline void wc_mat4_perspective(wc_mat4 m, float fovy_rad, float aspect,
                                       float znear, float zfar) {
    float f = wc_cosf(fovy_rad * 0.5f) / wc_sinf(fovy_rad * 0.5f);
    for (int i = 0; i < 16; i++) m[i] = 0.0f;
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (zfar + znear) / (znear - zfar);
    m[11] = -1.0f;
    m[14] = (2.0f * zfar * znear) / (znear - zfar);
}

/* Perspective projection: fovy in degrees (matches gluPerspective) */
static inline void wc_mat4_perspective_deg(wc_mat4 m, float fovy_deg, float aspect,
                                           float znear, float zfar) {
    wc_mat4_perspective(m, fovy_deg * WC_DEG2RAD, aspect, znear, zfar);
}

/* Orthographic projection */
static inline void wc_mat4_ortho(wc_mat4 m, float left, float right,
                                 float bottom, float top,
                                 float znear, float zfar) {
    for (int i = 0; i < 16; i++) m[i] = 0.0f;
    m[0]  =  2.0f / (right - left);
    m[5]  =  2.0f / (top - bottom);
    m[10] = -2.0f / (zfar - znear);
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
    m[14] = -(zfar + znear) / (zfar - znear);
    m[15] = 1.0f;
}

/* ── View matrix ──────────────────────────────────────────────────── */

/* LookAt: build a view matrix (matches gluLookAt) */
static inline void wc_mat4_look_at(wc_mat4 m,
                                   float eye_x, float eye_y, float eye_z,
                                   float center_x, float center_y, float center_z,
                                   float up_x, float up_y, float up_z) {
    /* Forward = normalize(center - eye) */
    float fx = center_x - eye_x, fy = center_y - eye_y, fz = center_z - eye_z;
    float fl = wc_sqrtf(fx*fx + fy*fy + fz*fz);
    if (fl > 0.0001f) { fx /= fl; fy /= fl; fz /= fl; }

    /* Side = normalize(forward x up) */
    float sx = fy*up_z - fz*up_y;
    float sy = fz*up_x - fx*up_z;
    float sz = fx*up_y - fy*up_x;
    float sl = wc_sqrtf(sx*sx + sy*sy + sz*sz);
    if (sl > 0.0001f) { sx /= sl; sy /= sl; sz /= sl; }

    /* Recomputed up = side x forward */
    float ux = sy*fz - sz*fy;
    float uy = sz*fx - sx*fz;
    float uz = sx*fy - sy*fx;

    for (int i = 0; i < 16; i++) m[i] = 0.0f;
    m[0] = sx;  m[4] = sy;  m[8]  = sz;
    m[1] = ux;  m[5] = uy;  m[9]  = uz;
    m[2] = -fx; m[6] = -fy; m[10] = -fz;
    m[12] = -(sx*eye_x + sy*eye_y + sz*eye_z);
    m[13] = -(ux*eye_x + uy*eye_y + uz*eye_z);
    m[14] =  (fx*eye_x + fy*eye_y + fz*eye_z);
    m[15] = 1.0f;
}

/* ── Single-axis rotation helpers (write from scratch) ────────────── */

static inline void wc_mat4_rotate_x(wc_mat4 m, float angle_rad) {
    wc_mat4_identity(m);
    float c = wc_cosf(angle_rad), s = wc_sinf(angle_rad);
    m[5] = c;  m[6] = s;
    m[9] = -s; m[10] = c;
}

static inline void wc_mat4_rotate_y(wc_mat4 m, float angle_rad) {
    wc_mat4_identity(m);
    float c = wc_cosf(angle_rad), s = wc_sinf(angle_rad);
    m[0] = c;  m[2] = -s;
    m[8] = s;  m[10] = c;
}

static inline void wc_mat4_rotate_z(wc_mat4 m, float angle_rad) {
    wc_mat4_identity(m);
    float c = wc_cosf(angle_rad), s = wc_sinf(angle_rad);
    m[0] = c;  m[1] = s;
    m[4] = -s; m[5] = c;
}

/* ── Translation helper (write from scratch) ──────────────────────── */

static inline void wc_mat4_from_translation(wc_mat4 m, float x, float y, float z) {
    wc_mat4_identity(m);
    m[12] = x; m[13] = y; m[14] = z;
}

/* ── Scale helper (write from scratch) ────────────────────────────── */

static inline void wc_mat4_from_scale(wc_mat4 m, float x, float y, float z) {
    wc_mat4_identity(m);
    m[0] = x; m[5] = y; m[10] = z;
}

#endif /* WC_MAT4_H */
