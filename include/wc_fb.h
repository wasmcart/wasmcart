/*
 * wc_fb.h - 2D framebuffer drawing primitives for wasmcart carts
 *
 * Software rendering functions that replace SDL_RenderCopy, SDL_FillRect,
 * SDL_BlitSurface, etc. for 2D carts using the wasmcart XRGB8888 framebuffer.
 *
 * All functions take the framebuffer pointer, width, and height as parameters
 * so they work with any cart's buffer layout. All are static inline.
 *
 * USAGE:
 *   #include "wc_fb.h"
 *
 *   // Fill a rect:
 *   wc_fb_fill(framebuffer, WIDTH, HEIGHT, 10, 20, 100, 50, 0xFF0000);
 *
 *   // Blit indexed sprite with palette:
 *   wc_fb_blit_indexed(framebuffer, WIDTH, HEIGHT,
 *                      sprite_data, sprite_stride, palette,
 *                      sx, sy, sw, sh, dx, dy);
 *
 *   // Blit RGBA pixels with transparency:
 *   wc_fb_blit_rgba(framebuffer, WIDTH, HEIGHT,
 *                   pixels, src_w, sx, sy, sw, sh, dx, dy);
 *
 * PIXEL FORMAT:
 *   Framebuffer is uint32_t XRGB8888: 0x00RRGGBB
 *   RGBA source data is uint32_t: 0xAARRGGBB (alpha in high byte)
 */

#ifndef WC_FB_H
#define WC_FB_H

#include <stdint.h>

/* ── Color helpers ────────────────────────────────────────────────── */

#define WC_RGB(r, g, b)    (((uint32_t)(r) << 16) | ((uint32_t)(g) << 8) | (uint32_t)(b))
#define WC_RGBA(r, g, b, a) (((uint32_t)(a) << 24) | ((uint32_t)(r) << 16) | ((uint32_t)(g) << 8) | (uint32_t)(b))

#define WC_R(c) (((c) >> 16) & 0xFF)
#define WC_G(c) (((c) >>  8) & 0xFF)
#define WC_B(c) ( (c)        & 0xFF)
#define WC_A(c) (((c) >> 24) & 0xFF)

/* ── Single pixel ─────────────────────────────────────────────────── */

static inline void wc_fb_pixel(uint32_t *fb, int fb_w, int fb_h,
                               int x, int y, uint32_t color) {
    if (x >= 0 && x < fb_w && y >= 0 && y < fb_h)
        fb[y * fb_w + x] = color;
}

/* ── Fill rect (solid color, no blending) ─────────────────────────── */

static inline void wc_fb_fill(uint32_t *fb, int fb_w, int fb_h,
                              int x, int y, int w, int h, uint32_t color) {
    int x0 = x < 0 ? 0 : x;
    int y0 = y < 0 ? 0 : y;
    int x1 = x + w > fb_w ? fb_w : x + w;
    int y1 = y + h > fb_h ? fb_h : y + h;
    for (int row = y0; row < y1; row++)
        for (int col = x0; col < x1; col++)
            fb[row * fb_w + col] = color;
}

/* ── Fill rect with alpha blending ────────────────────────────────── */

static inline void wc_fb_fill_alpha(uint32_t *fb, int fb_w, int fb_h,
                                    int x, int y, int w, int h,
                                    uint32_t color, int alpha) {
    int x0 = x < 0 ? 0 : x;
    int y0 = y < 0 ? 0 : y;
    int x1 = x + w > fb_w ? fb_w : x + w;
    int y1 = y + h > fb_h ? fb_h : y + h;
    int sr = WC_R(color), sg = WC_G(color), sb = WC_B(color);
    int inv = 255 - alpha;
    for (int row = y0; row < y1; row++)
        for (int col = x0; col < x1; col++) {
            uint32_t dst = fb[row * fb_w + col];
            int dr = WC_R(dst), dg = WC_G(dst), db = WC_B(dst);
            int rr = (sr * alpha + dr * inv) / 255;
            int gg = (sg * alpha + dg * inv) / 255;
            int bb = (sb * alpha + db * inv) / 255;
            fb[row * fb_w + col] = WC_RGB(rr, gg, bb);
        }
}

