/*
 * wgputex - WebGPU texture and sampler fixture (SPEC.md, "WebGPU").
 *
 * Nine 32x32 cells side by side (288x32), each the result of one texture
 * operation a host's WebGPU must get right:
 *
 *   cell  operation                                         expected RGB
 *   0     nearest, clamp, texel (0,0)                       255   0   0
 *   1     nearest, clamp, texel (3,1)                       128   0 255
 *   2     linear, halfway between texels (0,0) and (1,0)    ~128 ~128  0
 *   3     nearest, repeat, u = 1.375 (wraps to texel 1)       0 255   0
 *   4     nearest, clamp-to-edge, u = 1.375 (texel 3)       255 255   0
 *   5     nearest, mirror-repeat, u = 1.375 (texel 2)         0   0 255
 *   6     explicit mip level 1 (a 2x2 level, one colour)     20 200  40
 *   7     explicit mip level 2 (the 1x1 level)              200  20 180
 *   8     a texture the cart rendered into, sampled          51 102 204
 *
 * The 4x4 base level and the two smaller levels are uploaded with
 * wgpuQueueWriteTexture; cell 8 samples an 8x8 render target cleared in
 * wc_init. Everything stays inside compatibility mode (one view dimension
 * per texture, 2D views, rgba8unorm).
 *
 * The cart checks itself: the same pass is rendered into an rgba8unorm
 * texture, copied to a buffer and read with mapAsync (between frames, as the
 * tier requires), and each cell's centre is compared with the table above.
 * Debug state (WC_FLAG_DEBUG), readable on every host:
 *   tex.pass    bit i set when cell i matched (0x1ff = all nine)
 *   tex.done    1 once the readback arrived
 *   tex.errors  validation / out-of-memory errors caught by error scopes
 *               around init and the first frame (0 expected)
 *   tex.frames  frames rendered
 * The frame itself (the surface) shows the same nine cells, so a host can
 * also check its own readback against the table.
 *
 * Build (repo-local emsdk; the emdawnwebgpu package pinned in
 * scripts/wgpu/emdawnwebgpu.json):
 *   emcc wgputex.c -O2 -I../../include --use-port=<pkg>/emdawnwebgpu.port.py \
 *     -sSTANDALONE_WASM=1 --no-entry -sERROR_ON_UNDEFINED_SYMBOLS=0 \
 *     -sEXPORTED_FUNCTIONS=_wc_init,_wc_render,_wc_get_info -o wgputex.wasm
 *   node ../../bin/wasmcart-pack.js --wasm wgputex.wasm --name wgputex -o wgputex.wasc
 */
#include <stdlib.h>
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"
#include "wc_cart.h"

#define CELLS 9
#define W (CELLS * 32)
#define H 32
#define ROW_BYTES 1280 /* W * 4 = 1152, rounded up to 256 */

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

static WGPUDevice device;
static WGPUQueue queue;
static WGPUSurface surface;
static WGPURenderPipeline pipe_surface, pipe_check;
static WGPUBindGroup bind;
static WGPUTexture check_tex;
static WGPUBuffer check_buf;

static uint32_t tex_pass, tex_done, tex_errors, tex_frames;
WC_DEBUG_FIELDS(
    WC_DBG("tex.pass", tex_pass, WC_DBG_U32),
    WC_DBG("tex.done", tex_done, WC_DBG_U32),
    WC_DBG("tex.errors", tex_errors, WC_DBG_U32),
    WC_DBG("tex.frames", tex_frames, WC_DBG_U32)
)

static const uint8_t LEVEL0[16][4] = {
    { 255, 0, 0, 255 },   { 0, 255, 0, 255 },   { 0, 0, 255, 255 },   { 255, 255, 0, 255 },
    { 0, 255, 255, 255 }, { 255, 0, 255, 255 }, { 255, 128, 0, 255 }, { 128, 0, 255, 255 },
    { 32, 32, 32, 255 },  { 64, 64, 64, 255 },  { 96, 96, 96, 255 },  { 160, 160, 160, 255 },
    { 200, 100, 50, 255 }, { 50, 100, 200, 255 }, { 10, 20, 30, 255 }, { 250, 240, 230, 255 },
};
static const uint8_t MIP1[4] = { 20, 200, 40, 255 };
static const uint8_t MIP2[4] = { 200, 20, 180, 255 };
/* expected cell centres; tolerance per channel (linear filtering may round
   either way, and some hardware filters in fewer than 8 bits) */
