# Building a WebGPU cart

The normative contract is the WebGPU section of [SPEC.md](../SPEC.md). This
page is how to build a cart that meets it, what each host does with it, and
what to watch for. Everything here was checked against the hosts in this
repo, and the C below is quoted from a cart the test suite builds and runs.

## Start from the example

[`examples/webgpu-hello/`](../examples/webgpu-hello/) is a complete cart: a
triangle that samples a 2x2 texture, about 150 lines of C.

```sh
cd examples/webgpu-hello
EMDAWN=<path>/emdawnwebgpu_pkg ./build.sh     # writes webgpu-hello.wasc
npx wasmcart webgpu-hello.wasc                # opens it in a window (Node host)
```

`test/wgpu-example.test.js` (Node) and `test/browser.test.mjs` (Chromium)
run it and check its pixels, and `test/docs-snippets.test.js` checks that
every C block on this page is quoted from it, so the example and this page
cannot drift from what the hosts do.

## Toolchain

A WebGPU cart links Dawn's `emdawnwebgpu` port **at the release the hosts are
pinned to**:

| | |
| --- | --- |
| Release | `v20261002.154047` (Dawn `b1236a9bb4a47f1262bc3acb253bb1c2181e90dd`) |
| Package | [`emdawnwebgpu_pkg-v20261002.154047.zip`](https://github.com/google/dawn/releases/tag/v20261002.154047), unzipped (it holds `emdawnwebgpu_pkg/emdawnwebgpu.port.py`) |
| SHA-256 | `6b14532b85c7f4d51154b6eeb6bd3fcf7735ad5c7cfd698d83985dd21a1c15c2` (also in [`scripts/wgpu/emdawnwebgpu.json`](../scripts/wgpu/emdawnwebgpu.json)) |
| Emscripten | 4.0.18 builds the fixtures and the example; the port, not emcc, fixes the import set |
| wasi-sdk | 33 (see [`wgpu-wasi/`](../wgpu-wasi/README.md)) |

Use the package's port file, not the `emdawnwebgpu` port built into newer
Emscripten releases: that one follows Dawn's latest release, and a cart built
against a different release can disagree with the host about struct layouts.

```sh
emcc cart.c -O2 -I<wasmcart>/include \
  --use-port=<pkg>/emdawnwebgpu.port.py \
  -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 --no-entry \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_FUNCTIONS=_wc_init,_wc_render,_wc_get_info -o cart.wasm
npx wasmcart-pack --wasm cart.wasm --name mycart -o mycart.wasc
```

`<wasmcart>/include` is the `include/` directory of this repo or of the npm
package (`node_modules/wasmcart/include`).

Including `wasmcart.h` also defines and exports `wc_alloc`/`wc_free`, which
the host's glue allocates in your cart with: adapter info, mapped ranges and
callback messages (SPEC.md, "Cart memory the host writes"). Every WebGPU cart
needs them, and the header handles it; no flag is needed. The link still
exports `malloc`, `free` and the Emscripten stack helpers (the port asks for
them); the host never uses them.

`--use-port` goes on the compile AND the link. Emscripten's old built-in
bindings (`-sUSE_WEBGPU`) are a different, incompatible import set and are
refused at load.

**wasi-sdk** works too, threads included: compile the same package's
`webgpu.cpp` into the cart with the support in [`wgpu-wasi/`](../wgpu-wasi/README.md)
(a CMake function does it, and exports `wc_alloc`/`wc_free` too). The cart then
imports exactly what an Emscripten cart does, and runs on the same hosts.

## The cart, step by step

### wc_get_info

<!-- snippet: examples/webgpu-hello/hello.c -->
```c
__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = W;              /* the frame size the host shows */
    info.height = H;
    info.gpu_api = 2;            /* WebGPU; fb_ptr stays 0 (no 2D framebuffer) */
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    return &info;
}
```

`gpu_api = 2` declares WebGPU, but the import section is what decides it: a
cart that imports WebGPU functions is a WebGPU cart. `fb_ptr` is unused; the
frame is the surface below. Point `input_ptr`, `time_ptr` and
`host_info_ptr` at your own storage: without `input_ptr` the pads are not
delivered (romdev warns about it at load).

### wc_init: the device and the surface

<!-- snippet: examples/webgpu-hello/hello.c -->
```c
    /* The device is the host's, ready now: no adapter or device request. */
    device = emscripten_webgpu_get_device();
    queue = wgpuDeviceGetQueue(device);

    /* The frame: the surface behind "#canvas". Configure it once, at your
     * size; the host presents it after every wc_render. */
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvas = {
        .chain = { .sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector },
        .selector = { "#canvas", WGPU_STRLEN } };
    WGPUSurfaceDescriptor surface_desc = { .nextInChain = &canvas.chain };
    surface = wgpuInstanceCreateSurface(wgpuCreateInstance(NULL), &surface_desc);
    WGPUSurfaceCapabilities caps = { 0 };
    wgpuSurfaceGetCapabilities(surface, NULL, &caps);   /* NULL: the host's adapter */
    WGPUTextureFormat format = caps.formats[0];
    WGPUSurfaceConfiguration config = { .device = device, .format = format,
        .usage = WGPUTextureUsage_RenderAttachment, .width = W, .height = H,
        .alphaMode = WGPUCompositeAlphaMode_Opaque, .presentMode = WGPUPresentMode_Fifo };
    wgpuSurfaceConfigure(surface, &config);
```

The host owns the GPU: `emscripten_webgpu_get_device()` returns its device,
synchronously, from `wc_init` on. The surface's format is whatever the host
reports (`bgra8unorm` on most), so build your pipeline for `caps.formats[0]`.
The surface is not a window: it is a texture the host owns, which it shows,
scales into a window or reads back after `wc_render` returns.

### Resources: a texture

<!-- snippet: examples/webgpu-hello/hello.c -->
```c
    /* A 2x2 texture, uploaded with wgpuQueueWriteTexture (no staging buffer,
     * no 256-byte row alignment: that rule is for buffer copies only). */
    static const uint8_t texels[16] = { 255, 0, 0, 255,    0, 255, 0, 255,
                                         0, 0, 255, 255,    255, 255, 255, 255 };
    WGPUTextureDescriptor tex_desc = { .label = S("hello texture"),
        .usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst,
        .dimension = WGPUTextureDimension_2D, .size = { 2, 2, 1 },
        .format = WGPUTextureFormat_RGBA8Unorm, .mipLevelCount = 1, .sampleCount = 1 };
    WGPUTexture texture = wgpuDeviceCreateTexture(device, &tex_desc);
    WGPUTexelCopyTextureInfo dst = { .texture = texture, .aspect = WGPUTextureAspect_All };
    WGPUTexelCopyBufferLayout layout = { .bytesPerRow = 2 * 4, .rowsPerImage = 2 };
    WGPUExtent3D size = { 2, 2, 1 };
    wgpuQueueWriteTexture(queue, &dst, texels, sizeof texels, &layout, &size);
```

Zero-initialised descriptors are not the WebGPU defaults: a sampler needs
`maxAnisotropy = 1` and a non-zero `lodMaxClamp`, a texture needs
`mipLevelCount = 1` and `sampleCount = 1`. The `WGPU_*_INIT` macros in
`webgpu.h` fill in the defaults if you prefer them. The example's sampler,
shader, pipeline and bind group follow in [`hello.c`](../examples/webgpu-hello/hello.c).

### wc_render: one frame

<!-- snippet: examples/webgpu-hello/hello.c -->
```c
    /* This frame's texture: fresh every frame, its old contents undefined. */
    WGPUSurfaceTexture frame = { 0 };
    wgpuSurfaceGetCurrentTexture(surface, &frame);
    WGPUTextureView view = wgpuTextureCreateView(frame.texture, NULL);

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassColorAttachment color = { .view = view,
        .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,   /* required for a 2D target */
        .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store,
        .clearValue = { 0.10, 0.10, 0.15, 1.0 } };
    WGPURenderPassDescriptor pass_desc = { .colorAttachmentCount = 1, .colorAttachments = &color };
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_desc);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, NULL);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, NULL);
    wgpuQueueSubmit(queue, 1, &commands);
    /* No wgpuSurfacePresent: the host presents after wc_render returns. */

    /* Release everything made this frame, the surface texture included. */
    wgpuCommandBufferRelease(commands);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(encoder);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(frame.texture);
```

- **`depthSlice = WGPU_DEPTH_SLICE_UNDEFINED`.** A zeroed colour attachment
  says depth slice 0, which is valid only for a 3D texture: every frame then
  fails validation and the host shows black. (The first draft of this example,
  written from the previous version of this page, did exactly that.)
- **Never call `wgpuSurfacePresent`.** The host presents.
- **Each frame's surface texture is fresh**: do not depend on last frame's
  contents (clear it, as above).
- **Release what you make each frame**, the surface texture included. See
  "GPU memory" below for why releasing is necessary but not enough.

## Rules that bite

- **Never block.** Async results (buffer maps, error scopes, work-done,
  async pipeline creation, adapter and device requests) arrive between frames,
  on the host's event loop, never inside `wc_render` or `wc_init`. Use
  `WGPUCallbackMode_AllowSpontaneous` (or `AllowProcessEvents`), start the work
  in one frame and use the result in a later one, and do not assume "the next
  frame": a software adapter can take several.
- **Compatibility mode is the floor.** Hosts run you on a compatibility-mode
  device where they can (see "Limits and features"), and Dawn validates its
  restrictions even on a desktop GPU, so violations show up where you develop.
- **Set a finite `depthClearValue`.** `WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT`
  leaves it NaN, and implementations reject NaN even when the depth load op is
  `Load`.
- **Main thread only.** Workers of a threaded cart must not call WebGPU. On
  the web host the main thread also must never block (no `pthread_join` or
  contended lock in `wc_render`): poll workers instead.
- **WGSL only.** Browsers accept nothing else, so neither does the tier.
- **Do not destroy the host's device.** Nothing stops a cart from calling
  `wgpuDeviceDestroy` on it, but every later frame then draws nothing.

## The frame loop (for host authors and embedders)

`runFrame()` is synchronous. Between frames a host must **give the event loop
a macrotask turn**, not just `await`: that is when async results reach the
cart, and when the WebGPU implementation frees objects the cart released. A
loop of `await host.runFrame()` never leaves the microtask queue; on the Node
host GPU memory then grew by about 0.9 MiB per frame without bound (measured on
a real cart). Yield after every frame, or at least every 16 frames:

```js
for (let frame = 0; running; frame++) {
  host.runFrame(pads);
  await new Promise((resolve) => setImmediate(resolve));   // Node; in a page, loop on requestAnimationFrame
}
```

The bundled hosts already do: `wasmcart-play` and a page loop per animation
frame, wasmcart-native runs its event loop every frame, and romdev yields
every 16 frames of a burst.

## GPU memory

The glue does not destroy a GPU object when the cart releases it: a cart may
release a texture right after making a view of it, or a buffer after binding
it into a bind group, and keep using the view or the group, so destroying the
object would break them. A released object is freed when the host's
JavaScript engine collects its wrapper. How soon that happens depends on the
host. Measured with [`test/fixtures/wgpuvram.c`](../test/fixtures/wgpuvram.c),
which creates and releases about 1.3 MiB of textures and buffers every frame,
yielding a task after each frame:

| Host | GPU memory over 3000 frames |
| --- | --- |
| Node (`CartHost`) | levels off at about 0.7 GiB after about 1000 frames |
| Chromium (`CartHostWeb`) | **does not level off**: about 2.5 MiB a frame, 7 GB by frame 3000 (RX 7600) |

Chromium's garbage collector does not know how much GPU memory a small
wrapper object holds, so it may not run before the GPU is full. **Make GPU
resources once and reuse them**: textures, buffers, bind groups, pipelines.
Write new contents into an existing buffer with `wgpuQueueWriteBuffer`, or
into an existing texture with `wgpuQueueWriteTexture`, instead of creating
new ones per frame. The per-frame objects the example makes (an encoder, a
pass, a command buffer, a view of the surface texture) are small; creating
textures or buffers every frame is what fills the GPU.

## Resize

The frame is the size the cart configured the surface with. To change it, call
`wgpuSurfaceConfigure` with the new width and height and write the same size
into your `wc_info_t`: the host re-reads `width`/`height` after every
`wc_render` (SPEC.md, "Resolution changes") and uses them to scale and
letterbox. [`test/fixtures/wgpuedges.c`](../test/fixtures/wgpuedges.c) does this
mid-run, and the Node and browser hosts show and read back the new size from
that frame on.

## Errors and device loss

What a cart can see today:

- **Error scopes** work on every host: `wgpuDevicePushErrorScope`, then
  `wgpuDevicePopErrorScope` with a callback, which arrives between frames.
  This is the reliable way for a cart to learn that something it did was
  invalid.
- **Uncaptured errors on the host's device** (an error outside any scope) do
  not reach the cart: `emscripten_webgpu_get_device()` hands over a device
  with no uncaptured-error callback, and there is no call to add one later.
  The host's WebGPU implementation reports them itself: the Node host prints
  them to stderr (`validation: ...`, naming the call and any labels), as does
  romdev into its server log; Chromium reports them in the page's console.
- **A device the cart requests itself** (`wgpuInstanceRequestAdapter`, then
  `wgpuAdapterRequestDevice` with `uncapturedErrorCallbackInfo` and
  `deviceLostCallbackInfo`) has both callbacks. A request the host's device
  already satisfies returns the host's device; one that asks for more
  features or limits gets a separate device, or a failure if the hardware
  cannot meet it. Rendering to the surface with a separate device is allowed:
  configure the surface with that device. On the Node host and
  wasmcart-native an uncaptured error reaches that device's callback; in
  Chromium it did not arrive within a few dozen frames in our test.
- **Losing the host's device** (a driver reset, a GPU removed) is not
  signalled to the cart: the host logs it and keeps calling `wc_render`, whose
  WebGPU calls then do nothing, and the frame stays black. There is no
  recovery path in the tier yet.

## Limits and features

The host's device is made with **no required features and default limits**,
from a **compatibility-mode** adapter (`featureLevel: "compatibility"`) where
the implementation supports one. A cart can assume the compatibility-mode
defaults, among them: `maxTextureDimension2D` 4096, `maxColorAttachments` 4,
no storage buffers or storage textures in the vertex stage, one view
dimension per texture, no cube-array views, the same blend state on every
colour attachment, and no `sample_mask`. Read the device's actual limits with
`wgpuDeviceGetLimits`. An implementation without compatibility mode (Firefox,
for one) gives a core device, whose defaults are higher (8192, 8), but a cart
must not depend on that.

To use more, ask for it (as under "A device the cart requests itself"):
request the `core-features-and-limits` feature for core WebGPU, or specific
limits or optional features (timestamp queries, `float32-filterable`, ...),
and handle the failure where the hardware lacks them.

## Carts with both APIs

A **dual cart** imports both `gl` and WebGPU, so one binary runs on hosts
without WebGPU too. Before `wc_init` the host sets `WC_HOST_FLAG_GPU_WGPU`
(`0x02`) in `wc_host_info_t.flags` if it chose WebGPU; read it once in
`wc_init` and use only that API. Calling the other API's functions throws,
naming the call. [`test/fixtures/dualgpu.c`](../test/fixtures/dualgpu.c) is a
complete one.

## Hosts

| Host | WebGPU from | Status |
| --- | --- | --- |
| `CartHost` (Node, `wasmcart`) | webgpu-node (Dawn), a dependency like webgl-node | supported. Tested on Linux: AMD RX 7600 (RADV) and lavapipe (Mesa's software Vulkan, as in CI) |
| `CartHostWeb` (browser, `wasmcart/web`): Chrome / Chromium | the browser's `navigator.gpu` | supported. Tested: Chromium on Linux, RX 7600 |
| `CartHostWeb`: Firefox | the browser's `navigator.gpu` | **not by default on Linux**: Firefox 157 on Linux has no `navigator.gpu`, so a WebGPU-only cart is refused there with the reason. With `dom.webgpu.enabled` set, the example renders correctly (Firefox 157, Linux, RX 7600). Not tested on Windows, where Firefox ships WebGPU |
| `CartHostWeb`: Safari | the browser's `navigator.gpu` | **not tested** (Safari 26 ships WebGPU; nobody has run a cart on it yet) |
| wasmcart-native | native-dawn's `dawn.node` in its embedded Node, when built with `WASMCART_WGPU_JS_DIR` and `NATIVE_DAWN_DIR` | Linux. Tested, RX 7600 |
| romdev | wasmcart's `CartHost` | frames, screenshots and debug state; yields every 16 frames of a stepped burst |
| wasmcart-android, wasmcart-libretro | built without WebGPU | refuse WebGPU-only carts with the reason; dual carts run on GL |

In Chromium on Linux, WebGPU without `--enable-features=Vulkan` (plus
`--enable-unsafe-webgpu` where WebGPU is not on by default) silently runs on
SwiftShader, a software adapter: check `getGpuAdapterInfo()` before trusting
a timing. Inside the cart, `wgpuAdapterGetInfo` carries what the WebGPU API
exposes, which is the vendor, architecture and description strings, not PCI
vendor or device ids (those read 0) or an adapter type (Unknown).

A host reads frames with `readGpuFrame()` (async, top-down RGBA) and draws them
into a window with `presentWgpuTo(context, rect)` on `getGpuDevice()`.

Which GPU: on a machine with two, `powerPreference` picks one (`'low-power'`
is the integrated GPU). Embedders pass it in `adapterOptions`; the Node hosts
(`CartHost`, wasmcart-native, romdev) also take `WASMCART_WGPU_POWER`
(`low-power` or `high-performance`) as the default. `getGpuAdapterInfo()`
reports the GPU a cart got, for callers that must assert it. This is host
configuration: the cart never sees it.

## Debugging

- **Error scopes** around the calls you suspect, popped between frames.
- **Labels.** Give textures, buffers, pipelines and shader modules a `label`:
  the implementation's messages (stderr on the Node hosts, the console in
  Chromium) name objects by it, as in `[TextureView of Texture "hello texture"]`.
- **A black frame** usually means every frame fails validation: read the
  host's stderr or console from the first message.
- **romdev** loads a WebGPU cart with `loadMedia` (its result names the
  adapter and warns about `wc_info_t` fields such as a zero `input_ptr`),
  shows frames with `frame({op:'screenshot'})`, and reads a cart's named
  values with `wasm({op:'debugState'})` (SPEC.md, "Debug state"). That is how a
  cart can report checks it made on the GPU: [`test/fixtures/wgputex.c`](../test/fixtures/wgputex.c)
  reads its own render back and publishes pass/fail bits as debug fields.

## Performance

Every WebGPU call a cart makes crosses from wasm into the host's JavaScript
glue and then into the implementation, so the number of calls per frame
matters more than in native code. What helped in practice (cartwheel's engine,
on these hosts):

- **Keep bind groups across frames.** Make one per set of resources, not one
  per draw per frame, and use dynamic offsets into one uniform buffer for
  per-draw data. Cartwheel's post passes and particles went from making 70 to
  110 bind groups a frame to none: 4.2 to 3.8 ms a frame natively, 4.3 to
  3.8 ms in Chromium.
- **Do not set state that has not changed**: skip `SetPipeline`,
  `SetBindGroup`, `SetVertexBuffer` and `SetIndexBuffer` when the same object
  is already set (hold a reference to what you track, so a freed object's
  address cannot compare equal).
- **Upload with `wgpuQueueWriteBuffer` / `wgpuQueueWriteTexture`**, not mapped
  buffers: mapped ranges are copies in cart memory anyway (wasm cannot alias
  GPU memory), and mapping is asynchronous.
- **Reuse resources** (see "GPU memory").
- **Embedders: yield between frames** (see "The frame loop").

## Known limitations

- The import set is frozen at emdawnwebgpu `v20261002.154047`; a cart built
  against another release can be refused or misread.
- No uncaptured-error or device-lost callback on the host's device, and no
  recovery from device loss (see "Errors and device loss").
- Released GPU objects are freed by garbage collection, which in Chromium can
  fall far behind (see "GPU memory").
- No blocking waits: `wgpuInstanceWaitAny` with a timeout is not supported
  (the `TimedWaitAny` instance feature is absent).
- Main thread only; workers may not call WebGPU.
- Output is not bit-identical across GPUs and backends, so a WebGPU cart
  should not rely on frame hashes for determinism (SPEC.md, "WebGPU",
  "Determinism").
- Hosts: Firefox on Linux needs a preference set, Safari is untested, and the
  Android and libretro hosts have no WebGPU yet.

## Regenerating the host glue

```sh
EMCC=<emsdk>/upstream/emscripten/emcc node scripts/build-wgpu-glue.mjs
```

downloads the pinned package, checks its SHA-256, and rewrites
`src/wgpu/emdawnwebgpu-glue.mjs` and its manifest. The script routes every
allocation the generated glue makes in cart memory (its `malloc`, `memalign`
and Emscripten stack helpers) through the cart's `wc_alloc`/`wc_free`
(`scripts/wgpu/glue-alloc.mjs`), and fails if the generated code has changed
shape so that an allocation would escape. Moving the pin is an ABI
change: carts and hosts must move together.
