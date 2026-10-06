# wasmcart WebGPU for wasi-sdk carts (SPEC.md, "WebGPU"; README.md here).
#
#   include(<wasmcart>/wgpu-wasi/wasmcart-wgpu-wasi.cmake)
#   wasmcart_wgpu_wasi(mycart EMDAWNWEBGPU_PKG <path>/emdawnwebgpu_pkg)
#
# Adds Dawn's webgpu.cpp (the C++ half of emdawnwebgpu, from the SAME release
# the hosts' glue is generated from), the support this directory provides,
# the include paths, and the exports the host's glue calls back into. The
# target must be a reactor cart linked with -Wl,--allow-undefined (the WebGPU
# functions are imports the host provides).

set(_WASMCART_WGPU_WASI_DIR ${CMAKE_CURRENT_LIST_DIR})

function(wasmcart_wgpu_wasi target)
  cmake_parse_arguments(A "" "EMDAWNWEBGPU_PKG" "" ${ARGN})
  if(NOT A_EMDAWNWEBGPU_PKG OR NOT EXISTS "${A_EMDAWNWEBGPU_PKG}/webgpu/src/webgpu.cpp")
    message(FATAL_ERROR "wasmcart_wgpu_wasi(${target}): EMDAWNWEBGPU_PKG must point at an unpacked emdawnwebgpu_pkg (the release pinned in wasmcart's scripts/wgpu/emdawnwebgpu.json)")
  endif()
  target_sources(${target} PRIVATE
    ${A_EMDAWNWEBGPU_PKG}/webgpu/src/webgpu.cpp
    ${_WASMCART_WGPU_WASI_DIR}/emwgpu_wasi.c)
  target_include_directories(${target} PRIVATE
    ${_WASMCART_WGPU_WASI_DIR}/include
    ${A_EMDAWNWEBGPU_PKG}/webgpu/include)
  set_source_files_properties(${A_EMDAWNWEBGPU_PKG}/webgpu/src/webgpu.cpp
    PROPERTIES COMPILE_OPTIONS "-std=c++20;-fno-exceptions")
  file(STRINGS ${_WASMCART_WGPU_WASI_DIR}/exports.txt _exports)
  foreach(_e ${_exports})
    target_link_options(${target} PRIVATE "-Wl,--export=${_e}")
  endforeach()
  target_link_options(${target} PRIVATE -Wl,--allow-undefined)
endfunction()
