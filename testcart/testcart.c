/*
 * testcart -- wasmcart's host test cart: input, touch, sound and saves on one
 * screen, for a person to read at a glance and for a test to read by name.
 *
 * What a person sees (640x360, a 2D framebuffer, so it runs on every host,
 * including a GLES2 frontend's software path):
 *   - four pads, each a controller drawing: every WC_BTN_* lights when held
 *     (Guide, Misc, the four paddles and the touchpad click too), sticks are
 *     a dot in a circle, triggers a bar, with the raw values, the pad's name,
 *     the device the host says the player is on, and what the host calls the
 *     four face buttons (wc_action_origin: "A", "Cross", "Space")
 *   - every pointer slot (mouse is slot 0, fingers fill 1-9) as a numbered
 *     circle with a trail wherever it is on screen, the event tallies from
 *     wc_ptr_on_down/move/up, and the scroll wheel totals
 *   - the keyboard: keys held, modifiers, and the last keys pressed
 *   - sound: each face button plays its own note (A C5, B E5, X G5, Y C6) in
 *     a waveform that names the pad (P1 sine, P2 square, P3 triangle, P4 saw);
 *     holding L sends every note to the left channel only, R to the right
 *     only, so swapped channels are audible; LT bends down, RT up; a finger
 *     or click going down ticks; a scope draws what was written this frame
 *   - saves: the save block (32 KB) carries a magic word, a start counter, the
 *     frames the last session ran, press counts and a checksum, and the rest
 *     is a known pattern checked byte for byte on every start, so a host that
 *     loses, truncates or mangles the save shows it: FRESH, OK, CORRUPT or
 *     TRUNCATED. Holding SELECT+START for 3 seconds clears it (all zero), and
 *     the next start must then say FRESH, not bring the old save back
 *   - save states: the restore generation (wc_jit_config key 7) and how many
 *     restores this session saw
 *   - rumble: L3 runs the low motor, R3 the high one, on pads that have it
 *
 * What a test reads (WC_FLAG_DEBUG): every value above as a debug field; the
 * names are listed at WC_DEBUG_FIELDS below.
 *
 * Build: node testcart/build.mjs (clang with wasm-ld: WASM_CLANG, see there).
 */
#include "wasmcart.h"
#include "wc_cart.h"
#include "wc_fb.h"
#include "font8x8.h"

#define DEFAULT_WIDTH  640
#define DEFAULT_HEIGHT 360
#define MAX_WIDTH      640
#define MAX_HEIGHT     360
#define AUDIO_CAP      8192

#define W DEFAULT_WIDTH
#define H DEFAULT_HEIGHT

WC_CART_BUFFERS;

/* ---- small helpers (no libc) ---------------------------------------- */

static uint32_t str_len(const char *s) { uint32_t n = 0; while (s[n]) n++; return n; }

/* A line being built for the screen. */
typedef struct { char b[96]; uint32_t n; } line_t;

static void ln_reset(line_t *l) { l->n = 0; l->b[0] = 0; }
static void ln_str(line_t *l, const char *s) {
    while (*s && l->n < sizeof l->b - 1) l->b[l->n++] = *s++;
    l->b[l->n] = 0;
}
static void ln_chr(line_t *l, char c) {
    if (l->n < sizeof l->b - 1) l->b[l->n++] = c;
    l->b[l->n] = 0;
}
/* Signed decimal, right-aligned in `width` columns (0 = as wide as needed). */
static void ln_int(line_t *l, int32_t v, int width) {
    char tmp[12]; int n = 0;
    uint32_t u = v < 0 ? (uint32_t)(-(int64_t)v) : (uint32_t)v;
    do { tmp[n++] = (char)('0' + u % 10); u /= 10; } while (u);
    if (v < 0) tmp[n++] = '-';
    for (int i = n; i < width; i++) ln_chr(l, ' ');
    while (n) ln_chr(l, tmp[--n]);
}
static void ln_uint(line_t *l, uint32_t v) {
    char tmp[12]; int n = 0;
    do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    while (n) ln_chr(l, tmp[--n]);
}
static void ln_hex(line_t *l, uint32_t v, int digits) {
    for (int i = digits - 1; i >= 0; i--) ln_chr(l, "0123456789ABCDEF"[(v >> (i * 4)) & 15]);
}

/* ---- drawing --------------------------------------------------------- */

static uint32_t *fb = wc_framebuffer;

static void text(int x, int y, const char *s, uint32_t color) {
    for (; *s; s++, x += 8) {
        unsigned char c = (unsigned char)*s;
        if (c < 32 || c > 127) c = '?';
        const uint8_t *g = font8x8_basic[c - 32];
        for (int row = 0; row < 8; row++)
            for (int col = 0; col < 8; col++)
                if (g[row] & (1 << col)) wc_fb_pixel(fb, W, H, x + col, y + row, color);
    }
}

static void fill(int x, int y, int w, int h, uint32_t c) { wc_fb_fill(fb, W, H, x, y, w, h, c); }
static void box(int x, int y, int w, int h, uint32_t c) { wc_fb_rect(fb, W, H, x, y, w, h, c); }

static void circle(int cx, int cy, int r, uint32_t c, int filled) {
    for (int dy = -r; dy <= r; dy++)
        for (int dx = -r; dx <= r; dx++) {
            int d = dx * dx + dy * dy;
            if (filled ? d <= r * r : (d <= r * r && d > (r - 1) * (r - 1)))
                wc_fb_pixel(fb, W, H, cx + dx, cy + dy, c);
        }
}

