# wasmcart Specification

> **Current ABI version: 3** (backward compatible with v1 and v2). This is the
> normative specification for the wasmcart virtual cartridge format - the
> host↔cart contract that any conforming host (see the reference implementations
> in [`src/`](src/)) and any cart must follow. The machine-readable form of these
> constants lives in [`src/abi.js`](src/abi.js); the C-side contract in
> [`include/wc_cart.h`](include/wc_cart.h).


## Overview

ABI v3 extends wasmcart with networking (WebSocket + data channels) and extended input (pointer + keyboard). All new features are opt-in. Gamepad is always the default input. Backwards compatible with ABI v1 and v2 carts.

---

## Manifest

```json
{
  "name": "Game Name",
  "version": "1.0.0",
  "abi": 3,
  "entry": "cart.wasm",
  "players": 4,
  "pointer": true,
  "keyboard": true,
  "net": {
    "websocket": ["api.mygame.com", "leaderboard.example.com"],
    "data-channel": true
  }
}
```

### Fields

**`players`** (integer, optional, default: 1)
- How many gamepad inputs the game uses (1-4)

**`pointer`** (boolean, optional, default: false)
- If true, host writes pointer state (unified mouse/touch) and delivers pointer event callbacks
- If false, pointer state is not updated

**`keyboard`** (boolean, optional, default: false)
- If true, host writes raw key state and delivers key event callbacks
- If false, host does not deliver raw key input to the cart

**`net`** (object, optional)
- Omitted = no networking. Cart receives no network imports.
- If present, host provides the corresponding network imports to the cart
- Host MAY refuse to provide networking (e.g., offline device) - cart must handle gracefully

**`net.websocket`** (array of strings, optional)
- Domain allowlist for WebSocket connections
- Host enforces - connection attempts to unlisted domains fail
- No wildcards, no raw IPs, no localhost

**`net.data-channel`** (boolean, optional)
- If true, cart gets binary data channel imports
- Host manages peer connections and signaling (opaque to cart)

---

## Exports (cart provides)

```c
wc_info_t* wc_get_info(void);  // returns cart info struct
void wc_init(void);             // called once at startup
void wc_render(void);           // called every frame
```

---

## Imports (host provides)

```c
// Logging
void wc_log(const char* ptr, uint32_t len);

// Assets (v2+)
int32_t wc_asset_size(const char* path, uint32_t path_len);
int32_t wc_load_asset(const char* path, uint32_t path_len, void* dest, uint32_t max_size);

// GL (~100 functions, optional, imported from "gl" module)
void glClear(uint32_t mask);
// ... etc
```

---

## wc_info_t

```c
typedef struct {
    uint32_t version;           // 3
    uint32_t width;
    uint32_t height;
    uint32_t fb_ptr;
    uint32_t audio_ptr;
    uint32_t audio_cap;
    uint32_t audio_write_ptr;
    uint32_t input_ptr;         // → wc_pad_t[4]
    uint32_t save_ptr;
    uint32_t save_size;
    uint32_t time_ptr;
    uint32_t host_info_ptr;
    uint32_t flags;
    uint32_t audio_sample_rate;
    // v3 additions
    uint32_t pointer_ptr;       // → wc_pointer_t[10] (80 bytes), 0 = not used
    uint32_t keys_ptr;          // → uint8_t[32] key state bitmask, 0 = not used
} wc_info_t;
```

### Flags

```c
#define WC_FLAG_AUDIO_F32   0x01  // audio ring buffer uses float32
#define WC_FLAG_NET_WS      0x02  // cart wants WebSocket imports
#define WC_FLAG_NET_DC      0x04  // cart wants data channel imports
#define WC_FLAG_POINTER     0x08  // cart wants pointer input
#define WC_FLAG_KEYBOARD    0x10  // cart wants raw keyboard input
```

---

## WebSocket

### Cart imports (calls into host)

