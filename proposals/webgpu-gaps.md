# Proposals: WebGPU tier gaps that need a spec or behaviour change

Status: **proposals only, for monteslu's decision.** Nothing here is
implemented. docs/webgpu.md documents today's behaviour for each item; the
wording below is what SPEC.md could say if a change is approved. Measured on
2026-10-09 with test/fixtures/wgpuedges.c and wgpuvram.c (Node host, Chromium,
wasmcart-native; AMD RX 7600, Linux).

## 1. Released GPU objects in browsers (memory)

**Today.** The glue releases its handle when a cart calls `wgpu*Release`, and
never `destroy()`s (a released texture can still back a live view or bind
group). The object is freed when the JS engine collects its wrapper. With a
task yielded after every frame, a cart creating and releasing ~1.3 MiB of
textures and buffers per frame levels off at ~0.7 GiB on the Node host, but in
Chromium grows ~2.5 MiB a frame: 7 GB at frame 3000, nearly the whole card.

**Options.**
- (a) Glue: track dependents (views of a texture, bind groups naming a buffer
  or view) and call `destroy()` on a texture or buffer once the cart has
  released it and nothing live depends on it. Behaviour change in the host
  glue; no ABI change; carts that release-and-reuse stay correct.
- (b) Spec: a cart SHOULD create textures and buffers once and reuse them;
  hosts MAY destroy a released texture or buffer once nothing depends on it.
- (c) Docs only (done): tell cart authors to reuse resources.

Recommendation: (c) for 0.32, (a) after it with a test in the browser suite
(wgpuvram must plateau in Chromium).

## 2. The yield between frames (host contract)

**Today.** SPEC.md says async results arrive "between frames, on its event
loop"; it does not say a host must give the event loop a macrotask turn, and
docs/webgpu.md explains that without one, released objects are never freed
(0.9 MiB/frame growth on the Node host with `await` alone).

**Proposed SPEC text** (Asynchronous results): "A host MUST let its event
loop run a full turn (a macrotask, not only microtasks) at least every 16
frames; asynchronous results and the release of objects the cart dropped
depend on it."

## 3. Uncaptured errors and device loss on the host's device

**Today.** `emscripten_webgpu_get_device()` gives the cart the host's device
with no uncaptured-error or device-lost callback, and the frozen import set
has no call to add one. Errors outside an error scope go to the host's log
(stderr on Node, the page console in a browser). When the host's device is
lost the host logs it and keeps calling `wc_render`; every WebGPU call then
does nothing and the frame stays black. A device the cart requests itself
does get both callbacks (on Node and wasmcart-native the uncaptured error
reached the cart; in Chromium it did not arrive within ~70 frames).

**Options.**
- (a) Host: on loss of its device, stop calling `wc_render` and report a load
  error-like failure to the embedder (`host.lost`, an event), so a player can
  show "the GPU was reset" instead of black. Behaviour change; no ABI change.
- (b) ABI: an optional cart export `wc_on_gpu_lost(uint32_t reason)` the host
  calls once, after which the cart may call `emscripten_webgpu_get_device()`
  again for a new device. New export, so an ABI addition.
- (c) Glue: deliver the host device's uncaptured errors to a cart-provided
  callback (an optional export `wc_on_gpu_error(type, msg_ptr, len)`). ABI
  addition.
- (d) Spec: a cart MUST NOT destroy the host's device.

## 4. Resize

**Today.** A cart resizes by reconfiguring its surface and writing the new
size into `wc_info_t`. SPEC.md's "Resolution changes" speaks of `fb_ptr`
backing the new size, which a WebGPU cart (fb_ptr 0) does not have; the hosts
accept the change anyway (they check `width * height * 4` against the memory
above `fb_ptr`, which for 0 is all of it).

**Proposed SPEC text** (Resolution changes): "For a cart with `gpu_api` 1 or
2 the frame is the GL default framebuffer or the WebGPU surface, not
`fb_ptr`: such a cart changes size by resizing that (for WebGPU,
`wgpuSurfaceConfigure`) and writing the same size into `wc_info_t`; the
framebuffer bound check does not apply."

Also found: wasmcart-native's `--shot` never wrote a frame after a WebGPU cart
reconfigured its surface to a new size (the run had to be killed). A
wasmcart-native bug, reported here rather than fixed (not in this repo).
