# Changelog

## 0.22.1

Two GL import-layer fixes, both of the silent-wrong-picture kind: nothing
throws, no cart can see them, and the only symptom is that the frame is wrong.

**`glUniform1f` is routed to the setter WebGL2 will actually accept.** Desktop
GL converts; WebGL2 enforces an exact type match and REJECTS the call with
`GL_INVALID_OPERATION`, leaving the uniform at its previous value. A 3D cart
set `uniform int point_simple_count` — its light count — through the float
entry point every frame, so the count kept whatever it held and the scene was
lit wrong. `glGetUniformLocation` now records each location's declared type and
array size once (`getActiveUniform` is a driver round trip; setters run
thousands of times a frame) and `glUniform1f` dispatches on it: int/bool →
`uniform1i`, int vectors → `uniform{2,3,4}i` truncated, float vectors →
`uniform{2,3,4}f` broadcast, a declared array → the `*v` form even for one
element, and a plain float straight through.

**The feedback loop the FBO redirect creates is broken before the draw.** The
redirect makes "the screen" an ordinary 2D texture, which the cart cannot know.
Against a real default framebuffer, returning to the screen can never loop —
the screen is not sampleable. Here it can: a sampler still holding the target
means the draw both reads and writes the same image, and WebGL2 rejects it and
renders nothing. A match-three cart came out with a board and no jewels,
because it bakes each sprite into its own canvas and its bind cache left a
canvas texture on unit 0. Repaired at DRAW time, not at bind time — the cart
binds its texture *after* returning to the screen, so a bind-time fix is undone
immediately. Sampler units, the active unit and each FBO's `COLOR_ATTACHMENT0`
are tracked rather than queried, and the active unit is restored exactly as the
cart left it (engines cache it and skip binds they consider redundant).

Both are tested at two layers, because the premises fail differently from the
behaviour. The uniform premise is checked against real GL; the feedback-loop
premise needs a **real browser** (Playwright) — native-gles/radeonsi accepts
the looping draw and renders it, so a node-only suite would "prove" that fix
unnecessary. Controls were run for both: reverting the router fails 7 of 10
cases, removing the two guard calls fails 3 of 6.

One caveat recorded for the next reader: the array branch of the uniform fix
does not reproduce as a failure on native-gles. `glUniform1f` on `float[16]` is
accepted there and the readback confirms it writes, even at `size=16`. It is
kept because the browser's WebGL2 is the strict validator this exists for.

## 0.22.0

**The scroll wheel reaches carts.** Every device wasmcart runs on has a
gamepad, a touchscreen, or a mouse -- so a game needing one continuous axis
(zoom, throttle, scrub) needs three bindings to be universally playable:
a stick, a pinch, and a wheel. The first two were already possible. The
third had nowhere to go: `wc_pointer_t` carries {x, y, buttons, active} and
nothing else, so hosts dropped every wheel event on the floor.

This is an ADDITIVE ABI change (v3.1). Existing carts are unaffected --
`wheel_ptr` is a new `wc_info_t` field older carts leave as whatever was at
index 17, which hosts range-check and ignore. Rebuilding an existing cart
against the new headers gets it for free, since `WC_CART_BUFFERS` and
`WC_FILL_INFO` declare and wire the buffer.

- `wc_wheel_t {int32 dx, dy}`, reached through `wc_info_t.wheel_ptr`, gated
  by the existing `WC_FLAG_POINTER`. A wheel is a DELTA, not a position, so
  it is its own struct rather than an eleventh pointer slot -- it has no
  coordinates, no press and no identity to track across frames.
- **Units: 1/120 of a notch**, the `WHEEL_DELTA` convention. One click of a
  detented wheel is 120; trackpads and free-spin wheels report the fraction
  they actually moved, so precision scrolling is not rounded to a click.
  `dy` is positive UP.
- **Host accumulates, writes before `wc_render`, zeroes after.** The cart
  only reads, and what it reads is that frame's delta -- frame-rate
  independent, which matters because one trackpad flick is dozens of
  events. Nothing for the cart to clear, and no way to miss an event by
  reading late.
- **Zero is the normal state on most hardware,** and that is the point: a
  phone with no mouse never writes here, exactly as a desktop never fills
  touch slots 1-9. The field always exists and hardware that cannot produce
  it leaves it alone, so carts read it unconditionally instead of asking
  whether a wheel exists.
- Reference hosts (`CartHost`, `CartHostWeb`) gain `wheel(dx, dy)` for
  embedders to feed from `wheel` / `SDL_MOUSEWHEEL` / Android
  `ACTION_SCROLL`. Hosts must NOT synthesize it from touch: pinch is
  derived by the CART from two pointer slots, which is also the settled
  answer in SDL (SDL3 removed `SDL_MULTIGESTURE` for the same reason).
