# Porting Games to wasmcart

## Target: ES 3.0 / WebGL2

wasmcart's GL surface is ES 3.0. All carts should use GLES 2.0 or 3.0
shaders. See [gl-surface.md](gl-surface.md) for the full spec.

## Easiest Ports (zero GL translation needed)

| Source | Examples | Notes |
|--------|----------|-------|
| GLES 2.0/3.0 native | Godot, GZDoom | Engine handles GL, just wire up ABI |
| SDL2 + GLES | Many modern games | Use wasmcart SDL2 backend (sdl2_wc/) |
| Emscripten/WebGL2 | Browser games | Already WASM, add wasmcart ABI |
| ioquake3-based | OpenArena, Quake 3 | renderergl2 has GLES path |
| Canvas 2D / pixel buffer | Retro games | Use wc_gl_blit.h for GPU upload |

## GL 1.x Games

Games using OpenGL 1.x (glBegin/glEnd, fixed-function lighting, display lists)
need a renderer rewrite. Two approaches:

### Approach 1: Custom gl_compat (recommended)

Write a purpose-built ES 3.0 batch renderer for the specific game.
Only translate the GL 1.x calls the game actually uses.

**Example:** Chromium B.S.U. - `gl_compat.cpp` (~500 lines)
- Replaces immediate mode with VBO batching
- `#version 300 es` shaders
- Matrix stack, texture state, blending
- Zero external dependencies
- Compiled with `-include chromium_compat.h` (zero original files modified)

**Upstream value:** These renderers can be submitted as PRs to the original
game projects, benefiting the entire community.

### Approach 2: gl4es (quick start, more complexity)

Use [gl4es](https://github.com/ptitSeb/gl4es) for automatic translation.
See [gl-surface.md](gl-surface.md#gl4es-legacy-compatibility) for details.

## Porting Checklist

1. **Build to WASM** - Emscripten with `-sWASM=1`
2. **Export ABI** - `wc_get_info`, `wc_init`, `wc_render`
3. **Set gpu_api** - `wc_info_t.gpu_api = 1` (GL) for all carts
4. **Use ES 3.0 shaders** - `#version 100` or `#version 300 es`
5. **Assets via .wasc** - Pack with `wasmcart-pack`, load via `wc_asset_size`/`wc_load_asset`
6. **Audio** - Write to ring buffer, set sample rate + format flags
7. **Input** - Read `wc_pad_t` array (Xbox/W3C button layout)
8. **Invert the main loop** - if the engine owns its loop, see below
9. **Test on all hosts** - Browser, Node.js, wasmcart-native, RetroArch

## Inverting the Main Loop

Most ported engines own their main loop: `while (running) { input(); update(); draw(); }`,
which never returns. wasmcart is the other way round -- the host calls
`wc_render()` once per frame and expects it back. Restructuring a large engine
into a per-frame step function is usually the hardest part of a port, and
`wc_frame_yield` exists so you do not have to.

Build with binaryen's asyncify pass pointed at the import:

```bash
emcc ... -s ASYNCIFY=1 -s ASYNCIFY_IMPORTS=wc_frame_yield \
     -s EXPORTED_FUNCTIONS='[..., "_wc_yield_buffer"]'
```

Then call `wc_frame_yield()` once per iteration of your existing loop and leave
the loop otherwise untouched. The host unwinds the whole engine stack out of
`wc_render()` and rewinds back to exactly that point next frame: the engine
never notices, and the host gets a frame every call.

You must also export `wc_yield_buffer()`, returning a pre-initialized asyncify
stack descriptor -- a `{current, end}` `uint32` pair pointing at a stack area
large enough for your deepest call chain at the yield point:

```c
static uint8_t  yield_stack[64 * 1024];   /* size for YOUR call depth */
static uint32_t yield_desc[2];

__attribute__((export_name("wc_yield_buffer")))
uint32_t wc_yield_buffer(void) {
    yield_desc[0] = (uint32_t)yield_stack;
    yield_desc[1] = (uint32_t)yield_stack + sizeof(yield_stack);
    return (uint32_t)yield_desc;
}
```

So `wc_render()` becomes, in effect, "run the engine until it yields".

Two things to watch:

- **Size the stack for your engine.** 4KB suits a toy loop; a real engine
  yielding from inside several layers of update/draw needs far more. Too small
  corrupts the unwind rather than failing cleanly.
- **Asyncify instruments every function that can reach the yield,** which costs
  size and speed. Keep `ASYNCIFY_IMPORTS` to `wc_frame_yield` alone, and prefer
  yielding from as shallow a point in the loop as you can.

## Shared Porting Libraries

Located at `wasmcart/porting/include/`:

| Header | Purpose |
|--------|---------|
| `wc_cart.h` | Buffer declarations, WC_FILL_INFO macro |
| `wc_gl.h` | Shader compile/link, VAO/VBO helpers |
| `wc_gl_blit.h` | Upload CPU pixels as GL texture (2D→GL) |
| `wc_fb.h` | 2D framebuffer drawing (fill_rect, blit) |
| `wc_math.h` | sin, cos, sqrt, atan2, clamp, lerp |
| `wc_mat4.h` | 4x4 column-major matrix ops |
| `wc_vec3.h` | 3D vector operations |
| `wc_pcm_mixer.h` | Multi-channel PCM audio mixer |
| `wc_sdl_stubs.h` | SDL2 type defs + no-op stubs |
| `stb_image.h` | Image loading (JPEG, PNG, BMP) |
| `audio_bridge.h/c` | SDL2_mixer → ring buffer bridge |
| `emstubs.c` | Emscripten runtime stubs |

## SDL2 Games (Emscripten Backend)

Use the reusable `sdl2_wc/` backends for SDL2 games:

```bash
# Compile: use SDL2 headers from Emscripten
-sUSE_SDL=2  # at compile time (headers only)

# Link: use wasmcart's SDL2 backend, not Emscripten's
-sUSE_SDL=0  # at link time
```

The SDL2 backend provides video (GL surface), audio (ring buffer),
and input (gamepad) - all wired to the wasmcart ABI.

Validated on: Neverball ES, Neverputt ES, Flare ES, and a 2D platformer port.