static void line(int x0, int y0, int x1, int y1, uint32_t c) {
    int dx = x1 > x0 ? x1 - x0 : x0 - x1, sx = x0 < x1 ? 1 : -1;
    int dy = y1 > y0 ? y0 - y1 : y1 - y0, sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        wc_fb_pixel(fb, W, H, x0, y0, c);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

#define C_BG      0x101418
#define C_PANEL   0x1c232b
#define C_EDGE    0x3a4654
#define C_OFF     0x2e3844
#define C_ON      0x34e07a
#define C_TEXT    0xd8e0e8
#define C_DIM     0x7c8896
#define C_WARN    0xffb030
#define C_BAD     0xff4848
#define C_GOOD    0x34e07a

/* ---- input state ----------------------------------------------------- */

#define NBTN 21  /* WC_BTN_* bits 0-20 */

static uint8_t  pad_connected[4];
static uint32_t pad_buttons[4], pad_prev[4];
static int16_t  pad_lx[4], pad_ly[4], pad_rx[4], pad_ry[4], pad_lt[4], pad_rt[4];
static uint8_t  pad_rumble[4];
static int32_t  pad_device[4];
static char     pad_name[4][24];
static char     face_label[4][4][12];   /* [player][south,east,west,north] */
static int32_t  face_glyph[4];
static int32_t  face_action[4];
static uint32_t input_rev;

/* pointers */
#define TRAIL 24
static int16_t  trail_x[10][TRAIL], trail_y[10][TRAIL];
static uint8_t  trail_n[10], trail_head[10];
static uint16_t ptr_active_mask;
static int16_t  ptr_x[10], ptr_y[10];
static uint8_t  ptr_buttons[10];
static uint32_t ptr_downs, ptr_moves, ptr_ups;
static int32_t  wheel_total_x, wheel_total_y;

/* keyboard */
static uint8_t  key_log[8], key_log_n;
static uint8_t  key_mods, keys_held;
static uint32_t key_downs, key_ups;

/* ---- audio ----------------------------------------------------------- */

static uint32_t sample_rate = 48000;
static double   sample_frac;
static float    voice_phase[4][4], voice_env[4][4];
static float    tick_left;       /* seconds of pointer tick left */
static float    tick_phase;
static float    scope_l[256], scope_r[256];
static uint32_t audio_frames_written;
static float    audio_peak;
static uint16_t tone_mask;       /* bit p*4+f: that voice is sounding */
static int8_t   audio_pan;       /* -1 left only, 0 centre, 1 right only */

static const float note_hz[4] = { 523.25f, 659.26f, 783.99f, 1046.50f }; /* C5 E5 G5 C6 */
static const char *const note_name[4] = { "C5", "E5", "G5", "C6" };
static const char *const wave_name[4] = { "sine", "square", "tri", "saw" };

/* sin(2*pi*p) for p in [0, 1), a parabola refined once (error < 0.1%) */
static float sin2pi(float p) {
    float t = p < 0.5f ? p : p - 1.0f;             /* -0.5 .. 0.5 */
    float y = 8.0f * t - 16.0f * t * (t < 0 ? -t : t);
    return 0.225f * (y * (y < 0 ? -y : y) - y) + y;
}

static float wave(int pad, float p) {
    switch (pad) {
    case 0: return sin2pi(p);
    case 1: return p < 0.5f ? 0.5f : -0.5f;
    case 2: return p < 0.5f ? 4.0f * p - 1.0f : 3.0f - 4.0f * p;
    default: return 2.0f * p - 1.0f;
    }
}

static void audio_frame(double delta_ms) {
    sample_frac += sample_rate * delta_ms / 1000.0;
    uint32_t n = (uint32_t)sample_frac;
    sample_frac -= n;
    if (n > AUDIO_CAP / 2) n = AUDIO_CAP / 2;

    float gate[4][4], step[4][4];
    tone_mask = 0;
    int left = 0, right = 0;
    for (int p = 0; p < 4; p++) {
        if (!pad_connected[p]) { for (int f = 0; f < 4; f++) gate[p][f] = 0, step[p][f] = 0; continue; }
        if (pad_buttons[p] & WC_BTN_L) left = 1;
        if (pad_buttons[p] & WC_BTN_R) right = 1;
        float bend = 1.0f + pad_rt[p] / 32767.0f - 0.5f * pad_lt[p] / 32767.0f;
        for (int f = 0; f < 4; f++) {
            gate[p][f] = (pad_buttons[p] & (1u << f)) ? 1.0f : 0.0f;
            step[p][f] = note_hz[f] * bend / (float)sample_rate;
            if (gate[p][f] > 0) tone_mask |= (uint16_t)(1u << (p * 4 + f));
        }
    }
    audio_pan = (int8_t)(left == right ? 0 : left ? -1 : 1);
    float gl = audio_pan > 0 ? 0.0f : 1.0f, gr = audio_pan < 0 ? 0.0f : 1.0f;
    const float attack = 1.0f / (0.005f * sample_rate), release = 1.0f / (0.060f * sample_rate);

    for (uint32_t i = 0; i < n; i++) {
        float mix = 0;
        for (int p = 0; p < 4; p++)
            for (int f = 0; f < 4; f++) {
                float *env = &voice_env[p][f];
                if (gate[p][f] > *env) { *env += attack; if (*env > 1) *env = 1; }
                else if (*env > 0) { *env -= release; if (*env < 0) *env = 0; }
                if (*env <= 0) continue;
                float *ph = &voice_phase[p][f];
                mix += 0.15f * *env * wave(p, *ph);
                *ph += step[p][f];
                if (*ph >= 1.0f) *ph -= 1.0f;
            }
        float tick = 0;
        if (tick_left > 0) {
            tick = 0.2f * (tick_phase < 0.5f ? 1.0f : -1.0f);
            tick_phase += 2000.0f / sample_rate;
            if (tick_phase >= 1.0f) tick_phase -= 1.0f;
            tick_left -= 1.0f / sample_rate;
        }
        float l = mix * gl + tick, r = mix * gr + tick;
        if (l > 1) l = 1; else if (l < -1) l = -1;
        if (r > 1) r = 1; else if (r < -1) r = -1;
        uint32_t at = wc_audio_write_cursor % AUDIO_CAP;
        wc_audio_ring[at * 2] = l;
        wc_audio_ring[at * 2 + 1] = r;
        wc_audio_write_cursor = (wc_audio_write_cursor + 1) % AUDIO_CAP;
        float a = l < 0 ? -l : l, b = r < 0 ? -r : r;
        if (a > audio_peak) audio_peak = a;
        if (b > audio_peak) audio_peak = b;
        if (n >= 256 && i >= n - 256) { scope_l[i - (n - 256)] = l; scope_r[i - (n - 256)] = r; }
    }
    audio_frames_written += n;
}

/* ---- save block ------------------------------------------------------ */

#define SAVE_SIZE     32768
#define SAVE_MAGIC    0x53544357u    /* "WCTS" */
#define SAVE_VERSION  1
#define PATTERN_START 512

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t checksum;      /* FNV-1a of bytes 0..PATTERN_START-1, this field as 0 */
    uint32_t boots;         /* starts, this one included */
    uint32_t last_frames;   /* frames this session has run (the next start reads the last session's) */
    uint32_t total_frames;
    uint32_t presses[4][NBTN];
} save_hdr_t;

