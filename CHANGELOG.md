# Changelog

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