- `docs/input.md` gains the pattern other carts kept re-deriving: the
  three-binding coverage rule above, how to compute an anchored pinch from
  two slots (including the shift-the-camera step everyone forgets, which is
  why zooming a pinched corner looks wrong on the first try), and the
  gesture-priority rule that a second contact CANCELS an irreversible
  one-finger drag rather than completing it.

## 0.19.0

A cart's engine can now be built and run NATIVELY, off wasm, without
forking it: `WC_NATIVE_HOST`.

Some engines are C that happens to be compiled to wasm. Built with an
ordinary toolchain and linked against a host in the same address space,
such an engine needs no wasm runtime at all -- which matters where one is
expensive to ship. The reference case: an Android game APK drops from
about 64 MB to 6 MB, since the JS engine was nearly all of the difference,
and runs at a locked 60 fps for roughly 40% less CPU.

This is a build target, not an ABI change. The wasm output is
byte-identical, the exports and struct layouts are unchanged, and a cart
cannot tell the difference.

- `wc_cart.h`: `wc_debug_mark` gains an extern branch for a native host
  (the plain non-wasm branch is a no-op stub -- right for a cart built
  without a host, silently wrong for a host that must supply it), and the
  debug descriptor gains a native form holding real pointers.
  `(uint32_t)(uintptr_t)&x` is neither lossless nor a compile-time
  constant on a 64-bit target.
- `SPEC.md` documents the target, the parts of the ABI a native host
  cannot use (`wc_info_t`'s region pointers and the debug descriptor both
  encode 32-bit offsets into linear memory), and what it costs: native
  engine code carries the process's authority, so this is for first-party
  carts you ship yourself, not for running untrusted ones.

## 0.17.0

Carts are seeded with entropy on every normal load; determinism stays opt-in.

Both reference hosts called `wc_set_seed` only in deterministic-replay mode
(`CartHostWeb` never called it at all), so a normal power-on ran the
compile-time seed: every boot dealt the same shuffle, spawned the same waves,
rolled the same dice. `CartHost` now rolls a fresh random u32 per normal load
and `CartHostWeb` seeds from `crypto.getRandomValues` per page load.
`load(cart, { deterministic: { seed } })` pins the seed and the virtual clock
exactly as before, so replays, goldens, and regression loops are untouched. A
new test loads the RNG-noise fixture three times normally and requires the
frames to diverge; with the seeding reverted it fails.

Carts need no change: export `wc_set_seed` (the `wc_cart.h` macro provides
it) and draw randomness from `wc_rand()`. A cart that repeats itself
identically on every power-on is running on a pre-0.17.0 host.

New advisory manifest field `controls`: the subset of the standard pad the
game actually reads (`["dpad","a","b","start"]` and the like). Presentation
hint only, in the same doctrine class as `width`/`height` — a host drawing
on-screen touch controls shows just what the game needs, every other host
ignores it, and unknown tokens must be ignored. The full X360-style
`wc_pad_t` is always delivered regardless. `wasmcart-pack --controls
dpad,a,b,start` writes it (repeatable or comma-separated; unknown tokens
warn but still pack, since hosts tolerate them by spec).

Mixer fix in the vendored `wc_pcm_mixer.h`: the playback position was 16.16
fixed-point in a u32 — 65536 source frames of headroom, 1.37 seconds at
48kHz — so any longer sample silently wrapped to zero mid-play and started
over, heard as music restarting rather than reported as an error. The
position is now 48.16 in a u64; per-channel step stays 16.16. Vendored
copies in the ports are resynced (`scripts/sync-headers.sh --write`).

Both hosts seed at the same point now: BEFORE `_initialize` as well as
`wc_init`. `CartHostWeb` used to run static constructors first, so a browser
cart doing RNG work in a constructor got the compile-time seed while the same
cart on Node did not — the two reference hosts disagreed on the contract.

The player grew `--width`/`--height` (an explicit window size; the code that
honored them existed but no flag ever set them), and the front door's `-h`
now lists the full flag set. `wasmcart/web` exports `FLAG_DEBUG`,
`FLAG_DETERMINISTIC`, and `HOST_FLAG_DETERMINISTIC`, matching the Node entry
point.

A documentation sweep against the shipped code, the biggest since the
`wc_peer_*` merge:

- SPEC: `wc_info_t` now lists `gpu_api` (byte offset 64, in the ABI since
  v3 but missing from the normative struct); the manifest example uses
  `net.domains`; entropy-by-default seeding is normative; the manifest
  `debug` field is marked REMOVED (nothing ever read it — `WC_FLAG_DEBUG`
  is the gate, per the doctrine that a manifest field never gates a
  capability the cart declares about itself); the Security Model reflects
  the peer model's per-direction gating.
- docs/input.md: the button-bit table was wrong for bits 6-15 (it had
  pasted W3C indices into the wasmcart bit column — a cart following it
  tested the wrong masks); pointer and keyboard sections now document the
  slot contract (0 = mouse, 1-9 = touch fingers), `wc_pointer_t`, the
  event callbacks, and that `WC_FLAG_KEYBOARD` stops keyboard-to-gamepad
  mapping.
- docs/networking.md: gating is per direction — dial-out needs the flag
  plus `net.domains`; host-registered peers need the flag alone (the file
  previously contradicted itself on this); `net.lan`/`net.serial` are
  marked prospective, since no host reads them.
- docs/gl-surface.md and bind_framebuffer.md: claims that described
  native-host behavior as universal (VAO-0 redirect, buffer orphaning,
  GLSL version passthrough) are scoped honestly; CartHostWeb's redirect-FBO
  path is documented as current (the "no redirect needed" browser section
  predated it); CartHost self-provisions its GL context via webgl-node.
- docs/fetch.md carries a PROPOSAL banner — `wc_fetch_*` was never
  implemented and the doc read like it shipped.
- docs/porting.md: shared headers live in `include/` (the documented
  `porting/include/` never existed), the SDL2 backend is the wasmcart-sdl2
  package, and the checklist gains the Wasm-EH/SjLj build requirements.
- README: the `--pointer --keyboard` pack example (a warning no-op since
  the double-gate removal) is replaced with the real story, the full pack
  and play flag sets are listed, and the small-cart 2x window default is
  documented.

No ABI change: version 3, its imports, and the `.wasc` format are untouched.

## 0.16.3

WebAssembly exception handling is now an explicit part of the wasmcart
execution baseline. Carts may use the standardized Wasm EH instructions without
adding an import, permission, or manifest field.

This includes wasi-sdk's Wasm-native `setjmp`/`longjmp` implementation. The
README documents the wasi-sdk 33 build requirements:
`-mllvm -wasm-enable-sjlj` during compilation and `-lsetjmp` at link time.

A real cart built against wasi-sdk's `libsetjmp` now runs in both the Node.js
and Chromium conformance suites. It performs a `longjmp(..., 42)` during
`wc_init`, then exposes the result for an exact assertion. This verifies the
engine feature end to end instead of inferring support from API presence.

This is additive for carts and does not change ABI version 3, its imports, or
the `.wasc` format. It does strengthen the host execution baseline: a runtime
without standardized Wasm EH is not fully conforming.

## 0.16.2

`destroy()` no longer closes peer transports the host does not own.

Both reference hosts closed every entry in `_peers`, including channels the
embedder supplied via `addPeer()`. The host never owned those. Closing them
breaks any embedder that outlives one cart instance, and for a real
`RTCDataChannel` it is unrecoverable -- a closed channel forces the peer
connection to renegotiate.

The motivating case is swapping carts on a live session: two players stay on one
channel and cycle through games. The ABI deliberately puts connection lifecycle
in the host and gives the cart only an id and bytes, so that should be free.
Instead every swap cost a full WebRTC renegotiation -- signalling round trip, new
ICE, seconds of dead air. It also bit plainer cases, like an embedder keeping a
lobby socket across cart loads.

Peers now record ownership when created. A socket the host dialled via
`wc_peer_open` is still closed on teardown; a channel from `addPeer()` is
forgotten without closing, and its `onmessage`/`onclose` are detached so a dead
host stops queueing events into an object nobody reads.

This is the same line the GL context already drew (`_ownedGl` vs `_callerGl`)
five lines above the bug. Peers simply never got the same treatment.

Not a spec change: SPEC.md already says the host owns connection lifecycle and
the cart sees only an id and bytes. No cart needs rebuilding.

Reported with a working reproduction, which is how it was confirmed before any
code changed. `wasmcart-native` was checked and does not share the bug -- its
`destroy()` frees only its own bookkeeping and never calls a transport's close.

## 0.16.1

Fixes silent cart-memory corruption when the host delivers a payload to a cart
with no allocator.

For carts exporting no `malloc`/`free`, the host staged inbound payloads (peer
messages, text input) in **the top 64KB of existing linear memory**, assuming
nothing lived there. For a cart linked at the wasm-ld default of 128KB that is
false -- its statics run straight through that window. Reproduced: 9472 bytes of
a cart's array sat inside the region, and a 2000-byte message overwrote them.
`0xAB` became `0x58`, the ASCII `X` we sent.

