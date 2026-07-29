#ifndef WASMCART_H
#define WASMCART_H

#include <stdint.h>

// ABI version
#define WC_ABI_VERSION 3

// Button bitmask
#define WC_BTN_A       (1 << 0)
#define WC_BTN_B       (1 << 1)
#define WC_BTN_X       (1 << 2)
#define WC_BTN_Y       (1 << 3)
#define WC_BTN_L       (1 << 4)
#define WC_BTN_R       (1 << 5)
#define WC_BTN_START   (1 << 6)
#define WC_BTN_SELECT  (1 << 7)
#define WC_BTN_UP      (1 << 8)
#define WC_BTN_DOWN    (1 << 9)
#define WC_BTN_LEFT    (1 << 10)
#define WC_BTN_RIGHT   (1 << 11)
#define WC_BTN_L3      (1 << 12)
#define WC_BTN_R3      (1 << 13)

// Pad struct (16 bytes — must match host PAD_SIZE)
typedef struct {
    uint16_t buttons;
    int16_t  left_x;
    int16_t  left_y;
    int16_t  right_x;
    int16_t  right_y;
    uint8_t  left_trigger;
    uint8_t  right_trigger;
    uint8_t  connected;
    uint8_t  _pad[3];
} wc_pad_t;

// Time struct (20 bytes, 8-byte aligned)
typedef struct {
    double  time_ms;
    double  delta_ms;
    uint32_t frame;
} wc_time_t;

// Host info struct (written by host before wc_init, read by cart)
// Cart allocates this in static memory and puts its address in wc_info_t.host_info_ptr.
// Host writes preferred resolution etc. before calling wc_init().
// Cart reads during wc_init() and may adapt its resolution/framebuffer accordingly.
typedef struct {
    uint32_t preferred_width;   // host's preferred/native width (0 = no preference)
    uint32_t preferred_height;  // host's preferred/native height (0 = no preference)
    uint32_t _reserved0;        // (was host_fps — unused, carts use wc_time.delta_ms instead)
    uint32_t audio_sample_rate; // host audio rate (e.g. 48000)
    uint32_t flags;             // reserved for future use
} wc_host_info_t;

// Pointer struct (8 bytes — unified mouse/touch, ABI v3)
typedef struct {
    int16_t  x;        // cart-space X coordinate
    int16_t  y;        // cart-space Y coordinate
    uint8_t  buttons;  // bitmask: bit0=primary, bit1=secondary, bit2=middle
    uint8_t  active;   // 1 if this pointer exists
    uint8_t  _pad[2];
} wc_pointer_t;

// Keyboard keycodes (USB HID scancodes, ABI v3)
#define WC_KEY_A  0x04
#define WC_KEY_B  0x05
#define WC_KEY_C  0x06
#define WC_KEY_D  0x07
#define WC_KEY_E  0x08
#define WC_KEY_F  0x09
#define WC_KEY_G  0x0A
#define WC_KEY_H  0x0B
#define WC_KEY_I  0x0C
#define WC_KEY_J  0x0D
#define WC_KEY_K  0x0E
#define WC_KEY_L  0x0F
#define WC_KEY_M  0x10
#define WC_KEY_N  0x11
#define WC_KEY_O  0x12
#define WC_KEY_P  0x13
#define WC_KEY_Q  0x14
#define WC_KEY_R  0x15
#define WC_KEY_S  0x16
#define WC_KEY_T  0x17
#define WC_KEY_U  0x18
#define WC_KEY_V  0x19
#define WC_KEY_W  0x1A
#define WC_KEY_X  0x1B
#define WC_KEY_Y  0x1C
#define WC_KEY_Z  0x1D
#define WC_KEY_1  0x1E
#define WC_KEY_2  0x1F
#define WC_KEY_3  0x20
#define WC_KEY_4  0x21
#define WC_KEY_5  0x22
#define WC_KEY_6  0x23
#define WC_KEY_7  0x24
#define WC_KEY_8  0x25
#define WC_KEY_9  0x26
#define WC_KEY_0  0x27
#define WC_KEY_ENTER      0x28
#define WC_KEY_ESCAPE     0x29
#define WC_KEY_BACKSPACE  0x2A
#define WC_KEY_TAB        0x2B
#define WC_KEY_SPACE      0x2C
#define WC_KEY_MINUS      0x2D
#define WC_KEY_EQUAL      0x2E
#define WC_KEY_LBRACKET   0x2F
#define WC_KEY_RBRACKET   0x30
#define WC_KEY_BACKSLASH  0x31
#define WC_KEY_SEMICOLON  0x33
#define WC_KEY_QUOTE      0x34
#define WC_KEY_GRAVE      0x35
#define WC_KEY_COMMA      0x36
#define WC_KEY_PERIOD     0x37
#define WC_KEY_SLASH      0x38
#define WC_KEY_CAPSLOCK   0x39
#define WC_KEY_F1   0x3A
#define WC_KEY_F2   0x3B
#define WC_KEY_F3   0x3C
#define WC_KEY_F4   0x3D
#define WC_KEY_F5   0x3E
#define WC_KEY_F6   0x3F
#define WC_KEY_F7   0x40
#define WC_KEY_F8   0x41
#define WC_KEY_F9   0x42
#define WC_KEY_F10  0x43
#define WC_KEY_F11  0x44
#define WC_KEY_F12  0x45
#define WC_KEY_INSERT     0x49
#define WC_KEY_HOME       0x4A
#define WC_KEY_PAGEUP     0x4B
#define WC_KEY_DELETE     0x4C
#define WC_KEY_END        0x4D
#define WC_KEY_PAGEDOWN   0x4E
#define WC_KEY_RIGHT      0x4F
#define WC_KEY_LEFT       0x50
#define WC_KEY_DOWN       0x51
#define WC_KEY_UP         0x52
#define WC_KEY_NUMLOCK    0x53
#define WC_KEY_KP_DIVIDE  0x54
#define WC_KEY_KP_MULTIPLY 0x55
#define WC_KEY_KP_MINUS   0x56
#define WC_KEY_KP_PLUS    0x57
#define WC_KEY_KP_ENTER   0x58
#define WC_KEY_KP_1       0x59
#define WC_KEY_KP_2       0x5A
#define WC_KEY_KP_3       0x5B
#define WC_KEY_KP_4       0x5C
#define WC_KEY_KP_5       0x5D
#define WC_KEY_KP_6       0x5E
#define WC_KEY_KP_7       0x5F
#define WC_KEY_KP_8       0x60
#define WC_KEY_KP_9       0x61
#define WC_KEY_KP_0       0x62
#define WC_KEY_KP_PERIOD  0x63
#define WC_KEY_LCTRL   0xE0
#define WC_KEY_LSHIFT  0xE1
#define WC_KEY_LALT    0xE2
#define WC_KEY_LMETA   0xE3
#define WC_KEY_RCTRL   0xE4
#define WC_KEY_RSHIFT  0xE5
#define WC_KEY_RALT    0xE6
#define WC_KEY_RMETA   0xE7

