/*
 * wgpuvram - WebGPU fixture for GPU memory over a long run (SPEC.md, "WebGPU";
 * docs/webgpu.md, "A frame loop must yield to the event loop").
 *
 * Every frame it creates, uses and releases about 1.3 MiB of GPU objects:
 *   - a 512x512 rgba8unorm texture, filled with wgpuQueueWriteTexture
 *     (1 MiB), its view and a bind group;
 *   - a 256 KiB uniform-capable buffer, written with wgpuQueueWriteBuffer;
 *   - a command encoder, a render pass and a command buffer;
 * and draws the texture over the whole 64x64 frame. Released objects are
 * freed only when the host's WebGPU implementation collects them, so on a
 * host that yields an event-loop turn between frames GPU memory levels off
 * after a few hundred frames; on one that does not, it climbs by roughly a
 * frame's allocation per frame for as long as the cart runs.
 *
 * The frame is a solid colour that steps every 64 frames through four values
 * (vram.colour says which), so a stalled host is visible too.
 *
 * Debug state (WC_FLAG_DEBUG):
 *   vram.frames   frames rendered
 *   vram.errors   validation / out-of-memory errors caught by error scopes
 *                 (checked every 256 frames; 0 expected)
 *   vram.colour   0..3, the colour index of the last frame
 *
 * Build: as wgputex.c (emcc + the pinned emdawnwebgpu port), name wgpuvram.
 */
#include <stdlib.h>
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"
#include "wc_cart.h"

#define W 64
#define H 64
#define TEX 512
#define UBUF (256 * 1024)

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

static WGPUDevice device;
static WGPUQueue queue;
static WGPUSurface surface;
static WGPURenderPipeline pipe;
static WGPUBindGroupLayout bgl;
static WGPUSampler sampler;
static uint8_t *pixels;
static uint8_t *ubytes;

static uint32_t vram_frames, vram_errors, vram_colour;
WC_DEBUG_FIELDS(
    WC_DBG("vram.frames", vram_frames, WC_DBG_U32),
    WC_DBG("vram.errors", vram_errors, WC_DBG_U32),
    WC_DBG("vram.colour", vram_colour, WC_DBG_U32)
)

static const uint8_t COLOURS[4][4] = { { 200, 40, 40, 255 }, { 40, 200, 40, 255 }, { 40, 40, 200, 255 }, { 200, 200, 40, 255 } };

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = W;
    info.height = H;
    info.gpu_api = 2;
    info.flags = WC_FLAG_DEBUG;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    return &info;
}

static WGPUStringView sv(const char *s) { WGPUStringView v = { s, strlen(s) }; return v; }

