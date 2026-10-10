/*
 * wgpurelease - WebGPU fixture: objects a cart released while something it
 * still holds uses them (docs/webgpu.md, "GPU memory"). The host destroys a
 * released texture or buffer only once nothing live uses it; each case below
 * draws black, or raises a validation error, if a host destroys too early.
 *
 * The 64x64 frame is four 32x32 quadrants, each drawn by sampling a 2x2
 * texture and adding a 16-byte uniform (colour = texture + uniform):
 *   top-left      a bind group made at wc_init, whose texture, view and
 *                 buffer were released right after it was made; kept and
 *                 drawn every frame. Red texture + blue uniform: magenta.
 *   top-right     a view made at wc_init, its texture released right after;
 *                 every frame a new bind group of that view and a new uniform
 *                 buffer, the buffer released before the draw is recorded.
 *                 Green texture + zero uniform: green.
 *   bottom-left   a render bundle recorded at wc_init, everything it uses
 *                 (texture, view, buffer, bind group, the bundle encoder)
 *                 released after it was finished; executed every frame.
 *                 Blue texture + (1,1,0) uniform: white.
 *   bottom-right  every frame a new texture, view and bind group, all three
 *                 released after the draw is recorded but BEFORE the command
 *                 buffer is finished and submitted. Yellow texture: yellow.
 * At frame RELEASE_AT the cart releases the kept bind group, view and bundle
 * too, and stops drawing those three quadrants (black from then on), so their
 * textures and buffers become unused.
 *
 * Debug state (WC_FLAG_DEBUG):
 *   rel.frames   frames rendered
 *   rel.errors   validation errors caught by an error scope around every frame
 *                (0 expected)
 *
 * Build: as wgputex.c (emcc + the pinned emdawnwebgpu port), name wgpurelease.
 */
#include <stdlib.h>
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"
#include "wc_cart.h"

#define W 64
#define H 64
#define RELEASE_AT 30

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

static WGPUDevice device;
static WGPUQueue queue;
static WGPUSurface surface;
static WGPUTextureFormat format;
static WGPURenderPipeline pipe;
static WGPUBindGroupLayout bgl;
static WGPUSampler sampler;
static WGPUBindGroup kept_group;   /* top-left */
static WGPUTextureView kept_view;  /* top-right */
static WGPURenderBundle bundle;    /* bottom-left */

static uint32_t rel_frames, rel_errors;
WC_DEBUG_FIELDS(
    WC_DBG("rel.frames", rel_frames, WC_DBG_U32),
    WC_DBG("rel.errors", rel_errors, WC_DBG_U32)
)

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
    if (status == WGPUPopErrorScopeStatus_Success && type != WGPUErrorType_NoError) rel_errors++;
}

static WGPUTexture texture(uint8_t r, uint8_t g, uint8_t b) {
    WGPUTextureDescriptor td = { .usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst,
        .dimension = WGPUTextureDimension_2D, .size = { 2, 2, 1 }, .format = WGPUTextureFormat_RGBA8Unorm,
        .mipLevelCount = 1, .sampleCount = 1 };
    WGPUTexture t = wgpuDeviceCreateTexture(device, &td);
    uint8_t px[16];
    for (int i = 0; i < 4; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; }
    WGPUTexelCopyTextureInfo dst = { .texture = t, .aspect = WGPUTextureAspect_All };
    WGPUTexelCopyBufferLayout lay = { .bytesPerRow = 8, .rowsPerImage = 2 };
    WGPUExtent3D ext = { 2, 2, 1 };
    wgpuQueueWriteTexture(queue, &dst, px, sizeof px, &lay, &ext);
    return t;
}

static WGPUBuffer uniform(float r, float g, float b) {
    WGPUBufferDescriptor bd = { .usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst, .size = 16 };
    WGPUBuffer u = wgpuDeviceCreateBuffer(device, &bd);
    float v[4] = { r, g, b, 0 };
    wgpuQueueWriteBuffer(queue, u, 0, v, sizeof v);
    return u;
}