// Keyboard modifier bitmask (ABI v3)
#define WC_MOD_SHIFT  0x01
#define WC_MOD_CTRL   0x02
#define WC_MOD_ALT    0x04
#define WC_MOD_META   0x08

// Helper: test if a key is down in the key state bitmask
#define WC_KEY_IS_DOWN(keys, keycode) ((keys)[(keycode) >> 3] & (1 << ((keycode) & 7)))

// Cart info flags
#define WC_FLAG_AUDIO_F32  (1 << 0)  // audio ring buffer uses float32 (default: int16)
#define WC_FLAG_NET_WS     (1 << 1)  // cart wants WebSocket imports (ABI v3)
#define WC_FLAG_NET_DC     (1 << 2)  // cart wants data channel imports (ABI v3)
#define WC_FLAG_POINTER    (1 << 3)  // cart wants pointer input (ABI v3)
#define WC_FLAG_KEYBOARD   (1 << 4)  // cart wants raw keyboard input (ABI v3)
// Both of the following are OPT-IN and default OFF. A cart that sets neither is
// byte-for-byte identical to one built before they existed - see SPEC.md.
#define WC_FLAG_DEBUG      (1 << 5)  // cart exports wc_debug_state() (see wc_cart.h)
#define WC_FLAG_DETERMINISTIC (1 << 6) // cart honors host deterministic mode

// Info struct (returned by wc_get_info)
typedef struct {
    uint32_t version;
    uint32_t width;
    uint32_t height;
    uint32_t fb_ptr;
    uint32_t audio_ptr;
    uint32_t audio_cap;
    uint32_t audio_write_ptr;
    uint32_t input_ptr;
    uint32_t save_ptr;
    uint32_t save_size;
    uint32_t time_ptr;
    uint32_t host_info_ptr;    // pointer to wc_host_info_t (0 = not supported)
    uint32_t flags;            // cart capability flags (0 = defaults)
    uint32_t audio_sample_rate; // ring buffer sample rate (0 = host decides, typically 48000)
    uint32_t pointer_ptr;      // → wc_pointer_t[10], 0 = not used (ABI v3)
    uint32_t keys_ptr;         // → uint8_t[32] key state bitmask, 0 = not used (ABI v3)
    uint32_t gpu_api;          // 0=2D framebuffer, 1=WebGL2/GLES3, 2=WebGPU, 3=Vulkan
} wc_info_t;

// Optional host import: debug logging
#ifdef __wasm__
__attribute__((import_module("env"), import_name("wc_log")))
extern void wc_log(const char* ptr, unsigned int len);
#else
static inline void wc_log(const char* ptr, unsigned int len) { (void)ptr; (void)len; }
#endif

// Helper: log a string literal
#define WC_LOG(s) wc_log(s, sizeof(s) - 1)

