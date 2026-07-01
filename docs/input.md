# Input - Gamepad, Pointer, Keyboard

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
| 6 | - | buttons[6] | LT (analog) | L2 (analog) | ZL |
| 7 | - | buttons[7] | RT (analog) | R2 (analog) | ZR |
| 8 | `WC_BTN_SELECT` | buttons[8] | Back/View | Share | - |
| 9 | `WC_BTN_START` | buttons[9] | Start/Menu | Options | + |
| 10 | `WC_BTN_UP` | buttons[12] | D-pad Up | D-pad Up | D-pad Up |
| 11 | `WC_BTN_DOWN` | buttons[13] | D-pad Down | D-pad Down | D-pad Down |
| 12 | `WC_BTN_LEFT` | buttons[14] | D-pad Left | D-pad Left | D-pad Left |
| 13 | `WC_BTN_RIGHT` | buttons[15] | D-pad Right | D-pad Right | D-pad Right |
| 14 | `WC_BTN_L3` | buttons[10] | LS Click | L3 | LS Click |
| 15 | `WC_BTN_R3` | buttons[11] | RS Click | R3 | RS Click |

Triggers (buttons[6]/[7]) are analog - use `left_trigger`/`right_trigger` (0-255) for analog values, or the button bit for digital pressed/not-pressed.

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

Unified mouse + multitouch. Cart declares `"pointer": true` in manifest. Host writes `wc_pointer_t[10]` state each frame.

## Keyboard Input (Opt-In, ABI v3)

256-bit key state bitmask using USB HID scancodes. Cart declares `"keyboard": true` in manifest. Host writes `uint8_t[32]` bitmask each frame.