static WGPUBindGroup group(WGPUTextureView view, WGPUBuffer u) {
    WGPUBindGroupEntry be[3] = { { .binding = 0, .textureView = view }, { .binding = 1, .sampler = sampler },
                                 { .binding = 2, .buffer = u, .size = 16 } };
    WGPUBindGroupDescriptor bgd = { .layout = bgl, .entryCount = 3, .entries = be };
    return wgpuDeviceCreateBindGroup(device, &bgd);
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
    WGPUSurfaceCapabilities caps = { 0 };
    wgpuSurfaceGetCapabilities(surface, NULL, &caps);
    format = caps.formats[0];
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
        "@fragment fn fs() -> @location(0) vec4f {\n"
        "  return vec4f(textureSampleLevel(t, s, vec2f(0.5, 0.5), 0.0).rgb + u.rgb, 1.0);\n"
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

    /* top-left: keep only the bind group */
    WGPUTexture t = texture(255, 0, 0);
    WGPUTextureView v = wgpuTextureCreateView(t, NULL);
    WGPUBuffer u = uniform(0, 0, 1);
    kept_group = group(v, u);
    wgpuTextureRelease(t);
    wgpuTextureViewRelease(v);
    wgpuBufferRelease(u);

    /* top-right: keep only the view */
    t = texture(0, 255, 0);
    kept_view = wgpuTextureCreateView(t, NULL);
    wgpuTextureRelease(t);

    /* bottom-left: keep only the bundle */
    t = texture(0, 0, 255);
    v = wgpuTextureCreateView(t, NULL);
    u = uniform(1, 1, 0);
    WGPUBindGroup g = group(v, u);
    WGPURenderBundleEncoderDescriptor rbd = { .colorFormatCount = 1, .colorFormats = &format, .sampleCount = 1 };
    WGPURenderBundleEncoder rbe = wgpuDeviceCreateRenderBundleEncoder(device, &rbd);
    wgpuRenderBundleEncoderSetPipeline(rbe, pipe);
    wgpuRenderBundleEncoderSetBindGroup(rbe, 0, g, 0, NULL);
    wgpuRenderBundleEncoderDraw(rbe, 3, 1, 0, 0);
    bundle = wgpuRenderBundleEncoderFinish(rbe, NULL);
    wgpuRenderBundleEncoderRelease(rbe);
    wgpuBindGroupRelease(g);
    wgpuTextureRelease(t);
    wgpuTextureViewRelease(v);
    wgpuBufferRelease(u);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    rel_frames++;
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    if (rel_frames == RELEASE_AT) {
        wgpuBindGroupRelease(kept_group);
        wgpuTextureViewRelease(kept_view);
        wgpuRenderBundleRelease(bundle);
        kept_group = NULL;
        kept_view = NULL;
        bundle = NULL;
    }

    WGPUSurfaceTexture st = { 0 };
    wgpuSurfaceGetCurrentTexture(surface, &st);
    WGPUTextureView target = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassColorAttachment att = { .view = target, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
        .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store, .clearValue = { 0, 0, 0, 1 } };
    WGPURenderPassDescriptor rpd = { .colorAttachmentCount = 1, .colorAttachments = &att };
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
    wgpuRenderPassEncoderSetPipeline(pass, pipe);

    if (kept_group) {
        wgpuRenderPassEncoderSetViewport(pass, 0, 0, 32, 32, 0, 1);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, kept_group, 0, NULL);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    }
    if (kept_view) {
        WGPUBuffer u = uniform(0, 0, 0);
        WGPUBindGroup g = group(kept_view, u);
        wgpuBufferRelease(u);
        wgpuRenderPassEncoderSetViewport(pass, 32, 0, 32, 32, 0, 1);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, g, 0, NULL);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuBindGroupRelease(g);
    }
    if (bundle) {
        wgpuRenderPassEncoderSetViewport(pass, 0, 32, 32, 32, 0, 1);
        wgpuRenderPassEncoderExecuteBundles(pass, 1, &bundle);
        wgpuRenderPassEncoderSetPipeline(pass, pipe);
    }
    {
        WGPUTexture t = texture(255, 255, 0);
        WGPUTextureView v = wgpuTextureCreateView(t, NULL);
        WGPUBuffer u = uniform(0, 0, 0);
        WGPUBindGroup g = group(v, u);
        wgpuRenderPassEncoderSetViewport(pass, 32, 32, 32, 32, 0, 1);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, g, 0, NULL);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuBindGroupRelease(g);
        wgpuBufferRelease(u);
        wgpuTextureViewRelease(v);
        wgpuTextureRelease(t);
    }
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, NULL);
    wgpuCommandEncoderRelease(enc);
    wgpuQueueSubmit(queue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuTextureViewRelease(target);
    wgpuTextureRelease(st.texture);

    WGPUPopErrorScopeCallbackInfo ci = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_pop };
    wgpuDevicePopErrorScope(device, ci);
}