// Optional debug annotation (OPT-IN, default OFF). Stamps {frame, id} into a
// debug-capable host's event trace so a run or replay is navigable by event.
// An UNCALLED import is not emitted into the wasm binary, so merely declaring
// this keeps a cart with no call sites byte-identical. Keep call sites behind
// your own debug #ifdef. Play-only hosts stub it; see SPEC.md "Debug events".
#ifdef __wasm__
__attribute__((import_module("env"), import_name("wc_debug_mark")))
extern void wc_debug_mark(unsigned int id);
#else
static inline void wc_debug_mark(unsigned int id) { (void)id; }
#endif

// Optional host import: query gamepad device name
// Returns bytes written to buf (0 if pad_id invalid or no name available).
// The host provides the SDL controller name, Gamepad API id, or "Keyboard".
#ifdef __wasm__
__attribute__((import_module("env"), import_name("wc_pad_name")))
extern int wc_pad_name(unsigned int pad_id, char* buf, unsigned int buf_len);
#else
static inline int wc_pad_name(unsigned int pad_id, char* buf, unsigned int buf_len) {
    (void)pad_id; (void)buf; (void)buf_len; return 0;
}
#endif

// --- Rumble (ABI v3) ---
// Rumble runs the opposite way to the rest of input: the cart drives it, so it
// is a host import rather than a field in wc_pad_t.
//
// Capability is per-DEVICE, not per-platform, so always ask rather than assume:
// an Xbox 360 pad reports rumble but no trigger rumble, and a keyboard-only
// setup reports none at all. Calls on a pad without rumble are silent no-ops,
// so it is safe (if wasteful) to skip the query.
//
// low  = low-frequency / "strong" motor (0.0 .. 1.0)
// high = high-frequency / "weak" motor  (0.0 .. 1.0)
// Values outside 0..1 are clamped by the host. duration_ms is capped at
// WC_RUMBLE_MAX_MS: the host stops the motors on its own timer, so a cart that
// crashes mid-effect still leaves the controller quiet. For sustained rumble,
// re-arm each frame -- which also means rumble stops when the cart stops.
#define WC_RUMBLE_MAX_MS 5000

#ifdef __wasm__
__attribute__((import_module("env"), import_name("wc_pad_has_rumble")))
extern unsigned int wc_pad_has_rumble(unsigned int pad_id);

__attribute__((import_module("env"), import_name("wc_pad_rumble")))
extern void wc_pad_rumble(unsigned int pad_id, float low, float high,
                          unsigned int duration_ms);

__attribute__((import_module("env"), import_name("wc_pad_rumble_stop")))
extern void wc_pad_rumble_stop(unsigned int pad_id);
#else
static inline unsigned int wc_pad_has_rumble(unsigned int pad_id) {
    (void)pad_id; return 0;
}
static inline void wc_pad_rumble(unsigned int pad_id, float low, float high,
                                 unsigned int duration_ms) {
    (void)pad_id; (void)low; (void)high; (void)duration_ms;
}
static inline void wc_pad_rumble_stop(unsigned int pad_id) { (void)pad_id; }
#endif

// --- Asset API (ABI v2) ---
// For .wasc carts: load assets from the archive at runtime instead of embedding.
// For bare .wasm carts these are not available (don't import them unless you need them).

#ifdef __wasm__
// Query the size of an asset (returns -1 if not found)
__attribute__((import_module("env"), import_name("wc_asset_size")))
extern int wc_asset_size(const char* path, unsigned int path_len);

// Load an asset into cart memory at dest. Returns bytes loaded, or -1 on error.
__attribute__((import_module("env"), import_name("wc_load_asset")))
extern int wc_load_asset(const char* path, unsigned int path_len,
                         void* dest, unsigned int max_size);
#else
static inline int wc_asset_size(const char* path, unsigned int path_len) {
    (void)path; (void)path_len; return -1;
}
static inline int wc_load_asset(const char* path, unsigned int path_len,
                                void* dest, unsigned int max_size) {
    (void)path; (void)path_len; (void)dest; (void)max_size; return -1;
}
#endif

// Helper: load asset by string literal
#define WC_ASSET_SIZE(s) wc_asset_size(s, sizeof(s) - 1)
#define WC_LOAD_ASSET(s, dest, max) wc_load_asset(s, sizeof(s) - 1, dest, max)

// --- Networking API (ABI v3, optional) ---
// Set WC_FLAG_NET_WS / WC_FLAG_NET_DC in wc_info_t.flags to enable.
// Manifest must also declare net.websocket / net.data-channel.

#ifdef WC_USE_NET_WS

// WebSocket imports (cart calls into host)
#ifdef __wasm__
__attribute__((import_module("env"), import_name("wc_ws_open")))
extern int wc_ws_open(const char* url, unsigned int url_len);

__attribute__((import_module("env"), import_name("wc_ws_close")))
extern void wc_ws_close(int conn_id, unsigned int code);

__attribute__((import_module("env"), import_name("wc_ws_send")))
extern int wc_ws_send(int conn_id, const void* data, unsigned int len);