/* ── Clear entire framebuffer ─────────────────────────────────────── */

static inline void wc_fb_clear(uint32_t *fb, int fb_w, int fb_h, uint32_t color) {
    int total = fb_w * fb_h;
    for (int i = 0; i < total; i++)
        fb[i] = color;
}

/* ── Horizontal line (fast) ───────────────────────────────────────── */

static inline void wc_fb_hline(uint32_t *fb, int fb_w, int fb_h,
                               int x, int y, int w, uint32_t color) {
    if (y < 0 || y >= fb_h) return;
    int x0 = x < 0 ? 0 : x;
    int x1 = x + w > fb_w ? fb_w : x + w;
    for (int col = x0; col < x1; col++)
        fb[y * fb_w + col] = color;
}

/* ── Vertical line ────────────────────────────────────────────────── */

static inline void wc_fb_vline(uint32_t *fb, int fb_w, int fb_h,
                               int x, int y, int h, uint32_t color) {
    if (x < 0 || x >= fb_w) return;
    int y0 = y < 0 ? 0 : y;
    int y1 = y + h > fb_h ? fb_h : y + h;
    for (int row = y0; row < y1; row++)
        fb[row * fb_w + x] = color;
}

/* ── Rect outline ─────────────────────────────────────────────────── */

static inline void wc_fb_rect(uint32_t *fb, int fb_w, int fb_h,
                              int x, int y, int w, int h, uint32_t color) {
    wc_fb_hline(fb, fb_w, fb_h, x, y, w, color);
    wc_fb_hline(fb, fb_w, fb_h, x, y + h - 1, w, color);
    wc_fb_vline(fb, fb_w, fb_h, x, y, h, color);
    wc_fb_vline(fb, fb_w, fb_h, x + w - 1, y, h, color);
}

/* ── Blit indexed palette sprite ──────────────────────────────────── */
/*
 * Blit a region from an indexed (8-bit) image using a palette LUT.
 * Index 0 = transparent (skipped). No scaling.
 *
 *   src       - pointer to indexed pixel data
 *   src_stride - width of full source image in pixels
 *   palette   - uint32_t[256] color lookup table (XRGB8888)
 *   sx,sy     - source region origin
 *   sw,sh     - source region size
 *   dx,dy     - destination position in framebuffer
 */
static inline void wc_fb_blit_indexed(uint32_t *fb, int fb_w, int fb_h,
                                      const uint8_t *src, int src_stride,
                                      const uint32_t *palette,
                                      int sx, int sy, int sw, int sh,
                                      int dx, int dy) {
    for (int py = 0; py < sh; py++) {
        int dst_y = dy + py;
        if (dst_y < 0 || dst_y >= fb_h) continue;
        int src_row = sy + py;
        if (src_row < 0) continue;
        for (int px = 0; px < sw; px++) {
            int dst_x = dx + px;
            if (dst_x < 0 || dst_x >= fb_w) continue;
            int src_col = sx + px;
            if (src_col < 0) continue;
            uint8_t idx = src[src_row * src_stride + src_col];
            if (idx == 0) continue; /* transparent */
            fb[dst_y * fb_w + dst_x] = palette[idx];
        }
    }
}

/* ── Blit indexed with custom transparent index ───────────────────── */

static inline void wc_fb_blit_indexed_key(uint32_t *fb, int fb_w, int fb_h,
                                          const uint8_t *src, int src_stride,
                                          const uint32_t *palette,
                                          int sx, int sy, int sw, int sh,
                                          int dx, int dy, uint8_t trans_idx) {
    for (int py = 0; py < sh; py++) {
        int dst_y = dy + py;
        if (dst_y < 0 || dst_y >= fb_h) continue;
        int src_row = sy + py;
        if (src_row < 0) continue;
        for (int px = 0; px < sw; px++) {
            int dst_x = dx + px;
            if (dst_x < 0 || dst_x >= fb_w) continue;
            int src_col = sx + px;
            if (src_col < 0) continue;
            uint8_t idx = src[src_row * src_stride + src_col];
            if (idx == trans_idx) continue;
            fb[dst_y * fb_w + dst_x] = palette[idx];
        }
    }
}

