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
8. **Test on all hosts** - Browser, Node.js, wasmcart-native, RetroArch

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

Validated on: Neverball ES, Neverputt ES, Celeste Classic ES, Flare ES.