static uint8_t save_block[SAVE_SIZE] __attribute__((aligned(8)));
#define HDR ((save_hdr_t *)save_block)

enum { SAVE_FRESH, SAVE_OK, SAVE_CORRUPT, SAVE_TRUNCATED, SAVE_GARBAGE };
static const char *const save_status_name[] = { "FRESH", "OK", "CORRUPT", "TRUNCATED", "GARBAGE" };

static uint32_t save_status, save_bad_at, save_boots, save_prev_frames, save_prev_total;
static uint32_t save_cleared, clear_hold;

static uint8_t pattern_byte(uint32_t i) { return (uint8_t)(i * 167u + (i >> 9) * 13u + 0x5Au); }

static uint32_t header_checksum(void) {
    uint32_t h = 2166136261u;
    for (uint32_t i = 0; i < PATTERN_START; i++) {
        uint8_t b = (i >= 8 && i < 12) ? 0 : save_block[i];
        h = (h ^ b) * 16777619u;
    }
    return h;
}

static void save_check_at_start(void) {
    int all_zero = 1;
    for (uint32_t i = 0; i < SAVE_SIZE; i++) if (save_block[i]) { all_zero = 0; break; }
    if (all_zero) { save_status = SAVE_FRESH; return; }
    if (HDR->magic != SAVE_MAGIC || HDR->version != SAVE_VERSION) { save_status = SAVE_GARBAGE; return; }
    save_prev_frames = HDR->last_frames;
    save_prev_total = HDR->total_frames;
    if (HDR->checksum != header_checksum()) { save_status = SAVE_CORRUPT; save_bad_at = 8; return; }
    for (uint32_t i = PATTERN_START; i < SAVE_SIZE; i++)
        if (save_block[i] != pattern_byte(i)) {
            int rest_zero = 1;
            for (uint32_t j = i; j < SAVE_SIZE; j++) if (save_block[j]) { rest_zero = 0; break; }
            save_status = rest_zero ? SAVE_TRUNCATED : SAVE_CORRUPT;
            save_bad_at = i;
            return;
        }
    save_status = SAVE_OK;
}

static void save_start_session(void) {
    if (save_status != SAVE_OK) {
        for (uint32_t i = 0; i < SAVE_SIZE; i++) save_block[i] = 0;
        HDR->magic = SAVE_MAGIC;
        HDR->version = SAVE_VERSION;
        for (uint32_t i = PATTERN_START; i < SAVE_SIZE; i++) save_block[i] = pattern_byte(i);
    }
    HDR->boots++;
    HDR->last_frames = 0;
    save_boots = HDR->boots;
    HDR->checksum = header_checksum();
}

/* ---- save states ----------------------------------------------------- */

static uint32_t restore_gen, restores_seen, restore_at_frame;

/* ---- frame ----------------------------------------------------------- */

static uint32_t frame_n;