/* ── Blit XRGB pixels (color-key transparency) ────────────────────── */
/*
 * Blit a region of uint32_t XRGB pixels. Pixels matching color_key are
 * treated as transparent. Pass color_key=0xFFFFFFFF to disable keying
 * (blit all pixels).
 */
static inline void wc_fb_blit(uint32_t *fb, int fb_w, int fb_h,
                              const uint32_t *src, int src_w,
                              int sx, int sy, int sw, int sh,
                              int dx, int dy, uint32_t color_key) {
    for (int py = 0; py < sh; py++) {
        int dst_y = dy + py;
        if (dst_y < 0 || dst_y >= fb_h) continue;
        int src_row = sy + py;
        for (int px = 0; px < sw; px++) {
            int dst_x = dx + px;
            if (dst_x < 0 || dst_x >= fb_w) continue;
            int src_col = sx + px;
            uint32_t pixel = src[src_row * src_w + src_col];
            if (pixel == color_key) continue;
            fb[dst_y * fb_w + dst_x] = pixel;
        }
    }
}

/* ── Blit RGBA pixels with per-pixel alpha blending ───────────────── */
/*
 * Source pixels are uint32_t 0xAARRGGBB. Alpha 0 = transparent,
 * alpha 255 = opaque. Intermediate values are blended.
 */
static inline void wc_fb_blit_rgba(uint32_t *fb, int fb_w, int fb_h,
                                   const uint32_t *src, int src_w,
                                   int sx, int sy, int sw, int sh,
                                   int dx, int dy) {
    for (int py = 0; py < sh; py++) {
        int dst_y = dy + py;
        if (dst_y < 0 || dst_y >= fb_h) continue;
        int src_row = sy + py;
        for (int px = 0; px < sw; px++) {
            int dst_x = dx + px;
            if (dst_x < 0 || dst_x >= fb_w) continue;
            int src_col = sx + px;
            uint32_t spix = src[src_row * src_w + src_col];
            uint8_t sa = WC_A(spix);
            if (sa == 0) continue;
            if (sa == 255) {
                fb[dst_y * fb_w + dst_x] = spix & 0x00FFFFFF;
                continue;
            }
            /* Alpha blend */
            uint8_t inv = 255 - sa;
            uint32_t dpix = fb[dst_y * fb_w + dst_x];
            int rr = (WC_R(spix) * sa + WC_R(dpix) * inv) / 255;
            int gg = (WC_G(spix) * sa + WC_G(dpix) * inv) / 255;
            int bb = (WC_B(spix) * sa + WC_B(dpix) * inv) / 255;
            fb[dst_y * fb_w + dst_x] = WC_RGB(rr, gg, bb);
        }
    }
}

/* ── Blit with additive blending ──────────────────────────────────── */

static inline void wc_fb_blit_add(uint32_t *fb, int fb_w, int fb_h,
                                  const uint32_t *src, int src_w,
                                  int sx, int sy, int sw, int sh,
                                  int dx, int dy) {
    for (int py = 0; py < sh; py++) {
        int dst_y = dy + py;
        if (dst_y < 0 || dst_y >= fb_h) continue;
        int src_row = sy + py;
        for (int px = 0; px < sw; px++) {
            int dst_x = dx + px;
            if (dst_x < 0 || dst_x >= fb_w) continue;
            int src_col = sx + px;
            uint32_t spix = src[src_row * src_w + src_col];
            uint8_t sa = WC_A(spix);
            if (sa == 0) continue;
            uint32_t dpix = fb[dst_y * fb_w + dst_x];
            int rr = WC_R(dpix) + (WC_R(spix) * sa / 255);
            int gg = WC_G(dpix) + (WC_G(spix) * sa / 255);
            int bb = WC_B(dpix) + (WC_B(spix) * sa / 255);
            if (rr > 255) rr = 255;
            if (gg > 255) gg = 255;
            if (bb > 255) bb = 255;
            fb[dst_y * fb_w + dst_x] = WC_RGB(rr, gg, bb);
        }
    }
}

#endif /* WC_FB_H */