static const int EXPECT[CELLS][3] = {
    { 255, 0, 0 }, { 128, 0, 255 }, { 128, 128, 0 }, { 0, 255, 0 }, { 255, 255, 0 },
    { 0, 0, 255 }, { 20, 200, 40 }, { 200, 20, 180 }, { 51, 102, 204 },
};
static const int TOL[CELLS] = { 1, 1, 3, 1, 1, 1, 1, 1, 1 };

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
    if (status == WGPUPopErrorScopeStatus_Success && type != WGPUErrorType_NoError) tex_errors++;
}
static void push_scopes(void) {
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_OutOfMemory);
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
}
static void pop_scopes(void) {
    WGPUPopErrorScopeCallbackInfo ci = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_pop };
    wgpuDevicePopErrorScope(device, ci);
    wgpuDevicePopErrorScope(device, ci);
}

static WGPUTexture make_texture(uint32_t w, uint32_t h, uint32_t mips, WGPUTextureUsage usage) {
    WGPUTextureDescriptor d = { .usage = usage, .dimension = WGPUTextureDimension_2D, .size = { w, h, 1 },
        .format = WGPUTextureFormat_RGBA8Unorm, .mipLevelCount = mips, .sampleCount = 1 };
    return wgpuDeviceCreateTexture(device, &d);
}

static void upload(WGPUTexture t, uint32_t level, uint32_t w, uint32_t h, const void *px) {
    WGPUTexelCopyTextureInfo dst = { .texture = t, .mipLevel = level, .aspect = WGPUTextureAspect_All };
    WGPUTexelCopyBufferLayout layout = { .offset = 0, .bytesPerRow = w * 4, .rowsPerImage = h };
    WGPUExtent3D size = { w, h, 1 };
    wgpuQueueWriteTexture(queue, &dst, px, w * h * 4, &layout, &size);
}

static WGPUSampler make_sampler(WGPUFilterMode filter, WGPUAddressMode mode) {
    WGPUSamplerDescriptor d = { .addressModeU = mode, .addressModeV = mode, .addressModeW = mode,
        .magFilter = filter, .minFilter = filter, .mipmapFilter = WGPUMipmapFilterMode_Nearest,
        .lodMinClamp = 0, .lodMaxClamp = 32, .maxAnisotropy = 1 };
    return wgpuDeviceCreateSampler(device, &d);
}

static const char *SHADER =
    "@group(0) @binding(0) var tex: texture_2d<f32>;\n"
    "@group(0) @binding(1) var rt: texture_2d<f32>;\n"
    "@group(0) @binding(2) var s_nc: sampler;\n"
    "@group(0) @binding(3) var s_lc: sampler;\n"
    "@group(0) @binding(4) var s_nr: sampler;\n"
    "@group(0) @binding(5) var s_nm: sampler;\n"
    "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
    "  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));\n"
    "  return vec4f(p[i], 0.0, 1.0);\n"
    "}\n"
    "@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {\n"
    "  let cell = u32(p.x) / 32u;\n"
    "  switch cell {\n"
    "    case 0u: { return textureSampleLevel(tex, s_nc, vec2f(0.125, 0.125), 0.0); }\n"
    "    case 1u: { return textureSampleLevel(tex, s_nc, vec2f(0.875, 0.375), 0.0); }\n"
    "    case 2u: { return textureSampleLevel(tex, s_lc, vec2f(0.25, 0.125), 0.0); }\n"
    "    case 3u: { return textureSampleLevel(tex, s_nr, vec2f(1.375, 0.125), 0.0); }\n"
    "    case 4u: { return textureSampleLevel(tex, s_nc, vec2f(1.375, 0.125), 0.0); }\n"
    "    case 5u: { return textureSampleLevel(tex, s_nm, vec2f(1.375, 0.125), 0.0); }\n"
    "    case 6u: { return textureSampleLevel(tex, s_nc, vec2f(0.5, 0.5), 1.0); }\n"
    "    case 7u: { return textureSampleLevel(tex, s_nc, vec2f(0.5, 0.5), 2.0); }\n"
    "    case 8u: { return textureSampleLevel(rt, s_lc, vec2f(0.5, 0.5), 0.0); }\n"
    "    default: { return vec4f(0.0, 0.0, 0.0, 1.0); }\n"
    "  }\n"
    "}\n";

