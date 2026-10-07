# WebGPU carts with wasi-sdk

wasmcart's WebGPU tier (SPEC.md, "WebGPU") is defined by the imports Dawn's
emdawnwebgpu port produces. An Emscripten build gets them by linking the port.
A **wasi-sdk** build gets the same imports, and so runs on the same hosts with
no host changes, by compiling the port's C++ half itself plus the few things an
Emscripten link would otherwise supply:

| File | What it is |
| --- | --- |
| `include/emscripten/emscripten.h` | Stand-in for the one Emscripten function the port uses (`emscripten_has_asyncify`, a host import). |
| `emwgpu_wasi.c` | `memalign` (declared but not defined by wasi-libc) and Emscripten's three stack helpers, which the host's glue calls back into. |
| `exports.txt` | The functions the cart must export for the glue. Generated with the glue (`scripts/build-wgpu-glue.mjs`), so it cannot drift. |
| `imports.txt` | Every function the kit lets a cart import from `env` (the glue's, plus `emscripten_has_asyncify`). Generated the same way. See "Auditing imports". |
| `wasmcart-wgpu-wasi.cmake` | `wasmcart_wgpu_wasi(target EMDAWNWEBGPU_PKG <pkg>)` adds all of the above to one CMake target; `wasmcart_wgpu_wasi_library(name EMDAWNWEBGPU_PKG <pkg>)` compiles it once for many carts. |

The emdawnwebgpu package must be the release the hosts pin
(`scripts/wgpu/emdawnwebgpu.json`): its `webgpu/src/webgpu.cpp` and
`webgpu/include` are compiled into the cart.

## CMake

```cmake
include(<wasmcart>/wgpu-wasi/wasmcart-wgpu-wasi.cmake)
add_executable(mycart main.c)
set_target_properties(mycart PROPERTIES SUFFIX ".wasm")
target_link_options(mycart PRIVATE -mexec-model=reactor
  -Wl,--export=wc_get_info -Wl,--export=wc_init -Wl,--export=wc_render)
wasmcart_wgpu_wasi(mycart EMDAWNWEBGPU_PKG <path>/emdawnwebgpu_pkg)
```

configured with wasi-sdk's toolchain file (`wasi-sdk.cmake`, or
`wasi-sdk-pthread.cmake` for `wasm32-wasip1-threads`). Threaded carts also link
with `-Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=...`, as any
threaded wasmcart cart does. Tested with wasi-sdk 33. wasi-sdk 34's
`wasi-sdk-pthread.cmake` still targets `wasm32-wasi-threads`, whose sysroot 34
no longer ships, so its compiler cannot find `stdlib.h`; use 33's, or set the
target to `wasm32-wasip1-threads`.

### Many carts

`wasmcart_wgpu_wasi` compiles `webgpu.cpp` (about 77 KB of C++) into each
target. For a build with many carts, compile it once:

```cmake
wasmcart_wgpu_wasi_library(wcwgpu EMDAWNWEBGPU_PKG <path>/emdawnwebgpu_pkg)
foreach(cart cart_a cart_b)
  add_executable(${cart} ${cart}.c)
  set_target_properties(${cart} PROPERTIES SUFFIX ".wasm")
  target_link_options(${cart} PRIVATE -mexec-model=reactor
    -Wl,--export=wc_get_info -Wl,--export=wc_init -Wl,--export=wc_render)
  target_link_libraries(${cart} PRIVATE wcwgpu)
endforeach()
```

The library is an OBJECT library that carries the include paths, the exports
and `-Wl,--allow-undefined`, so a cart linking it needs nothing else.

## Without CMake

```sh
CC="$WASI_SDK/bin/clang --target=wasm32-wasip1-threads -pthread"
CXX="$WASI_SDK/bin/clang++ --target=wasm32-wasip1-threads -pthread"
$CXX -O2 -std=c++20 -fno-exceptions -I wgpu-wasi/include -I $PKG/webgpu/include \
  -c $PKG/webgpu/src/webgpu.cpp -o webgpu.o
$CC -O2 -I wgpu-wasi/include -I $PKG/webgpu/include -I include -c main.c -o main.o
$CC -O2 -c wgpu-wasi/emwgpu_wasi.c -o emwgpu_wasi.o
$CXX -O2 -s -mexec-model=reactor -Wl,--allow-undefined \
  $(sed 's/^/-Wl,--export=/' wgpu-wasi/exports.txt) \
  -Wl,--export=wc_get_info -Wl,--export=wc_init -Wl,--export=wc_render \
  webgpu.o main.o emwgpu_wasi.o -o cart.wasm
```

(Link with `clang++`: the port is C++ and needs libc++. Add the threaded
memory flags above for a `wasm32-wasip1-threads` cart.)

## Auditing imports

The WebGPU functions are imports the host provides, so carts link with
`-Wl,--allow-undefined`. That also turns any symbol that went missing (a
dropped source file, a typo) into a silent `env` import, which fails only at
load. Check a built cart: every `env` function import should be in
`imports.txt` or be a wasmcart host function (`wc_*`).

```js
const allowed = new Set(fs.readFileSync('wgpu-wasi/imports.txt', 'utf8').trim().split('\n'));
const stray = WebAssembly.Module.imports(new WebAssembly.Module(fs.readFileSync('cart.wasm')))
  .filter(i => i.module === 'env' && i.kind === 'function' && !allowed.has(i.name) && !i.name.startsWith('wc_'));
```

## Dual carts (GL and WebGPU in one cart)

A cart can import both `gl` and WebGPU and run on whichever the host has
(SPEC.md, "WebGPU"):

1. Set `gpu_api = 2` in `wc_get_info`.
2. In `wc_init`, read `WC_HOST_FLAG_GPU_WGPU` from host-info `flags`: set
   means the host selected WebGPU, clear means GL.
3. From then on call only the selected API. The other one's imports are bound
   to functions that throw, naming the call.

`test/fixtures/dualgpu.c` is a complete small example.

## Threads

WebGPU calls are made from the main thread only (`wc_init`, `wc_render`, and
the callbacks the host delivers between frames). Workers may do anything else,
and a worker that never calls WebGPU is unaffected by the cart importing it.

On the web host the main thread can never block: `pthread_join`, a contended
mutex or a condition-variable wait in `wc_render` traps (`Atomics.wait cannot
be called in this context`). Have the main thread poll its workers instead.
That rule is the browser's and applies to every threaded cart, WebGPU or not.

`test/fixtures/wasicart.c` is a complete example: render, compute read back
with `wgpuBufferMapAsync`, an error scope, and two workers polled through
atomic flags. It runs on the Node, browser and native hosts.