There was no trap and no error. The corruption surfaced later as something
unrelated -- in the report that found this, a nonsense `cart requested
6647407x32` resize warning pointing nowhere near the cause. It only triggers
once networking or text input is used, so it presents as "my cart broke when I
added multiplayer".

The host now grows a dedicated scratch page onto the END of linear memory, past
everything the cart owns, so staging cannot alias cart data. If the cart pinned
its memory maximum and growth is impossible, the host falls back to the tail of
existing memory **only after proving** it sits above the cart's declared
high-water mark (framebuffer, save region, input/time/pointer/keys structs, plus
a margin). Failing that it drops the payload and says why: a dropped message is
recoverable, corrupted cart memory is not.

Reported by the agent who wrote the `wc_peer_*` merge, who hit it in their own
fixture, fixed the fixture, and left the host alone on the grounds that it
affects every cart. That was the right call -- the hazard is general and the
existing suite could not have caught it, because every fixture was large enough
to escape.

`smallmem.wasc` is a fixture built to fail: 128KB memory, pinned maximum,
statics crossing the 64KB line, and a guard array that shows the overwrite.
Three tests cover it, including a control proving delivery still works where it
is safe.

## 0.16.0

Merges the WebSocket and data-channel families into one peer-connection family.

BREAKING at the package level, but **ABI version stays 3**. A cart is a
connection to a peer: open it, send bytes, receive bytes, learn when it opens or
closes. `wc_ws_send` and `wc_dc_send` were the same function under two names,
and the split forced a cart to care how a connection was established -- a cart
written against a relay server could not run over a serial cable without a
rewrite. Transport (WebSocket, WebRTC, TCP, MQTT, serial) is the host's business
and stays opaque.

- `wc_ws_*` and `wc_dc_*` are replaced by `wc_peer_*`.
- `FLAG_NET_WS` / `FLAG_NET_DC` become `FLAG_NET_PEER`. Bit `1 << 2` is reserved
  and unused, with a test asserting nothing reclaims it.
- `net.domains` replaces `net.websocket` in the manifest. The old key is still
  read, so existing manifests keep working.
- Text frames are gone. They are meaningless on a serial cable, so framing
  belongs to the cart; a server's text frame now arrives as its UTF-8 bytes
  rather than being dropped.

The ABI version is deliberately NOT bumped to 4. Nothing outside this org
consumes wasmcart yet, so the only carts affected are ones we control, and a
version bump exists to protect third parties who do not yet exist. Checked
before deciding: no sibling project actually calls the old imports -- the hits
across wasmcart-lua, -mruby, -jsgame, -native and the examples are all stale
vendored copies of `wasmcart.h`, not live usage.

Two defects found while wiring it up, both fixed:

- `peer_name` could truncate the NUL terminator on a short buffer, handing the
  cart an unterminated string. It now truncates the text and always terminates.
- The dual gate SPEC.md describes was not enforced anywhere. `_peerOpen` now
  requires both the cart's `WC_FLAG_NET_PEER` and a manifest net grant, and a
  `net.lan` grant no longer opens a `wss://` address.

`peernet.c` is a real cart importing the family and exporting the four
callbacks, so the ABI is exercised end to end rather than mocked. 102/102.

## 0.15.1

Clamps `delta_ms`, which is the general fix for a problem 0.14.0 only solved
halfway.

`delta_ms` is `now - lastFrameTime`, so any stall inflates it and a cart
integrating velocity by dt moves a stall's worth of distance in one step. 0.14.0
addressed this by rebasing the clock on lifecycle resume -- but that only covers
stalls the host *knows* about. A GC pause, a slow disk read, a debugger
breakpoint or a throttled background tab produces exactly the same spike with no
event to hang a fix on. Measured: a 30-second stall with no suspend involved
still delivered a 30000ms delta.

Hosts now clamp at 250ms (4fps), the same cap Unity and Unreal apply. `time_ms`
absorbs the discarded time so the two clocks stay consistent -- otherwise a cart
summing deltas and a cart reading `time_ms` drift apart by the length of every
stall. Deterministic fixed steps are not clamped, since a harness setting a step
is stating the delta it wants.

The lifecycle rebase stays and is now correctly described as a refinement rather
than the protection: with the clamp alone a suspend costs one clamped frame of
phantom time, with the rebase it costs none. SPEC.md's claim that the rebase was
required has been corrected accordingly.

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
