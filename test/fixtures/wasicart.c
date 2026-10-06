/*
 * wasicart - the wgpucart fixture built with wasi-sdk (wasm32-wasip1-threads), plus
 * two pthread workers that do CPU work and never call WebGPU.
 *
 * Original: wgpucart - WebGPU fixture for the `wgpu` capability (SPEC.md, "WebGPU").
 *
 * Exercises the parts of the contract a host can get wrong:
 *   - the device is the host's (emscripten_webgpu_get_device);
 *   - frames go to the surface made from "#canvas";
 *   - an async result (a compute shader's output, read with mapAsync) reaches
 *     the cart between frames, never during one;
 *   - the cart's memory grows mid-run (frame 3 allocates 32 MB) and WebGPU
 *     calls keep working afterwards.
 *
 * What it draws (256x192):
 *   background: (0, 0, 255) until the compute result arrives, then
 *               (result, 0, 255) where result = 21 * 2 = 42 from the shader;
 *   an orange triangle in the middle: (255, 128, 64).
 *
 * Build: wasi-sdk 33, wasm32-wasip1-threads, through wgpu-wasi/wasmcart-wgpu-wasi.cmake:
 *   add_executable(wasicart test/fixtures/wasicart.c)       # SUFFIX .wasm
 *   target_link_options(wasicart PRIVATE -mexec-model=reactor -Wl,--import-memory
 *     -Wl,--shared-memory -Wl,--max-memory=268435456 -Wl,--initial-memory=33554432
 *     -Wl,-z,stack-size=1048576 -s -Wl,--export=wc_get_info -Wl,--export=wc_init
 *     -Wl,--export=wc_render)
 *   wasmcart_wgpu_wasi(wasicart EMDAWNWEBGPU_PKG <pkg>)
 *   configured with -DCMAKE_TOOLCHAIN_FILE=<wasi-sdk>/share/cmake/wasi-sdk-pthread.cmake
 *   node bin/wasmcart-pack.js --wasm wasicart.wasm --name wasicart -o test/fixtures/wasicart.wasc
 */
#include <stdlib.h>
#include <pthread.h>
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"
#include "wc_cart.h"

#define W 256
#define H 192

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

static WGPUDevice device;
static WGPUQueue queue;
static WGPUSurface surface;
static WGPURenderPipeline pipe;
static WGPUBuffer storage, readback;
static int frame;
static volatile int result = -1;       /* written by the map callback */
static volatile int mapped_during_render;
static volatile int in_render;
static char *big;

/* Two wasi-threads workers doing CPU work only (they never call WebGPU):
   each sums 1..N and stores it; the main thread checks after joining. */
#define WORK_N 1000000u
/* The main thread POLLS the workers' done flags rather than joining: a
   browser's main thread may not block (Atomics.wait traps there), so a
   threaded cart that must run on the web never waits on a worker in
   wc_render. */
static volatile uint64_t worker_sum[2];
static int worker_done[2];
static void *worker(void *arg) {
    int k = (int)(intptr_t)arg; uint64_t s = 0;
    for (uint32_t i = 1; i <= WORK_N; i++) s += i;
    worker_sum[k] = s + (uint64_t)k;
    __atomic_store_n(&worker_done[k], 1, __ATOMIC_RELEASE);
    return NULL;
}
__attribute__((export_name("wasicart_workers_ok"))) int wasicart_workers_ok(void) {
    const uint64_t want = (uint64_t)WORK_N * (WORK_N + 1) / 2;
    return __atomic_load_n(&worker_done[0], __ATOMIC_ACQUIRE) && __atomic_load_n(&worker_done[1], __ATOMIC_ACQUIRE)
        && worker_sum[0] == want && worker_sum[1] == want + 1;
}

static WGPUStringView sv(const char *s) { WGPUStringView v = { s, strlen(s) }; return v; }

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = W;
    info.height = H;
    info.gpu_api = 2;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    return &info;
}

