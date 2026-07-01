# wasmcart GL Surface Specification

## Overview

The wasmcart GL surface is **WebGL2 / OpenGL ES 3.0**. This is the same on all hosts:
browser, Node.js, wasmcart-native, and RetroArch (libretro).

The host reports `GL_VERSION = "OpenGL ES 3.0 wasmcart"` regardless of the actual
driver. Real driver extensions pass through for engines that need them (e.g., Godot
texture format detection).

## Shader Requirements

All shaders MUST use one of:
- `#version 100` (GLES 2.0 - works everywhere)
- `#version 300 es` (GLES 3.0 / WebGL2 - recommended)

Desktop GL version strings (`#version 110`, `#version 120`, `#version 330 core`)
are NOT supported. The host does NOT translate shaders.

## Texture Formats

The host translates legacy/unsized formats to ES 3.0 equivalents:

| Legacy Format | ES 3.0 Internal Format | ES 3.0 Format |
|--------------|----------------------|--------------|
| `GL_LUMINANCE` | `GL_R8` | `GL_RED` |
| `GL_LUMINANCE_ALPHA` | `GL_RG8` | `GL_RG` |
| `GL_ALPHA` | `GL_R8` | `GL_RED` |
| `GL_RGB` (ubyte) | `GL_RGB8` | `GL_RGB` |
| `GL_RGBA` (ubyte) | `GL_RGBA8` | `GL_RGBA` |

Carts SHOULD use sized internal formats (`GL_RGBA8`, `GL_R8`, etc.) directly.
The host fixup exists for compatibility with legacy GL code.

## Porting GL 1.x Games

Games written for OpenGL 1.x (fixed-function pipeline) need a renderer rewrite
to target ES 3.0. There are two approaches:

### 1. Purpose-built gl_compat (recommended)

Write a small translation layer (~500-1000 lines) that replaces GL 1.x calls
with ES 3.0 shader-based equivalents. This is compiled into the cart.

Example: `chromium_bsu/gl_compat.cpp` - batch renderer with `#version 300 es`
shaders. Handles glBegin/glEnd, matrix stack, texture state, blending.

Advantages:
- No external dependencies
- Small binary size
- Only translates what the game actually uses
- Full ES 3.0 compliance

### 2. gl4es (legacy compatibility)

Use [ptitSeb/gl4es](https://github.com/ptitSeb/gl4es) to translate GL 1.x → GLES 2.0.
gl4es is compiled to WASM as a static library and linked into the cart.

Current gl4es carts: Neverball, Neverputt, Extreme Tux Racer.

Limitations:
- gl4es only targets GLES 2.0, not ES 3.0
- Requires host-side format fixup and extension injection
- Large dependency (~150K lines)
- Shader version issues on Core 3.3 contexts (RetroArch desktop)

gl4es patches required for wasmcart:
- `hardext.c`: disable `#version 120` detection, force `esversion = 3`
- Build with `NO_LOADER=ON`, `NOEGL=ON`, `STATICLIB=ON`

### Games that DON'T need translation

Games with native GLES 2.0/3.0 renderers work on all hosts with zero translation:
- Godot 4.x (GLES3 Compatibility renderer)
- ioquake3 renderergl2 (GLES2/3 path)
- GZDoom (GLES2 renderer)
- Any Emscripten/WebGL2 game
- SDL2 games using GLES backend

## FBO Redirect

The host intercepts `glBindFramebuffer(GL_FRAMEBUFFER, 0)` and redirects to an
internal FBO with depth24+stencil8 attachments. This FBO is then blitted to the
display surface (EGL window, RetroArch hw_render FBO, or canvas backbuffer).

Carts should bind FBO 0 when they want to render to the "screen". The host
handles the actual presentation.

## VAO Handling

On GLES 3.0, VAO 0 is the default VAO. On Core 3.3 (RetroArch desktop),
VAO 0 is invalid. The host creates an isolated cart VAO and redirects
`glBindVertexArray(0)` to it. The host also binds this VAO at frame start
for carts that don't use VAOs at all (gl4es).

## Extension Passthrough

`GL_EXTENSIONS` returns real driver extensions. On Core 3.3 contexts,
the host also injects GLES-equivalent extension names (`GL_OES_*`, `GL_EXT_*`)
so GLES-targeting code (like gl4es) can detect features.

`GL_SHADING_LANGUAGE_VERSION` passes through real values so carts can
detect Core vs GLES contexts if needed.

## Buffer Orphaning

The host applies buffer orphaning on `glBufferSubData` with offset 0:
`glBufferData(target, size, NULL, GL_STREAM_DRAW)` is called first to
avoid GPU sync stalls on mobile drivers (Mali, Adreno). This is transparent
to the cart.
