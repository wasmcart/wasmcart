/*
 * wgpucart - WebGPU fixture for the `wgpu` capability (SPEC.md, "WebGPU").
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
 * Build (repo-local emsdk; the emdawnwebgpu package pinned in
 * scripts/wgpu/emdawnwebgpu.json):
 *   emcc wgpucart.c -O2 -I../../include --use-port=<pkg>/emdawnwebgpu.port.py \
 *     -sSTANDALONE_WASM=1 --no-entry -sERROR_ON_UNDEFINED_SYMBOLS=0 \
 *     -sEXPORTED_FUNCTIONS=_wc_init,_wc_render,_wc_get_info -o wgpucart.wasm
 *   node ../../bin/wasmcart-pack.js --wasm wgpucart.wasm --name wgpucart -o wgpucart.wasc
 */
#include <stdlib.h>
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
static void on_pop(WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView msg, void *a, void *b) {
    scope_error = status == WGPUPopErrorScopeStatus_Success ? (int)type : -2;
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
