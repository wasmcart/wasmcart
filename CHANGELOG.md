# Changelog

## 0.8.0

**Breaking:** `allowMissingGL` is gone, and the browser host now enforces the
same rule as the Node host.

0.7.0 made "GL cart, no context" a load error but left two holes. First, it
shipped an `allowMissingGL` opt-out — which was wrong in principle: GL is part
of the host contract, not a capability a host advertises. A cart author writes
against the guarantee that any conformant host can run a cart importing `gl`;
a per-host opt-out turns that guarantee into something you discover at runtime,
as a black screen. Most carts never import `gl` and never cause a context to be
created — that is what the lazy `glBackend` factory is for — but a host that
cannot produce one when asked is not a wasmcart host.

Second, and worse, `CartHostWeb` never got 0.7.0's change at all: it still
silently stubbed. Since `web.js` is the default export for browsers, the
breaking change 0.7.0 announced did not actually apply to most consumers. The
web host had no test coverage for this, which is how it drifted; there is now
a parity test.

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