```c
// Open a WebSocket connection.
// url must be in the manifest's websocket allowlist.
// Returns a connection ID (>= 0) or -1 on failure.
int32_t wc_ws_open(const char* url, uint32_t url_len);

// Close a WebSocket connection.
void wc_ws_close(int32_t conn_id, uint32_t code);

// Send binary data. Returns bytes sent, or -1 on error.
int32_t wc_ws_send(int32_t conn_id, const void* data, uint32_t len);

// Send text data. Returns bytes sent, or -1 on error.
int32_t wc_ws_send_text(int32_t conn_id, const char* str, uint32_t len);

// Get readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
int32_t wc_ws_state(int32_t conn_id);
```

### Cart exports (host calls into cart - all optional)

```c
void wc_ws_on_open(int32_t conn_id);
void wc_ws_on_message(int32_t conn_id, const void* data, uint32_t len);
void wc_ws_on_message_text(int32_t conn_id, const char* str, uint32_t len);
void wc_ws_on_close(int32_t conn_id, uint32_t code);
void wc_ws_on_error(int32_t conn_id);
```

### Notes
- Event-driven - mirrors the real WebSocket API
- Host buffers events and delivers them before each `wc_render()` call
- Both binary and text frame support
- Cart exports are optional - if missing, host silently drops events
- Host validates URL against manifest allowlist before connecting
- Connection IDs are small integers managed by host (0, 1, 2, ...)
- `data`/`str` pointers in callbacks are temporary - cart must copy what it needs

---

## Data Channel

For peer-to-peer gameplay. The host manages signaling and peer connections - the cart just sees binary data channels. The underlying transport (WebRTC, relayed, LAN UDP, etc.) is opaque to the cart.

### Cart imports (calls into host)

```c
// Get number of currently connected peers.
int32_t wc_dc_peer_count(void);

// Get info about a peer by index (0 to peer_count-1).
// Writes a null-terminated username/label into dest.
// Returns the peer's connection ID, or -1 if index out of range.
int32_t wc_dc_peer_info(uint32_t index, char* dest, uint32_t max_len);

// Send binary data to a specific peer. Returns bytes sent, or -1 on error.
int32_t wc_dc_send(int32_t peer_id, const void* data, uint32_t len);

// Send binary data to all connected peers. Returns peer count, or -1 on error.
int32_t wc_dc_broadcast(const void* data, uint32_t len);
```

### Cart exports (host calls into cart - all optional)

```c
// peer_id is stable for this session.
void wc_dc_on_connect(int32_t peer_id, const char* label, uint32_t label_len);
void wc_dc_on_disconnect(int32_t peer_id);
void wc_dc_on_message(int32_t peer_id, const void* data, uint32_t len);
```

### Notes
- Cart does NOT manage connections - host handles all signaling
- peer_id works like a socket descriptor - games can use it to track players
- Cart exports are optional - if missing, cart can still poll via `wc_dc_peer_count()`/`wc_dc_peer_info()`
- Binary only - games serialize their own protocols
- Delivery semantics are host-defined (may be unreliable or reliable depending on transport)
- Host delivers events before `wc_render()`

---

## Pointer Input

Unified mouse + touch. Opt-in via `"pointer": true` in manifest. Both shared-memory state and event callbacks.

### Shared memory (host writes every frame)

```c
typedef struct {
    int16_t  x;        // cart-space coordinates (0 to width-1)
    int16_t  y;        // cart-space coordinates (0 to height-1)
    uint8_t  buttons;  // bitmask: bit0=primary, bit1=secondary, bit2=middle
    uint8_t  active;   // 1 if this pointer exists
    uint8_t  _pad[2];
} wc_pointer_t;        // 8 bytes

// 10 pointer slots, 80 bytes total
// Cart sets wc_info_t.pointer_ptr to a wc_pointer_t[10] buffer
```

### Cart exports (host calls into cart - all optional)

```c
void wc_ptr_on_down(uint32_t id, int16_t x, int16_t y, uint8_t button);
void wc_ptr_on_move(uint32_t id, int16_t x, int16_t y);
void wc_ptr_on_up(uint32_t id, uint8_t button);
```

