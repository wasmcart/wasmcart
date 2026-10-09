#!/bin/sh
# Builds the "Cart memory the host writes" fixtures (SPEC.md) with wasi-sdk.
#   WASI_SDK=<wasi-sdk> sh test/fixtures/alloc/build.sh      (from the repo root)
set -e
: "${WASI_SDK:?set WASI_SDK to a wasi-sdk install}"
cd "$(dirname "$0")/.."
OUT=../../out/alloc-fixtures
mkdir -p "$OUT"
CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 -O2 -I../../include -I. -mexec-model=reactor -s"
build() { # name, flags...
  name=$1; shift
  $CC alloccart.c "$@" -o "$OUT/$name.wasm"
  node ../../bin/wasmcart-pack.js --wasm "$OUT/$name.wasm" --name "$name" -o "$name.wasc" >/dev/null
}
build alloc_header -DALLOC_HEADER -Wl,--export=malloc -Wl,--export=free
build alloc_count  -DALLOC_COUNT
build alloc_malloc -Wl,--export=malloc -Wl,--export=free
build alloc_none
rm -rf "$OUT"