__attribute__((import_module("env"), import_name("wc_ws_send_text")))
extern int wc_ws_send_text(int conn_id, const char* str, unsigned int len);

__attribute__((import_module("env"), import_name("wc_ws_state")))
extern int wc_ws_state(int conn_id);
#else
static inline int wc_ws_open(const char* url, unsigned int url_len) {
    (void)url; (void)url_len; return -1;
}
static inline void wc_ws_close(int conn_id, unsigned int code) {
    (void)conn_id; (void)code;
}
static inline int wc_ws_send(int conn_id, const void* data, unsigned int len) {
    (void)conn_id; (void)data; (void)len; return -1;
}
static inline int wc_ws_send_text(int conn_id, const char* str, unsigned int len) {
    (void)conn_id; (void)str; (void)len; return -1;
}
static inline int wc_ws_state(int conn_id) {
    (void)conn_id; return 3; /* CLOSED */
}
#endif

// WebSocket exports (cart implements, host calls — all optional)
// void wc_ws_on_open(int conn_id);
// void wc_ws_on_message(int conn_id, const void* data, unsigned int len);
// void wc_ws_on_message_text(int conn_id, const char* str, unsigned int len);
// void wc_ws_on_close(int conn_id, unsigned int code);
// void wc_ws_on_error(int conn_id);

#endif // WC_USE_NET_WS

#ifdef WC_USE_NET_DC

// Data Channel imports (cart calls into host)
#ifdef __wasm__
__attribute__((import_module("env"), import_name("wc_dc_peer_count")))
extern int wc_dc_peer_count(void);

__attribute__((import_module("env"), import_name("wc_dc_peer_info")))
extern int wc_dc_peer_info(unsigned int index, char* dest, unsigned int max_len);

__attribute__((import_module("env"), import_name("wc_dc_send")))
extern int wc_dc_send(int peer_id, const void* data, unsigned int len);

__attribute__((import_module("env"), import_name("wc_dc_broadcast")))
extern int wc_dc_broadcast(const void* data, unsigned int len);
#else
static inline int wc_dc_peer_count(void) { return 0; }
static inline int wc_dc_peer_info(unsigned int index, char* dest, unsigned int max_len) {
    (void)index; (void)dest; (void)max_len; return -1;
}
static inline int wc_dc_send(int peer_id, const void* data, unsigned int len) {
    (void)peer_id; (void)data; (void)len; return -1;
}
static inline int wc_dc_broadcast(const void* data, unsigned int len) {
    (void)data; (void)len; return -1;
}
#endif

// Data Channel exports (cart implements, host calls — all optional)
// void wc_dc_on_connect(int peer_id, const char* label, unsigned int label_len);
// void wc_dc_on_disconnect(int peer_id);
// void wc_dc_on_message(int peer_id, const void* data, unsigned int len);

#endif // WC_USE_NET_DC

// --- OpenGL ES 3.0 API (ABI v2, optional) ---
// Define WC_USE_GL before including this header to enable GL imports.
// Cart GL calls are imported from the "gl" WASM module and routed to the
// host's GL backend (native EGL+GLES3, ANGLE, or WebGL2).

#ifdef WC_USE_GL

// GL type aliases
typedef unsigned int   GLenum;
typedef unsigned char  GLboolean;
typedef unsigned int   GLbitfield;
typedef int            GLint;
typedef unsigned int   GLuint;
typedef int            GLsizei;
typedef float          GLfloat;
typedef signed long int GLsizeiptr;   // wasm32: 4 bytes
typedef signed long int GLintptr;

// GL constants
#define GL_FALSE                          0
#define GL_TRUE                           1
#define GL_NONE                           0

// Clear bits
#define GL_DEPTH_BUFFER_BIT               0x00000100
#define GL_STENCIL_BUFFER_BIT             0x00000400
#define GL_COLOR_BUFFER_BIT               0x00004000

// Primitive types
#define GL_POINTS                         0x0000
#define GL_LINES                          0x0001
#define GL_LINE_LOOP                      0x0002
#define GL_LINE_STRIP                     0x0003
#define GL_TRIANGLES                      0x0004
#define GL_TRIANGLE_STRIP                 0x0005
#define GL_TRIANGLE_FAN                   0x0006

// Data types
#define GL_BYTE                           0x1400
#define GL_UNSIGNED_BYTE                  0x1401
#define GL_SHORT                          0x1402
#define GL_UNSIGNED_SHORT                 0x1403
#define GL_INT                            0x1404
#define GL_UNSIGNED_INT                   0x1405
#define GL_FLOAT                          0x1406
#define GL_HALF_FLOAT                     0x140B

// Enable/Disable
#define GL_BLEND                          0x0BE2
#define GL_CULL_FACE                      0x0B44
#define GL_DEPTH_TEST                     0x0B71
#define GL_DITHER                         0x0BD0
#define GL_POLYGON_OFFSET_FILL            0x8037
#define GL_SCISSOR_TEST                   0x0C11
#define GL_STENCIL_TEST                   0x0B90

