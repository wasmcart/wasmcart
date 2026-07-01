# wasmcart

**A virtual cartridge format for safe, portable games.** A wasmcart cart is a
standalone WebAssembly module - a self-contained game that owns its own memory and
talks to the outside world only through a tiny, well-defined contract: the host
writes input + timing, calls `wc_render()` each frame, and reads back pixels and
audio. No filesystem, no syscalls, no ambient authority. Just pixels, sound, input,
and opt-in networking.

Because a cart is only WebAssembly + a fixed ABI, **the same cart runs anywhere a
conforming host exists** - Node.js, the browser, a libretro core in RetroArch, a
native player, a terminal - on any OS and any hardware with enough power. Write the
game once; it runs on all of them, sandboxed.

This repository is the **specification** and its **reference implementations**.

- 📄 **[SPEC.md](SPEC.md)** - the normative host↔cart contract (current ABI: v3)
- 🧩 **[`src/abi.js`](src/abi.js)** - the machine-readable contract (constants, layouts)
- 🖥️ **[`include/wc_cart.h`](include/wc_cart.h)** - the C side of the contract for cart authors
- 📚 **[`docs/`](docs/)** - per-subsystem guides (input, networking, GL, framebuffer, fetch, porting)

## Reference implementations

Two reference hosts ship in this package - they define, by example, what a
conforming host does. Both are pure JavaScript (MIT).

| Import | Class | Runs on |
|--------|-------|---------|
| `wasmcart`       | `CartHost`    | Node.js (native GLES3 via a supplied WebGL2 context) |
| `wasmcart/web`   | `CartHostWeb` | Browsers (WebGL2 from a `<canvas>`) |

```js
import { CartHost } from 'wasmcart';        // Node
import { CartHostWeb } from 'wasmcart/web';  // browser
```

