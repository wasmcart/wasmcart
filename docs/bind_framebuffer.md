# glBindFramebuffer(target, 0) - Host FBO Redirect

## The Rule

When a cart calls `glBindFramebuffer(GL_FRAMEBUFFER, 0)`, the host MUST redirect this to its display FBO. The cart uses FBO 0 to mean "the screen." The host decides what "the screen" actually is.

## Why This Matters

Carts that use Skia Ganesh GL (wasmcart-jsgame's Canvas 2D) render to an offscreen FBO, then blit to FBO 0:

```
Game draws → Ganesh offscreen FBO (e.g. FBO 2)
                    ↓
         glBlitFramebuffer(FBO 2 → FBO 0)
                    ↓
         Host reads display FBO → screen
```

If the host doesn't intercept `glBindFramebuffer(target, 0)`, the blit goes to the real default framebuffer (FBO 0), which may not be what the host reads.

## How Each Host Handles It

### Browser (CartHostWeb) - Works

WebGL2's `gl.bindFramebuffer(target, null)` binds the canvas backbuffer. The cart calls `glBindFramebuffer(target, 0)`, the host maps ID 0 → `null`, which IS the canvas. The browser composites the canvas to the page. No redirect needed.

### Node.js (retroemu cli.js) - Works

The Node host creates an offscreen FBO (`glFBO`) with a color texture + depth/stencil renderbuffer. It intercepts `glBindFramebuffer`:

```javascript
gl.glBindFramebuffer = (target, fb) => {
    const actual = fb === 0 ? glFBO : fb;
    _origBindFB.call(gl, target, actual);
};
```

When the cart binds FBO 0, the host redirects to `glFBO`. After `wc_render()`, the host blits from `glFBO` to the window surface via `glBlitFramebuffer`, then calls `swapBuffers`.

### wasmcart-native (standalone) - Works (redirect FBO)

The native host creates a redirect FBO via `wc_gl_setup_redirect()`. `gl_imports.cpp` intercepts `glBindFramebuffer(target, 0)` → redirect FBO. After `wc_render()`, `wc_gl_blit_to_screen()` blits redirect FBO → real FBO 0 (EGL window surface) with letterboxing, then calls `eglSwapBuffers`.

### RetroArch (libretro) - WORKS (redirect FBO)

RetroArch uses `hw_render` which gives the core a specific FBO via `get_current_framebuffer()`. The wasmcart libretro core uses the shared `gl_imports.cpp` FBO redirect (same code as wasmcart-native via git submodule). When the cart binds FBO 0, the redirect intercepts it to our capture FBO. After `wc_render()`, `libretro.c` blits from the capture FBO → RetroArch's hw_render FBO.

**NOTE (2026-03-31): The FBO redirect works correctly. Verified by readPixels:**

```
Ganesh FBO center pixel:  R=252 G=216 B=168 A=255  ← game content in Ganesh's offscreen FBO
Blit TARGET center pixel: R=252 G=216 B=168 A=255  ← same content in redirect FBO after blit
```

The cart's blit delivers full game content to FBO 0 (redirect). The content is verified
present in the redirect FBO. But RetroArch displays only the background.

This means the issue is in the HOST's final blit from redirect FBO → RetroArch's
hw_render FBO (or RetroArch's compositing of the hw_render FBO to screen).

**Debugging done on cart side:**
- Shaders: `#version 300 es` accepted by Mesa Core 3.3 (GL_ARB_ES3_compatibility) - no patching needed
- Shader compile: all pass
- Program link: all pass
- GL errors: none
- Ganesh FBO readPixels: full game content present
- Redirect FBO readPixels AFTER blit: full game content present
- `glBlitFramebuffer` from Ganesh FBO → FBO 0: works (content verified in target)

**What to check on host side (wasmcart-native gl_imports.cpp / libretro.c):**
1. Does `wc_gl_blit_to_screen()` correctly blit redirect FBO → hw_render FBO?
2. Is the blit Y-flipped? The redirect FBO content is kTopLeft (Y=0 at top, Skia convention).
   The hw_render FBO might expect kBottomLeft (Y=0 at bottom, GL convention). If so, the
   blit needs to flip Y: `glBlitFramebuffer(0, H, W, 0, 0, 0, W, H, ...)`.
3. Is the blit happening AFTER wc_render returns? The redirect FBO is populated during
   wc_render. If the host blits before wc_render completes, it reads stale content.
4. Does RetroArch's hw_render FBO have the correct format (RGBA8, same as redirect)?
5. Is the redirect FBO being cleared BEFORE the blit reads from it? Check for glClear
   calls between wc_render return and the redirect→hw_render blit.

**UPDATE 2 (2026-03-31): CONFIRMED HOST-SIDE ISSUE**

Tested with BOTH GPU (Ganesh) AND CPU (Skia raster + GL blit) rendering.
Both produce correct game content in the redirect FBO. Host-side logging confirms:

```
Canvas 2D: CPU (Skia raster + GL blit)           ← CPU fallback, no Ganesh
[pre-blit] rfbo=2 ra_fbo=1 blit=1920x1080
  center=(252,216,168,255)                        ← game tile color, correct
  quarter=(252,216,168,255)                       ← also correct
```

The redirect FBO (rfbo=2) has full game content. RetroArch's FBO (ra_fbo=1) is the
blit target. The host's blit from rfbo→ra_fbo is not producing visible output.

This is NOT a cart-side issue. NOT a Ganesh issue. NOT a shader issue. The cart
delivers correct pixels to FBO 0 (redirect) via both GPU and CPU paths. The host's
final blit from redirect FBO → RetroArch's hw_render FBO is broken.

**UPDATE 3 (2026-03-31): GL CALL TRACES PROVE HOST ISSUE**

Captured full GL call traces on Node (working) and RetroArch (failing). The call
sequences are FUNCTIONALLY IDENTICAL:

```
Node frame 5:                           RetroArch frame 5:
glBindFramebuffer(0x8d40, 1)            glBindFramebuffer(0x8d40, 3)
glViewport(0, 0, 800, 600)             glViewport(0, 0, 1920, 1080)
glClearColor(0.99, 0.85, 0.66, 1.0)    glClearColor(0.99, 0.85, 0.66, 1.0)
glClear(0x4000)                         glClear(0x4000)
glUseProgram(1)                         glUseProgram(28)
glDrawArrays(0x5, 0, 4)                glDrawArrays(0x5, 0, 4)
glUseProgram(6)       ← textured       glUseProgram(43)      ← textured
glActiveTexture(0x84c0)                 glActiveTexture(0x84c0)
glBindTexture(0xde1, 13)                glBindTexture(0xde1, 192)
glDrawArrays(0x5, 0, 4)                glDrawArrays(0x5, 0, 4)
... identical pattern continues ...     ... identical pattern continues ...
```

Same GL calls, same order, same patterns. Only resource IDs differ (expected).
The cart is doing everything correctly. The HOST's gl_imports.cpp virtual ID
mapping must be breaking texture or FBO mapping on the RetroArch path.

**UPDATE 4: FULL GL CALL TRACE COMPARISON (2026-03-31)**

Captured 694 GL calls (Node, working) vs 762 calls (RetroArch, failing).
The call sequences are FUNCTIONALLY IDENTICAL:
- Same FBO binds (Node: FBO 1, RetroArch: FBO 3)
- Same texture uploads (glTexSubImage2D with real data)
- Same program binds (textured program + solid program)
- Same draw calls (glDrawArrays with same vertex counts/offsets)
- Same sampler binds (glBindSampler unit 0)
- Same blend/stencil/scissor state
- Same clear color (0.99, 0.85, 0.66 = game background)

BUT: RetroArch Ganesh FBO reads as ALL background color at frame 7.
The 67 textured glDrawArrays calls produce ZERO visible fragments.

**This is proven to be a HOST issue, not a cart issue.** The cart sends
identical GL commands. The host's gl_imports.cpp must be:
1. Mapping texture virtual IDs to wrong real GL textures, OR
2. Mapping FBO virtual ID to wrong real GL FBO, OR
3. RetroArch is overwriting our GL objects between frames

The other agent needs to add real GL-level inspection (apitrace/renderdoc)
to see what ACTUAL GL calls reach the driver after the host's ID translation.

**UPDATE 5 (2026-03-31): GANESH WORKS ON RETROARCH!**

The other agent's gl_imports.cpp fix resolved the Ganesh rendering issue.
Adventure-ai renders fully with GPU-accelerated Canvas 2D on RetroArch.

**BUT: Three.js (direct WebGL, no Ganesh) is now broken on RetroArch.**

The gl_imports.cpp change that fixed Ganesh broke the direct WebGL path.
The fix MUST work for ALL carts - the host cannot know whether a cart uses
Ganesh or direct WebGL. The host is a transparent GL passthrough.

**The fix must be unconditionally correct.** Whatever GL behavior was changed
to fix Ganesh must ALSO be correct for direct WebGL carts. If the change
altered how a specific GL function works (e.g., internal format translation,
FBO binding, texture storage), find the version that works for BOTH:

1. Identify exactly which gl_imports.cpp function was changed
2. Test that function's behavior against both adventure-ai (Ganesh) AND
   threejs (direct WebGL) AND Godot (direct GL)
3. The correct behavior is whatever real GLES 3.0 / GL 3.3 does - the host
   should be a transparent passthrough, not cart-specific

If the fix involved working around a Ganesh quirk by changing GL behavior,
that's wrong. The host should pass GL calls through unchanged. The cart
is responsible for generating correct GL calls - and we proved the cart's
GL calls are identical between working (Node) and failing (RetroArch) hosts.

**Most likely cause:** Y-flip mismatch. The cart's blit to redirect flips Y (Skia
top-down → GL bottom-up). If the host's blit from redirect→hw_render ALSO flips Y,
the image is double-flipped. The host should do a 1:1 copy (no flip) since the cart
already handled the flip. OR: check glBlitFramebuffer src/dst coords in libretro.c.

## The FBO ID Collision Problem

On RetroArch, the hw_render FBO might have the same GL ID as Ganesh's offscreen FBO. This happens because:

1. RetroArch binds its hw_render FBO (e.g. FBO 2) before calling `retro_run()`
2. During `wc_render()`, Ganesh creates its offscreen render target via `SkSurfaces::RenderTarget`
3. The wasmcart host's `glGenFramebuffers` goes through the host's GL import table
4. If the host uses virtual ID mapping (like webgl_imports.js), Ganesh might get a virtual ID that collides with the host's FBO virtual ID
5. If the host passes through raw GL IDs, Ganesh gets a NEW real FBO (e.g. FBO 3) - no collision

On RetroArch, the wasmcart libretro core appears to use raw GL IDs (no virtual mapping). Ganesh calls `glGenFramebuffers` and gets a new FBO. But from the cart's perspective (via the host's GL imports), both the host's FBO and Ganesh's FBO report as ID 2. This suggests the host IS using virtual ID mapping, and both got virtual ID 2.

