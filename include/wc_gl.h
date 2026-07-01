/*
 * wc_gl.h - Common OpenGL ES 3.0 utilities for wasmcart GL carts
 *
 * Single-header library providing shader compilation, program linking,
 * and other GL boilerplate that's identical across all GL carts.
 *
 * USAGE:
 *   #include "wasmcart.h"   // must define WC_USE_GL before including
 *   #include "wc_gl.h"
 *
 * All functions are static inline. No separate .c file needed.
 */

#ifndef WC_GL_H
#define WC_GL_H

/* ── Shader compilation ───────────────────────────────────────────── */

/*
 * Compile a single shader (vertex or fragment).
 * Returns the shader handle. No error checking (WASM has no stderr).
 */
static inline GLuint wc_compile_shader(GLenum type, const char *src) {
    GLuint s = glCreateShader(type);
    const char *strings[1] = { src };
    glShaderSource(s, 1, strings, 0);
    glCompileShader(s);
    return s;
}

/*
 * Compile vertex + fragment shaders and link into a program.
 * Deletes the individual shaders after linking.
 * Returns the program handle.
 */
static inline GLuint wc_link_program(const char *vs_src, const char *fs_src) {
    GLuint vs = wc_compile_shader(GL_VERTEX_SHADER, vs_src);
    GLuint fs = wc_compile_shader(GL_FRAGMENT_SHADER, fs_src);
    GLuint prog = glCreateProgram();
    glAttachShader(prog, vs);
    glAttachShader(prog, fs);
    glLinkProgram(prog);
    glDeleteShader(vs);
    glDeleteShader(fs);
    return prog;
}

/* ── Resolution negotiation ───────────────────────────────────────── */

/*
 * Read host preferred resolution, clamp to max, update width/height.
 * Call in wc_init() after host_info has been written.
 *
 *   host      - pointer to host_info struct (written by host before wc_init)
 *   width     - pointer to current width (updated in place)
 *   height    - pointer to current height (updated in place)
 *   max_w     - maximum width the cart supports
 *   max_h     - maximum height the cart supports
 */
static inline void wc_negotiate_resolution(const wc_host_info_t *host,
                                           uint32_t *width, uint32_t *height,
                                           uint32_t max_w, uint32_t max_h) {
    if (host->preferred_width > 0 && host->preferred_height > 0) {
        *width  = host->preferred_width;
        *height = host->preferred_height;
        if (*width  > max_w) *width  = max_w;
        if (*height > max_h) *height = max_h;
    }
}

/* ── Common GL state setup ────────────────────────────────────────── */

/*
 * Set up typical 2D GL state: viewport, alpha blending, no depth test.
 * Good default for 2D games, menus, HUD rendering.
 */
static inline void wc_gl_setup_2d(uint32_t width, uint32_t height) {
    glViewport(0, 0, width, height);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glDisable(GL_DEPTH_TEST);
}

/*
 * Set up typical 3D GL state: viewport, alpha blending, depth test enabled.
 * Good default for 3D games.
 */
static inline void wc_gl_setup_3d(uint32_t width, uint32_t height) {
    glViewport(0, 0, width, height);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_LEQUAL);
}

/* ── VAO/VBO creation helpers ─────────────────────────────────────── */

/*
 * Create a simple VAO + VBO pair for dynamic vertex data.
 * Allocates max_bytes of GL_DYNAMIC_DRAW storage.
 * Returns the VBO handle (for later glBufferSubData calls).
 * The VAO is bound after this call.
 */
static inline GLuint wc_create_dynamic_vbo(GLuint *vao, int max_bytes) {
    GLuint vbo;
    glGenVertexArrays(1, vao);
    glBindVertexArray(*vao);
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, max_bytes, 0, GL_DYNAMIC_DRAW);
    return vbo;
}

/*
 * Create a VAO + VBO pair with static vertex data.
 * Uploads data immediately. Returns the VBO handle.
 * The VAO is bound after this call.
 */
static inline GLuint wc_create_static_vbo(GLuint *vao,
                                          const void *data, int size_bytes) {
    GLuint vbo;
    glGenVertexArrays(1, vao);
    glBindVertexArray(*vao);
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, size_bytes, data, GL_STATIC_DRAW);
    return vbo;
}

/* ── Texture loading from WASM memory ─────────────────────────────── */

/*
 * IMPORTANT: Texture vertical flip convention
 *
 * stb_image loads images top-to-bottom (row 0 = top of image).
 * Whether you need to flip before uploading depends on the original
 * game's framework:
 *
 *   SDL games:  Flip vertically before glTexImage2D.
 *               SDL + standard GL convention: V=0 = bottom of image.
 *               The game's tex coords expect V=0 at the bottom.
 *
 *   SFML games: Do NOT flip. SFML convention: V=0 = top of image.
 *               stb_image's top-first output already matches.
 *               Flipping will invert ALL textures (trees, sprites,
 *               skybox, HUD - everything).
 *
 *   Raw GL:     Check the game's tex coord usage to determine which
 *               convention it expects.
 *
 * The functions below upload pixels as-is (no flip). If you need to
 * flip for an SDL-based port, do it before calling these functions.
 */

/*
 * Upload RGBA pixel data to a new GL texture with typical settings.
 * Returns the texture handle.
 *
 * Use with stb_image: decode image → get RGBA pixels → call this.
 */
static inline GLuint wc_create_texture_rgba(const unsigned char *pixels,
                                            int width, int height) {
    GLuint tex;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    return tex;
}

/*
 * Create a texture with nearest-neighbor filtering (pixel art).
 */
static inline GLuint wc_create_texture_nearest(const unsigned char *pixels,
                                               int width, int height) {
    GLuint tex;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    return tex;
}

/* ── Simple PRNG (xorshift32) ─────────────────────────────────────── */
/* Duplicated in 5+ carts. Included here since GL carts commonly need it
 * for particle effects, procedural generation, etc. */

static unsigned int _wc_rng_state = 12345;

static inline void wc_srand(unsigned int seed) {
    _wc_rng_state = seed ? seed : 1;
}

static inline unsigned int wc_rand(void) {
    _wc_rng_state ^= _wc_rng_state << 13;
    _wc_rng_state ^= _wc_rng_state >> 17;
    _wc_rng_state ^= _wc_rng_state << 5;
    return _wc_rng_state;
}

/* Random float in [0, 1) */
static inline float wc_randf(void) {
    return (float)(wc_rand() % 10000) / 10000.0f;
}

/* Random float in [lo, hi) */
static inline float wc_randf_range(float lo, float hi) {
    return lo + wc_randf() * (hi - lo);
}

/* Random int in [0, max) */
static inline int wc_rand_range(int max) {
    return (int)(wc_rand() % (unsigned int)max);
}

#endif /* WC_GL_H */
