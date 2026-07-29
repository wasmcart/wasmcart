# wasmcart Specification

> **ABI version: 3.** This is the normative specification for the wasmcart virtual
> cartridge format - the host↔cart contract that any conforming host (see the
> reference implementations in [`src/`](src/)) and any cart must follow. The
> machine-readable form of these constants lives in [`src/abi.js`](src/abi.js); the
> C-side contract in [`include/wc_cart.h`](include/wc_cart.h).


## Overview

A cart exports three functions (`wc_get_info`, `wc_init`, `wc_render`) and
declares its capabilities in `wc_info_t.flags`. Gamepad input is always
available; extended input (pointer, keyboard) is opt-in per cart via those
flags. Networking is the one capability a cart cannot grant itself, so it is
declared in the manifest and fails closed. The host provides everything through
a small set of imports and shared-memory regions; the cart owns its own memory
and reaches nothing else.

Everything a cart can call is listed under [Imports](#imports-host-provides).
That list is the complete attack surface -- see [Security Model](#security-model).

### Why each part of the ABI exists

The ABI is deliberately small, and additions are held to a bar: **a cart must
not be able to solve the problem itself.** This table records which parts met
that bar because something was *broken*, and which are conveniences that could
in principle have been left out. It exists so the next person weighing an
addition can see the standard that was applied, and hold a new proposal to it.

| Feature | Why | Could a cart do this itself? |
|---|---|---|
| **Delta clamp** | **Bug.** An unclamped `delta_ms` handed a cart the length of any stall -- a GC pause, a disk hit, a suspended tab -- and integrating velocity by that dt teleports objects through walls. Measured at 30000ms for a 30s stall. | No. The cart cannot see the stall, and clamping cart-side means every cart reimplements it. |
| **Resize validation** | **Bug.** A cart writing an oversized `width`/`height` was *reported* at that size while the framebuffer was silently clamped -- the host described a frame whose pixels did not exist. | No. The corruption was in the host's own reporting. |
| **Save durability** | **Bug.** Saves were written only on a graceful quit, so Ctrl-C or an OS kill lost them. The terminal player never saved at all. | No. The host owns persistence by design. |
| **Loop inversion** (`wc_frame_yield`) | **Bug** in the web host, which stubbed the import and hung the tab on the first frame. The mechanism itself is a **necessity**: an engine that owns its main loop cannot return a frame without it. | No. Unwinding the stack requires host cooperation. |
| **Text input** (`wc_on_text`) | **Necessity.** Scancodes are key positions, not characters: `Shift+2` differs by layout and `é` has no scancode. | No. Deriving characters from scancodes means reimplementing every keyboard layout, and non-Latin input stays impossible. |
| **Optional manifest** | **Bug.** Manifest fields double-gated capabilities the cart already declared, so a mismatch silently dropped input with nothing logged. | No. |
| **Lifecycle** (`wc_on_suspend`, …) | **Mixed.** Suspension itself is host-owned and needs no cart cooperation. The callbacks are a **convenience** -- pausing audio, dropping a netplay connection, flushing a save before a backgrounded app is killed. The clock rebase they enable is a refinement over the clamp, not a replacement for it. | Partly. A cart cannot detect suspension, but it also does not have to: the host simply stops calling it. |
| **Rumble** (`wc_pad_rumble`) | **Additive.** Nothing is broken without it. Included because it is table stakes on every console, and maps 1:1 onto SDL and the W3C haptics API with no per-platform divergence. | No -- but nothing breaks in its absence either. |

Deliberately **not** added, as examples of what fails the bar: IME preedit state
(large surface, every host must plumb composition through, cart must render it)
and host-owned text fields (dictates editing behaviour and fights a cart drawing
its own UI). Both were considered and rejected.

Every entry above is optional: a cart that exports and imports none of them runs
unchanged.

---

## Manifest

**The manifest is OPTIONAL.** A cart with no `manifest.json` runs: every field
has a default, and `entry` defaults to `cart.wasm`. A host MUST NOT refuse a
cart for lacking one.

**A manifest field never gates a capability the cart declares about itself.**
The cart's `wc_info_t.flags` and its wasm import section are the ground truth,
and both are visible to the host without the packager's cooperation. Requiring
the manifest to *also* say yes creates a capability that is on in one place and
off in the other, whose failure mode is silence: the cart loads, the feature
does nothing, and no error is reported anywhere. That is the worst outcome
available, and it has now been fixed twice — once for GL detection, once for
pointer and keyboard input.

So the manifest carries only what the cart cannot state for itself:

- **Deployment policy** the packager decides, not the code — the network
  allowlist above all. A cart asserting its own permission to reach any host
  would defeat the point of having one.
- **Presentation hints** a launcher wants before instantiation, like
  `width`/`height` (see Resolution) — advisory, never binding.
- **Human metadata**: `name`, `version`.

```json
{
  "name": "Game Name",
  "version": "1.0.0",
  "abi": 3,
  "entry": "cart.wasm",
  "players": 4,
  "net": {
    "websocket": ["api.mygame.com", "leaderboard.example.com"],
  }
}
```

### Fields

**`players`** (integer, optional, default: 1)
- How many gamepad inputs the game uses (1-4)

**`pointer`** / **`keyboard`** — **REMOVED.** These were the double gate
described above: the cart set `WC_FLAG_POINTER`/`WC_FLAG_KEYBOARD` and the
manifest had to independently agree, or input was silently dropped. The flag
alone now governs. Hosts MUST ignore these fields if present in an older
manifest; carts MUST NOT rely on them.

**`debug`** (boolean, optional, default: false)
- If true, the cart exports `wc_debug_state()` naming values it chooses to expose
  to a host/harness by name (see [Debug state](#debug-state))
- If false (the default), the cart exports no debug surface and is byte-for-byte
  a non-debug cart — the debug ABI is structurally absent, not merely inert
- Debug state is read PULL-ONLY (on host demand), never per frame, so exposing
  fields costs nothing at runtime

**`net`** (object, optional)
- Omitted = no networking. Cart receives no network imports.
- If present, host provides the corresponding network imports to the cart
- Host MAY refuse to provide networking (e.g., offline device) - cart must handle gracefully

**`net.domains`** (array of strings, optional)
- Domain allowlist for peer connections addressed by URL
- Host enforces - `wc_peer_open` to an unlisted domain returns -1
- No wildcards, no raw IPs, no localhost
- `net.websocket` is the superseded spelling and is still read, so manifests
  written before the `wc_peer_*` merge keep working

This is a **permission, not a capability declaration**, which is why it lives in
the manifest rather than in `wc_info_t.flags`. Everywhere else in this ABI the
cart is the authority on what it wants (see Manifest), but a cart cannot be
trusted to grant itself network reach: that decision belongs to whoever packaged
it. So it fails closed - no manifest, or no `net` entry, means no networking.

Opening a connection requires **both** gates: the cart's `WC_FLAG_NET_PEER`
(it asked for the imports) **and** a manifest grant covering the address (it is
allowed to reach that host). Either alone is insufficient.

---

## Exports (cart provides)

```c
wc_info_t* wc_get_info(void);  // returns cart info struct
void wc_init(void);             // called once at startup
void wc_render(void);           // called every frame
```

Optional (opt-in via a flag, absent by default):

```c
wc_debug_field_t* wc_debug_state(void);  // debug:true carts only (WC_FLAG_DEBUG)
void wc_set_seed(uint32_t seed);         // deterministic carts only (WC_FLAG_DETERMINISTIC);
                                         // host calls it BEFORE wc_init on replay runs
```

---

## Imports (host provides)

```c
// Logging
void wc_log(const char* ptr, uint32_t len);

// Assets (v2+)
int32_t wc_asset_size(const char* path, uint32_t path_len);
int32_t wc_load_asset(const char* path, uint32_t path_len, void* dest, uint32_t max_size);

// Rumble (v3) - see Rumble
uint32_t wc_pad_has_rumble(uint32_t pad_id);
void wc_pad_rumble(uint32_t pad_id, float low, float high, uint32_t duration_ms);
void wc_pad_rumble_stop(uint32_t pad_id);

// GL (~100 functions, optional, imported from "gl" module)
void glClear(uint32_t mask);
// ... etc
```

**GL surface (normative):** the `gl` module is **OpenGL ES 3.0 C signatures
with WebGL2 semantics** — the same profile on every host; see
[docs/gl-surface.md](docs/gl-surface.md) for the full surface (shader
versions, texture formats, FBO/VAO rules). **GL detection:** a cart *is* a GL
cart iff its wasm import section imports from the `gl` module — the import
section is the ground truth a host can read before instantiation; the
`gpu_api` field confirms it after `wc_get_info` (a manifest field never gates
GL). Hosts SHOULD accept `glBackend` as a lazy factory (invoked once, only
for GL carts) so launchers need no advance knowledge of what they're loading.

**Hosts MUST be able to supply a GL context.** GL is part of the host
contract, not an advertised capability: a cart author writes against the
guarantee that any conformant host can run a cart importing `gl`. Most carts
never import it and no context is ever created — that is what the lazy factory
is for — but a host that cannot produce one when asked is not conformant.

A host SHOULD satisfy this itself rather than requiring its embedder to. A
browser host can always create a WebGL2 context (offscreen or on a detached
canvas); a native host links a GL provider and creates one on demand. `glBackend` then means "render
into THIS context instead of one you make" — an override for the common case
of drawing into an on-screen canvas — not the host's only source of GL.

Consequently, loading a GL cart without a usable context is a load **error**,
never a silent stub, and there is no opt-out flag. This covers BOTH a factory
that returns nothing AND no `glBackend` passed at all; the two are the same
failure. Stubbing is prohibited because it is undetectable from the cart's
side: every GL call succeeds, `load()` reports success, and the frame is
blank — indistinguishable from a broken cart.

---

## wc_info_t

```c
typedef struct {
    uint32_t version;           // 3
    uint32_t width;
    uint32_t height;
    uint32_t fb_ptr;
    uint32_t audio_ptr;
    uint32_t audio_cap;
    uint32_t audio_write_ptr;
    uint32_t input_ptr;         // → wc_pad_t[4]
    uint32_t save_ptr;
    uint32_t save_size;
    uint32_t time_ptr;
    uint32_t host_info_ptr;
    uint32_t flags;
    uint32_t audio_sample_rate;
    // v3 additions
    uint32_t pointer_ptr;       // → wc_pointer_t[10] (80 bytes), 0 = not used
    uint32_t keys_ptr;          // → uint8_t[32] key state bitmask, 0 = not used
} wc_info_t;
```

### Flags

```c
#define WC_FLAG_AUDIO_F32   0x01  // audio ring buffer uses float32
#define WC_FLAG_NET_WS      0x02  // cart wants WebSocket imports
#define WC_FLAG_NET_DC      0x04  // cart wants data channel imports
#define WC_FLAG_POINTER     0x08  // cart wants pointer input
#define WC_FLAG_KEYBOARD    0x10  // cart wants raw keyboard input
#define WC_FLAG_DEBUG       0x20  // cart exports wc_debug_state() (opt-in, default off)
#define WC_FLAG_DETERMINISTIC 0x40 // cart honors deterministic mode (opt-in, default off)
```

Host-info flags (`wc_host_info_t.flags`, written by the host BEFORE `wc_init`,
read by the cart ONCE at init — never per frame):

```c
#define WC_HOST_FLAG_DETERMINISTIC 0x01  // this run is a deterministic replay
```

---

## Text input

For name entry, chat, seeds -- anywhere the player types **characters** rather
than pressing game buttons.

The raw keyboard ABI reports HID scancodes, which are physical key positions,
not characters. `Shift+2` is `@` on a US layout and something else on many
others; `é` has no scancode at all. Rather than have every cart reimplement
keyboard layouts, the host delivers text the platform has already composed --
layout, shift, dead keys, compose sequences and IME commits all applied.

```c
// Cart export (optional)
void wc_on_text(const char* utf8, uint32_t len);

// Host imports
void wc_text_input_begin(void);
void wc_text_input_end(void);
uint32_t wc_text_input_active(void);
```

The `utf8` pointer is valid **only for the duration of the call** and is **not
null-terminated**; a cart MUST copy what it needs and MUST honour `len`. A
single call MAY carry several codepoints, since an IME commits a whole word at
once.

**Text input is off until the cart calls `wc_text_input_begin()`.** A host MUST
NOT deliver `wc_on_text` before that, and MUST stop on `wc_text_input_end()`.
A host MAY forward platform text unconditionally and let the gate drop it,
which is what makes a cart that never asks for text immune to it.

**A host MUST discard text queued but not yet delivered when the cart calls
`wc_text_input_end()`.** Otherwise what the player typed into one field
reappears in the next field they open, which reads as a ghost keystroke.

**While text input is active, a host SHOULD suppress its own key bindings and
gameplay key delivery.** Typing `q` into a name field must not quit, and `w`
must not also walk the player forward. A host that suppresses key events this
way MUST also release keys already held at the transition, or they stick down
for as long as the field is open.

On platforms with an on-screen keyboard, `wc_text_input_begin` / `end` is the
signal to raise and dismiss it.

Editing keys stay on the keyboard ABI: backspace, arrows and enter are key
presses rather than characters, so a cart drawing its own text field reads
those through `wc_kb_on_down` and appends characters from `wc_on_text`.

## Frame timing and the delta clamp

`wc_time_t.delta_ms` is the time since the last rendered frame, so **a host MUST
clamp it**. Any stall inflates it -- a GC pause, a slow disk read, a debugger
breakpoint, a throttled background tab -- and a cart integrating velocity by dt
moves a stall's worth of distance in one step, straight through whatever it
should have collided with. This is the same cap every engine applies (Unity's
`maximumDeltaTime`, Unreal's Max Physics Delta Time).

The reference hosts clamp at **250ms** (4fps): slow enough that no real frame
reaches it, fast enough that it never fires during normal play.

**A host MUST keep `time_ms` consistent with the deltas it delivered.** If
`time_ms` advanced by the full stall while `delta_ms` was clamped, a cart
summing deltas and a cart reading `time_ms` would disagree by the length of the
stall and drift apart for the rest of the session. `time_ms` MUST NOT run
backwards.

A deterministic fixed step (see Deterministic replay) is NOT clamped: a harness
setting a step is stating the delta it wants, and clamping it would silently
break reproducibility for any step above the cap.

The clamp is the general guard. Lifecycle `resume()` additionally rebases the
clock for stalls the host *knows* about, so a genuine suspend costs the cart no
phantom time at all -- but the clamp is what protects a cart from the stalls
nothing reports.

## Lifecycle

Four optional cart exports. A cart MAY export any subset; the host skips those
it does not find.

```c
void wc_on_suspend(void);       // host is about to STOP calling wc_render
void wc_on_resume(void);        // host is about to start calling it again
void wc_on_focus_lost(void);    // still running, no longer the active window
void wc_on_focus_gained(void);  // active window again
```

**Suspension is host-owned.** While a cart is suspended the host MUST NOT call
`wc_render()`. This is what makes the callbacks optional in practice: a cart
that exports none of them is still correct under suspension, because it is
simply not running. A cart handles lifecycle to be polite -- pause audio, drop a
netplay connection, flush state -- never to be correct.

**Suspend and focus are distinct, deliberately.** Hiding a tab or minimizing a
window suspends; alt-tabbing only moves focus, and a focused-but-not-suspended
cart keeps rendering. Conflating them means a game either cannot auto-pause on
alt-tab, or wrongly freezes when it should still be drawing.

**The host SHOULD rebase the clock across a suspend.** The delta clamp (see
Frame timing) already prevents a suspended gap from reaching the cart as a giant
time step, so this is a refinement rather than the protection: rebasing means a
*known* suspension costs the cart no phantom time at all, where the clamp alone
leaves it one clamped frame. `time_ms` MUST stay continuous either way, since it
measures time the cart has been *running*.

**Ordering is guaranteed.** Suspending emits `wc_on_focus_lost` before
`wc_on_suspend`; resuming emits `wc_on_resume` before `wc_on_focus_gained`. The
focus pair is therefore always balanced across a suspend/resume round trip, and
a cart is never left permanently unfocused. A host resuming into a background
window drops focus again explicitly afterwards.

**Transitions are idempotent.** Hosts receive duplicate visibility events
routinely, so a second `suspend()` with no intervening `resume()` MUST NOT
deliver a second callback.

A host SHOULD treat suspend as a persistence point. A backgrounded application
can be killed by the OS without ever reaching a graceful quit, so this is often
the last moment a save can be written.

## Loop inversion (`wc_frame_yield`)

Engines ported from native code usually own their main loop: they call
`while (running) { ... }` internally and never return. The wasmcart contract is
the opposite -- the host calls `wc_render()` once per frame and expects it back.

`wc_frame_yield` bridges the two. The cart is post-processed with binaryen's
asyncify pass (`asyncify-imports=env.wc_frame_yield`) and calls the import once
per iteration of its own loop. The host unwinds the entire engine stack out of
`wc_render()`, and on the next `runFrame()` rewinds back to exactly that point.
From the engine's perspective its loop never stopped; from the host's, every
frame returned.

A cart using it MUST export `wc_yield_buffer()`, returning a pointer to a
pre-initialized asyncify stack descriptor (a `{current, end}` pair followed by
the stack area), plus the four `asyncify_*` functions the pass emits. The host
resolves the buffer once, after `wc_init()`.

**Hosts MUST provide `wc_frame_yield` explicitly, and MUST NOT satisfy it with a
generic stub.** A host that stubs unknown imports will link such a cart happily
and then hang on the first frame: the yield does nothing, so the engine's
infinite loop never unwinds and `wc_render()` never returns. Because the cart
loads successfully, this presents as a freeze with no diagnostic. A host that
stubs unknown imports at all SHOULD warn when it does so, for the same reason.

A cart that does not export the asyncify functions never triggers any of this;
the import is a no-op for it, and hosts MUST still provide it, since a wasm
module importing a function the host omits fails to instantiate outright.

## Resolution changes

A cart MAY change its resolution at runtime by writing new `width`/`height` into
its `wc_info_t`. The host re-reads both after every `wc_render()` and adopts the
new size for that frame's returned framebuffer.

**The cart MUST grow its framebuffer before enlarging its resolution.** These
fields live in cart memory, so they are untrusted input: the host MUST verify
that `fb_ptr + width * height * 4` fits within the cart's memory, and MUST
reject a change it cannot back, keeping the previous size.

Rejecting rather than clamping is normative, and the reason is that the failure
is otherwise invisible. Reading the framebuffer with a clamped view succeeds and
returns a short buffer, so a host that skips this check reports a resolution
whose pixels do not exist, and every consumer that indexes by the reported width
reads past the real data. A host MUST guarantee that the frame it reports and
the bytes it returns agree.

The size computation MUST NOT overflow: `width * height * 4` can exceed 2^32
(65536x65536 is 17GB, which wraps to 0 in 32-bit math), so a host computing it
in 32-bit integers would turn an absurd request into a small, plausible one.

A host SHOULD warn on rejection, and SHOULD do so once rather than per frame.

## Debug state

**Opt-in, default OFF.** A cart MAY expose named game state to a host or
development harness. This is the ONLY sanctioned way to read a cart's values by
name (there is no symbol table in a shipped WASM cart). It is governed by one
overriding rule:

> **The debug ABI defaults to ABSENT, not merely inert.** A cart that does not
> opt in exports no `wc_debug_state`, sets no `WC_FLAG_DEBUG`, and is
> byte-for-byte identical to a cart built before the debug ABI existed. A host
> MUST NOT execute any debug work in the per-frame path; debug state is read
> PULL-ONLY, on demand.

A `debug:true` cart sets `WC_FLAG_DEBUG` in `wc_info_t.flags` and exports
`wc_debug_state()` returning a pointer to a NUL-terminated array of
`wc_debug_field_t`:

```c
typedef struct {
    uint32_t name_ptr;   // → NUL-terminated field name ("player_x")
    uint32_t value_ptr;  // → the value in cart memory
    uint8_t  type;       // WC_DBG_* (see below)
    uint8_t  _pad[3];
    uint32_t len;        // element count: scalar=1, array>1, bytes=length
} wc_debug_field_t;      // 16 bytes; array ends at the first name_ptr == 0

#define WC_DBG_U8 0  #define WC_DBG_I8 1  #define WC_DBG_U16 2  #define WC_DBG_I16 3
#define WC_DBG_U32 4 #define WC_DBG_I32 5 #define WC_DBG_F32 6  #define WC_DBG_F64 7
#define WC_DBG_BYTES 8
```

The host reads this table only when a debug consumer asks (e.g. "read
`player_x`"), resolves the name to `value_ptr` + `type`, and reads/writes the
value in cart memory. The cart author names only the handful of values worth
watching — this is opt-in and author-controlled, not a heap dump.

The `wc_cart.h` SDK provides `WC_DEBUG_FIELDS(...)` (with `WC_DBG` / `WC_DBG_ARR`)
to emit the table + export in one line, kept SEPARATE from the base `WC_CART`
boilerplate so a non-debug cart pulls in none of it.

### Debug events (frame annotations + captured log)

**Opt-in, default OFF.** A debug-capable cart MAY import:

```c
void wc_debug_mark(uint32_t id);  // import "env"."wc_debug_mark"
```

A call stamps an annotation (`{frame, id}`) into the host's event trace —
"level loaded", "boss spawned" — so a run or replay is navigable by event.
Debug-capable hosts additionally capture `wc_log()` lines into the same trace
(`{frame, text}`); `wc_log` remains the one logging import, there is no
separate debug-log call. Capture is PULL-drained by the consumer, capped, and
costs nothing per frame on the host side.

An UNCALLED import is not emitted into the WASM binary, so declaring
`wc_debug_mark` in a header keeps a cart with no call sites byte-identical
(governing rule upheld). Play-only hosts MUST still instantiate carts that DO
call it — provide a no-op stub. The intent remains zero call sites in a
shipped build (keep marks behind your own debug `#ifdef`).

---

## Deterministic replay

**Opt-in, default OFF — and legitimately NOT universal.** By default a cart
runs on wall-clock time and whatever entropy it chooses; nothing changes. A
cart that sets `WC_FLAG_DETERMINISTIC` declares a contract:

- its RNG is seeded ONLY by the host, via a new optional export
  `void wc_set_seed(uint32_t seed)`, which a host calls after instantiation and
  BEFORE `wc_init` on deterministic runs;
- all timing comes from `wc_time_t` (no other clock reads);
- it performs no other nondeterministic host calls during a deterministic run.

The host signals a deterministic run by setting `WC_HOST_FLAG_DETERMINISTIC`
in host-info flags (written before `wc_init`) and driving a fixed virtual
clock (`setFixedStep`). Everything is selected ONCE at init: neither side
checks a determinism flag in the per-frame path.

**Guarantee:** same seed + same input script + fixed step → an identical frame
sequence. This is what makes golden frame-hash regression testing airtight
instead of flaky.

**Scale honesty (normative):** large or engine-built carts (threading, GPU
driver variance, float ordering, asset-load timing) often CANNOT honestly
promise bit-reproducibility. Such carts simply never set the flag, and that is
a first-class, supported case — a harness MUST NOT assume replay works for an
arbitrary cart, and SHOULD fall back to named debug-state checkpoints (see
Debug state), which work at any size. A host MAY still call `wc_set_seed` only
when the flag is set; a cart without the export is seeded by nobody and runs
as normal.

The `wc_cart.h` SDK provides `WC_DETERMINISTIC_RNG` (xorshift32 +
`wc_set_seed` export + `wc_rand()`/`wc_rand_range(n)`), kept SEPARATE from the
base boilerplate so a non-deterministic cart emits none of it. Pair it with
`WC_FILL_INFO(WC_FLAG_DETERMINISTIC)`.

---

## Peer Connection

The **only** networking primitive. A cart opens connections to peers, sends and
receives bytes, and is told when a connection opens or closes. That is the whole
surface.

Opt-in by setting `WC_FLAG_NET_PEER` in `wc_info_t.flags` **and** having the
packager grant the relevant transport class in the manifest `net` object.
Networking is the one capability where both are required (see Manifest).

### The transport is opaque

A connection may be a WebSocket to a server, a WebRTC data channel, direct TCP,
a relay, MQTT, or a serial cable — whatever the host implements. **The cart
cannot tell and MUST NOT care.** This is what makes a cart portable: the same
binary runs on a host with a matchmaking service and on a host where the player
types an IP address.

**There is no client/server split in the ABI.** Which end dialed which is a
host-side fact. Both ends simply have connections. A cart may of course *behave*
as a server or a client — that is game logic, expressed in the messages it sends
— and may hold as many connections as it chooses to accept.

### Addressing

`wc_peer_open` takes a string that **the host interprets**. This spec
deliberately does not define its grammar. Depending on the host, valid addresses
might look like `wss://game.example.com/lobby`, `room:ABCD`, `192.168.1.7:9000`,
or `serial:/dev/ttyUSB0`. A host that does not understand an address, or whose
manifest grant does not cover that address's transport class, fails the open.

### Cart imports (calls into host)

```c
// Open a connection. addr is host-interpreted; see Addressing.
// Returns a connection ID (>= 0), or -1 on failure.
int32_t wc_peer_open(const char* addr, uint32_t addr_len);

// Close a connection.
void wc_peer_close(int32_t peer_id);

// Send binary data to one peer. Returns bytes sent, or -1 on error.
int32_t wc_peer_send(int32_t peer_id, const void* data, uint32_t len);

// Send binary data to every connected peer. Returns peer count, or -1 on error.
int32_t wc_peer_broadcast(const void* data, uint32_t len);

// Connection state: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
int32_t wc_peer_state(int32_t peer_id);

// Number of currently connected peers.
int32_t wc_peer_count(void);

// Connection ID at an index (0 to peer_count-1), or -1 if out of range.
// Lets a cart enumerate peers without tracking on_connect events.
int32_t wc_peer_id(uint32_t index);

// Write the peer's display name (null-terminated) into dest.
// Returns bytes written, or -1 if peer_id is unknown.
int32_t wc_peer_name(int32_t peer_id, char* dest, uint32_t max_len);

// OPTIONAL. Transport properties as a bitmask, or 0 (WC_TRANSPORT_UNKNOWN).
int32_t wc_peer_transport(int32_t peer_id);
```

### Cart exports (host calls into cart - all optional)

```c
void wc_peer_on_connect(int32_t peer_id, const char* name, uint32_t name_len);
void wc_peer_on_message(int32_t peer_id, const void* data, uint32_t len);
void wc_peer_on_disconnect(int32_t peer_id);
void wc_peer_on_error(int32_t peer_id);
```

### Identity: the id is the handle, the name is display-only

Two things identify a peer, and they are **not** interchangeable:

- **`peer_id`** — a small integer, stable for the session, assigned by the host.
  This is the handle. Key player tables on it; pass it to send.
- **name** — a display string the host supplies: a username, a room nickname, an
  OS account name, whatever identity the host has.

**Normative:** a cart MUST NOT assume names are unique, stable across sessions,
or trustworthy. A host with real accounts may guarantee all three; a host that
prompts for a nickname guarantees none. Names arrive from remote machines and
are therefore attacker-controlled text: bound the length, do not assume valid
UTF-8, and never use a name as a key for anything that matters.

### Transport properties (optional both ways)

Most carts never ask. `wc_peer_transport` exists for the narrow case of a cart
doing tight per-frame synchronization that must know whether delivery is
reliable, or whether it is running over something with inherent latency, before
assuming it can.

```c
#define WC_TRANSPORT_UNKNOWN     0x00  // host does not characterize it
#define WC_TRANSPORT_RELIABLE    0x01  // delivery guaranteed
#define WC_TRANSPORT_ORDERED     0x02  // messages arrive in send order
#define WC_TRANSPORT_LOW_LATENCY 0x04  // suitable for per-frame traffic
```

It is optional in **both** directions: optional for the cart to call, and
optional for the host to answer. A host that does not characterize its transport
returns `WC_TRANSPORT_UNKNOWN`, and carts MUST handle that — treat it as
"assume nothing", not "assume the worst" or "assume reliable".

Deliberately *properties*, not a transport name: a name invites carts to write
`if (transport == "webrtc")`, re-coupling them to the implementations this
design exists to hide.

### Notes

- **Binary only** — games serialize their own protocols. There is no text-frame
  variant: text frames are meaningful for WebSocket and meaningless for a serial
  cable or raw TCP, so framing belongs to the cart.
- Host buffers events and delivers them before each `wc_render()` call
- Cart exports are optional - if missing, the cart can still poll via
  `wc_peer_count()` / `wc_peer_id()` / `wc_peer_state()`
- Connection IDs are small integers managed by the host (0, 1, 2, ...)
- `data` / `name` pointers in callbacks are temporary - the cart MUST copy what
  it needs before returning
- Delivery semantics are host-defined; query `wc_peer_transport()` if it matters

### Out of scope, deliberately

**Auth and matchmaking are host territory.** They govern *how a connection comes
to exist*; the cart's world begins once one exists and has an id and a name. A
host may do accounts, signed tokens, lobbies, room codes, LAN discovery, QR
codes, or nothing. None of it changes a line of cart code — and a cart that
never participates in authentication cannot leak a credential or be tricked into
trusting an identity.

**Custom game attributes are cart-layer data.** Character select, team, colour,
ready state, protocol version: a cart sends these itself as its first message
after connect, in its own format. The host MUST NOT parse cart traffic.

**Rollback netplay is not a wasmcart feature.** A cart's state is its whole
linear memory, which is orders of magnitude too large to snapshot per frame. A
cart wanting rollback implements it internally over ordinary peer connections,
rolling back only the state it knows matters. See
[docs/networking.md](docs/networking.md).

---

## Pointer Input

Unified mouse + touch. Opt-in by setting `WC_FLAG_POINTER` in `wc_info_t.flags`. Both shared-memory state and event callbacks. **The flag is the only gate** — a manifest field never gates a capability the cart declares about itself (see Manifest below).

### Shared memory (host writes every frame)

```c
typedef struct {
    int16_t  x;        // cart-space coordinates (0 to width-1)
    int16_t  y;        // cart-space coordinates (0 to height-1)
    uint8_t  buttons;  // bitmask: bit0=primary, bit1=secondary, bit2=middle
    uint8_t  active;   // 1 if this pointer exists
    uint8_t  _pad[2];
} wc_pointer_t;        // 8 bytes

// 10 pointer slots, 80 bytes total
// Cart sets wc_info_t.pointer_ptr to a wc_pointer_t[10] buffer
```

### Cart exports (host calls into cart - all optional)

```c
void wc_ptr_on_down(uint32_t id, int16_t x, int16_t y, uint8_t button);
void wc_ptr_on_move(uint32_t id, int16_t x, int16_t y);
void wc_ptr_on_up(uint32_t id, uint8_t button);
```

### Notes
- Host normalizes screen coordinates to cart resolution
- Mouse = pointer 0 (always active when cursor is over window)
- Touch = each finger gets the next available slot, active only while touching, buttons=0x01
- If device has both mouse and touch, they coexist - mouse is 0, fingers fill 1+
- `button` param: 0=primary (left click / touch), 1=secondary (right click), 2=middle
- State array is always up to date regardless of whether cart exports callbacks
- Host delivers events before `wc_render()`

---

## Rumble

Rumble runs the opposite way to the rest of input: the cart drives it, so it is a
set of host **imports** rather than a field in `wc_pad_t`. There is no flag to set
and no manifest entry - a cart just calls it. Hosts always provide the imports;
where there is no hardware they are silent no-ops.

```c
#define WC_RUMBLE_MAX_MS 5000

unsigned int wc_pad_has_rumble(unsigned int pad_id);
void wc_pad_rumble(unsigned int pad_id, float low, float high,
                   unsigned int duration_ms);
void wc_pad_rumble_stop(unsigned int pad_id);
```

`low` drives the low-frequency ("strong") motor, `high` the high-frequency
("weak") one, both `0.0 .. 1.0`. These map directly onto SDL's
`SDL_GameControllerRumble` and the W3C `dual-rumble` effect
(`strongMagnitude` / `weakMagnitude`), so the same call behaves the same way in a
native window and in a browser.

### Notes

- **Capability is per-device, not per-platform.** Ask `wc_pad_has_rumble()` rather
  than assuming: an Xbox 360 pad reports rumble but not trigger rumble, and a
  keyboard-only setup reports none. A cart may skip the query - calls on a pad
  without rumble are silent no-ops - but then it cannot offer the player a toggle.
- **Out-of-range values are clamped, not rejected.** Magnitudes outside `0..1` clamp
  into range (`NaN` becomes `0`) and `duration_ms` caps at `WC_RUMBLE_MAX_MS`. A cart
  deriving intensity from game state will overshoot at the edges, and a dropped
  rumble is harder to diagnose than a saturated one.
- **Effects stop on the host's timer.** The duration cap means a cart cannot pin the
  motors indefinitely, and a cart that crashes mid-effect still leaves the controller
  quiet. Sustained rumble is done by re-arming each frame, which also stops rumble
  when the cart stops.
- **Invalid pad slots are ignored.** `pad_id >= 4` never reaches the device.
- Rumble does not widen the security boundary: it is write-only to hardware the host
  already owns, and carries no data back to the cart beyond the capability bit.

## Keyboard Input

Opt-in by setting `WC_FLAG_KEYBOARD` in `wc_info_t.flags`. Both shared-memory state and event callbacks. **The flag is the only gate** (see Manifest below).

### Shared memory (host writes every frame)

```c
// 256-bit bitmask - one bit per keycode
// Cart sets wc_info_t.keys_ptr to a uint8_t[32] buffer
uint8_t wc_keys[32];  // 32 bytes

// Test if key is down:
// wc_keys[keycode >> 3] & (1 << (keycode & 7))
```

### Cart exports (host calls into cart - all optional)

```c
void wc_kb_on_down(uint8_t keycode, uint8_t modifiers);
void wc_kb_on_up(uint8_t keycode, uint8_t modifiers);
```

### Modifier bitmask

```c
#define WC_MOD_SHIFT  0x01
#define WC_MOD_CTRL   0x02
#define WC_MOD_ALT    0x04
#define WC_MOD_META   0x08
```

### Keycodes (USB HID scancodes)

```c
// Letters (0x04–0x1D)
#define WC_KEY_A  0x04
#define WC_KEY_B  0x05
#define WC_KEY_C  0x06
#define WC_KEY_D  0x07
#define WC_KEY_E  0x08
#define WC_KEY_F  0x09
#define WC_KEY_G  0x0A
#define WC_KEY_H  0x0B
#define WC_KEY_I  0x0C
#define WC_KEY_J  0x0D
#define WC_KEY_K  0x0E
#define WC_KEY_L  0x0F
#define WC_KEY_M  0x10
#define WC_KEY_N  0x11
#define WC_KEY_O  0x12
#define WC_KEY_P  0x13
#define WC_KEY_Q  0x14
#define WC_KEY_R  0x15
#define WC_KEY_S  0x16
#define WC_KEY_T  0x17
#define WC_KEY_U  0x18
#define WC_KEY_V  0x19
#define WC_KEY_W  0x1A
#define WC_KEY_X  0x1B
#define WC_KEY_Y  0x1C
#define WC_KEY_Z  0x1D

// Numbers (0x1E–0x27)
#define WC_KEY_1  0x1E
#define WC_KEY_2  0x1F
#define WC_KEY_3  0x20
#define WC_KEY_4  0x21
#define WC_KEY_5  0x22
#define WC_KEY_6  0x23
#define WC_KEY_7  0x24
#define WC_KEY_8  0x25
#define WC_KEY_9  0x26
#define WC_KEY_0  0x27

// Common keys
#define WC_KEY_ENTER      0x28
#define WC_KEY_ESCAPE     0x29
#define WC_KEY_BACKSPACE  0x2A
#define WC_KEY_TAB        0x2B
#define WC_KEY_SPACE      0x2C

// Punctuation
#define WC_KEY_MINUS      0x2D
#define WC_KEY_EQUAL      0x2E
#define WC_KEY_LBRACKET   0x2F
#define WC_KEY_RBRACKET   0x30
#define WC_KEY_BACKSLASH  0x31
#define WC_KEY_SEMICOLON  0x33
#define WC_KEY_QUOTE      0x34
#define WC_KEY_GRAVE      0x35
#define WC_KEY_COMMA      0x36
#define WC_KEY_PERIOD     0x37
#define WC_KEY_SLASH      0x38

// Function keys (0x3A–0x45)
#define WC_KEY_F1   0x3A
#define WC_KEY_F2   0x3B
#define WC_KEY_F3   0x3C
#define WC_KEY_F4   0x3D
#define WC_KEY_F5   0x3E
#define WC_KEY_F6   0x3F
#define WC_KEY_F7   0x40
#define WC_KEY_F8   0x41
#define WC_KEY_F9   0x42
#define WC_KEY_F10  0x43
#define WC_KEY_F11  0x44
#define WC_KEY_F12  0x45

// Navigation
#define WC_KEY_INSERT     0x49
#define WC_KEY_HOME       0x4A
#define WC_KEY_PAGEUP     0x4B
#define WC_KEY_DELETE     0x4C
#define WC_KEY_END        0x4D
#define WC_KEY_PAGEDOWN   0x4E

// Arrows
#define WC_KEY_RIGHT      0x4F
#define WC_KEY_LEFT       0x50
#define WC_KEY_DOWN       0x51
#define WC_KEY_UP         0x52

// Numpad
#define WC_KEY_NUMLOCK    0x53
#define WC_KEY_KP_DIVIDE  0x54
#define WC_KEY_KP_MULTIPLY 0x55
#define WC_KEY_KP_MINUS   0x56
#define WC_KEY_KP_PLUS    0x57
#define WC_KEY_KP_ENTER   0x58
#define WC_KEY_KP_1       0x59
#define WC_KEY_KP_2       0x5A
#define WC_KEY_KP_3       0x5B
#define WC_KEY_KP_4       0x5C
#define WC_KEY_KP_5       0x5D
#define WC_KEY_KP_6       0x5E
#define WC_KEY_KP_7       0x5F
#define WC_KEY_KP_8       0x60
#define WC_KEY_KP_9       0x61
#define WC_KEY_KP_0       0x62
#define WC_KEY_KP_PERIOD  0x63

// Modifiers (0xE0–0xE7)
#define WC_KEY_LCTRL   0xE0
#define WC_KEY_LSHIFT  0xE1
#define WC_KEY_LALT    0xE2
#define WC_KEY_LMETA   0xE3
#define WC_KEY_RCTRL   0xE4
#define WC_KEY_RSHIFT  0xE5
#define WC_KEY_RALT    0xE6
#define WC_KEY_RMETA   0xE7
```

All keycodes follow USB HID Usage Tables. SDL provides these natively. Browser `KeyboardEvent.code` requires a static lookup table to convert (well-documented 1:1 mapping).

### Notes
- Host delivers events before `wc_render()`
- State bitmask is always up to date regardless of whether cart exports callbacks
- When the cart sets `WC_FLAG_KEYBOARD`, the host does not map keyboard keys to gamepad

---

## Security Model

A cart is a plain WebAssembly module with **no ambient authority**. It has no
syscalls, no filesystem, no network, no clock beyond what the host hands it, and no
way to reach anything outside its own module memory except through the imports the
host provides. Everything a cart can touch is mediated by the host and validated
before it acts. This is what makes running an untrusted cart safe.

This is the guarantee game consoles had and general-purpose computers gave up. A
console cartridge could only do what the console's hardware let it do; a modern
game you download is arbitrary code running with your full user privileges, free to
read your home directory or open a socket. A `.wasc` is a cartridge again: the
security boundary is the import table, and the import table is a closed set.

### The import table is the whole attack surface

A cart can only call what the host passes it. There is no dynamic linking, no
`dlopen`, no eval, and no way to obtain a function the host did not hand over.
Auditing a wasmcart host therefore means auditing one list, and that list is short:

- **Cart services** - `wc_log`, `wc_debug_mark`, `wc_frame_yield`, `wc_pad_name`,
  `wc_pad_has_rumble`, `wc_pad_rumble`, `wc_pad_rumble_stop`
- **Assets (read-only, path-validated)** - `wc_asset_size`, `wc_load_asset`
- **Network (opt-in, allowlisted)** - the `wc_peer_*` family
- **Toolchain shims** - a small set of emscripten/WASI symbols that compilers emit
  unconditionally

The toolchain shims are the subtle part, because their *names* imply capabilities
the host does not actually grant. They are deliberately inert:

| Symbol | Behaviour | Consequence |
|--------|-----------|-------------|
| `path_open`, `fd_prestat_*` | **not provided at all** | a cart has no way to *name* a host file |
| `fd_read`, `fd_seek` | return `0` | no input, no seeking |
| `fd_write` | routed to the host log | stdout/stderr become log lines, never files |
| `environ_get`, `environ_sizes_get` | return `0` | no environment variables |
| `__syscall_getcwd` | returns `-1` | no filesystem position |
| `proc_exit` | no-op | a cart cannot terminate the host |

The absence of `path_open` is the load-bearing one. Filesystem sandboxes usually
work by permitting `open()` and then filtering the path, which fails whenever the
filter and the OS disagree about what a path means. Here the operation does not
exist, so there is no filter to outwit.

### Threads

Threaded carts are supported (`wasi.thread-spawn` plus a shared `WebAssembly.Memory`),
and they do not widen the boundary. Spawned threads run the *same* module with the
*same* import table, so a worker thread has exactly the authority the main thread
has. A cart that imports `thread-spawn` must also export `wasi_thread_start`; the
host rejects the mismatched pair rather than instantiating a module it cannot drive.

### What a malicious cart can still do

Being honest about the limits matters as much as the guarantees. Within its
sandbox a cart may:

- **Burn CPU or hang.** Nothing in the ABI bounds how long `wc_render()` runs. A
  host that needs to stay responsive must enforce its own timeout.
- **Exhaust memory,** up to the `maximum` its module declares.
- **Render or play anything,** including hostile visuals or audio.
- **Talk to allowlisted hosts,** if the packager declared any, and exfiltrate
  whatever it can reach - which is only its own state, since it can read nothing else.

What it cannot do is reach *outside* itself: no host files, no unlisted hosts, no
environment, no other processes, no persistence the host did not choose to write.

### Filesystem and assets

Carts have **no filesystem access.** There is no `open`, `read`, `write`, `stat`,
directory listing, or any path-based I/O available to a cart - those imports simply
do not exist.

The only files a cart can read are **its own bundled assets**, and only through the
asset API:

- `wc_asset_size(path, len)` and `wc_load_asset(path, len, dest, maxSize)` resolve
  paths **against the cart's own asset bundle only** (the `assets/` entries inside
  its `.wasc`, or the dev-mode directory). A cart cannot name a file outside that
  scope.
- The host **validates every requested path** and rejects: absolute paths (`/...`,
  `\...`), Windows drive letters (`C:`), parent-directory traversal (`..`), null
  bytes, and backslashes. A rejected or unknown path returns `-1`; there is no way
  for it to resolve to a host file.
- A cart therefore cannot read the user's files, other carts' assets, or anything
  on the host - its entire readable world is the assets it shipped with.

### Saving is host-managed

Carts do **not** write files to save progress. Persistence is entirely the host's
responsibility, through a fixed shared-memory region:

- The cart declares a save region via `wc_info_t.save_ptr` / `save_size` (a plain
  byte blob in the cart's own memory).
- **The host owns storage.** Before `wc_init()`, the host loads any existing save
  bytes into that region so the cart can read them at startup. After a frame (or on
  demand), the host reads the region back and persists it however it sees fit
  (a file, browser storage, a libretro SRAM/save-state, a database - the cart never
  knows or cares).
- The cart never chooses *where* or *whether* data is stored; it only reads and
  writes its own in-memory save blob. This keeps saving safe (no filesystem write
  authority) and portable (the same cart saves correctly on every host).

Because the host owns persistence, the host also owns **durability**. A host that
persists saves SHOULD do so on every ordinary exit path, not only a graceful one:
Ctrl-C (`SIGINT`) and `kill` (`SIGTERM`) are normal ways to stop a game, and a
save that survives only a clean shutdown will lose player progress in practice.

A host writing an all-zero save region SHOULD distinguish two cases that look
identical byte-for-byte: a cart that has *never* saved (skip the write, so a
`.sav` is not created merely by running the cart) versus a player who *cleared*
their data (write it, or the previous save silently resurrects on next load).

### Networking

1. **No networking by default** - omit `net` from manifest = zero network access
2. **Domain allowlist** - WebSocket connections only to declared domains
3. **No raw sockets** - no TCP, no UDP, no localhost, no IP addresses
4. **Host enforces** - cart can't bypass; imports validate before acting
5. **Graceful degradation** - offline hosts provide stub imports returning -1
6. **Data channels are host-managed** - cart can't initiate peer connections
7. **No DNS resolution** - cart can't enumerate network

### Summary

| Capability | Cart access |
|------------|-------------|
| Host filesystem | none |
| Own bundled assets | read-only, path-validated, via `wc_load_asset` |
| Save data | in-memory blob only; host owns persistence |
| Network | none unless declared in the manifest (allowlisted WebSocket / data channels) |
| Syscalls / clock / RNG | none except what the host explicitly imports |
| Environment / cwd / process control | none (`environ_*` return 0, `proc_exit` is a no-op) |
| Threads | supported, and confined to the same import table as the main thread |
| CPU / memory | **not** bounded by the ABI - the host must impose its own limits |