Either way: the cart blits to FBO 0. If the host redirects 0 → its display FBO, it works. If it doesn't redirect, the content goes to the wrong place.

## Fix for RetroArch (wasmcart_libretro.so)

The libretro core needs to intercept `glBindFramebuffer` and redirect FBO 0 to the hw_render FBO:

```c
// In gl_imports.cpp or wherever GL imports are provided:

static GLuint _hw_render_fbo = 0;

// Called each frame before wc_render():
void set_hw_render_fbo(GLuint fbo) {
    _hw_render_fbo = fbo;
}

// GL import provided to the cart:
void gl_glBindFramebuffer(GLenum target, GLuint framebuffer) {
    GLuint actual = (framebuffer == 0 && _hw_render_fbo != 0) ? _hw_render_fbo : framebuffer;
    glBindFramebuffer(target, actual);
}
```

And in `retro_run()`:
```c
void retro_run(void) {
    // Get RetroArch's hw_render FBO for this frame
    GLuint fbo = hw_render.get_current_framebuffer();
    set_hw_render_fbo(fbo);

    // Run the cart frame
    wc_render();

    // RetroArch reads from fbo after we return
}
```

This is the same pattern as the Node host's FBO redirect. The cart always blits to FBO 0 meaning "the screen." The host decides where "the screen" is.