WC_DEBUG_FIELDS(
    WC_DBG("frame", frame_n, WC_DBG_U32),
    WC_DBG_ARR("pad.connected", pad_connected, WC_DBG_U8, 4),
    WC_DBG_ARR("pad.buttons", pad_buttons, WC_DBG_U32, 4),
    WC_DBG_ARR("pad.lx", pad_lx, WC_DBG_I16, 4),
    WC_DBG_ARR("pad.ly", pad_ly, WC_DBG_I16, 4),
    WC_DBG_ARR("pad.rx", pad_rx, WC_DBG_I16, 4),
    WC_DBG_ARR("pad.ry", pad_ry, WC_DBG_I16, 4),
    WC_DBG_ARR("pad.lt", pad_lt, WC_DBG_I16, 4),
    WC_DBG_ARR("pad.rt", pad_rt, WC_DBG_I16, 4),
    WC_DBG_ARR("pad.device", pad_device, WC_DBG_I32, 4),
    WC_DBG_ARR("pad.rumble", pad_rumble, WC_DBG_U8, 4),
    WC_DBG_ARR("pad.glyph", face_glyph, WC_DBG_I32, 4),
    WC_DBG("ptr.active", ptr_active_mask, WC_DBG_U16),
    WC_DBG_ARR("ptr.x", ptr_x, WC_DBG_I16, 10),
    WC_DBG_ARR("ptr.y", ptr_y, WC_DBG_I16, 10),
    WC_DBG_ARR("ptr.buttons", ptr_buttons, WC_DBG_U8, 10),
    WC_DBG("ptr.downs", ptr_downs, WC_DBG_U32),
    WC_DBG("ptr.moves", ptr_moves, WC_DBG_U32),
    WC_DBG("ptr.ups", ptr_ups, WC_DBG_U32),
    WC_DBG("wheel.x", wheel_total_x, WC_DBG_I32),
    WC_DBG("wheel.y", wheel_total_y, WC_DBG_I32),
    WC_DBG("key.downs", key_downs, WC_DBG_U32),
    WC_DBG("key.ups", key_ups, WC_DBG_U32),
    WC_DBG("key.held", keys_held, WC_DBG_U8),
    WC_DBG("key.mods", key_mods, WC_DBG_U8),
    WC_DBG_ARR("key.log", key_log, WC_DBG_U8, 8),
    WC_DBG("audio.rate", sample_rate, WC_DBG_U32),
    WC_DBG("audio.frames", audio_frames_written, WC_DBG_U32),
    WC_DBG("audio.tones", tone_mask, WC_DBG_U16),
    WC_DBG("audio.pan", audio_pan, WC_DBG_I8),
    WC_DBG("audio.peak", audio_peak, WC_DBG_F32),
    WC_DBG("save.status", save_status, WC_DBG_U32),
    WC_DBG("save.bad_at", save_bad_at, WC_DBG_U32),
    WC_DBG("save.boots", save_boots, WC_DBG_U32),
    WC_DBG("save.prev_frames", save_prev_frames, WC_DBG_U32),
    WC_DBG("save.cleared", save_cleared, WC_DBG_U32),
    WC_DBG("restore.gen", restore_gen, WC_DBG_U32),
    WC_DBG("restore.seen", restores_seen, WC_DBG_U32)
)

WC_EXPORT wc_info_t *wc_get_info(void) {
    (void)wc_cur_width; (void)wc_cur_height;   /* fixed size: WC_CART_BUFFERS declares these for resizable carts */
    WC_FILL_INFO(WC_FLAG_POINTER | WC_FLAG_KEYBOARD | WC_FLAG_DEBUG);
    wc_info.save_ptr = (uint32_t)(uintptr_t)save_block;
    wc_info.save_size = SAVE_SIZE;
    return &wc_info;
}

static void refresh_input_info(void) {
    for (int p = 0; p < 4; p++) {
        int n = wc_pad_name((unsigned)p, pad_name[p], sizeof pad_name[p] - 1);
        if (n < 0) n = 0;
        if (n > (int)sizeof pad_name[p] - 1) n = sizeof pad_name[p] - 1;
        pad_name[p][n] = 0;
        pad_rumble[p] = (uint8_t)(wc_pad_has_rumble((unsigned)p) != 0);
        pad_device[p] = wc_input_device(p);
        for (int f = 0; f < 4; f++) {
            const char *s = wc_action_label(p, face_action[f], f);
            uint32_t i = 0;
            for (; s[i] && i < sizeof face_label[p][f] - 1; i++) face_label[p][f][i] = s[i];
            face_label[p][f][i] = 0;
        }
        face_glyph[p] = wc_action_glyph(p, face_action[0]);
    }
}

WC_EXPORT_INIT void wc_init(void) {
    if (wc_host_info.audio_sample_rate) sample_rate = wc_host_info.audio_sample_rate;
    int set = wc_action_set_new("test");
    face_action[0] = wc_action_new(set, WC_ACTION_DIGITAL, WC_IN_A, "South");
    face_action[1] = wc_action_new(set, WC_ACTION_DIGITAL, WC_IN_B, "East");
    face_action[2] = wc_action_new(set, WC_ACTION_DIGITAL, WC_IN_X, "West");
    face_action[3] = wc_action_new(set, WC_ACTION_DIGITAL, WC_IN_Y, "North");
    save_check_at_start();
    save_start_session();
    restore_gen = (uint32_t)wc_jit_config(WC_JIT_CFG_RESTORE_GEN);
    refresh_input_info();
    input_rev = wc_input_revision();
    WC_LOG("testcart: started");
}

/* pointer events: tallies, and a tick on every press */
__attribute__((export_name("wc_ptr_on_down")))
void wc_ptr_on_down(uint32_t id, int16_t x, int16_t y, uint8_t button) {
    (void)id; (void)x; (void)y; (void)button;
    ptr_downs++;
    tick_left = 0.03f;
}
__attribute__((export_name("wc_ptr_on_move")))
void wc_ptr_on_move(uint32_t id, int16_t x, int16_t y) { (void)id; (void)x; (void)y; ptr_moves++; }
__attribute__((export_name("wc_ptr_on_up")))
void wc_ptr_on_up(uint32_t id, uint8_t button) { (void)id; (void)button; ptr_ups++; }

__attribute__((export_name("wc_kb_on_down")))
void wc_kb_on_down(uint8_t keycode, uint8_t modifiers) {
    key_downs++;
    key_mods = modifiers;
    for (int i = 7; i > 0; i--) key_log[i] = key_log[i - 1];
    key_log[0] = keycode;
    if (key_log_n < 8) key_log_n++;
}
__attribute__((export_name("wc_kb_on_up")))
void wc_kb_on_up(uint8_t keycode, uint8_t modifiers) { (void)keycode; key_ups++; key_mods = modifiers; }

