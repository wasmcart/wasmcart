/*
 * webgpu-hello: the smallest complete WebGPU cart, a textured triangle.
 * docs/webgpu.md walks through it; build.sh builds it; the test suite runs it
 * (test/wgpu-example.test.js) on every check.
 *
 * What it draws (320x240): a dark blue-grey background and a triangle that
 * samples a 2x2 texture (red, green / blue, white) with a nearest sampler.
 */
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"

#define W 320
#define H 240

/* The host reads wc_info_t once, before wc_init, and writes pads, time and
 * host info into the cart's memory every frame: give it somewhere to write. */
static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

static WGPUDevice device;
static WGPUQueue queue;
static WGPUSurface surface;
static WGPURenderPipeline pipeline;
static WGPUBindGroup bind_group;

static WGPUStringView S(const char *s) { return (WGPUStringView){ s, strlen(s) }; }

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

/* region: init */
__attribute__((export_name("wc_init")))
void wc_init(void) {
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
/* endregion: init */

/* region: texture */
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
    WGPUSamplerDescriptor sampler_desc = { .addressModeU = WGPUAddressMode_ClampToEdge,
        .addressModeV = WGPUAddressMode_ClampToEdge, .addressModeW = WGPUAddressMode_ClampToEdge,
        .magFilter = WGPUFilterMode_Nearest, .minFilter = WGPUFilterMode_Nearest,
        .mipmapFilter = WGPUMipmapFilterMode_Nearest, .lodMaxClamp = 32, .maxAnisotropy = 1 };
    WGPUSampler sampler = wgpuDeviceCreateSampler(device, &sampler_desc);
/* endregion: texture */

/* region: pipeline */
    WGPUShaderSourceWGSL wgsl = { .chain = { .sType = WGPUSType_ShaderSourceWGSL }, .code = S(
        "struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };\n"
        "@vertex fn vs(@builtin(vertex_index) i: u32) -> V {\n"
        "  var p = array<vec2f, 3>(vec2f(0.0, 0.7), vec2f(-0.7, -0.7), vec2f(0.7, -0.7));\n"
        "  var o: V;\n"
        "  o.pos = vec4f(p[i], 0.0, 1.0);\n"
        "  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);\n"
        "  return o;\n"
        "}\n"
        "@group(0) @binding(0) var tex: texture_2d<f32>;\n"
        "@group(0) @binding(1) var samp: sampler;\n"
        "@fragment fn fs(v: V) -> @location(0) vec4f { return textureSample(tex, samp, v.uv); }\n") };
    WGPUShaderModuleDescriptor module_desc = { .nextInChain = &wgsl.chain, .label = S("hello shader") };
    WGPUShaderModule module = wgpuDeviceCreateShaderModule(device, &module_desc);
    WGPUColorTargetState target = { .format = format, .writeMask = WGPUColorWriteMask_All };
    WGPUFragmentState fragment = { .module = module, .entryPoint = S("fs"), .targetCount = 1, .targets = &target };
    WGPURenderPipelineDescriptor pipeline_desc = { .label = S("hello pipeline"),
        .vertex = { .module = module, .entryPoint = S("vs") },
        .primitive = { .topology = WGPUPrimitiveTopology_TriangleList },
        .multisample = { .count = 1, .mask = 0xFFFFFFFF }, .fragment = &fragment };
    pipeline = wgpuDeviceCreateRenderPipeline(device, &pipeline_desc);

    /* Made once and reused every frame: a bind group per frame costs time
     * and memory for nothing. */
    WGPUTextureView view = wgpuTextureCreateView(texture, NULL);
    WGPUBindGroupEntry entries[2] = { { .binding = 0, .textureView = view },
                                      { .binding = 1, .sampler = sampler } };
    WGPUBindGroupLayout bgl = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    WGPUBindGroupDescriptor bind_desc = { .layout = bgl, .entryCount = 2, .entries = entries };
    bind_group = wgpuDeviceCreateBindGroup(device, &bind_desc);

    /* The bind group keeps what it uses alive: drop our references. */
    wgpuBindGroupLayoutRelease(bgl);
    wgpuTextureViewRelease(view);
    wgpuSamplerRelease(sampler);
    wgpuTextureRelease(texture);
    wgpuShaderModuleRelease(module);
}
/* endregion: pipeline */

/* region: render */
__attribute__((export_name("wc_render")))
void wc_render(void) {
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
}
/* endregion: render */
