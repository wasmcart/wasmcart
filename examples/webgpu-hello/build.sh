#!/usr/bin/env bash
# Build webgpu-hello.wasc.
#   EMDAWN=<emdawnwebgpu_pkg dir> ./build.sh
# Needs: emcc (Emscripten 4.0.18 is what the test suite builds with) on PATH,
# and Dawn's emdawnwebgpu package at the release the hosts pin
# (scripts/wgpu/emdawnwebgpu.json): emdawnwebgpu_pkg-v20261002.154047.zip from
# https://github.com/google/dawn/releases/tag/v20261002.154047, unzipped.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASMCART="$HERE/../.."
: "${EMDAWN:?set EMDAWN to the unzipped emdawnwebgpu_pkg directory}"
emcc "$HERE/hello.c" -O2 -I"$WASMCART/include" \
  --use-port="$EMDAWN/emdawnwebgpu.port.py" \
  -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 --no-entry -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_FUNCTIONS=_wc_init,_wc_render,_wc_get_info \
  -o "$HERE/webgpu-hello.wasm"
node "$WASMCART/bin/wasmcart-pack.js" --wasm "$HERE/webgpu-hello.wasm" --name webgpu-hello -o "$HERE/webgpu-hello.wasc"
rm -f "$HERE/webgpu-hello.wasm"
