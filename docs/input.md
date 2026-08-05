# Input - Gamepad, Rumble, Pointer, Keyboard, Text

## Gamepad Input (Always Available)

Every wasmcart host normalizes controller input to the **W3C Standard Gamepad** layout before writing to `wc_pads[]`. The cart always sees the same button/axis mapping regardless of the physical controller.

### Normalization Pipeline

```
Physical controller (Xbox, PS5, 8BitDo, Switch Pro, etc.)
    ↓
Host SDL / HID driver
    ↓
SDL GameController mapping (gamecontrollerdb.txt - 2000+ controller definitions)
    ↓
Normalized to W3C Standard Gamepad layout
    ↓
Written to wc_pad_t[4] shared memory
    ↓
Cart reads buttons/axes - every controller looks the same
```

This means:
- An Xbox controller's A button = `WC_BTN_A` = W3C `buttons[0]`
- A PlayStation DualSense's X button = `WC_BTN_A` = W3C `buttons[0]`
- A Nintendo Pro Controller's B button = `WC_BTN_A` = W3C `buttons[0]`
- A virtual touchscreen overlay's south button = `WC_BTN_A` = W3C `buttons[0]`

The cart never needs to know what controller is physically connected.

### wc_pad_t Layout (16 bytes per pad)

```c
typedef struct {
    uint16_t buttons;        // Bitmask (WC_BTN_A, WC_BTN_B, etc.)
    int16_t  left_x;         // Left stick X: -32768 to 32767
    int16_t  left_y;         // Left stick Y: -32768 to 32767
    int16_t  right_x;        // Right stick X: -32768 to 32767
    int16_t  right_y;        // Right stick Y: -32768 to 32767
    uint8_t  left_trigger;   // Left trigger: 0-255
    uint8_t  right_trigger;  // Right trigger: 0-255
    uint8_t  connected;      // 1 if controller is connected
    uint8_t  _pad[3];        // Alignment padding
} wc_pad_t;
```

### Button Mapping (W3C Standard Gamepad)

| Bit | Constant | W3C Index | Xbox | PlayStation | Nintendo |
|-----|----------|-----------|------|-------------|----------|
| 0 | `WC_BTN_A` | buttons[0] | A | Cross | B |
| 1 | `WC_BTN_B` | buttons[1] | B | Circle | A |
| 2 | `WC_BTN_X` | buttons[2] | X | Square | Y |
| 3 | `WC_BTN_Y` | buttons[3] | Y | Triangle | X |
| 4 | `WC_BTN_L` | buttons[4] | LB | L1 | L |
| 5 | `WC_BTN_R` | buttons[5] | RB | R1 | R |
| 6 | `WC_BTN_START` | buttons[9] | Start/Menu | Options | + |
| 7 | `WC_BTN_SELECT` | buttons[8] | Back/View | Share | - |
| 8 | `WC_BTN_UP` | buttons[12] | D-pad Up | D-pad Up | D-pad Up |
| 9 | `WC_BTN_DOWN` | buttons[13] | D-pad Down | D-pad Down | D-pad Down |
| 10 | `WC_BTN_LEFT` | buttons[14] | D-pad Left | D-pad Left | D-pad Left |
| 11 | `WC_BTN_RIGHT` | buttons[15] | D-pad Right | D-pad Right | D-pad Right |
| 12 | `WC_BTN_L3` | buttons[10] | LS Click | L3 | LS Click |
| 13 | `WC_BTN_R3` | buttons[11] | RS Click | R3 | RS Click |

Bits 14-15 are unassigned. Note the wasmcart bit is NOT the W3C index — the
two orders differ (W3C puts the analog triggers at buttons[6]/[7]; wasmcart
has no trigger bits at all). The triggers are analog-only here: read
`left_trigger`/`right_trigger` (0-255).

### Axes

| Axis | W3C Index | Range |
|------|-----------|-------|
| Left Stick X | axes[0] | -32768 to 32767 (left to right) |
| Left Stick Y | axes[1] | -32768 to 32767 (up to down) |
| Right Stick X | axes[2] | -32768 to 32767 |
| Right Stick Y | axes[3] | -32768 to 32767 |

Note: W3C Gamepad API uses -1.0 to 1.0 floats. wasmcart uses int16. JS game runtimes (wasmcart-jsgame) convert: `axes[i] = pad.left_x / 32767.0`.

### For JS Game Runtimes

When exposing `navigator.getGamepads()` to JavaScript games, the gamepad object **must** include `mapping: 'standard'`. Many game frameworks (Phaser, custom engines) filter gamepads by this property:

```javascript
// Common pattern in game code:
gamepads = navigator.getGamepads().filter(gp => gp && gp.mapping === 'standard');
```

Without `mapping: 'standard'`, the gamepad is invisible to the game even though input data is available.

### 4-Player Support

`wc_pads[0]` through `wc_pads[3]` support up to 4 controllers. The host maps physical controllers to pad slots in connection order. `connected` field indicates which slots are active.

## Pointer Input (Opt-In, ABI v3)

Unified mouse + multitouch. Cart declares it by setting `WC_FLAG_POINTER` in
`wc_info_t.flags` — the flag is the only gate, no manifest field is involved.
Host writes `wc_pointer_t[10]` state each frame, in CART pixels (the host
inverts whatever letterboxing/scaling it presented with).

```c
typedef struct {
    int16_t  x;        // cart-resolution pixels
    int16_t  y;
    uint8_t  buttons;  // bit 0 primary, bit 1 secondary, bit 2 middle
    uint8_t  active;   // 1 while this pointer exists
    uint8_t  _pad[2];
} wc_pointer_t;         // 8 bytes; wc_info_t.pointer_ptr → wc_pointer_t[10]
```

