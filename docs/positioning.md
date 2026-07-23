# Positioning: ship the artifact you debugged

This doc states the project's stance on what a `.wasc` is *for*, where native
execution fits, and why the format is deliberately observable. It's the
rationale behind decisions the SPEC makes normative.

## `.wasc` is the primary deliverable

The cart you develop, test, and debug **is the file you ship**. There is no
"debug build vs release binary" seam, no per-platform compile at the end, no
"works in the harness but the shipped build differs" class of bug. One
artifact:

- runs on every conforming host (browser, Node.js, libretro, native players,
  terminal);
- carries its own manifest (capabilities declared, not discovered);
- was validated *as itself* — the bytes that passed conformance are the bytes
  players run.

Anything that would fork the artifact into "the one we test" and "the one we
ship" is treated as a design smell and kept out of the contract.

## Native execution is an optional backend, not the destination

The wasmcart org maintains native paths — `wasmcart-native-host` (wasmtime /
libnode), `wasmcart-sdl2`, `wasmcart-libretro` — for platform edges and
performance headroom. They are **escape hatches, deliberately downstream**:

- The mainline story ships the `.wasc` as-is. Most games never need a native
  backend; GPU calls already hit real hardware and WASM overhead only taxes
  the logic between frames.
- **Fidelity risk is contained to the optional path.** A backend that
  re-executes the cart differently is the only place a "ran differently than
  debugged" gap can exist — so backend parity is a *backend's* burden, proven
  against the reference hosts, never a caveat on the primary artifact.
- A game that adopts a native backend still ships the same `.wasc` alongside
  it; the cart remains the source of truth.

## Built to be observable (why the debug ABI exists)

A conventional native game is an opaque window: you can launch it and kill
it. Nothing about it can be driven, frame-stepped, or read back by tooling —
which is why testing it means a person watching a screen.

A `.wasc` is observable **by construction**: three exports, a framebuffer the
host reads back, input the host writes, audio as returned samples, a pure
`runFrame` step. On top of that base, the contract adds opt-in, default-off
depth (see SPEC.md):

- **Named debug state** (`wc_debug_state`) — read `player_x` by name, no
  symbol parser, because the author declared it.
- **Frame-stamped events** (`wc_debug_mark`, captured `wc_log`) — a run is
  navigable by the moments the cart marked.
- **Deterministic replay** (`wc_set_seed` + fixed step) — for carts that opt
  in, same seed + same input script reproduces the exact frame sequence, so a
  recorded golden is airtight.

This is what makes a `.wasc` developable by automated harnesses and test rigs
(for example, the `romdevtools` MCP harness drives carts headlessly:
run/see/hear/inspect/regress without a human at the window). The governing
rule stays absolute: **every debug affordance defaults to structurally
absent** — a cart that doesn't opt in is byte-for-byte a plain cart, and a
shipped cart pays nothing for any of this.

## The compiler boundary

The format is language-agnostic and always will be: anything that emits WASM
is a valid toolchain, and no wasmcart tool owns or wraps a compiler. Hosts and
harnesses start at the `.wasc` (or the `.wasm` handed to `wasmcart-pack`);
how it was produced is the developer's business.