static void key_name(line_t *l, uint8_t k) {
    if (k >= WC_KEY_A && k <= WC_KEY_Z) { ln_chr(l, (char)('A' + k - WC_KEY_A)); return; }
    if (k >= WC_KEY_1 && k <= WC_KEY_9) { ln_chr(l, (char)('1' + k - WC_KEY_1)); return; }
    if (k >= WC_KEY_F1 && k <= WC_KEY_F12) { ln_chr(l, 'F'); ln_uint(l, (uint32_t)(k - WC_KEY_F1 + 1)); return; }
    switch (k) {
    case WC_KEY_0: ln_str(l, "0"); return;
    case WC_KEY_ENTER: ln_str(l, "Ent"); return;
    case WC_KEY_ESCAPE: ln_str(l, "Esc"); return;
    case WC_KEY_BACKSPACE: ln_str(l, "Bksp"); return;
    case WC_KEY_TAB: ln_str(l, "Tab"); return;
    case WC_KEY_SPACE: ln_str(l, "Spc"); return;
    case WC_KEY_UP: ln_str(l, "Up"); return;
    case WC_KEY_DOWN: ln_str(l, "Dn"); return;
    case WC_KEY_LEFT: ln_str(l, "Lf"); return;
    case WC_KEY_RIGHT: ln_str(l, "Rt"); return;
    case WC_KEY_LSHIFT: case WC_KEY_RSHIFT: ln_str(l, "Shft"); return;
    case WC_KEY_LCTRL: case WC_KEY_RCTRL: ln_str(l, "Ctrl"); return;
    case WC_KEY_LALT: case WC_KEY_RALT: ln_str(l, "Alt"); return;
    case WC_KEY_LMETA: case WC_KEY_RMETA: ln_str(l, "Meta"); return;
    default: ln_str(l, "0x"); ln_hex(l, k, 2); return;
    }
}

static void read_input(void) {
    for (int p = 0; p < 4; p++) {
        const wc_pad_t *pd = &wc_pads[p];
        pad_connected[p] = pd->connected;
        pad_prev[p] = pad_buttons[p];
        pad_buttons[p] = pd->connected ? pd->buttons : 0;
        pad_lx[p] = pd->left_x;  pad_ly[p] = pd->left_y;
        pad_rx[p] = pd->right_x; pad_ry[p] = pd->right_y;
        pad_lt[p] = pd->left_trigger; pad_rt[p] = pd->right_trigger;
        uint32_t rose = pad_buttons[p] & ~pad_prev[p];
        if (!save_cleared)
            for (int b = 0; b < NBTN; b++) if (rose & (1u << b)) HDR->presses[p][b]++;
        if (pad_rumble[p]) {
            int l3 = (pad_buttons[p] & WC_BTN_L3) != 0, r3 = (pad_buttons[p] & WC_BTN_R3) != 0;
            if (l3 || r3) wc_pad_rumble((unsigned)p, l3 ? 1.0f : 0.0f, r3 ? 1.0f : 0.0f, 100);
            else if (pad_prev[p] & (WC_BTN_L3 | WC_BTN_R3)) wc_pad_rumble_stop((unsigned)p);
        }
    }

    ptr_active_mask = 0;
    for (int i = 0; i < 10; i++) {
        const wc_pointer_t *pt = &wc_pointers[i];
        ptr_x[i] = pt->x; ptr_y[i] = pt->y; ptr_buttons[i] = pt->buttons;
        if (!pt->active) { trail_n[i] = 0; continue; }
        ptr_active_mask |= (uint16_t)(1u << i);
        uint8_t last = (uint8_t)((trail_head[i] + TRAIL - 1) % TRAIL);
        if (!trail_n[i] || trail_x[i][last] != pt->x || trail_y[i][last] != pt->y) {
            trail_x[i][trail_head[i]] = pt->x;
            trail_y[i][trail_head[i]] = pt->y;
            trail_head[i] = (uint8_t)((trail_head[i] + 1) % TRAIL);
            if (trail_n[i] < TRAIL) trail_n[i]++;
        }
    }
    wheel_total_x += wc_wheel.dx;
    wheel_total_y += wc_wheel.dy;

    uint8_t held = 0;
    for (int i = 0; i < 32; i++)
        for (int b = 0; b < 8; b++) if (wc_keys[i] & (1 << b)) held++;
    keys_held = held;
}

static void update_save(void) {
    if (save_cleared) return;
    /* SELECT+START held on any pad for 3 seconds clears the block */
    int combo = 0;
    for (int p = 0; p < 4; p++)
        if ((pad_buttons[p] & (WC_BTN_SELECT | WC_BTN_START)) == (WC_BTN_SELECT | WC_BTN_START)) combo = 1;
    clear_hold = combo ? clear_hold + 1 : 0;
    if (clear_hold >= 180) {
        for (uint32_t i = 0; i < SAVE_SIZE; i++) save_block[i] = 0;
        save_cleared = 1;
        WC_LOG("testcart: save cleared");
        return;
    }
    HDR->last_frames = frame_n;
    HDR->total_frames++;
    HDR->checksum = header_checksum();
}

/* ---- screen ---------------------------------------------------------- */

static void button_rect(int x, int y, int w, int h, int on, const char *label) {
    fill(x, y, w, h, on ? C_ON : C_OFF);
    box(x, y, w, h, C_EDGE);
    if (label) text(x + (w - (int)str_len(label) * 8) / 2, y + (h - 8) / 2 + 1, label, on ? 0x000000 : C_DIM);
}

static void button_round(int cx, int cy, int r, int on, const char *label) {
    circle(cx, cy, r, on ? C_ON : C_OFF, 1);
    circle(cx, cy, r, C_EDGE, 0);
    if (label) text(cx - (int)str_len(label) * 4, cy - 3, label, on ? 0x000000 : C_TEXT);
}