/* Exposed so a test can see when the map callback ran. */
__attribute__((export_name("wgpucart_result"))) int wgpucart_result(void) { return result; }
__attribute__((export_name("wgpucart_mapped_during_render"))) int wgpucart_mapped_during_render(void) { return mapped_during_render; }
__attribute__((export_name("wgpucart_host_flags"))) uint32_t wgpucart_host_flags(void) { return host_info.flags; }

/* An error scope around a deliberately invalid buffer (MapRead|MapWrite is
   not a legal usage), popped on frame 2: the glue must classify the error
   with the WebGPU error classes, which a Node host has to supply. */
static volatile int scope_error = -1;   /* WGPUErrorType once popped */
__attribute__((export_name("wgpucart_scope_error"))) int wgpucart_scope_error(void) { return scope_error; }
/* The glue hands the error message over on the cart's STACK (Emscripten's
   stack helpers, which a wasi-sdk cart supplies from wgpu-wasi): a wrong
   helper shows up here as a garbled or missing message. */
static volatile int scope_msg_ok = -1;
__attribute__((export_name("wasicart_scope_msg_ok"))) int wasicart_scope_msg_ok(void) { return scope_msg_ok; }
static void on_pop(WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView msg, void *a, void *b) {
    scope_error = status == WGPUPopErrorScopeStatus_Success ? (int)type : -2;
    static const char want[] = "MapRead";
    int found = 0;
    if (msg.data && msg.length >= sizeof want - 1)
        for (size_t i = 0; i + sizeof want - 1 <= msg.length && !found; i++)
            found = memcmp(msg.data + i, want, sizeof want - 1) == 0;
    scope_msg_ok = found;
}
static void provoke_validation_error(void) {
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    WGPUBufferDescriptor bad = { .usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_MapWrite, .size = 4 };
    WGPUBuffer b = wgpuDeviceCreateBuffer(device, &bad);
    WGPUPopErrorScopeCallbackInfo info = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_pop };
    wgpuDevicePopErrorScope(device, info);
    wgpuBufferRelease(b);
}

static void on_map(WGPUMapAsyncStatus status, WGPUStringView msg, void *a, void *b) {
    if (in_render) mapped_during_render = 1;
    if (status != WGPUMapAsyncStatus_Success) { result = -2; return; }
    const uint32_t *v = (const uint32_t *)wgpuBufferGetConstMappedRange(readback, 0, 4);
    result = (int)v[0];
    wgpuBufferUnmap(readback);
}

