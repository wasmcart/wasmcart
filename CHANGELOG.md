# Changelog

## 0.15.0

Adds text input: characters, not scancodes.

```c
void wc_on_text(const char* utf8, uint32_t len);  // cart export, optional
void wc_text_input_begin(void);                   // host imports
void wc_text_input_end(void);
uint32_t wc_text_input_active(void);
```

The keyboard ABI reports HID scancodes -- physical key positions, which are not
characters. `Shift+2` is `@` on a US layout and something else on many others,
and `e-acute` has no scancode at all, so a cart deriving characters from
scancodes is reimplementing keyboard layouts badly. The host now delivers text
the platform already composed: layout, shift, dead keys, compose sequences and
IME commits all applied. Verified end to end with 2-, 3- and 4-byte sequences
round-tripping intact.

The pointer is valid only during the call and is not null-terminated, so a cart
must copy and must honour `len` -- one call can carry several codepoints because
an IME commits a whole word at once.

Text is off until the cart calls `wc_text_input_begin()`, which means a host can
forward platform text unconditionally and a cart that never asks is immune. Text
queued but undelivered is discarded on `end()`, so what the player typed into one
field cannot reappear as a ghost keystroke in the next one.

`bin/play-window.js` suppresses its own key bindings while text input is active
-- typing `q` into a name field previously quit the player, and `w` would also
walk the player forward. It also releases keys held at the transition, since
`keyDown` suppression would otherwise leave them stuck down for as long as the
field is open.

Editing keys stay on the keyboard ABI: backspace, arrows and enter are presses
rather than characters, so a cart drawing its own field reads those through
`wc_kb_on_down` and appends what arrives via `wc_on_text`.

Also adds `test/fixtures/gltri.wasc`, a GL orientation probe, and three tests on
it. The existing GL fixture only calls `glClearColor`, so every pixel is
identical and a vertical flip or bad viewport is invisible; gltri draws
asymmetric geometry so the pixels say which way is up. One of the three pins the
letterbox path, which resizes by calling `gl.viewport` on the cart's own context.

## 0.14.0

Adds lifecycle events, and fixes the clock spike that made suspension unsafe.

Four new optional cart exports: `wc_on_suspend`, `wc_on_resume`,
`wc_on_focus_lost`, `wc_on_focus_gained`. No flag, no manifest entry -- export
any subset and the host skips the rest.

**Suspension is host-owned.** While suspended the host does not call
`wc_render()` at all, so a cart exporting none of these is still correct: it is
simply not running. You handle lifecycle to be polite (pause audio, drop a
netplay connection, flush state), never to be correct. `runFrame()` replays the
last frame while suspended rather than throwing, so a host whose loop keeps
ticking stays correct without knowing about lifecycle.

**Suspend and focus are separate on purpose.** Minimize or hide suspends the
cart; alt-tab only moves focus and the cart keeps rendering. Conflating them
means a game either cannot auto-pause on alt-tab, or wrongly freezes when it
should still draw.

**The clock is now rebased across a suspend.** `delta_ms` is the time since the
last *rendered* frame, so without this the first resumed frame reported the
entire gap -- a ten-minute background stint arrived as a 600000ms delta and
teleported anything integrating velocity by dt straight through the world.
Measured before the fix: exactly 600000. `time_ms` stays continuous for the
same reason; it measures time the cart has been running.

Ordering is guaranteed and balanced: suspend emits focus_lost then suspend,
resume emits resume then focus_gained, so a cart is never left permanently
unfocused after a round trip. Transitions are idempotent, since hosts get
duplicate visibility events routinely.

`CartHostWeb` gains `autoWireLifecycle()`, driving the pairs from
`visibilitychange` and window focus/blur, and adopting the current state on
attach so a cart loaded into an already-hidden tab starts suspended rather than
running one stray frame. `bin/play-window.js` wires the SDL window events, and
persists the save on suspend -- a backgrounded app can be killed by the OS
without ever reaching a graceful quit, so that is often the last chance to write
one.