// Blend factors
#define GL_ZERO                           0
#define GL_ONE                            1
#define GL_SRC_COLOR                      0x0300
#define GL_ONE_MINUS_SRC_COLOR            0x0301
#define GL_SRC_ALPHA                      0x0302
#define GL_ONE_MINUS_SRC_ALPHA            0x0303
#define GL_DST_ALPHA                      0x0304
#define GL_ONE_MINUS_DST_ALPHA            0x0305
#define GL_DST_COLOR                      0x0306
#define GL_ONE_MINUS_DST_COLOR            0x0307

// Blend equations
#define GL_FUNC_ADD                       0x8006
#define GL_FUNC_SUBTRACT                  0x800A
#define GL_FUNC_REVERSE_SUBTRACT          0x800B

// Depth / Stencil
#define GL_NEVER                          0x0200
#define GL_LESS                           0x0201
#define GL_EQUAL                          0x0202
#define GL_LEQUAL                         0x0203
#define GL_GREATER                        0x0204
#define GL_NOTEQUAL                       0x0205
#define GL_GEQUAL                         0x0206
#define GL_ALWAYS                         0x0207
#define GL_KEEP                           0x1E00
#define GL_REPLACE                        0x1E01
#define GL_INCR                           0x1E02
#define GL_DECR                           0x1E03
#define GL_INCR_WRAP                      0x8507
#define GL_DECR_WRAP                      0x8508
#define GL_INVERT                         0x150A

// Face culling
#define GL_FRONT                          0x0404
#define GL_BACK                           0x0405
#define GL_FRONT_AND_BACK                 0x0408
#define GL_CW                             0x0900
#define GL_CCW                            0x0901

// Buffer targets
#define GL_ARRAY_BUFFER                   0x8892
#define GL_ELEMENT_ARRAY_BUFFER           0x8893

// Buffer usage
#define GL_STATIC_DRAW                    0x88E4
#define GL_DYNAMIC_DRAW                   0x88E8
#define GL_STREAM_DRAW                    0x88E0

// Texture targets
#define GL_TEXTURE_2D                     0x0DE1
#define GL_TEXTURE_CUBE_MAP               0x8513

// Texture params
#define GL_TEXTURE_MIN_FILTER             0x2801
#define GL_TEXTURE_MAG_FILTER             0x2800
#define GL_TEXTURE_WRAP_S                 0x2802
#define GL_TEXTURE_WRAP_T                 0x2803
#define GL_NEAREST                        0x2600
#define GL_LINEAR                         0x2601
#define GL_NEAREST_MIPMAP_NEAREST         0x2700
#define GL_LINEAR_MIPMAP_NEAREST          0x2701
#define GL_NEAREST_MIPMAP_LINEAR          0x2702
#define GL_LINEAR_MIPMAP_LINEAR           0x2703
#define GL_CLAMP_TO_EDGE                  0x812F
#define GL_REPEAT                         0x2901
#define GL_MIRRORED_REPEAT                0x8370

// Texture units
#define GL_TEXTURE0                       0x84C0

// Pixel formats
#define GL_ALPHA                          0x1906
#define GL_RGB                            0x1907
#define GL_RGBA                           0x1908
#define GL_LUMINANCE                      0x1909
#define GL_LUMINANCE_ALPHA                0x190A
#define GL_RED                            0x1903
#define GL_RG                             0x8227
#define GL_R8                             0x8229
#define GL_RG8                            0x822B
#define GL_RGB8                           0x8051
#define GL_RGBA8                          0x8058

// Shader types
#define GL_VERTEX_SHADER                  0x8B31
#define GL_FRAGMENT_SHADER                0x8B30

// Shader params
#define GL_COMPILE_STATUS                 0x8B81
#define GL_LINK_STATUS                    0x8B82
#define GL_VALIDATE_STATUS                0x8B83
#define GL_INFO_LOG_LENGTH                0x8B84

// Framebuffer
#define GL_FRAMEBUFFER                    0x8D40
#define GL_READ_FRAMEBUFFER               0x8CA8
#define GL_DRAW_FRAMEBUFFER               0x8CA9
#define GL_RENDERBUFFER                   0x8D41
#define GL_COLOR_ATTACHMENT0              0x8CE0
#define GL_DEPTH_ATTACHMENT               0x8D00
#define GL_STENCIL_ATTACHMENT             0x8D20
#define GL_DEPTH_STENCIL_ATTACHMENT       0x821A
#define GL_FRAMEBUFFER_COMPLETE           0x8CD5

// Renderbuffer formats
#define GL_DEPTH_COMPONENT16              0x81A5
#define GL_DEPTH_COMPONENT24              0x81A6
#define GL_DEPTH24_STENCIL8               0x88F0

// GetString
#define GL_VENDOR                         0x1F00
#define GL_RENDERER                       0x1F01
#define GL_VERSION                        0x1F02