static void stick(int cx, int cy, int16_t sx, int16_t sy, int clicked) {
    circle(cx, cy, 15, clicked ? 0x1f6b42 : C_OFF, 1);
    circle(cx, cy, 15, C_EDGE, 0);
    int dx = sx * 13 / 32768, dy = sy * 13 / 32768;
    line(cx, cy, cx + dx, cy + dy, C_DIM);
    circle(cx + dx, cy + dy, 3, clicked ? C_ON : C_TEXT, 1);
}

static void trigger_bar(int x, int y, int16_t v) {
    fill(x, y, 40, 6, C_OFF);
    int w = v * 40 / 32767;
    if (w > 0) fill(x, y, w > 40 ? 40 : w, 6, v >= WC_TRIGGER_PRESSED ? C_ON : C_DIM);
    box(x, y, 40, 6, C_EDGE);
}

static const char *device_name(int32_t d) {
    switch (d) {
    case WC_DEVICE_KEYBOARD_MOUSE: return "KB+MOUSE";
    case WC_DEVICE_GAMEPAD: return "GAMEPAD";
    case WC_DEVICE_TOUCH: return "TOUCH";
    case WC_DEVICE_REMOTE: return "REMOTE";
    default: return "DEVICE ?";
    }
}

static const char *glyph_family_name(int32_t g) {
    switch (WC_GLYPH_FAMILY(g)) {
    case WC_GLYPH_XBOX: return "Xbox";
    case WC_GLYPH_PLAYSTATION: return "PlayStation";
    case WC_GLYPH_NINTENDO: return "Nintendo";
    case WC_GLYPH_GAMEPAD: return "gamepad";
    case WC_GLYPH_KEY: return "keyboard";
    case WC_GLYPH_MOUSE: return "mouse";
    case WC_GLYPH_TOUCH: return "touch";
    default: return "no glyphs";
    }
}

static void draw_pad(int p) {
    int x = p * 160, y = 0;
    uint32_t b = pad_buttons[p];
    line_t l;
    fill(x + 1, y + 1, 158, 212, C_PANEL);
    box(x, y, 160, 214, C_EDGE);

    ln_reset(&l); ln_str(&l, "P"); ln_uint(&l, (uint32_t)p + 1);
    text(x + 4, y + 4, l.b, C_TEXT);
    fill(x + 24, y + 3, 24, 10, pad_connected[p] ? C_GOOD : C_BAD);
    text(x + 26, y + 4, pad_connected[p] ? "ON" : "--", 0x000000);
    text(x + 156 - (int)str_len(device_name(pad_device[p])) * 8, y + 4, device_name(pad_device[p]), C_DIM);
    char nm[20]; uint32_t i = 0;
    for (; pad_name[p][i] && i < 19; i++) nm[i] = pad_name[p][i];
    nm[i] = 0;
    text(x + 4, y + 15, i ? nm : "(no name)", C_DIM);

    trigger_bar(x + 8, y + 27, pad_lt[p]);
    trigger_bar(x + 112, y + 27, pad_rt[p]);
    button_rect(x + 8, y + 35, 40, 10, (b & WC_BTN_L) != 0, "L");
    button_rect(x + 112, y + 35, 40, 10, (b & WC_BTN_R) != 0, "R");

    button_rect(x + 56, y + 37, 18, 9, (b & WC_BTN_SELECT) != 0, 0);
    button_rect(x + 86, y + 37, 18, 9, (b & WC_BTN_START) != 0, 0);
    text(x + 54, y + 48, "SE", C_DIM);
    text(x + 90, y + 48, "ST", C_DIM);
    button_round(x + 80, y + 46, 6, (b & WC_BTN_GUIDE) != 0, 0);
    button_rect(x + 62, y + 58, 36, 10, (b & WC_BTN_TOUCHPAD) != 0, "TP");
    button_rect(x + 72, y + 72, 16, 8, (b & WC_BTN_MISC1) != 0, 0);
    text(x + 72, y + 82, "M", C_DIM);

    int dx = x + 32, dy = y + 70;
    button_rect(dx - 5, dy - 16, 11, 11, (b & WC_BTN_UP) != 0, 0);
    button_rect(dx - 5, dy + 6, 11, 11, (b & WC_BTN_DOWN) != 0, 0);
    button_rect(dx - 16, dy - 5, 11, 11, (b & WC_BTN_LEFT) != 0, 0);
    button_rect(dx + 6, dy - 5, 11, 11, (b & WC_BTN_RIGHT) != 0, 0);

    int fx = x + 128, fy = y + 70;
    button_round(fx, fy + 11, 6, (b & WC_BTN_A) != 0, "A");
    button_round(fx + 11, fy, 6, (b & WC_BTN_B) != 0, "B");
    button_round(fx - 11, fy, 6, (b & WC_BTN_X) != 0, "X");
    button_round(fx, fy - 11, 6, (b & WC_BTN_Y) != 0, "Y");

    stick(x + 50, y + 108, pad_lx[p], pad_ly[p], (b & WC_BTN_L3) != 0);
    stick(x + 110, y + 108, pad_rx[p], pad_ry[p], (b & WC_BTN_R3) != 0);

    button_rect(x + 6, y + 128, 34, 10, (b & WC_BTN_PADDLE4) != 0, "P4");
    button_rect(x + 44, y + 128, 34, 10, (b & WC_BTN_PADDLE2) != 0, "P2");
    button_rect(x + 82, y + 128, 34, 10, (b & WC_BTN_PADDLE1) != 0, "P1");
    button_rect(x + 120, y + 128, 34, 10, (b & WC_BTN_PADDLE3) != 0, "P3");

    ln_reset(&l); ln_str(&l, "LS"); ln_int(&l, pad_lx[p], 7); ln_int(&l, pad_ly[p], 7);
    text(x + 4, y + 144, l.b, C_TEXT);
    ln_reset(&l); ln_str(&l, "RS"); ln_int(&l, pad_rx[p], 7); ln_int(&l, pad_ry[p], 7);
    text(x + 4, y + 154, l.b, C_TEXT);
    ln_reset(&l); ln_str(&l, "LT"); ln_int(&l, pad_lt[p], 6); ln_str(&l, " RT"); ln_int(&l, pad_rt[p], 6);
    text(x + 4, y + 164, l.b, C_TEXT);
    ln_reset(&l); ln_str(&l, "BTN "); ln_hex(&l, b, 6);
    ln_str(&l, pad_rumble[p] ? " rumble" : " no rmbl");
    text(x + 4, y + 174, l.b, C_TEXT);

    ln_reset(&l); ln_str(&l, "A="); ln_str(&l, face_label[p][0]);
    ln_str(&l, " B="); ln_str(&l, face_label[p][1]);
    l.b[19] = 0;
    text(x + 4, y + 186, l.b, C_DIM);
    ln_reset(&l); ln_str(&l, "X="); ln_str(&l, face_label[p][2]);
    ln_str(&l, " Y="); ln_str(&l, face_label[p][3]);
    l.b[19] = 0;
    text(x + 4, y + 195, l.b, C_DIM);

    uint32_t total = 0;
    for (int k = 0; k < NBTN; k++) total += HDR->presses[p][k];
    ln_reset(&l); ln_str(&l, glyph_family_name(face_glyph[p]));
    text(x + 4, y + 204, l.b, C_DIM);
    if (!save_cleared) {
        ln_reset(&l); ln_str(&l, "pressed "); ln_uint(&l, total);
        text(x + 156 - (int)l.n * 8, y + 204, l.b, C_DIM);
    }
}