### Notes
- Host normalizes screen coordinates to cart resolution
- Mouse = pointer 0 (always active when cursor is over window)
- Touch = each finger gets the next available slot, active only while touching, buttons=0x01
- If device has both mouse and touch, they coexist - mouse is 0, fingers fill 1+
- `button` param: 0=primary (left click / touch), 1=secondary (right click), 2=middle
- State array is always up to date regardless of whether cart exports callbacks
- Host delivers events before `wc_render()`

---

## Keyboard Input

Opt-in via `"keyboard": true` in manifest. Both shared-memory state and event callbacks.

### Shared memory (host writes every frame)

```c
// 256-bit bitmask - one bit per keycode
// Cart sets wc_info_t.keys_ptr to a uint8_t[32] buffer
uint8_t wc_keys[32];  // 32 bytes

// Test if key is down:
// wc_keys[keycode >> 3] & (1 << (keycode & 7))
```

### Cart exports (host calls into cart - all optional)

```c
void wc_kb_on_down(uint8_t keycode, uint8_t modifiers);
void wc_kb_on_up(uint8_t keycode, uint8_t modifiers);
```

### Modifier bitmask

```c
#define WC_MOD_SHIFT  0x01
#define WC_MOD_CTRL   0x02
#define WC_MOD_ALT    0x04
#define WC_MOD_META   0x08
```

### Keycodes (USB HID scancodes)

```c
// Letters (0x04–0x1D)
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

// Numbers (0x1E–0x27)
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

// Common keys
#define WC_KEY_ENTER      0x28
#define WC_KEY_ESCAPE     0x29
#define WC_KEY_BACKSPACE  0x2A
#define WC_KEY_TAB        0x2B
#define WC_KEY_SPACE      0x2C

// Punctuation
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

// Function keys (0x3A–0x45)
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

// Navigation
#define WC_KEY_INSERT     0x49
#define WC_KEY_HOME       0x4A
#define WC_KEY_PAGEUP     0x4B
#define WC_KEY_DELETE     0x4C
#define WC_KEY_END        0x4D
#define WC_KEY_PAGEDOWN   0x4E

// Arrows
#define WC_KEY_RIGHT      0x4F
#define WC_KEY_LEFT       0x50
#define WC_KEY_DOWN       0x51
#define WC_KEY_UP         0x52

// Numpad
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

// Modifiers (0xE0–0xE7)
#define WC_KEY_LCTRL   0xE0
#define WC_KEY_LSHIFT  0xE1
#define WC_KEY_LALT    0xE2
#define WC_KEY_LMETA   0xE3
#define WC_KEY_RCTRL   0xE4
#define WC_KEY_RSHIFT  0xE5
#define WC_KEY_RALT    0xE6
#define WC_KEY_RMETA   0xE7
```

All keycodes follow USB HID Usage Tables. SDL provides these natively. Browser `KeyboardEvent.code` requires a static lookup table to convert (well-documented 1:1 mapping).

### Notes
- Host delivers events before `wc_render()`
- State bitmask is always up to date regardless of whether cart exports callbacks
- When `"keyboard": true` is in manifest, host does not map keyboard keys to gamepad

---

## Security Model

1. **No networking by default** - omit `net` from manifest = zero network access
2. **Domain allowlist** - WebSocket connections only to declared domains
3. **No raw sockets** - no TCP, no UDP, no localhost, no IP addresses
4. **Host enforces** - cart can't bypass; imports validate before acting
5. **Graceful degradation** - offline hosts provide stub imports returning -1
6. **Data channels are host-managed** - cart can't initiate peer connections
7. **No DNS resolution** - cart can't enumerate network

---

## Backwards Compatibility

- ABI v1/v2 carts work unchanged - new wc_info_t fields are beyond v2 struct size, host detects version
- New fields (pointer_ptr, keys_ptr) default to 0 - host checks before writing
- All new cart exports are optional - host checks for their existence before calling
- All new cart imports return -1 or no-op when feature is unavailable
