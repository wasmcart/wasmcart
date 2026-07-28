# wasmcart

**A virtual cartridge format for safe, portable games.** A wasmcart cart is a
standalone WebAssembly module - a self-contained game that owns its own memory and
talks to the outside world only through a tiny, well-defined contract: the host
writes input + timing, calls `wc_render()` each frame, and reads back pixels and
audio. No filesystem, no syscalls, no ambient authority. Just pixels, sound, input,
and opt-in networking.

Because a cart is only WebAssembly + a fixed ABI, **the same cart runs anywhere a
conforming host exists** - Node.js, the browser, a libretro core in [RetroArch](https://www.retroarch.com), a
native player, a terminal - on any OS and any hardware with enough power. Write the
game once; it runs on all of them, sandboxed.

This repository is the **specification** and its **reference implementations**.

- 📄 **[SPEC.md](SPEC.md)** - the normative host↔cart contract (current ABI: v3)
- 🧩 **[`src/abi.js`](src/abi.js)** - the machine-readable contract (constants, layouts)
- 🖥️ **[`include/wasmcart.h`](include/wasmcart.h)** - the C ABI header (structs, flags, GL + host imports)
- 🧰 **[`include/wc_cart.h`](include/wc_cart.h)** - cart boilerplate macros on top of it
- 📚 **[`docs/`](docs/)** - per-subsystem guides (input, networking, GL, framebuffer, fetch, porting)
- 🧭 **[docs/positioning.md](docs/positioning.md)** - ship the artifact you debugged: `.wasc` primary, native backends optional, observability by construction

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
([`wasmcart-libretro`](https://github.com/wasmcart/wasmcart-libretro)), a native
player ([`wasmcart-native`](https://github.com/wasmcart/wasmcart-native)), and the
terminal emulator ([`retroemu`](https://github.com/monteslu/retroemu)). See
**[The wasmcart org](#the-wasmcart-org)** below.

## Installation

```bash
npm install wasmcart
```

## Play a cart

```bash
npx wasmcart game.wasc              # SDL window + audio + gamepad (the default)
npx wasmcart game.wasc              # GL carts too - auto-detected, OpenGL window via webgl-node
npx wasmcart my-cart-dir/           # dev mode: manifest.json + cart.wasm + assets, straight off disk
npx wasmcart game.wasc --term       # ANSI terminal player (GL carts too, via offscreen readback)
npx wasmcart game.wasc --frames 300 --shot out.png --wav out.wav   # headless: step, dump, exit
npx wasmcart game.wasc --seed 7 --frames 60 --shot a.png           # deterministic replay run
npx wasmcart game.wasc --no-resize  # pin the window to the cart's declared size
npx wasmcart game.wasc --stretch    # fill the window, distorting the aspect ratio
npx wasmcart pack --wasm cart.wasm -o game.wasc                    # packing, same front door
```

### Window sizing

The window opens at the size the **cart** declares — that is the cart's call,
not the player's — and is **resizable** from there. As you resize, the frame is
scaled up to the largest rect that still fits and **letterboxed**: black bars
fill whatever is left over, so a cart's aspect ratio survives any window shape.
A cart that declares 480x600 stays portrait in a wide window instead of being
stretched into one.

| flag | effect |
| --- | --- |
| *(default)* | window opens at the cart's size, resizable, letterboxed |
| `--zoom n` | open at n× the cart's size (still resizable) |
| `--no-resize` | pin the window to the cart's size; no bars, no scaling |
| `--stretch` | scale to fill the window, distorting the aspect ratio |

Letterboxing applies to both rendering paths: 2D carts are scaled on blit, and
GL carts get a viewport fitted inside the drawable with the surrounding area
cleared to black.

The windowed player runs on the org's own stack —
[`@kmamal/sdl`](https://github.com/kmamal/node-sdl) (window, keyboard, audio
queue, game controllers) and [`webgl-node`](https://github.com/monteslu/webgl-node)
(WebGL2-over-native GLES for GL carts, auto-detected from the wasm imports) — with
audio-paced frame stepping so sound never
stutters. Keys: arrows/WASD d-pad, `x`/`z` = A/B, Enter = Start, Tab = Select,
Esc/`q` quits; the first plugged-in controller maps automatically. No display?
It falls back to the terminal player, and headless mode is scriptable: same
seed → byte-identical PNG, so a shell loop is a regression test. Hosts that
embed `CartHost` (harnesses like [romdevtools](https://www.npmjs.com/package/romdevtools))
keep supplying their OWN backends via `load(..., { glBackend })` — these
dependencies power the CLI, they are not required by the embedding API.

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

See [SPEC.md](SPEC.md) for the normative struct layouts, [`src/abi.js`](src/abi.js)
for the machine-readable constants, and [`include/wc_cart.h`](include/wc_cart.h) for
the C-side boilerplate that fills the struct for you.

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

4. **GPU engines with getProcAddress callbacks** (Skia Ganesh, ANGLE, etc.) must override `glGetString(GL_EXTENSIONS)` in their callback to return empty - preventing the engine from probing for extension function pointers that don't exist as WASM imports. The engine then falls back to its core-GL path, which is all the cart can import anyway. See [`docs/gl-surface.md`](docs/gl-surface.md) for what the GL surface guarantees, and the porting guide in [wasmcart-sdl2](https://github.com/wasmcart/wasmcart-sdl2) for the full pattern.

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
  glBackend: gl,                // OPTIONAL override: render into THIS context
                                // (a WebGL2 context, or a factory returning one)
                                // instead of the one the host makes itself
  preferredWidth: 800,          // hint for resolution negotiation
  preferredHeight: 600,
  saveData: existingSaveBuffer,  // restore previous save
});
```

### GL Carts

GL carts import functions from the `"gl"` WASM module. The host provides a
WebGL2-compatible context — either directly, or (since 0.6.0) as a **factory**
that CartHost invokes exactly once, and only if the cart's wasm actually
imports GL. The factory form means a launcher never needs to know what kind
of cart it's loading (this is how `npx wasmcart` auto-detects GL carts; the
detection ground truth is the wasm import section, never a manifest field):

```js
// Factory (recommended): runs only for GL carts, may be async
await cart.load('game.wasc', {
  glBackend: () => {
    const canvas = document.createElement('canvas');   // browser
    return canvas.getContext('webgl2');
  },
});

// Node.js factory — offscreen context (headless harnesses) or a
// window-bound one (see bin/play-window.js for the SDL wiring)
await cart.load('game.wasc', {
  glBackend: async () => (await import('webgl-node')).createWebGL2Context(1280, 720).gl,
});

// Plain context still works (created up front, GL cart or not)
await cart.load('gl_game.wasm', { glBackend: glContext });
```

A GL cart never runs on stubs. If a context cannot be obtained, the load is a
**load error** — never a silent success that renders black:

```js
// Either host: no glBackend needed, the host makes its own context.
await cart.load('gl_game.wasc', {});

// Where GL genuinely cannot be obtained (no driver, headless box with no
// EGL, ancient browser, blocklisted driver):
// Error: ... a WebGL2 context could not be created.
```

Stubbing looks harmless because a hybrid cart can still fill its 2D
framebuffer, but for a cart that *renders* through GL every call becomes a
no-op, `load()` reports success, and the player sees a black screen with no
error anywhere.

There is **no opt-out**. GL is part of the host contract, not a capability a
host advertises: a cart author writes against the guarantee that if their cart
imports `gl`, any conformant host can run it. Most carts never import `gl` and
never create a context — the factory form below exists precisely so a 2D-only
session pays nothing.

**You do not have to pass anything on either host.** `CartHostWeb` creates its
own WebGL2 context (offscreen where available); `CartHost` creates one through
`webgl-node`, a regular dependency. `glBackend` is an **override** meaning
"render into THIS context instead of one you make" — the common case being an
on-screen canvas or an SDL window — not the host's only source of GL.

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

Or pack a **dev directory** that already has its own `manifest.json` — the
same layout `npx wasmcart <dir>` runs — keeping that manifest verbatim:

```bash
npx wasmcart-pack --source my-game/ -o game.wasc
```

The flag form above *generates* a manifest, so it cannot express a cart whose
manifest already says something specific (a custom `assets` root, a field
with no flag). `--source` resolves the wasm through the manifest's own
`entry`, packs every other file at its original path, and rewrites only
`entry` to the archive's `cart.wasm`.

## Writing Carts

### Minimal 2D cart (C + [Emscripten](https://emscripten.org))

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
| `wasmcart.h` | **The ABI header** - `wc_info_t`/`wc_pad_t` structs, flags, GL + host imports. Include this first. |
| `wc_cart.h` | Cart boilerplate - buffer declarations + `WC_FILL_INFO`, plus the opt-in `WC_DEBUG_FIELDS` |
| `wc_fb.h` | 2D drawing (fill_rect, blit, alpha blend) |
| `wc_gl.h` / `wc_gl_blit.h` | Shader compile/link, VAO/VBO helpers, CPU→GPU blit |
| `wc_math.h` | sin, cos, sqrt, atan2 (no libm) |
| `wc_mat4.h` / `wc_vec3.h` | 4x4 matrix + 3D vector ops |
| `wc_pcm_mixer.h` | Multi-channel PCM mixer + WAV parser |

For porting *existing* C/SDL games, [`docs/porting.md`](docs/porting.md) is the
short version; the [**wasmcart-sdl2**](https://github.com/wasmcart/wasmcart-sdl2)
repo has the SDL2 backend itself plus the full porting guide.

### Threading ([wasi-sdk](https://github.com/WebAssembly/wasi-sdk))

Carts can spawn background threads using standard pthreads. Requires wasi-sdk (not Emscripten):

```bash
${WASI_SDK}/bin/clang --target=wasm32-wasip1-threads -pthread \
  -Wl,--import-memory,--shared-memory,--max-memory=67108864 \
  -Wl,--no-entry -nostartfiles -O2 -o cart.wasm cart.c
```

The host detects a threaded cart from its wasm imports (shared memory) and wires
up the worker pool itself - no manifest field, and no change to the three-export
contract.

## Examples

Example carts range from minimal (`hello`) to full game ports. They live outside
this repo - the game ports are upstream forks on a `wasmcart` branch, each
shipping its `.wasc` as a Release artifact:

| Example | Type | Description |
|---------|------|-------------|
| `hello` | 2D | Minimal ABI demo |
| `hello_gl` | GL | Minimal GL triangle |
| `hello_threads` | 2D + threads | WASI threads demo |
| `snake`, `breakout`, `tetris` | 2D | Classic arcade games |
| `doom` | 2D | DOOM (doomgeneric) |
| `neverball`, `neverputt` | GL | GL1.x via [gl4es](https://github.com/ptitSeb/gl4es) |
| `chromium_bsu` | GL | GL1.x shoot-em-up |
| `etr` | GL | Extreme Tux Racer (SFML port) |
| `openarena2` | GL | Quake III Arena (ioquake3) |
| `flare`, `flare_es` | 2D | FLARE RPG (hand-port and SDL2 backend) |

## Documentation

- **[SPEC.md](SPEC.md)** - the normative specification
- **[`docs/`](docs/)** - per-subsystem guides: [input](docs/input.md), [networking](docs/networking.md), [GL surface](docs/gl-surface.md), [framebuffer](docs/bind_framebuffer.md), [fetch](docs/fetch.md), [porting](docs/porting.md)
- **[`include/`](include/)** - C headers for cart authors (`wc_cart.h` is the contract; `wc_fb.h`/`wc_gl.h`/math/mixer are a lightweight SDK)

## The wasmcart org

wasmcart is a small ecosystem. This repo is the spec + JS reference hosts; the rest
are separate repos, all running the *same* carts. Full list:
**[github.com/orgs/wasmcart/repositories](https://github.com/orgs/wasmcart/repositories)**

| Repo | What it is |
|------|------------|
| [**wasmcart**](https://github.com/wasmcart/wasmcart) (this repo) | Spec, JS reference hosts (`CartHost`, `CartHostWeb`), the `wasmcart` CLI + packer |
| [**wasmcart-sdl2**](https://github.com/wasmcart/wasmcart-sdl2) | SDL2 backend + `stb_*` helpers + the full porting guide - for porting existing C/SDL games |
| [**wasmcart-mruby**](https://github.com/wasmcart/wasmcart-mruby) | write games in Ruby (mruby runtime, DragonRuby-style API) - prebuilt engine, games ship only Ruby |
| [**wasmcart-lua**](https://github.com/wasmcart/wasmcart-lua) | write games in Lua (Lua 5.4, LÖVE-style API, batched GL2D renderer) - prebuilt engine, games ship only Lua |
| [**wasmcart-pygame**](https://github.com/wasmcart/wasmcart-pygame) | write games in Python (CPython 3.13 + pygame-ce) - one reusable runtime, games ship only Python and assets |
| [**wasmcart-jsgame**](https://github.com/wasmcart/wasmcart-jsgame) | write games in JavaScript - sandboxed QuickJS runtime with Canvas 2D, WebGL2 and Web Audio |
| [**wasmcart-libretro**](https://github.com/wasmcart/wasmcart-libretro) | libretro core - run carts in RetroArch / RetroDECK |
| [**wasmcart-native**](https://github.com/wasmcart/wasmcart-native) | native host built on libnode - a standalone player with no Node install |
| [**build-libnode**](https://github.com/wasmcart/build-libnode) | precompiled libnode for V8-WASM use, the substrate the native host builds on |
| [**retroemu**](https://github.com/monteslu/retroemu) | terminal + SDL host (libretro cores *and* wasmcart carts) |
| game port forks | each an upstream game fork on a `wasmcart` branch (`.wasc` shipped as Release artifacts) |

## License

MIT - see [LICENSE](LICENSE). Compatible with all dependencies
([fflate](https://github.com/101arrowz/fflate),
[yauzl](https://github.com/thejoshwolfe/yauzl),
[yazl](https://github.com/thejoshwolfe/yazl) - all MIT).