## 0.13.2

CI and README only. No runtime changes -- the published code is identical to
0.13.1.

**CI could not run the GL tests.** Four of them failed on every runner with "a
WebGL2 context could not be created", which also blocked the tag-gated publish
job. The workflow described this as a "pure-JS package, no native build" -- true
once, but stale since GL became a hard requirement of the ABI. `webgl-node`
delegates to `native-gles`, which dlopens `libEGL.so.1` and `libGLESv2.so.2` and
needs a DRI driver behind them; a bare runner has none. Mesa's swrast/llvmpipe
supplies all three in software, so CI now installs `libegl1`, `libgles2` and
`libgl1-mesa-dri` before `npm ci`.

Skipping the GL tests in CI would have been the wrong fix: they assert that GL
is unconditional and never stubbed, which is exactly the guarantee worth
keeping covered.

A context check now runs before `npm test`, mirroring `CartHost`'s own
`createWebGL2Context(w, h)?.gl` call so it cannot pass while the host fails. A
driver-less runner produces one clear error instead of four confusing test
failures.

**README** now lists the language SDKs the org actually ships (Lua, Python,
Ruby, JavaScript, GDScript, Rust, Zig, C/C++), split by whether you compile.

## 0.13.1

Documents loop inversion for the people who need it. No code changes.

0.13.0 implemented `wc_frame_yield` in the web host but only specified it in
SPEC.md, which left two gaps for cart authors:

- **`include/wasmcart.h` did not declare it.** A cart using loop inversion had
  to hand-write the `import_module`/`import_name` attributes, which is exactly
  the boilerplate the header exists to remove. Now declared, with the
  `wc_yield_buffer` contract and a worked example in the comment.
- **`docs/porting.md` did not mention it.** That is the one document a porter
  reads, and inverting the main loop is usually the hardest part of a port. It
  now has a section covering the asyncify build flags, the yield-buffer export,
  and the two traps: sizing the unwind stack for the real call depth, and
  keeping `ASYNCIFY_IMPORTS` narrow so instrumentation stays cheap.

Also adds loop inversion to the README's ABI v3 feature list, where it was the
only v3 feature missing.

## 0.13.0

Fixes loop-inverted carts hanging the browser, and makes silent import stubbing
audible.

`CartHostWeb` had none of the asyncify machinery behind `wc_frame_yield` -- the
protocol ported engines use when they own their main loop (`wc_render()` never
returns; it yields once per iteration and the host unwinds the whole engine
stack out of it, rewinding to the same point next frame).

The failure was not a load error, which is what made it invisible. The web
host's auto-stub backfilled the missing import as `() => -1`, so the cart linked
cleanly and then the yield did nothing: the engine's infinite main loop never
unwound, and the **first `runFrame()` never returned**, hanging the tab. Carts
affected are exactly the ported engines that need loop inversion.

`CartHostWeb` now implements the full protocol -- unwind state, `wc_yield_buffer`
resolution after `wc_init`, and rewind/suspend around `wc_render` -- matching
`CartHost` behaviour for behaviour. The two hosts are now at complete import
parity. `cartWorker.js` and `cartWorkerWeb.js` also declare `wc_frame_yield` (a
no-op there, since only the main thread can unwind out of `wc_render`) because a
threaded cart instantiates the same module in a worker, where a missing import
IS a hard LinkError.

The auto-stub that hid this now warns when it fires. It stays -- it keeps carts
built against a newer ABI loadable -- but a silently stubbed import is a real
incompatibility that surfaces later as inexplicable runtime behaviour, so it
should never again be silent.

## 0.12.2

Documents rumble in `docs/input.md`, the dedicated input reference, which had no
rumble section -- so the one place a cart author looks for input details did not
mention it. No code changes.

## 0.12.1

Two correctness fixes: saves that only survived a graceful exit, and a resize
path that reported pixels it did not return.