Other hosts in the wasmcart org (own repos) run the *same* carts: a libretro core
(`wasmcart-libretro`), native players (`wasmcart-native-host`), and the terminal
emulator (`retroemu`). See **[The wasmcart org](#the-wasmcart-org)** below.

## Installation

```bash
npm install wasmcart
```

Requires Node.js >= 22.

## Cart Formats

| Format | Description |
|--------|-------------|
| `.wasm` | Standalone WASM file, assets embedded as C arrays |
| `.wasc` | ZIP archive: `manifest.json` + `cart.wasm` + `assets/` (recommended for games with assets) |

## The ABI

Every cart exports three functions:

- **`wc_get_info()`** - returns a pointer to a struct describing the cart's memory layout (framebuffer, audio ring, input pads, save data, timing)
- **`wc_init()`** - called once at startup
- **`wc_render()`** - called every frame (~60fps)

The cart declares all buffers as static globals. The host reads their locations from `wc_get_info()`, writes input/timing before each frame, and reads pixels/audio after `wc_render()` returns.

See [`examples/hello/wasmcart.h`](examples/hello/wasmcart.h) for the complete ABI header.

### Rendering Mode

Every cart declares its rendering mode via `wc_info_t.gpu_api`:

| Value | Mode | Description |
|-------|------|-------------|
| 0 | **2D Framebuffer** | Cart writes ARGB8888 pixels to the framebuffer. Host reads and displays them. *(legacy - prefer gpu_api=1)* |
| 1 | **WebGL2 / GLES3** | Cart renders via GL function imports. The GPU output is the primary display. **Recommended for all carts.** |
| 2 | **WebGPU** | *(reserved for future use)* |
| 3 | **Vulkan** | *(reserved for future use)* |

**Rendering mode is declared once** in `wc_get_info()` and does not change during the cart's lifetime.

### Recommended: All Carts Use GPU (gpu_api = 1)

**Every wasmcart host has OpenGL.** The recommended approach is for all carts to set `gpu_api = 1` and render all output through GL - even 2D pixel-buffer carts.

For carts that render pixels to a CPU buffer (software renderers, SDL2 2D games), use the `wc_gl_blit()` helper to upload the pixel buffer as a GL texture and draw a fullscreen quad:

```c
#define WC_USE_GL
#include "wasmcart.h"
#include "wc_gl_blit.h"   // single-header GL blit library

// In wc_get_info():
info.gpu_api = 1;

// In wc_render(), after drawing to your pixel buffer:
wc_gl_blit(my_pixels, width, height);  // uploads as GL texture + draws quad
```

This eliminates the host-side complexity of detecting 2D vs GL carts and managing two display paths. One rendering path for all carts, all hosts.

**Performance:** `glTexImage2D` is a DMA transfer - the GPU pulls pixel data without CPU waiting. At 1080p, this is significantly faster than the old CPU-side pixel copy + format conversion. 2D games that previously ran at 30fps at 1080p now run at 60fps with this approach.

**SDL2 carts** using the `sdl2_wc` backend can enable GL blit automatically:
```c
info.gpu_api = 1;                    // in wc_get_info()
SDL_WASMCART_SetGLBlit(1);           // in wc_init(), after SDL_Init
// Link with: sdl2_wc/sdl2_gl_blit.c
```

SDL's software renderer draws pixels as usual. The `sdl2_wc` backend uploads them to GL on `SDL_RenderPresent`. No game code changes needed.

### Legacy: 2D Framebuffer (gpu_api = 0)

Still supported for simplicity. The cart writes ARGB8888 pixels to a framebuffer, the host reads and displays them. No GL imports needed.

- Simplest possible cart - just write pixels to a buffer
- Host handles format conversion and display
- Performance limited by CPU pixel copy at high resolutions

### GPU Carts (gpu_api = 1)

- Render via GL function imports (`"gl"` WASM module)
- The host displays GL output directly (swapBuffers)
- If the host needs pixels (terminal rendering, screenshots), the **host** performs readback (`glReadPixels`) at whatever frequency it chooses
- 2D and 3D content can coexist on the same GL context

**Compositing** (e.g., 2D HUD over 3D scene) is the cart's responsibility within its chosen GPU API. There is no hybrid mode - a cart that uses GL for 3D and wants a 2D overlay renders both through GL.

**Hosts should reject carts with unsupported gpu_api values** gracefully (e.g., "This host does not support WebGPU carts").

### Resolution Negotiation

The host and cart negotiate resolution through a two-step process:

1. **Host → Cart**: Before calling `wc_init()`, the host writes its preferred resolution to `wc_host_info_t.preferred_width` and `preferred_height`. This is a *suggestion* - the host's display capability, not a requirement. A value of 0 means "no preference."

2. **Cart → Host**: During `wc_init()`, the cart reads the host's preference and decides its actual rendering resolution. It may use the preference directly, scale it, clamp it, or ignore it entirely. The cart writes its chosen resolution to `wc_info_t.width` and `wc_info_t.height`.

After `wc_init()` returns, the host reads the cart's actual width/height. These dimensions define:
- **2D carts**: the framebuffer size in pixels (ARGB8888, `width × height × 4` bytes)
- **GL carts**: the viewport/render target dimensions for GL calls

**Display scaling** is the host's responsibility:
- The host creates its display surface at whatever size it wants (its own preferred resolution, fullscreen, user-resizable window, etc.)
- The host scales the cart's output to fit the display, **preserving the cart's aspect ratio** with letterboxing/pillarboxing as needed
- The cart never knows or cares about the actual display size

**If no preferred resolution is specified** (both 0), the host should create its window at the cart's returned dimensions - a 1:1 pixel match with no scaling.

Example flow:
```
Host sets preferred: 1920×1080
Cart reads preference, decides: 640×360 (16:9, manageable for this engine)
Host creates window: 1920×1080
Host scales 640×360 → 1920×1080 (exact 3x, no letterboxing needed)
```

```
Host sets preferred: 0×0 (no preference)
Cart uses its default: 320×240
Host creates window: 320×240 (1:1 match)
```

```
Host sets preferred: 1920×1080
Cart ignores it, uses fixed: 960×540
Host creates window: 1920×1080
Host scales 960×540 → 1920×1080 (exact 2x)
```

This design means:
- The same `.wasc` cart works on any display size - phone, desktop, 4K TV, RetroArch
- The cart controls its rendering budget - a simple game can render at 320×240, a complex game at 1080p
- The host controls the display - letterboxing, fullscreen, window resize all work without cart cooperation

### Manifest (`.wasc` carts)

The `manifest.json` inside a `.wasc` archive describes the cart:

```json
{
  "name": "My Game",
  "version": "1.0.0",
  "abi": 3,
  "entry": "cart.wasm",
  "players": 2,
  "pointer": true,
  "keyboard": true,
  "net": {
    "websocket": ["api.mygame.com"],
    "data-channel": true
  }
}
```

All fields except `name`, `abi`, and `entry` are optional. `pointer`, `keyboard`, and `net` are ABI v3 features - gamepad input is always available regardless.

### ABI v3: Networking & Extended Input

ABI v3 adds opt-in features beyond the core framebuffer/audio/gamepad loop:

- **Pointer input** (`"pointer": true`) - host writes `wc_pointer_t[10]` state (unified mouse + multitouch) and optionally calls `wc_ptr_on_down`, `wc_ptr_on_move`, `wc_ptr_on_up` exports
- **Keyboard input** (`"keyboard": true`) - host writes `uint8_t[32]` key state bitmask (USB HID scancodes) and optionally calls `wc_kb_on_down`, `wc_kb_on_up` exports
- **WebSocket** (`"net": {"websocket": [...]}`) - cart calls `wc_ws_open`/`send`/`close` imports, host delivers events via `wc_ws_on_open`/`on_message`/`on_close` exports
- **Data channels** (`"net": {"data-channel": true}`) - peer-to-peer via `wc_dc_send`/`broadcast` imports and `wc_dc_on_connect`/`on_message`/`on_disconnect` exports

All v3 exports are optional - the host silently skips events if the cart doesn't export the callbacks. Existing v2 carts work unchanged.

## GPU ABI

There is **one GPU ABI: WebGL2 (OpenGL ES 3.0)**. All hosts present the same ES 3.0 GL surface. This is the ceiling - no host may expose ES 3.1+ or desktop GL features.

A cart that doesn't use the GPU at all can write pixels directly to a shared-memory framebuffer (ARGB8888). This is not a second GPU ABI - it's just pixels in a buffer, no GL involved.

### Rules for GPU carts

1. **ES 3.0 core only.** Do not use ES 3.1+ features (compute shaders, SSBO, image load/store). The browser host is WebGL2 which is ES 3.0. Native hosts cap `GL_VERSION` to ES 3.0.

2. **Declare all GL functions as WASM imports at compile time.** There is no `eglGetProcAddress` or runtime function discovery in WASM. If a function isn't in the cart's import table, it cannot be called.

3. **Extensions are informational, not guaranteed.** Hosts pass through real driver extensions via `GL_EXTENSIONS` (some carts like Godot need them for format detection). But extension *function pointers* are only available if the cart declares them as WASM imports. Calling an undeclared extension function traps.

4. **GPU engines with getProcAddress callbacks** (Skia Ganesh, ANGLE, etc.) must override `glGetString(GL_EXTENSIONS)` in their callback to return empty - preventing the engine from probing for extension function pointers that don't exist as WASM imports. See the porting notes in the [wasmcart-sdl2](https://github.com/wasmcart/wasmcart-sdl2) repo for the full pattern.

5. **Same `.wasc` runs everywhere.** If a cart works in the browser, it must work on Node.js, native, and RetroArch hosts. Staying within ES 3.0 core guarantees this.

## Features

- **2D framebuffer** - ARGB8888 pixel buffer for software-rendered carts (no GL)
- **WebGL2 GPU** - one GL ABI everywhere. Cart imports WebGL2 functions, host provides them (native GLES3 on Node.js, WebGL2 in browser). Emscripten's GL output works directly.
- **Stereo audio** - Float32 or Int16 ring buffer, cart-declared sample rate
- **Gamepad input** - 4 pads with buttons, analog sticks, triggers (always available)
- **Pointer input** - unified mouse + touch via shared memory state + event callbacks (opt-in)
- **Keyboard input** - 256-bit key state bitmask (USB HID scancodes) + event callbacks (opt-in)
- **WebSocket networking** - event-driven WebSocket API with domain allowlist (opt-in)
- **Data channels** - peer-to-peer communication via host-managed connections (opt-in)
- **Save data** - persistent save blob (host manages storage)
- **Asset loading** - `.wasc` carts load files at runtime via `wc_asset_size()` / `wc_load_asset()`
- **WASI threads** - carts compiled with wasi-sdk `-pthread` can spawn background threads via pthreads

## Node.js API

```js
import { CartHost } from 'wasmcart';

const cart = new CartHost();
await cart.load('game.wasc');

// Main loop
const gamepads = [];  // array of { buttons, axes, ... }
const frame = cart.runFrame(gamepads);

// frame.framebuffer - Uint8Array of ARGB pixels (for 2D carts)
// frame.audio - Int16Array of stereo PCM samples
// frame.saveData - Uint8Array (if cart uses save)

cart.destroy();
```

### Options

```js
await cart.load('game.wasc', {
  glBackend: gl,                // required for GL carts (any WebGL2-compatible context)
  preferredWidth: 800,          // hint for resolution negotiation
  preferredHeight: 600,
  saveData: existingSaveBuffer,  // restore previous save
});
```

### GL Carts

GL carts import functions from the `"gl"` WASM module. The host must provide a WebGL2-compatible context:

```js
// Browser
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2');
await cart.load('gl_game.wasm', { glBackend: gl });

// Node.js - provide any WebGL2-compatible context
await cart.load('gl_game.wasm', { glBackend: glContext });
```

## CLI Tools

### wasmcart-pack

Create `.wasc` archives from a `.wasm` file and an assets directory:

```bash
npx wasmcart-pack --wasm cart.wasm --assets assets/ -o game.wasc
npx wasmcart-pack --wasm cart.wasm --assets assets/ -o game.wasc --name "My Game" --version "1.0"

# With ABI v3 features
npx wasmcart-pack --wasm cart.wasm -o game.wasc --pointer --keyboard
npx wasmcart-pack --wasm cart.wasm -o game.wasc --players 4 --ws api.mygame.com --data-channel
```

## Writing Carts

### Minimal 2D cart (C + Emscripten)

```c
#include "wasmcart.h"
#include <string.h>

#define WIDTH 320
#define HEIGHT 240

static uint32_t framebuffer[WIDTH * HEIGHT];
static wc_info_t info;

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = 3;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = (uint32_t)(uintptr_t)framebuffer;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    // Fill screen red
    for (int i = 0; i < WIDTH * HEIGHT; i++)
        framebuffer[i] = 0xFFFF0000;
}
```

```bash
emcc -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 --no-entry -O2 -o cart.wasm cart.c
```

### Shared cart-author libraries

The [`include/`](include/) directory ships reusable C headers:

| Header | Purpose |
|--------|---------|
| `wc_cart.h` | **The C-side contract** - buffer declarations + `WC_FILL_INFO` macro |
| `wc_fb.h` | 2D drawing (fill_rect, blit, alpha blend) |
| `wc_gl.h` / `wc_gl_blit.h` | Shader compile/link, VAO/VBO helpers, CPU→GPU blit |
| `wc_math.h` | sin, cos, sqrt, atan2 (no libm) |
| `wc_mat4.h` / `wc_vec3.h` | 4x4 matrix + 3D vector ops |
| `wc_pcm_mixer.h` | Multi-channel PCM mixer + WAV parser |

For porting *existing* C/SDL games (the SDL2 backend + `stb_*` decoders), see the
**wasmcart-sdl2** repo.

### Threading (wasi-sdk)

Carts can spawn background threads using standard pthreads. Requires wasi-sdk (not Emscripten):

```bash
${WASI_SDK}/bin/clang --target=wasm32-wasip1-threads -pthread \
  -Wl,--import-memory,--shared-memory,--max-memory=67108864 \
  -Wl,--no-entry -nostartfiles -O2 -o cart.wasm cart.c
```

See [`examples/hello_threads/`](examples/hello_threads/) and the Threading section in the Porting Guide (in the [wasmcart-sdl2](https://github.com/wasmcart/wasmcart-sdl2) repo).

## Examples

34 example carts ranging from minimal (`hello`) to full game ports:

| Example | Type | Description |
|---------|------|-------------|
| `hello` | 2D | Minimal ABI demo |
| `hello_gl` | GL | Minimal GL triangle |
| `hello_threads` | 2D + threads | WASI threads demo |
| `snake`, `breakout`, `tetris` | 2D | Classic arcade games |
| `doom` | 2D | DOOM (doomgeneric) |
| `neverball`, `neverputt` | GL | GL1.x via gl4es |
| `chromium_bsu` | GL | GL1.x shoot-em-up |
| `etr` | GL | Extreme Tux Racer (SFML port) |
| `openarena2` | GL | Quake III Arena (ioquake3) |
| `flare`, `flare_es` | 2D | FLARE RPG (hand-port and SDL2 backend) |

## Documentation

- **[SPEC.md](SPEC.md)** - the normative specification
- **[`docs/`](docs/)** - per-subsystem guides: [input](docs/input.md), [networking](docs/networking.md), [GL surface](docs/gl-surface.md), [framebuffer](docs/bind_framebuffer.md), [fetch](docs/fetch.md), [porting](docs/porting.md)
- **[`include/`](include/)** - C headers for cart authors (`wc_cart.h` is the contract; `wc_fb.h`/`wc_gl.h`/math/mixer are a lightweight SDK)

Porting existing C/SDL games (the SDL2 backend, `stb_*` helpers, and the full
porting guide) lives in the **wasmcart-sdl2** repo - see below.

## The wasmcart org

wasmcart is a small ecosystem. This repo is the spec + JS reference hosts; the rest
are separate repos, all running the *same* carts:

| Repo | What it is |
|------|------------|
| **wasmcart** (this repo) | Spec, JS reference hosts (`CartHost`, `CartHostWeb`), `wasmcart-pack` |
| **wasmcart-sdl2** | SDL2 backend + `stb_*` helpers + porting guide - for porting existing C/SDL games |
| **wasmcart-native-host** | `libwasmcart` C host + `wasmcart-run` standalone SDL2 player (wasmtime / libnode) |
| **wasmcart-libretro** | libretro core - run carts in RetroArch / RetroDECK |
| **retroemu** | terminal + SDL host (libretro cores *and* wasmcart carts) |
| **wasmcart-website** | wasmcart.org - docs site |
| game port forks | each an upstream game fork on a `wasmcart` branch (`.wasc` shipped as Release artifacts) |

## License

MIT - see [LICENSE](LICENSE). Compatible with all dependencies (fflate, yauzl,
yazl - all MIT).
