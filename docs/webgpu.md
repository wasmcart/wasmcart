# Building a WebGPU cart

The normative contract is the WebGPU section of [SPEC.md](../SPEC.md). This
page is how to produce a cart that meets it, and what each host does with it.

## Toolchain

A WebGPU cart is an Emscripten build that links Dawn's `emdawnwebgpu` port at
the release the hosts are pinned to:

| | |
| --- | --- |
| Release | `v20261002.154047` (Dawn `b1236a9bb4a47f1262bc3acb253bb1c2181e90dd`) |
| Package | `emdawnwebgpu_pkg-v20261002.154047.zip` from github.com/google/dawn/releases |
| SHA-256 | in [`scripts/wgpu/emdawnwebgpu.json`](../scripts/wgpu/emdawnwebgpu.json) |

Use the package's port file directly: the remote port built into newer
Emscripten releases follows Dawn's latest release, and a cart built against a
different release can disagree with the host about struct layouts.

```sh
emcc cart.c -O2 -I<wasmcart>/include \
  --use-port=<pkg>/emdawnwebgpu.port.py \
  -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 --no-entry \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_FUNCTIONS=_wc_init,_wc_render,_wc_get_info -o cart.wasm
npx wasmcart-pack --wasm cart.wasm --name mycart -o mycart.wasc
```

`--use-port` goes on the compile AND the link. Emscripten's old built-in
bindings (`-sUSE_WEBGPU`) are a different, incompatible import set and are
refused.

## The cart, in outline

```c
#include <webgpu/webgpu.h>
#include "wasmcart.h"

wc_info_t *wc_get_info(void) { ... info.gpu_api = 2; ... }

void wc_init(void) {
    device = emscripten_webgpu_get_device();      // the host's; synchronous
    queue = wgpuDeviceGetQueue(device);
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvas = {
        .chain = { .sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector },
        .selector = { "#canvas", WGPU_STRLEN } };
    WGPUSurfaceDescriptor sd = { .nextInChain = &canvas.chain };
    surface = wgpuInstanceCreateSurface(wgpuCreateInstance(NULL), &sd);
    // wgpuSurfaceGetCapabilities -> pick formats[0]; wgpuSurfaceConfigure at your size
}

void wc_render(void) {
    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    // ... encode, draw into st.texture, wgpuQueueSubmit ...
    // no wgpuSurfacePresent: the host presents after wc_render returns
}
```

[`test/fixtures/wgpucart.c`](../test/fixtures/wgpucart.c) is complete: render,
a compute shader read back with `wgpuBufferMapAsync`, an error scope, and
memory growth. [`test/fixtures/dualgpu.c`](../test/fixtures/dualgpu.c) is a
dual GL/WebGPU cart.

## Rules that bite

- **Never block.** Callbacks (`AllowSpontaneous` or `AllowProcessEvents`)
  arrive between frames. Kick work off in one frame, use the result in a later
  one.
- **Compatibility mode is the floor.** Hosts run you on a compatibility-mode
  device, and Dawn validates its restrictions even on a desktop GPU, so
  violations show up where you develop rather than on a handheld.
- **Set a finite `depthClearValue`.** `WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT`
  leaves it NaN, and implementations reject NaN even when the depth load op is
  `Load`.
- **Main thread only.** Workers of a threaded cart must not call WebGPU.
- **WGSL only.** Browsers accept nothing else, so neither does the tier.

## Hosts

| Host | WebGPU from | State |
| --- | --- | --- |
| `CartHost` (Node) | webgpu-node (Dawn), an optional dependency | supported |
| `CartHostWeb` (browser) | the browser's `navigator.gpu` | supported; browser support varies |
| wasmcart-native | native-dawn's `dawn.node` in its embedded Node, when built with `WASMCART_WGPU_JS_DIR` and `NATIVE_DAWN_DIR` | Linux |
| romdev | wasmcart's `CartHost` | frames and screenshots via async readback |
| wasmcart-android, wasmcart-libretro | not yet | refuse WebGPU-only carts; dual carts run on GL |

A host reads frames with `readGpuFrame()` (async, top-down RGBA) and draws them
into a window with `presentWgpuTo(context, rect)` on `getGpuDevice()`.

## Regenerating the host glue

```sh
EMCC=<emsdk>/upstream/emscripten/emcc node scripts/build-wgpu-glue.mjs
```

downloads the pinned package, checks its SHA-256, and rewrites
`src/wgpu/emdawnwebgpu-glue.mjs` and its manifest. Moving the pin is an ABI
change: carts and hosts must move together.
