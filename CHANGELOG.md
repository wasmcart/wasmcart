# Changelog

## 0.10.0

Resizable windows with aspect-preserving letterboxing, and a GL context sized
from the cart rather than from a guess.

The window still opens at the size the cart declares, which stays the cart's
call. What is new is that it can be resized from there: the frame scales up to
the largest rect that fits and the leftover area is filled with black bars, so
a cart's aspect ratio survives any window shape. A cart declaring 480x600 stays
portrait in a wide window instead of stretching into one. This applies to both
paths — 2D carts scale on blit via SDL's `dstRect`, GL carts get a viewport
fitted inside the drawable with the surround cleared.

Two new flags opt out: `--no-resize` pins the window to the cart's size, and
`--stretch` fills the window and lets the frame distort.

Also fixes a real rendering bug for GL carts that declare a resolution larger
than the old fixed default. The GL window was hardcoded to 1280x720 and the
self-provisioned context to 640x480, but `wc_gl_blit`'s viewport is the
*context*, not the frame — so a cart declaring 1600x900 rendered into a corner
of a too-small context. Both now size from the manifest's `width`/`height`.
`wasmcart-pack` gained `--width`/`--height` to record them, since `wc_get_info`
runs too late to size a window that must already exist.

New: `fitRect()` in `src/letterbox.js`, covered by `test/letterbox.test.js`.

## 0.9.1

Adds `getGlContext()` — the live WebGL2 context a cart is rendering through,
or null for a 2D cart — and switches `bin/wasmcart-play.js` to it.

0.9.0 left the player reading the private `_ownedGl`, which is set only when
the host creates a context for itself. A caller that supplies its own
`glBackend` left it null, so GL readback silently disabled and the frame came
back black. The CLI never hits that today (it passes nothing), but it was a
trap in shipped code for anyone embedding the same pattern, and readback needs
the context regardless of who made it.

Ownership is unchanged: `destroy()` still releases only a context the host
created, never the caller's.

## 0.9.0

**`CartHost` now supplies its own GL context**, matching what `CartHostWeb`
started doing in 0.8.0. Loading a GL cart with no `glBackend` used to throw on
Node; it now creates an offscreen context through `webgl-node` — already a
regular dependency — and runs.

```js
const cart = new CartHost();
await cart.load('gl_game.wasc', {});   // 0.8.0: threw. 0.9.0: works.
```

This finishes what 0.8.0 started. SPEC says *"a host SHOULD satisfy this itself
rather than requiring its embedder to"*, and the browser host does; Node did
not, so the same call succeeded in a browser and failed under Node. The 0.8.0
parity test pinned the two hosts to the same **error**; they are now pinned to
the same **behaviour**, which is the property that actually matters.

`glBackend` keeps its 0.8.0 meaning: an **override** — "render into THIS
context instead of one you make" — for drawing into an on-screen canvas or an
SDL window. It is not the host's only source of GL, and most callers should
pass nothing.

Scope worth being precise about: **the CLI was never affected.** `npx wasmcart`
plays GL carts on 0.8.0 and earlier because `bin/wasmcart-play.js` wired up its
own context. What was broken is the **library** API for anyone embedding
`CartHost` directly. That player no longer special-cases GL, since the host
handles it.

A context the host creates is owned by the host and released with
`WEBGL_lose_context` on `destroy()`; a caller-supplied one is left alone. If GL
genuinely cannot be obtained — no driver, a headless box with no EGL, an
install where the native addon did not build — that is still a load error
naming that cause, not a silent stub.

`allowMissingGL` remains gone and is simply ignored if passed: the host
provides a real context either way.

45 tests pass (44 existing + context-ownership coverage).


## 0.8.0

**Breaking:** `allowMissingGL` is gone, and the browser host now guarantees a
GL context instead of silently stubbing.

0.7.0 made "GL cart, no context" a load error but left two holes. First, it
shipped an `allowMissingGL` opt-out — which was wrong in principle: GL is part
of the host contract, not a capability a host advertises. A cart author writes
against the guarantee that any conformant host can run a cart importing `gl`;
a per-host opt-out turns that guarantee into something you discover at runtime,
as a black screen. Most carts never import `gl` and never cause a context to be
created — that is what the lazy `glBackend` factory is for — but a host that
cannot produce one when asked is not a wasmcart host.