// Errors
#define GL_NO_ERROR                       0

// ─── GL Function Declarations ─────────────────────────────────────────

#ifdef __wasm__
#define _GL_IMPORT(name) __attribute__((import_module("gl"), import_name(#name)))
#else
#define _GL_IMPORT(name)
#endif

// State
_GL_IMPORT(glEnable)      extern void glEnable(GLenum cap);
_GL_IMPORT(glDisable)     extern void glDisable(GLenum cap);
_GL_IMPORT(glGetError)    extern GLenum glGetError(void);
_GL_IMPORT(glFinish)      extern void glFinish(void);
_GL_IMPORT(glFlush)       extern void glFlush(void);
_GL_IMPORT(glHint)        extern void glHint(GLenum target, GLenum mode);
_GL_IMPORT(glPixelStorei) extern void glPixelStorei(GLenum pname, GLint param);
_GL_IMPORT(glGetIntegerv) extern void glGetIntegerv(GLenum pname, GLint* data);
_GL_IMPORT(glGetString)   extern const unsigned char* glGetString(GLenum name);

// Viewport / Clear
_GL_IMPORT(glViewport)     extern void glViewport(GLint x, GLint y, GLsizei w, GLsizei h);
_GL_IMPORT(glScissor)      extern void glScissor(GLint x, GLint y, GLsizei w, GLsizei h);
_GL_IMPORT(glClear)        extern void glClear(GLbitfield mask);
_GL_IMPORT(glClearColor)   extern void glClearColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a);
_GL_IMPORT(glClearDepthf)  extern void glClearDepthf(GLfloat d);
_GL_IMPORT(glClearStencil) extern void glClearStencil(GLint s);

// Blending
_GL_IMPORT(glBlendFunc)            extern void glBlendFunc(GLenum sfactor, GLenum dfactor);
_GL_IMPORT(glBlendFuncSeparate)    extern void glBlendFuncSeparate(GLenum srcRGB, GLenum dstRGB, GLenum srcA, GLenum dstA);
_GL_IMPORT(glBlendEquation)        extern void glBlendEquation(GLenum mode);
_GL_IMPORT(glBlendEquationSeparate) extern void glBlendEquationSeparate(GLenum modeRGB, GLenum modeAlpha);
_GL_IMPORT(glBlendColor)           extern void glBlendColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a);
_GL_IMPORT(glColorMask)            extern void glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a);

// Depth / Stencil
_GL_IMPORT(glDepthFunc)            extern void glDepthFunc(GLenum func);
_GL_IMPORT(glDepthMask)            extern void glDepthMask(GLboolean flag);
_GL_IMPORT(glDepthRangef)          extern void glDepthRangef(GLfloat n, GLfloat f);
_GL_IMPORT(glStencilFunc)          extern void glStencilFunc(GLenum func, GLint ref, GLuint mask);
_GL_IMPORT(glStencilFuncSeparate)  extern void glStencilFuncSeparate(GLenum face, GLenum func, GLint ref, GLuint mask);
_GL_IMPORT(glStencilOp)            extern void glStencilOp(GLenum fail, GLenum zfail, GLenum zpass);
_GL_IMPORT(glStencilOpSeparate)    extern void glStencilOpSeparate(GLenum face, GLenum sfail, GLenum dpfail, GLenum dppass);
_GL_IMPORT(glStencilMask)          extern void glStencilMask(GLuint mask);
_GL_IMPORT(glStencilMaskSeparate)  extern void glStencilMaskSeparate(GLenum face, GLuint mask);

// Face culling
_GL_IMPORT(glCullFace)       extern void glCullFace(GLenum mode);
_GL_IMPORT(glFrontFace)      extern void glFrontFace(GLenum mode);
_GL_IMPORT(glPolygonOffset)  extern void glPolygonOffset(GLfloat factor, GLfloat units);
_GL_IMPORT(glLineWidth)      extern void glLineWidth(GLfloat width);

// Buffers
_GL_IMPORT(glGenBuffers)    extern void glGenBuffers(GLsizei n, GLuint* buffers);
_GL_IMPORT(glDeleteBuffers) extern void glDeleteBuffers(GLsizei n, const GLuint* buffers);
_GL_IMPORT(glBindBuffer)    extern void glBindBuffer(GLenum target, GLuint buffer);
_GL_IMPORT(glBufferData)    extern void glBufferData(GLenum target, GLsizeiptr size, const void* data, GLenum usage);
_GL_IMPORT(glBufferSubData) extern void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void* data);

