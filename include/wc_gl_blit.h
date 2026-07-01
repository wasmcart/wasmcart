/*
 * wc_gl_blit.h - Upload CPU pixels to GPU via GL texture + fullscreen quad
 *
 * The standard display path for ALL wasmcart carts. Even 2D framebuffer
 * carts upload their pixels as a GL texture and draw a fullscreen quad.
 * This means every cart uses gpu_api=1 and the host always uses the GL
 * display path (swapBuffers).
 *
 * USAGE:
 *
 *   #define WC_USE_GL
 *   #include "wasmcart.h"
 *   #include "wc_gl_blit.h"
 *
 *   // In wc_get_info():
 *   info.gpu_api = 1;  // always GL
 *
 *   // In wc_render(), after drawing to your pixel buffer:
 *   wc_gl_blit(pixels, width, height);
 *
 * The first call compiles a blit shader and creates a texture.
 * Subsequent calls just upload pixels and draw the quad.
 *
 * Pixel format: RGBA8888 (4 bytes per pixel, R first).
 * If your buffer is XRGB/BGRA, convert before calling.
 *
 * For carts that render via GL directly (WebGL, three.js, etc.),
 * don't call wc_gl_blit - the GL output is already on screen.
 *
 * STB-STYLE SINGLE-HEADER LIBRARY
 * Define WC_GL_BLIT_IMPLEMENTATION in exactly ONE .c file before including.
 */

#ifndef WC_GL_BLIT_H
#define WC_GL_BLIT_H

#ifndef WASMCART_H
#error "Include wasmcart.h (with WC_USE_GL) before wc_gl_blit.h"
#endif

/* Upload RGBA pixels to a GL texture and draw a fullscreen quad.
 * Call once per frame after all CPU rendering is done. */
static void wc_gl_blit(const void *pixels, int width, int height);

#ifdef WC_GL_BLIT_IMPLEMENTATION

static GLuint _wc_blit_tex = 0;
static GLuint _wc_blit_program = 0;
static GLuint _wc_blit_vao = 0;
static GLuint _wc_blit_vbo = 0;
static int _wc_blit_ready = 0;

static void _wc_blit_init(int width, int height) {
    const char *vs_src =
        "#version 300 es\n"
        "in vec2 aPos;\n"
        "out vec2 vUV;\n"
        "void main() {\n"
        "  vUV = aPos * 0.5 + 0.5;\n"
        "  vUV.y = 1.0 - vUV.y;\n"
        "  gl_Position = vec4(aPos, 0.0, 1.0);\n"
        "}\n";
    const char *fs_src =
        "#version 300 es\n"
        "precision mediump float;\n"
        "in vec2 vUV;\n"
        "uniform sampler2D uTex;\n"
        "out vec4 fragColor;\n"
        "void main() {\n"
        "  fragColor = texture(uTex, vUV);\n"
        "}\n";

    GLuint vs = glCreateShader(GL_VERTEX_SHADER);
    GLint vs_len = (GLint)__builtin_strlen(vs_src);
    glShaderSource(vs, 1, &vs_src, &vs_len);
    glCompileShader(vs);

    GLuint fs = glCreateShader(GL_FRAGMENT_SHADER);
    GLint fs_len = (GLint)__builtin_strlen(fs_src);
    glShaderSource(fs, 1, &fs_src, &fs_len);
    glCompileShader(fs);

    _wc_blit_program = glCreateProgram();
    glAttachShader(_wc_blit_program, vs);
    glAttachShader(_wc_blit_program, fs);
    glLinkProgram(_wc_blit_program);

    float quad[] = { -1,-1, 1,-1, -1,1, 1,1 };
    glGenVertexArrays(1, &_wc_blit_vao);
    glBindVertexArray(_wc_blit_vao);
    glGenBuffers(1, &_wc_blit_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, _wc_blit_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(quad), quad, GL_STATIC_DRAW);

    GLint aPos = glGetAttribLocation(_wc_blit_program, "aPos");
    glEnableVertexAttribArray(aPos);
    glVertexAttribPointer(aPos, 2, GL_FLOAT, GL_FALSE, 0, 0);

    glGenTextures(1, &_wc_blit_tex);
    glBindTexture(GL_TEXTURE_2D, _wc_blit_tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    _wc_blit_ready = 1;
}

static void wc_gl_blit(const void *pixels, int width, int height) {
    if (!_wc_blit_ready) _wc_blit_init(width, height);
    if (!_wc_blit_ready) return;

    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, width, height);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_BLEND);

    glBindTexture(GL_TEXTURE_2D, _wc_blit_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0,
                  GL_RGBA, GL_UNSIGNED_BYTE, pixels);

    glUseProgram(_wc_blit_program);
    glUniform1i(glGetUniformLocation(_wc_blit_program, "uTex"), 0);
    glBindVertexArray(_wc_blit_vao);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

#endif /* WC_GL_BLIT_IMPLEMENTATION */
#endif /* WC_GL_BLIT_H */