Second, and worse, `CartHostWeb` never got 0.7.0's change at all: it still
silently stubbed. Since `web.js` is the `browser` export, the breaking change
0.7.0 announced did not actually apply to most consumers. The web host had no
test coverage for this, which is how it drifted; there is now a parity test.

Both hosts now guarantee a real context, but they satisfy that differently —
Node needs one supplied (`native-gles`), while the browser makes its own. See
Added below.

### Added

- **`CartHostWeb` supplies its own WebGL2 context.** WebGL2 has shipped in
  browsers for over a decade, so the web host satisfies the "hosts MUST be able
  to supply a GL context" rule itself instead of pushing the requirement onto
  the page: a GL cart loaded with no `glBackend` now gets an offscreen (or
  detached-canvas) context automatically. Passing `glBackend` still wins and is
  how you render into your own on-screen canvas — it is an override, not the
  host's only source of GL. A context the host created is released on
  `destroy()`; a caller-supplied one is left alone. If WebGL2 genuinely cannot
  be created, that is an error naming *that* cause rather than blaming the
  caller for not passing a backend.

```js
await cart.load('gl_game.wasc', {});
// Error: this cart imports the `gl` module but no glBackend was provided.
// (same in Node and in the browser; no flag re-enables stubbing)
```

If you were passing `allowMissingGL: true`, supply a real context instead. On
Node that is `native-gles` (a regular dependency, not optional); in a browser
it is `canvas.getContext('webgl2')`.

SPEC.md now states the requirement normatively. It previously said only that
"a factory that produces no context is a load error", which left the
no-`glBackend`-at-all case unspecified — the exact gap a downstream host fell
into.

## 0.7.0

**Breaking:** a GL cart loaded with no GL context is now a load **error**
rather than a silent stub.

`SPEC.md` already required this ("a factory that produces no context for a GL
cart is a load error, never a silent stub"), and the factory path enforced it,
but passing no `glBackend` at all did the opposite: it stubbed the `gl`
imports so every call became a no-op returning 0. For a hybrid cart that also
fills a 2D framebuffer this is survivable, which is why it went unnoticed. For
a cart that *renders* through GL, `load()` reported success and the player got
a black screen with no error anywhere — indistinguishable from a broken cart.

```js
await cart.load('gl_game.wasc', {});
// 0.6.0: loads, renders nothing
// 0.7.0: Error: this cart imports the `gl` module but no glBackend was provided.
```

If you were relying on the stub — a hybrid cart whose 2D output is enough —
opt in explicitly:

```js
await cart.load('hybrid.wasc', { allowMissingGL: true });
```

`usesGL` still reports true under `allowMissingGL`, because the cart's own
`gpu_api` declaration is authoritative and that is what launchers key "needs a
GL window" off.

### Added

- **`wasmcart-pack --source <dir>`** packs a dev directory that already has
  its own `manifest.json`, keeping that manifest verbatim. The flag form
  generates a manifest and so cannot express a cart whose manifest already
  says something specific (a custom `assets` root, a field with no flag). The
  wasm is resolved through the manifest's own `entry`, every other file is
  packed at its original path — the `assets` prefix refers to those paths — and
  only `entry` is rewritten to the archive's `cart.wasm`.

- **The terminal player renders GL carts.** `--term` previously refused them
  with "the terminal player only renders 2D framebuffer carts". Rendering on
  the GPU and displaying as ANSI are orthogonal; the player was simply loading
  without a `glBackend` and bailing. It now supplies an offscreen WebGL2
  context and reads the frame back, so `--term`, `--shot` and `--frames` all
  work for GL carts, including over SSH.

### Fixed

- **A manifest `assets` root without a trailing slash now resolves.** The
  field is joined as a *directory* in dev mode but stripped as a *path prefix*
  from a packed `.wasc`, so `"assets": "app"` turned `app/main.lua` into
  `/main.lua` and every lookup missed. A cart authored from a dev directory
  therefore booted fine and failed the moment it was packed, reporting a
  missing asset that is plainly in the archive. Both hosts now normalize it.

## 0.6.0 and earlier

Not tracked here; see the commit history.