// Textures
_GL_IMPORT(glGenTextures)    extern void glGenTextures(GLsizei n, GLuint* textures);
_GL_IMPORT(glDeleteTextures) extern void glDeleteTextures(GLsizei n, const GLuint* textures);
_GL_IMPORT(glBindTexture)    extern void glBindTexture(GLenum target, GLuint texture);
_GL_IMPORT(glActiveTexture)  extern void glActiveTexture(GLenum texture);
_GL_IMPORT(glTexImage2D)     extern void glTexImage2D(GLenum target, GLint level, GLint internalformat, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const void* pixels);
_GL_IMPORT(glTexSubImage2D)  extern void glTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLenum type, const void* pixels);
_GL_IMPORT(glTexParameteri)  extern void glTexParameteri(GLenum target, GLenum pname, GLint param);
_GL_IMPORT(glTexParameterf)  extern void glTexParameterf(GLenum target, GLenum pname, GLfloat param);
_GL_IMPORT(glGenerateMipmap) extern void glGenerateMipmap(GLenum target);
_GL_IMPORT(glCompressedTexImage2D) extern void glCompressedTexImage2D(GLenum target, GLint level, GLenum internalformat, GLsizei width, GLsizei height, GLint border, GLsizei imageSize, const void* data);

// Shaders
_GL_IMPORT(glCreateShader)      extern GLuint glCreateShader(GLenum type);
_GL_IMPORT(glDeleteShader)      extern void glDeleteShader(GLuint shader);
_GL_IMPORT(glShaderSource)      extern void glShaderSource(GLuint shader, GLsizei count, const char* const* string, const GLint* length);
_GL_IMPORT(glCompileShader)     extern void glCompileShader(GLuint shader);
_GL_IMPORT(glGetShaderiv)       extern void glGetShaderiv(GLuint shader, GLenum pname, GLint* params);
_GL_IMPORT(glGetShaderInfoLog)  extern void glGetShaderInfoLog(GLuint shader, GLsizei bufSize, GLsizei* length, char* infoLog);

// Programs
_GL_IMPORT(glCreateProgram)      extern GLuint glCreateProgram(void);
_GL_IMPORT(glDeleteProgram)      extern void glDeleteProgram(GLuint program);
_GL_IMPORT(glAttachShader)       extern void glAttachShader(GLuint program, GLuint shader);
_GL_IMPORT(glDetachShader)       extern void glDetachShader(GLuint program, GLuint shader);
_GL_IMPORT(glLinkProgram)        extern void glLinkProgram(GLuint program);
_GL_IMPORT(glUseProgram)         extern void glUseProgram(GLuint program);
_GL_IMPORT(glGetProgramiv)       extern void glGetProgramiv(GLuint program, GLenum pname, GLint* params);
_GL_IMPORT(glGetProgramInfoLog)  extern void glGetProgramInfoLog(GLuint program, GLsizei bufSize, GLsizei* length, char* infoLog);
_GL_IMPORT(glValidateProgram)    extern void glValidateProgram(GLuint program);
_GL_IMPORT(glBindAttribLocation) extern void glBindAttribLocation(GLuint program, GLuint index, const char* name);
_GL_IMPORT(glGetAttribLocation)  extern GLint glGetAttribLocation(GLuint program, const char* name);
_GL_IMPORT(glGetUniformLocation) extern GLint glGetUniformLocation(GLuint program, const char* name);
_GL_IMPORT(glGetActiveAttrib)    extern void glGetActiveAttrib(GLuint program, GLuint index, GLsizei bufSize, GLsizei* length, GLint* size, GLenum* type, char* name);
_GL_IMPORT(glGetActiveUniform)   extern void glGetActiveUniform(GLuint program, GLuint index, GLsizei bufSize, GLsizei* length, GLint* size, GLenum* type, char* name);

// Uniforms
_GL_IMPORT(glUniform1i)  extern void glUniform1i(GLint location, GLint v0);
_GL_IMPORT(glUniform2i)  extern void glUniform2i(GLint location, GLint v0, GLint v1);
_GL_IMPORT(glUniform3i)  extern void glUniform3i(GLint location, GLint v0, GLint v1, GLint v2);
_GL_IMPORT(glUniform4i)  extern void glUniform4i(GLint location, GLint v0, GLint v1, GLint v2, GLint v3);
_GL_IMPORT(glUniform1f)  extern void glUniform1f(GLint location, GLfloat v0);
_GL_IMPORT(glUniform2f)  extern void glUniform2f(GLint location, GLfloat v0, GLfloat v1);
_GL_IMPORT(glUniform3f)  extern void glUniform3f(GLint location, GLfloat v0, GLfloat v1, GLfloat v2);
_GL_IMPORT(glUniform4f)  extern void glUniform4f(GLint location, GLfloat v0, GLfloat v1, GLfloat v2, GLfloat v3);
_GL_IMPORT(glUniform1iv) extern void glUniform1iv(GLint location, GLsizei count, const GLint* value);
_GL_IMPORT(glUniform2iv) extern void glUniform2iv(GLint location, GLsizei count, const GLint* value);
_GL_IMPORT(glUniform3iv) extern void glUniform3iv(GLint location, GLsizei count, const GLint* value);
_GL_IMPORT(glUniform4iv) extern void glUniform4iv(GLint location, GLsizei count, const GLint* value);
_GL_IMPORT(glUniform1fv) extern void glUniform1fv(GLint location, GLsizei count, const GLfloat* value);
_GL_IMPORT(glUniform2fv) extern void glUniform2fv(GLint location, GLsizei count, const GLfloat* value);
_GL_IMPORT(glUniform3fv) extern void glUniform3fv(GLint location, GLsizei count, const GLfloat* value);
_GL_IMPORT(glUniform4fv) extern void glUniform4fv(GLint location, GLsizei count, const GLfloat* value);
_GL_IMPORT(glUniformMatrix2fv) extern void glUniformMatrix2fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat* value);
_GL_IMPORT(glUniformMatrix3fv) extern void glUniformMatrix3fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat* value);
_GL_IMPORT(glUniformMatrix4fv) extern void glUniformMatrix4fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat* value);