**Slot allocation is the contract:** slot 0 is the mouse, slots 1-9 are touch
contacts (fingers), one slot per finger for as long as it stays down. The #1
portability trap is a cart that polls only `pointer[0]`: it works perfectly
with a desktop mouse and silently ignores every touch on a phone or tablet.
Poll all ten slots (a `for` loop costs nothing) unless the game genuinely
wants only a cursor. A touch contact ends with `active = 0` — that is the
touchend.

Polling the array is the primary model. Carts that want edges instead may
export the optional callbacks, which hosts call as events arrive:

```c
void wc_ptr_on_down(uint32_t id, int16_t x, int16_t y, uint8_t button);
void wc_ptr_on_move(uint32_t id, int16_t x, int16_t y);
void wc_ptr_on_up  (uint32_t id, uint8_t button);
```

Host applications drive the array through the reference hosts'
`setPointer(id, x, y, buttons, active)` /
`pointerDown` / `pointerMove` / `pointerUp` methods.

Related: the advisory manifest `controls` field (SPEC, Manifest section)
tells hosts that draw ON-SCREEN touch pads which subset of `wc_pad_t` the
game reads. It is presentation-only and unrelated to `WC_FLAG_POINTER`,
which is about the cart reading a pointer itself. It never truncates input:
the host writes the full `wc_pad_t` every frame regardless, and a control
the UI didn't draw just never changes — the same as a player who never
touches it.

## Keyboard Input (Opt-In, ABI v3)

256-bit key state bitmask using USB HID scancodes. Cart declares it by setting
`WC_FLAG_KEYBOARD` in `wc_info_t.flags` — the flag is the only gate, no
manifest field is involved. Host writes the `uint8_t[32]` bitmask
(`wc_info_t.keys_ptr`) each frame; test a key with the header's
`WC_KEY_IS_DOWN(keys, scancode)` helper.

Once the flag is set, the host STOPS mapping keyboard keys onto gamepad
buttons for that cart — the cart owns the keyboard, so WASD does not also
steer pad 1.

Optional edge callbacks, called as events arrive (`modifiers` is the
`WC_MOD_*` bitmask):

```c
void wc_kb_on_down(uint8_t keycode, uint8_t modifiers);
void wc_kb_on_up  (uint8_t keycode, uint8_t modifiers);
```

Scancodes identify physical key POSITIONS. For characters (names, chat,
anything a layout or IME touches), use Text Input below instead.

## Rumble (Always Available, ABI v3)

Rumble runs the opposite way to everything above: the cart drives it, so it is a
set of host **imports** rather than shared-memory state the host writes. There is
no flag and no manifest entry - a cart just calls it.

```c
unsigned int wc_pad_has_rumble(unsigned int pad_id);
void wc_pad_rumble(unsigned int pad_id, float low, float high,
                   unsigned int duration_ms);
void wc_pad_rumble_stop(unsigned int pad_id);
```

`low` drives the low-frequency ("strong") motor and `high` the high-frequency
("weak") one, both `0.0 .. 1.0`. These map straight onto SDL's
`SDL_GameControllerRumble` and the W3C `dual-rumble` effect
(`strongMagnitude` / `weakMagnitude`), so the same call behaves identically in a
native window and in a browser.

**Ask before assuming.** Rumble support is per-*device*, not per-platform: an
Xbox 360 pad reports rumble but not trigger rumble, and a keyboard-only setup
reports none at all. `wc_pad_has_rumble()` is what lets a cart offer the player a
toggle. Calling rumble on a pad without it is a silent no-op, so skipping the
query is safe but leaves the cart unable to tell.

**Values are clamped, not rejected.** Magnitudes outside `0..1` clamp into range
(NaN becomes 0) and `duration_ms` caps at `WC_RUMBLE_MAX_MS` (5s). A cart
deriving intensity from game state overshoots at the edges, and a dropped rumble
is harder to diagnose than a saturated one. The duration cap also means a cart
cannot pin the motors indefinitely: the host stops them on its own timer, so a
cart that crashes mid-effect still leaves the controller quiet. Sustained rumble
is done by re-arming each frame.

Hosts always provide these imports. Where no device is wired (headless runs,
`--frames` captures, tests) they are no-ops and `wc_pad_has_rumble` returns 0, so
a cart that rumbles is never a cart that fails to load.

## Text Input (Opt-In, ABI v3)

Keyboard scancodes are physical key positions; text is characters. `Shift+2` is
`@` on a US layout and something else on many others, and `é` has no scancode at
all -- so a cart that reads scancodes and tries to derive characters is
reimplementing keyboard layouts, badly. Use text input instead for names, chat
and seeds.

```c
void wc_on_text(const char* utf8, uint32_t len);  // cart export, optional
void wc_text_input_begin(void);                   // host imports
void wc_text_input_end(void);
unsigned int wc_text_input_active(void);
```

The host hands over text the platform has already composed: layout, shift, dead
keys, compose sequences and IME commits are all applied before it reaches you.

- **Copy immediately.** The pointer is valid only during the call and is not
  null-terminated. Always honour `len` -- one call can carry several codepoints,
  because an IME commits a whole word at once.
- **It is off until you ask.** Call `wc_text_input_begin()` when a field opens
  and `wc_text_input_end()` when it closes. On mobile that is what raises and
  dismisses the on-screen keyboard, and while it is active the host suppresses
  gameplay key bindings -- otherwise typing "w" in a chat box also walks the
  player forward.
- **Editing keys are still keys.** Backspace, arrows and enter are presses, not
  characters. Read those through `wc_kb_on_down` and append what arrives via
  `wc_on_text`.