static void on_pop(WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView msg, void *a, void *b) {
    if (status == WGPUPopErrorScopeStatus_Success && type != WGPUErrorType_NoError) vram_errors++;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    device = emscripten_webgpu_get_device();
    queue = wgpuDeviceGetQueue(device);
    pixels = malloc(TEX * TEX * 4);
    ubytes = calloc(1, UBUF);

    WGPUInstance instance = wgpuCreateInstance(NULL);
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvas = {
        .chain = { .sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector }, .selector = sv("#canvas") };
    WGPUSurfaceDescriptor sd = { .nextInChain = &canvas.chain };
    surface = wgpuInstanceCreateSurface(instance, &sd);
    WGPUSurfaceCapabilities caps = { 0 };
    wgpuSurfaceGetCapabilities(surface, NULL, &caps);
    WGPUTextureFormat format = caps.formats[0];
    WGPUSurfaceConfiguration cfg = { .device = device, .format = format, .usage = WGPUTextureUsage_RenderAttachment,
        .width = W, .height = H, .alphaMode = WGPUCompositeAlphaMode_Opaque, .presentMode = WGPUPresentMode_Fifo };
    wgpuSurfaceConfigure(surface, &cfg);

    WGPUShaderSourceWGSL wgsl = { .chain = { .sType = WGPUSType_ShaderSourceWGSL }, .code = sv(
        "@group(0) @binding(0) var t: texture_2d<f32>;\n"
        "@group(0) @binding(1) var s: sampler;\n"
        "@group(0) @binding(2) var<uniform> u: vec4f;\n"
        "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
        "  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));\n"
        "  return vec4f(p[i], 0.0, 1.0);\n"
        "}\n"
        "@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {\n"
        "  return textureSampleLevel(t, s, p.xy / 64.0, 0.0) + u * 0.0;\n"
        "}\n") };
    WGPUShaderModuleDescriptor smd = { .nextInChain = &wgsl.chain };
    WGPUShaderModule sm = wgpuDeviceCreateShaderModule(device, &smd);

    WGPUBindGroupLayoutEntry le[3] = { 0 };
    le[0] = (WGPUBindGroupLayoutEntry){ .binding = 0, .visibility = WGPUShaderStage_Fragment,
        .texture = { .sampleType = WGPUTextureSampleType_Float, .viewDimension = WGPUTextureViewDimension_2D } };
    le[1] = (WGPUBindGroupLayoutEntry){ .binding = 1, .visibility = WGPUShaderStage_Fragment,
        .sampler = { .type = WGPUSamplerBindingType_Filtering } };
    le[2] = (WGPUBindGroupLayoutEntry){ .binding = 2, .visibility = WGPUShaderStage_Fragment,
        .buffer = { .type = WGPUBufferBindingType_Uniform, .minBindingSize = 16 } };
    WGPUBindGroupLayoutDescriptor bld = { .entryCount = 3, .entries = le };
    bgl = wgpuDeviceCreateBindGroupLayout(device, &bld);
    WGPUPipelineLayoutDescriptor pld = { .bindGroupLayoutCount = 1, .bindGroupLayouts = &bgl };
    WGPUPipelineLayout layout = wgpuDeviceCreatePipelineLayout(device, &pld);

    WGPUColorTargetState target = { .format = format, .writeMask = WGPUColorWriteMask_All };
    WGPUFragmentState fs = { .module = sm, .entryPoint = sv("fs"), .targetCount = 1, .targets = &target };
    WGPURenderPipelineDescriptor pd = { .layout = layout, .vertex = { .module = sm, .entryPoint = sv("vs") },
        .primitive = { .topology = WGPUPrimitiveTopology_TriangleList },
        .multisample = { .count = 1, .mask = 0xFFFFFFFF }, .fragment = &fs };
    pipe = wgpuDeviceCreateRenderPipeline(device, &pd);
    WGPUSamplerDescriptor samd = { .addressModeU = WGPUAddressMode_ClampToEdge, .addressModeV = WGPUAddressMode_ClampToEdge,
        .addressModeW = WGPUAddressMode_ClampToEdge, .magFilter = WGPUFilterMode_Nearest, .minFilter = WGPUFilterMode_Nearest,
        .mipmapFilter = WGPUMipmapFilterMode_Nearest, .lodMaxClamp = 32, .maxAnisotropy = 1 };
    sampler = wgpuDeviceCreateSampler(device, &samd);
    wgpuShaderModuleRelease(sm);
    wgpuPipelineLayoutRelease(layout);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    vram_frames++;
    int check = (vram_frames & 255) == 1;
    if (check) {
        wgpuDevicePushErrorScope(device, WGPUErrorFilter_OutOfMemory);
        wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    }
    vram_colour = (vram_frames / 64) & 3;
    for (int i = 0; i < TEX * TEX; i++) memcpy(pixels + i * 4, COLOURS[vram_colour], 4);

    /* this frame's objects, released below */
    WGPUTextureDescriptor td = { .usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst,
        .dimension = WGPUTextureDimension_2D, .size = { TEX, TEX, 1 }, .format = WGPUTextureFormat_RGBA8Unorm,
        .mipLevelCount = 1, .sampleCount = 1 };
    WGPUTexture tex = wgpuDeviceCreateTexture(device, &td);
    WGPUTexelCopyTextureInfo dst = { .texture = tex, .aspect = WGPUTextureAspect_All };
    WGPUTexelCopyBufferLayout lay = { .bytesPerRow = TEX * 4, .rowsPerImage = TEX };
    WGPUExtent3D ext = { TEX, TEX, 1 };
    wgpuQueueWriteTexture(queue, &dst, pixels, TEX * TEX * 4, &lay, &ext);
    WGPUTextureView tv = wgpuTextureCreateView(tex, NULL);

    WGPUBufferDescriptor bd = { .usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst, .size = UBUF };
    WGPUBuffer ub = wgpuDeviceCreateBuffer(device, &bd);
    ubytes[0] = (uint8_t)vram_frames;
    wgpuQueueWriteBuffer(queue, ub, 0, ubytes, UBUF);

    WGPUBindGroupEntry be[3] = { { .binding = 0, .textureView = tv }, { .binding = 1, .sampler = sampler },
                                 { .binding = 2, .buffer = ub, .size = 16 } };
    WGPUBindGroupDescriptor bgd = { .layout = bgl, .entryCount = 3, .entries = be };
    WGPUBindGroup bg = wgpuDeviceCreateBindGroup(device, &bgd);

    WGPUSurfaceTexture st = { 0 };
    wgpuSurfaceGetCurrentTexture(surface, &st);
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassColorAttachment att = { .view = view, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
        .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store, .clearValue = { 0, 0, 0, 1 } };
    WGPURenderPassDescriptor rpd = { .colorAttachmentCount = 1, .colorAttachments = &att };
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
    wgpuRenderPassEncoderSetPipeline(pass, pipe);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bg, 0, NULL);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cb);

    if (check) {
        WGPUPopErrorScopeCallbackInfo ci = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_pop };
        wgpuDevicePopErrorScope(device, ci);
        wgpuDevicePopErrorScope(device, ci);
    }
    wgpuCommandBufferRelease(cb);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(st.texture);
    wgpuBindGroupRelease(bg);
    wgpuBufferRelease(ub);
    wgpuTextureViewRelease(tv);
    wgpuTextureRelease(tex);
}