// Vertex attribs
_GL_IMPORT(glEnableVertexAttribArray)  extern void glEnableVertexAttribArray(GLuint index);
_GL_IMPORT(glDisableVertexAttribArray) extern void glDisableVertexAttribArray(GLuint index);
_GL_IMPORT(glVertexAttribPointer)      extern void glVertexAttribPointer(GLuint index, GLint size, GLenum type, GLboolean normalized, GLsizei stride, const void* pointer);

// Drawing
_GL_IMPORT(glDrawArrays)   extern void glDrawArrays(GLenum mode, GLint first, GLsizei count);
_GL_IMPORT(glDrawElements)  extern void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void* indices);

// FBOs
_GL_IMPORT(glGenFramebuffers)        extern void glGenFramebuffers(GLsizei n, GLuint* framebuffers);
_GL_IMPORT(glDeleteFramebuffers)     extern void glDeleteFramebuffers(GLsizei n, const GLuint* framebuffers);
_GL_IMPORT(glBindFramebuffer)        extern void glBindFramebuffer(GLenum target, GLuint framebuffer);
_GL_IMPORT(glCheckFramebufferStatus) extern GLenum glCheckFramebufferStatus(GLenum target);
_GL_IMPORT(glFramebufferTexture2D)   extern void glFramebufferTexture2D(GLenum target, GLenum attachment, GLenum textarget, GLuint texture, GLint level);
_GL_IMPORT(glFramebufferRenderbuffer) extern void glFramebufferRenderbuffer(GLenum target, GLenum attachment, GLenum renderbuffertarget, GLuint renderbuffer);

// RBOs
_GL_IMPORT(glGenRenderbuffers)    extern void glGenRenderbuffers(GLsizei n, GLuint* renderbuffers);
_GL_IMPORT(glDeleteRenderbuffers) extern void glDeleteRenderbuffers(GLsizei n, const GLuint* renderbuffers);
_GL_IMPORT(glBindRenderbuffer)    extern void glBindRenderbuffer(GLenum target, GLuint renderbuffer);
_GL_IMPORT(glRenderbufferStorage) extern void glRenderbufferStorage(GLenum target, GLenum internalformat, GLsizei width, GLsizei height);

// Readback
_GL_IMPORT(glReadPixels) extern void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void* pixels);

// ES3 / VAO
_GL_IMPORT(glGenVertexArrays)       extern void glGenVertexArrays(GLsizei n, GLuint* arrays);
_GL_IMPORT(glDeleteVertexArrays)    extern void glDeleteVertexArrays(GLsizei n, const GLuint* arrays);
_GL_IMPORT(glBindVertexArray)       extern void glBindVertexArray(GLuint array);
_GL_IMPORT(glDrawArraysInstanced)   extern void glDrawArraysInstanced(GLenum mode, GLint first, GLsizei count, GLsizei instancecount);
_GL_IMPORT(glDrawElementsInstanced) extern void glDrawElementsInstanced(GLenum mode, GLsizei count, GLenum type, const void* indices, GLsizei instancecount);
_GL_IMPORT(glVertexAttribDivisor)   extern void glVertexAttribDivisor(GLuint index, GLuint divisor);
_GL_IMPORT(glDrawBuffers)           extern void glDrawBuffers(GLsizei n, const GLenum* bufs);

// WebGL2 UBO / Buffer binding
_GL_IMPORT(glBindBufferBase)        extern void glBindBufferBase(GLenum target, GLuint index, GLuint buffer);
_GL_IMPORT(glBindBufferRange)       extern void glBindBufferRange(GLenum target, GLuint index, GLuint buffer, GLintptr offset, GLsizeiptr size);
_GL_IMPORT(glGetUniformBlockIndex)  extern GLuint glGetUniformBlockIndex(GLuint program, const char* uniformBlockName);
_GL_IMPORT(glUniformBlockBinding)   extern void glUniformBlockBinding(GLuint program, GLuint uniformBlockIndex, GLuint uniformBlockBinding);
_GL_IMPORT(glTexStorage2D)          extern void glTexStorage2D(GLenum target, GLsizei levels, GLenum internalformat, GLsizei width, GLsizei height);

#undef _GL_IMPORT

#endif // WC_USE_GL

#endif // WASMCART_H