**Save durability.** Saves were persisted only from the windowed player's
`quit()` (window close, Esc/Q), so Ctrl-C -- an ordinary way to stop a game --
discarded the player's progress. The terminal player was worse: it neither
loaded nor saved, so progress was invisible there in both directions and playing
in the terminal silently threw it away. Both players now load an existing save on
start and persist on `SIGINT`, `SIGTERM`, and `uncaughtException` as well as
normal exit. Path handling moved to `src/save.js` so the two players cannot
disagree about where a cart's `.sav` lives.

The all-zero check that guards the first write also had a data-loss bug: it
treated "never saved" and "player cleared their data" as the same state, so
clearing your data and quitting silently resurrected the old save. It is now a
first-write guard only -- once a `.sav` exists, an all-zero region overwrites it.

**Resize validation.** A cart can change resolution by writing `width`/`height`
into its `wc_info_t`, and the host adopted whatever it found. Those fields live
in cart memory, so they are untrusted: a cart poking 4096x4096 was *reported* as
4096x4096 while `subarray()` silently clamped the framebuffer to the end of
memory, returning 17,169,312 of the 67,108,864 bytes implied. Nothing threw --
the host simply described a frame whose pixels did not exist, and any consumer
indexing by the reported width read ~50MB past the real data.

The host now verifies that `fb_ptr + w*h*4` fits in the cart's memory and keeps
the previous resolution otherwise, so the reported size and the returned bytes
agree by construction. The check computes in floats because `w*h*4` can exceed
2^32 (65536x65536 is 17GB, which wraps to 0 in 32-bit math and would make an
absurd request look tiny). Legitimate resizes are unaffected. Rejection warns
once, not per frame.

SPEC.md gains a normative "Resolution changes" section and a durability
requirement under host-managed saving.

## 0.12.0

Adds rumble, and documents the security boundary that was already there.

**Rumble.** Three new host imports: `wc_pad_has_rumble(pad)`,
`wc_pad_rumble(pad, low, high, duration_ms)` and `wc_pad_rumble_stop(pad)`.
Rumble runs the opposite way to the rest of input -- the cart drives it -- so it
is an import rather than a field in `wc_pad_t`, and needs no flag or manifest
entry. `low`/`high` map onto SDL's strong/weak motors and the W3C `dual-rumble`
effect's `strongMagnitude`/`weakMagnitude`, so one call behaves identically in a
native window and a browser.

Capability is per-device rather than per-platform, so `wc_pad_has_rumble` is a
real query: an Xbox 360 pad reports rumble but not trigger rumble. Magnitudes
outside `0..1` clamp (NaN to 0) and duration caps at `WC_RUMBLE_MAX_MS` (5s)
rather than being rejected, since a cart deriving intensity from game state
overshoots at the edges and a dropped rumble is harder to diagnose than a
saturated one. The cap also means a cart cannot pin the motors forever: the host
stops them on its own timer, so a cart that crashes mid-effect still leaves the
controller quiet.

Hosts always provide the imports. With no device wired (headless runs, `--frames`
captures, tests) they are silent no-ops and `wc_pad_has_rumble` returns 0, so a
cart that rumbles is never a cart that fails to load. `bin/play-window.js` routes
pad 0 to the SDL controller; `CartHostWeb` defaults to `navigator.getGamepads()`
and both accept a `setRumbleHandler()` override.

**Security model.** The existing section now enumerates the import table as the
complete attack surface, and is explicit that the toolchain shims whose names
imply capabilities are inert: `path_open` and `fd_prestat_*` are not provided at
all (so a cart has no way to *name* a host file), `fd_read`/`fd_seek` return 0,
`environ_*` return 0, `__syscall_getcwd` returns -1, and `proc_exit` is a no-op.
Threads are documented as confined to the same import table as the main thread.
Also states plainly what a malicious cart still *can* do -- burn CPU, exhaust its
declared memory -- since the ABI does not bound either and hosts must.

No breaking changes. Carts built against 0.11.0 are unaffected.

## 0.11.0

The manifest is now optional, and it no longer gates anything the cart
declares about itself.