static void run_compute(void) {
    WGPUShaderSourceWGSL src = { .chain = { .sType = WGPUSType_ShaderSourceWGSL }, .code = sv(
        "@group(0) @binding(0) var<storage, read_write> v: array<u32>;\n"
        "@compute @workgroup_size(1) fn main() { v[0] = v[0] * 2u; }\n") };
    WGPUShaderModuleDescriptor smd = { .nextInChain = &src.chain };
    WGPUShaderModule sm = wgpuDeviceCreateShaderModule(device, &smd);
    WGPUComputePipelineDescriptor cpd = { .compute = { .module = sm, .entryPoint = sv("main") } };
    WGPUComputePipeline cp = wgpuDeviceCreateComputePipeline(device, &cpd);

    WGPUBufferDescriptor sbd = { .usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst, .size = 4 };
    storage = wgpuDeviceCreateBuffer(device, &sbd);
    uint32_t seed = 21;
    wgpuQueueWriteBuffer(queue, storage, 0, &seed, 4);
    WGPUBufferDescriptor rbd = { .usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, .size = 4 };
    readback = wgpuDeviceCreateBuffer(device, &rbd);

    WGPUBindGroupEntry e = { .binding = 0, .buffer = storage, .size = 4 };
    WGPUBindGroupDescriptor bgd = { .layout = wgpuComputePipelineGetBindGroupLayout(cp, 0), .entryCount = 1, .entries = &e };
    WGPUBindGroup bg = wgpuDeviceCreateBindGroup(device, &bgd);

    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(enc, NULL);
    wgpuComputePassEncoderSetPipeline(pass, cp);
    wgpuComputePassEncoderSetBindGroup(pass, 0, bg, 0, NULL);
    wgpuComputePassEncoderDispatchWorkgroups(pass, 1, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuCommandEncoderCopyBufferToBuffer(enc, storage, 0, readback, 0, 4);
    WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cb);

    WGPUBufferMapCallbackInfo mci = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_map };
    wgpuBufferMapAsync(readback, WGPUMapMode_Read, 0, 4, mci);
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    device = emscripten_webgpu_get_device();
    queue = wgpuDeviceGetQueue(device);

    WGPUInstance instance = wgpuCreateInstance(NULL);
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvas = {
        .chain = { .sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector }, .selector = sv("#canvas") };
    WGPUSurfaceDescriptor sd = { .nextInChain = &canvas.chain };
    surface = wgpuInstanceCreateSurface(instance, &sd);
    WGPUSurfaceCapabilities caps = {0};
    wgpuSurfaceGetCapabilities(surface, NULL, &caps);
    WGPUTextureFormat format = caps.formats[0];
    WGPUSurfaceConfiguration cfg = { .device = device, .format = format, .usage = WGPUTextureUsage_RenderAttachment,
        .width = W, .height = H, .alphaMode = WGPUCompositeAlphaMode_Opaque, .presentMode = WGPUPresentMode_Fifo };
    wgpuSurfaceConfigure(surface, &cfg);

    WGPUShaderSourceWGSL wgsl = { .chain = { .sType = WGPUSType_ShaderSourceWGSL }, .code = sv(
        "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
        "  var p = array<vec2f,3>(vec2f(0.0,0.5), vec2f(-0.5,-0.5), vec2f(0.5,-0.5));\n"
        "  return vec4f(p[i], 0.0, 1.0);\n}\n"
        "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 128.0/255.0, 64.0/255.0, 1.0); }\n") };
    WGPUShaderModuleDescriptor smd = { .nextInChain = &wgsl.chain };
    WGPUShaderModule sm = wgpuDeviceCreateShaderModule(device, &smd);
    WGPUColorTargetState target = { .format = format, .writeMask = WGPUColorWriteMask_All };
    WGPUFragmentState fs = { .module = sm, .entryPoint = sv("fs"), .targetCount = 1, .targets = &target };
    WGPURenderPipelineDescriptor pd = { .vertex = { .module = sm, .entryPoint = sv("vs") },
        .primitive = { .topology = WGPUPrimitiveTopology_TriangleList },
        .multisample = { .count = 1, .mask = 0xFFFFFFFF }, .fragment = &fs };
    pipe = wgpuDeviceCreateRenderPipeline(device, &pd);

    run_compute();
    for (int k = 0; k < 2; k++) {
        pthread_t t;
        if (pthread_create(&t, NULL, worker, (void *)(intptr_t)k) == 0) pthread_detach(t);
    }
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    in_render = 1;
    frame++;
    /* Grow the cart's memory under the glue's feet: the views it holds must
       be refreshed or the following WebGPU calls read a detached buffer. */
    if (frame == 3 && !big) { big = malloc(32 << 20); if (big) memset(big, 1, 32 << 20); }
    if (frame == 2) provoke_validation_error();

    WGPUSurfaceTexture st = {0};
    wgpuSurfaceGetCurrentTexture(surface, &st);
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    double red = result >= 0 ? result / 255.0 : 0.0;
    WGPURenderPassColorAttachment att = { .view = view, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
        .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store, .clearValue = { red, 0.0, 1.0, 1.0 } };
    WGPURenderPassDescriptor rpd = { .colorAttachmentCount = 1, .colorAttachments = &att };
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
    wgpuRenderPassEncoderSetPipeline(pass, pipe);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(st.texture);
    in_render = 0;
}