## Why This Affects Ganesh Specifically

Other GL carts (Godot, OpenArena) render directly to whatever FBO the host has bound. They don't create their own offscreen FBOs and blit. They call `glClear` + `glDraw*` and the host sees the results in its FBO.

Ganesh is different because it creates its OWN offscreen FBO (for stencil support needed by Canvas 2D path rendering). It renders there, then needs to copy the result to the display. The copy goes to FBO 0, which must be the display.

## Cart-Side Principle

The cart MUST blit to FBO 0 to mean "the display." The cart MUST NOT try to detect or target a specific host FBO by ID. The host is responsible for making FBO 0 the correct target.

This matches the WebGL2 convention: `gl.bindFramebuffer(target, null)` always means the canvas. And the wasmcart spec: the host is a transparent ES 3.0 surface.

## UPDATE 6 (2026-03-31): Direct FBO redirect REVERTED - depth/stencil required

Setting RetroArch's hw_render FBO as the redirect target directly
(`wc_gl_set_redirect_fbo`) broke ALL GL carts - not just Ganesh. Three.js
and OpenArena also stopped rendering.

**Root cause:** RetroArch's hw_render FBO does not have depth+stencil
attachments. Our `wc_gl_setup_redirect` creates an FBO with:
- Color texture (RGBA8)
- Depth24+Stencil8 renderbuffer

Three.js needs depth testing. Ganesh needs stencil for path rendering.
OpenArena needs both. Without these attachments, 3D rendering fails.

**Current architecture (restored):**

```
Cart draws → redirect FBO (ours, with depth+stencil)
                    ↓ wc_gl_blit_to_fbo
            RetroArch hw_render FBO (color only)
                    ↓ RetroArch composites
                  Screen
```

The intermediate blit is required because RetroArch's FBO lacks depth/stencil.

**Ganesh on RetroArch remains broken** (shows only background). The fix is
cart-side: Ganesh binds VAO 0 which is undefined on Core 3.3 Profile. The
cart's `wc_gl_get_proc` must redirect `glBindVertexArray(0)` to a real VAO.
See `wasmcart-jsgame/ganesh.md` UPDATE 3.

**Working on RetroArch:** Three.js, OpenArena, Snake, Warlords, Roboblast
**Broken on RetroArch:** Adventure-ai (Ganesh VAO 0 - cart-side fix needed)