static WGPURenderPipeline make_pipeline(WGPUShaderModule sm, WGPUPipelineLayout layout, WGPUTextureFormat format) {
    WGPUColorTargetState target = { .format = format, .writeMask = WGPUColorWriteMask_All };
    WGPUFragmentState fs = { .module = sm, .entryPoint = sv("fs"), .targetCount = 1, .targets = &target };
    WGPURenderPipelineDescriptor pd = { .layout = layout, .vertex = { .module = sm, .entryPoint = sv("vs") },
        .primitive = { .topology = WGPUPrimitiveTopology_TriangleList },
        .multisample = { .count = 1, .mask = 0xFFFFFFFF }, .fragment = &fs };
    return wgpuDeviceCreateRenderPipeline(device, &pd);
}

static void draw(WGPUCommandEncoder enc, WGPUTextureView view, WGPURenderPipeline pipe) {
    WGPURenderPassColorAttachment att = { .view = view, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
        .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store, .clearValue = { 0, 0, 0, 1 } };
    WGPURenderPassDescriptor rpd = { .colorAttachmentCount = 1, .colorAttachments = &att };
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
    wgpuRenderPassEncoderSetPipeline(pass, pipe);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind, 0, NULL);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
}

static void on_map(WGPUMapAsyncStatus status, WGPUStringView msg, void *a, void *b) {
    if (status != WGPUMapAsyncStatus_Success) { tex_done = 2; return; }
    const uint8_t *px = (const uint8_t *)wgpuBufferGetConstMappedRange(check_buf, 0, ROW_BYTES * H);
    uint32_t pass = 0;
    for (int c = 0; c < CELLS; c++) {
        const uint8_t *p = px + (H / 2) * ROW_BYTES + (c * 32 + 16) * 4;
        int ok = 1;
        for (int k = 0; k < 3; k++) {
            int d = (int)p[k] - EXPECT[c][k];
            if (d < -TOL[c] || d > TOL[c]) ok = 0;
        }
        if (ok) pass |= 1u << c;
    }
    tex_pass = pass;
    tex_done = 1;
    wgpuBufferUnmap(check_buf);
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    device = emscripten_webgpu_get_device();
    queue = wgpuDeviceGetQueue(device);
    push_scopes();

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

    /* the sampled texture: 4x4, 2x2, 1x1 */
    WGPUTexture tex = make_texture(4, 4, 3, WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
    upload(tex, 0, 4, 4, LEVEL0);
    uint8_t m1[4][4], m2[4];
    for (int i = 0; i < 4; i++) memcpy(m1[i], MIP1, 4);
    memcpy(m2, MIP2, 4);
    upload(tex, 1, 2, 2, m1);
    upload(tex, 2, 1, 1, m2);

    /* a render target, cleared to (51, 102, 204), then sampled */
    WGPUTexture rt = make_texture(8, 8, 1, WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding);
    WGPUTextureView rt_view = wgpuTextureCreateView(rt, NULL);
    {
        WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
        WGPURenderPassColorAttachment att = { .view = rt_view, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
            .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store, .clearValue = { 51 / 255.0, 102 / 255.0, 204 / 255.0, 1 } };
        WGPURenderPassDescriptor rpd = { .colorAttachmentCount = 1, .colorAttachments = &att };
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
        wgpuRenderPassEncoderEnd(pass);
        WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, NULL);
        wgpuQueueSubmit(queue, 1, &cb);
        wgpuCommandBufferRelease(cb);
        wgpuRenderPassEncoderRelease(pass);
        wgpuCommandEncoderRelease(enc);
    }

    WGPUShaderSourceWGSL wgsl = { .chain = { .sType = WGPUSType_ShaderSourceWGSL }, .code = sv(SHADER) };
    WGPUShaderModuleDescriptor smd = { .nextInChain = &wgsl.chain };
    WGPUShaderModule sm = wgpuDeviceCreateShaderModule(device, &smd);

    WGPUBindGroupLayoutEntry le[6] = { 0 };
    for (int i = 0; i < 6; i++) { le[i].binding = (uint32_t)i; le[i].visibility = WGPUShaderStage_Fragment; }
    for (int i = 0; i < 2; i++) {
        le[i].texture.sampleType = WGPUTextureSampleType_Float;
        le[i].texture.viewDimension = WGPUTextureViewDimension_2D;
    }
    for (int i = 2; i < 6; i++) le[i].sampler.type = WGPUSamplerBindingType_Filtering;
    WGPUBindGroupLayoutDescriptor bld = { .entryCount = 6, .entries = le };
    WGPUBindGroupLayout bgl = wgpuDeviceCreateBindGroupLayout(device, &bld);
    WGPUPipelineLayoutDescriptor pld = { .bindGroupLayoutCount = 1, .bindGroupLayouts = &bgl };
    WGPUPipelineLayout layout = wgpuDeviceCreatePipelineLayout(device, &pld);

    WGPUTextureView tex_view = wgpuTextureCreateView(tex, NULL);
    WGPUBindGroupEntry be[6] = { 0 };
    for (int i = 0; i < 6; i++) be[i].binding = (uint32_t)i;
    be[0].textureView = tex_view;
    be[1].textureView = rt_view;
    be[2].sampler = make_sampler(WGPUFilterMode_Nearest, WGPUAddressMode_ClampToEdge);
    be[3].sampler = make_sampler(WGPUFilterMode_Linear, WGPUAddressMode_ClampToEdge);
    be[4].sampler = make_sampler(WGPUFilterMode_Nearest, WGPUAddressMode_Repeat);
    be[5].sampler = make_sampler(WGPUFilterMode_Nearest, WGPUAddressMode_MirrorRepeat);
    WGPUBindGroupDescriptor bgd = { .layout = bgl, .entryCount = 6, .entries = be };
    bind = wgpuDeviceCreateBindGroup(device, &bgd);

    pipe_surface = make_pipeline(sm, layout, format);
    pipe_check = make_pipeline(sm, layout, WGPUTextureFormat_RGBA8Unorm);

    check_tex = make_texture(W, H, 1, WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc);
    WGPUBufferDescriptor bd = { .usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, .size = ROW_BYTES * H };
    check_buf = wgpuDeviceCreateBuffer(device, &bd);

    /* the bind group holds what it needs; the views and samplers may go */
    for (int i = 2; i < 6; i++) wgpuSamplerRelease(be[i].sampler);
    wgpuTextureViewRelease(tex_view);
    wgpuTextureViewRelease(rt_view);
    wgpuShaderModuleRelease(sm);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    tex_frames++;
    WGPUSurfaceTexture st = { 0 };
    wgpuSurfaceGetCurrentTexture(surface, &st);
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    draw(enc, view, pipe_surface);
    if (tex_frames == 1) { /* the self-check, once */
        WGPUTextureView cv = wgpuTextureCreateView(check_tex, NULL);
        draw(enc, cv, pipe_check);
        WGPUTexelCopyTextureInfo src = { .texture = check_tex, .aspect = WGPUTextureAspect_All };
        WGPUTexelCopyBufferInfo dst = { .buffer = check_buf, .layout = { .bytesPerRow = ROW_BYTES, .rowsPerImage = H } };
        WGPUExtent3D size = { W, H, 1 };
        wgpuCommandEncoderCopyTextureToBuffer(enc, &src, &dst, &size);
        wgpuTextureViewRelease(cv);
    }
    WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cb);
    if (tex_frames == 1) {
        pop_scopes();
        WGPUBufferMapCallbackInfo mci = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_map };
        wgpuBufferMapAsync(check_buf, WGPUMapMode_Read, 0, ROW_BYTES * H, mci);
    }
    wgpuCommandBufferRelease(cb);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(st.texture);
}
