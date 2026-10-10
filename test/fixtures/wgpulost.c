/*
 * wgpulost - WebGPU fixture for losing the host's device (docs/webgpu.md,
 * "Errors and device loss"). It clears its 64x64 frame green every frame and
 * at frame 5 destroys the device emscripten_webgpu_get_device() gave it, as a
 * driver reset would lose it. (A real cart must never do this; see "Rules
 * that bite".) The host must then stop calling wc_render and report the loss
 * to its embedder; the bundled players say so and exit 4.
 *
 * Debug state (WC_FLAG_DEBUG):
 *   lost.frames   frames rendered (stays at 5, or one more, once the host stops)
 *
 * Build: as wgputex.c (emcc + the pinned emdawnwebgpu port), name wgpulost.
 */
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"
#include "wc_cart.h"

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

static WGPUDevice device;
static WGPUQueue queue;
static WGPUSurface surface;

static uint32_t lost_frames;
WC_DEBUG_FIELDS(
    WC_DBG("lost.frames", lost_frames, WC_DBG_U32)
)

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = 64;
    info.height = 64;
    info.gpu_api = 2;
    info.flags = WC_FLAG_DEBUG;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    return &info;
}

static WGPUStringView sv(const char *s) { WGPUStringView v = { s, strlen(s) }; return v; }

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
    WGPUSurfaceConfiguration cfg = { .device = device, .format = caps.formats[0], .usage = WGPUTextureUsage_RenderAttachment,
        .width = 64, .height = 64, .alphaMode = WGPUCompositeAlphaMode_Opaque, .presentMode = WGPUPresentMode_Fifo };
    wgpuSurfaceConfigure(surface, &cfg);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    lost_frames++;
    WGPUSurfaceTexture st = { 0 };
    wgpuSurfaceGetCurrentTexture(surface, &st);
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassColorAttachment att = { .view = view, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
        .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store, .clearValue = { 0.0, 1.0, 0.0, 1.0 } };
    WGPURenderPassDescriptor rpd = { .colorAttachmentCount = 1, .colorAttachments = &att };
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
    wgpuRenderPassEncoderEnd(pass);
    WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(st.texture);
    if (lost_frames == 5) wgpuDeviceDestroy(device);
}