static const uint32_t slot_color[10] = {
    0xffffff, 0xff5a5a, 0x5ab4ff, 0xffd84a, 0xb07cff,
    0x4affc8, 0xff8a3a, 0xff6ad8, 0xa8ff4a, 0x7ac0c0 };

static void draw_pointers(void) {
    for (int i = 0; i < 10; i++) {
        if (!(ptr_active_mask & (1u << i))) continue;
        int n = trail_n[i];
        for (int k = 1; k < n; k++) {
            int a = (trail_head[i] + TRAIL - n + k - 1) % TRAIL, c = (trail_head[i] + TRAIL - n + k) % TRAIL;
            line(trail_x[i][a], trail_y[i][a], trail_x[i][c], trail_y[i][c], slot_color[i]);
        }
        int x = ptr_x[i], y = ptr_y[i];
        if (ptr_buttons[i]) circle(x, y, 9, slot_color[i], 1);
        circle(x, y, 10, slot_color[i], 0);
        line(x - 14, y, x - 11, y, slot_color[i]);
        line(x + 11, y, x + 14, y, slot_color[i]);
        line(x, y - 14, x, y - 11, slot_color[i]);
        line(x, y + 11, x, y + 14, slot_color[i]);
        char d[2] = { (char)('0' + i), 0 };
        text(x - 3, y - 3, d, ptr_buttons[i] ? 0x000000 : slot_color[i]);
    }
}

static void draw_middle(void) {
    line_t l;
    int y = 218;
    fill(0, y, 316, 84, C_PANEL); box(0, y, 316, 84, C_EDGE);
    fill(324, y, 316, 84, C_PANEL); box(324, y, 316, 84, C_EDGE);

    text(4, y + 4, "POINTERS", C_TEXT);
    ln_reset(&l);
    for (int i = 0; i < 10; i++) if (ptr_active_mask & (1u << i)) { ln_chr(&l, (char)('0' + i)); ln_chr(&l, ' '); }
    if (!ptr_active_mask) ln_str(&l, "none");
    text(76, y + 4, l.b, C_DIM);
    ln_reset(&l); ln_str(&l, "down "); ln_uint(&l, ptr_downs);
    ln_str(&l, " move "); ln_uint(&l, ptr_moves); ln_str(&l, " up "); ln_uint(&l, ptr_ups);
    text(4, y + 14, l.b, C_TEXT);
    ln_reset(&l); ln_str(&l, "slot 0 ");
    ln_int(&l, ptr_x[0], 0); ln_chr(&l, ','); ln_int(&l, ptr_y[0], 0);
    ln_str(&l, " btn "); ln_uint(&l, ptr_buttons[0]);
    text(4, y + 24, l.b, C_TEXT);
    ln_reset(&l); ln_str(&l, "wheel x "); ln_int(&l, wheel_total_x, 0);
    ln_str(&l, " y "); ln_int(&l, wheel_total_y, 0); ln_str(&l, " (/120)");
    text(4, y + 34, l.b, C_TEXT);

    text(4, y + 48, "KEYBOARD", C_TEXT);
    ln_reset(&l); ln_str(&l, "held "); ln_uint(&l, keys_held);
    if (key_mods & WC_MOD_SHIFT) ln_str(&l, " shift");
    if (key_mods & WC_MOD_CTRL) ln_str(&l, " ctrl");
    if (key_mods & WC_MOD_ALT) ln_str(&l, " alt");
    if (key_mods & WC_MOD_META) ln_str(&l, " meta");
    text(76, y + 48, l.b, C_DIM);
    ln_reset(&l); ln_str(&l, "last:");
    for (int i = key_log_n - 1; i >= 0; i--) { ln_chr(&l, ' '); key_name(&l, key_log[i]); }
    text(4, y + 58, l.b, C_TEXT);
    ln_reset(&l); ln_str(&l, "down "); ln_uint(&l, key_downs); ln_str(&l, " up "); ln_uint(&l, key_ups);
    text(4, y + 70, l.b, C_DIM);

    int ax = 328;
    ln_reset(&l); ln_str(&l, "AUDIO "); ln_uint(&l, sample_rate); ln_str(&l, " Hz ");
    ln_str(&l, audio_pan < 0 ? "LEFT ONLY" : audio_pan > 0 ? "RIGHT ONLY" : "both ch");
    text(ax, y + 4, l.b, C_TEXT);
    ln_reset(&l);
    for (int p = 0; p < 4; p++)
        for (int f = 0; f < 4; f++)
            if (tone_mask & (1u << (p * 4 + f))) {
                ln_chr(&l, 'P'); ln_uint(&l, (uint32_t)p + 1); ln_chr(&l, ':');
                ln_str(&l, note_name[f]); ln_chr(&l, ' ');
            }
    if (!tone_mask) ln_str(&l, "press A B X Y");
    l.b[38] = 0;
    text(ax, y + 14, l.b, tone_mask ? C_ON : C_DIM);
    int sx = ax, sy = y + 26, sw = 304, sh = 52;
    fill(sx, sy, sw, sh, 0x0a0d10);
    line(sx, sy + sh / 2, sx + sw - 1, sy + sh / 2, C_OFF);
    for (int i = 1; i < 256; i++) {
        int x0 = sx + (i - 1) * sw / 256, x1 = sx + i * sw / 256;
        line(x0, sy + sh / 2 - (int)(scope_l[i - 1] * (sh / 2 - 1)), x1, sy + sh / 2 - (int)(scope_l[i] * (sh / 2 - 1)), 0x4aff8a);
        line(x0, sy + sh / 2 - (int)(scope_r[i - 1] * (sh / 2 - 1)), x1, sy + sh / 2 - (int)(scope_r[i] * (sh / 2 - 1)), 0xff5ad0);
    }
    text(sx + sw - 72, sy + 2, "L", 0x4aff8a);
    text(sx + sw - 56, sy + 2, "R", 0xff5ad0);
}