Two rules, both now normative in SPEC.md:

**A cart with no `manifest.json` loads and runs.** `entry` falls back to
`cart.wasm` and every other field takes its default. Previously all three
loader paths threw `.wasc archive missing manifest.json`, which made the
smallest possible valid cart -- a single wasm file in a zip -- unloadable for
no reason the format required.

**A manifest field never gates a capability the cart declares itself.**
Pointer and keyboard delivery were gated on `WC_FLAG_POINTER`/`WC_FLAG_KEYBOARD`
*and* on `manifest.pointer`/`manifest.keyboard` -- eight sites across the two
hosts. Since the flags are the cart's own statement of what it handles, the
manifest field could never usefully agree and could only disagree, and when it
did the failure was silent: a cart that set the flag but shipped a manifest
without the field just stopped receiving input, with nothing logged. The flags
are now the only gate. The `pointer` and `keyboard` manifest fields are
removed, and `wasmcart pack --pointer` / `--keyboard` are accepted no-ops that
warn.

`net` is deliberately not covered by the second rule. An allowlist is a
permission the cart cannot grant itself, so it stays manifest-only and fails
closed: no manifest, or no `net` entry, means no network access.

BREAKING: a cart relying on `manifest.pointer` / `manifest.keyboard` to *enable*
input must set the corresponding `WC_FLAG_*` in `wc_info_t` instead. A cart that
already sets the flags is unaffected, and gains input it may have been silently
losing.

## 0.10.2

Passes a manifest's `width`/`height` through as the host's preferred
resolution when the caller has no opinion of its own.

`_writeHostInfo` only ever wrote `options.preferredWidth`, so a runtime that
sizes itself from `preferred_width` never saw a cart's own declaration. Godot
does exactly that -- it picks its viewport from the host preference -- so
every Godot cart rendered at its built-in default no matter what the manifest
said: a 1920x1080 game came out 640x480. An explicit `preferredWidth` from the
caller still wins, since that is the host legitimately asking.

## 0.10.1

Fixes GL carts that declare a resolution the host had to guess at, and adds
`--fullscreen` / `-f`.

A GL cart's window has to be created *during* `load()`, because the GL context
is a wasm import and must exist before instantiation — which is before
`wc_get_info` can say how big the cart is. The window therefore opened at a
guess and was never corrected, so a cart declaring 1280x720 got a 640x480
window and rendered into a corner of it. The window now adopts the cart's real
resolution once `wc_get_info` has answered (skipped when the caller passed an
explicit `--width`/`--height`, since that is the host legitimately asking).

The offscreen context that `CartHost` provisions for itself had the same
guess, and it must match the cart in *both* directions: too small clips the
frame, and too large is equally wrong, because a cart's own renderer sizes its
viewport from the drawable rather than from `wc_gl_blit`'s
`glViewport(0, 0, w, h)`. Measured against wasmcart-lua: given a 1920x1080
drawable, a cart declaring 1280x720 painted all the way out to x=1918, y=1078,
so a cart-sized readback cropped the frame. It now takes the manifest's
`width`/`height`, then the caller's preference, then 720p as a blind default.

`--fullscreen` fills the display. It needs no special handling beyond that:
the frame is letterboxed into whatever the drawable turns out to be, so the
cart's aspect ratio holds on a screen of any shape.

Docs: "Resolution Negotiation" said the cart picks its resolution *during*
`wc_init()`. The host actually reads it from `wc_get_info()`, which it calls
**before** `wc_init()` — that inversion is exactly what makes this a hard
problem for carts whose script chooses the resolution at init time, so the
section now says so and points at the manifest as the way out. The manifest's
`width`/`height` fields, added in 0.10.0, are documented for the first time.

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

Also fixes `--shot` for carts that import `gl` without rendering through it.
An SDK that links a GL backend into every cart makes `usesGL` true even for a
cart that only writes the CPU framebuffer, and the player was reading back the
untouched context and writing a black PNG over a perfectly good frame. The GL
readback is now used only when it actually captured something.

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