static void draw_bottom(void) {
    line_t l;
    int y = 306;
    fill(0, y, W, 54, C_PANEL); box(0, y, W, 54, C_EDGE);
    uint32_t sc = save_status == SAVE_OK ? C_GOOD : save_status == SAVE_FRESH ? C_WARN : C_BAD;

    ln_reset(&l); ln_str(&l, "SAVE "); text(4, y + 4, l.b, C_TEXT);
    text(44, y + 4, save_status_name[save_status], sc);
    ln_reset(&l);
    if (save_status == SAVE_OK) {
        ln_str(&l, "start #"); ln_uint(&l, save_boots);
        ln_str(&l, ", last session saved through frame "); ln_uint(&l, save_prev_frames);
        ln_str(&l, " ("); ln_uint(&l, save_prev_frames / 60); ln_str(&l, "s)");
    } else if (save_status == SAVE_FRESH) {
        ln_str(&l, "no save yet; restart and it should say OK, start #2");
    } else if (save_status == SAVE_GARBAGE) {
        ln_str(&l, "not this cart's save (wrong magic or version)");
    } else {
        ln_str(&l, save_status == SAVE_TRUNCATED ? "only " : "bad byte at ");
        ln_uint(&l, save_bad_at); ln_str(&l, save_status == SAVE_TRUNCATED ? " of 32768 bytes came back" : " of 32768");
    }
    text(44 + (int)str_len(save_status_name[save_status]) * 8 + 8, y + 4, l.b, C_TEXT);

    ln_reset(&l);
    ln_str(&l, "frame "); ln_uint(&l, frame_n);
    ln_str(&l, "   restore gen "); ln_hex(&l, restore_gen, 8);
    ln_str(&l, ", restores seen "); ln_uint(&l, restores_seen);
    if (restores_seen) { ln_str(&l, " (last at frame "); ln_uint(&l, restore_at_frame); ln_chr(&l, ')'); }
    text(4, y + 16, l.b, C_DIM);

    if (save_cleared) {
        text(4, y + 28, "SAVE CLEARED: restart, and it must say FRESH (not the old save)", C_WARN);
    } else {
        text(4, y + 28, "hold SELECT+START 3s to clear the save", C_DIM);
        if (clear_hold) {
            fill(320, y + 28, 200, 8, C_OFF);
            fill(320, y + 28, (int)(clear_hold * 200 / 180), 8, C_WARN);
        }
    }
    ln_reset(&l);
    ln_str(&l, "ABXY: P1 "); ln_str(&l, wave_name[0]); ln_str(&l, " P2 "); ln_str(&l, wave_name[1]);
    ln_str(&l, " P3 "); ln_str(&l, wave_name[2]); ln_str(&l, " P4 "); ln_str(&l, wave_name[3]);
    ln_str(&l, "  L/R pan  LT/RT bend  L3/R3 rumble");
    text(4, y + 42, l.b, C_DIM);
}

WC_EXPORT_RENDER void wc_render(void) {
    frame_n++;

    uint32_t gen = (uint32_t)wc_jit_config(WC_JIT_CFG_RESTORE_GEN);
    if (gen != restore_gen) { restore_gen = gen; restores_seen++; restore_at_frame = frame_n; }

    uint32_t rev = wc_input_revision();
    if (rev != input_rev || frame_n % 60 == 0) { input_rev = rev; refresh_input_info(); }

    read_input();
    update_save();
    audio_frame(wc_time.delta_ms);

    wc_fb_clear(fb, W, H, C_BG);
    for (int p = 0; p < 4; p++) draw_pad(p);
    draw_middle();
    draw_bottom();
    draw_pointers();
}
