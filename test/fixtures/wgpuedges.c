/*
 * wgpuedges - records what a host does at the WebGPU tier's edges, where
 * SPEC.md is silent or thin (docs/webgpu-spec-gaps.md): uncaptured errors,
 * device loss, and a surface resized mid-run. It asserts nothing itself;
 * tests read its debug state and compare hosts.
 *
 *   frame 1   requests an adapter and a SECOND device through the WebGPU API
 *             (wgpuInstanceRequestAdapter / wgpuAdapterRequestDevice), with an
 *             uncaptured-error callback and a device-lost callback, asking for
 *             maxTextureDimension2D 8192 (above the compatibility floor of
 *             4096) so the host must make a separate device for it
 *   frame 4   an invalid buffer on that device, outside any error scope
 *   frame 5   an invalid buffer on the HOST device (emscripten_webgpu_get_device),
 *             outside any error scope: the cart has no callback for that device
 *   frame 8   destroys its second device (never the host's)
 *   frame 10  reconfigures the #canvas surface from 128x96 to 160x120 and
 *             writes the new size into wc_info_t
 *
 * Debug state (WC_FLAG_DEBUG):
 *   edge.adapter      1 adapter granted, 2 refused
 *   edge.device       1 second device granted, 2 refused (hardware below 8192)
 *   edge.separate     1 if the second device differs from the host's (by the
 *                     maximum texture size it reports)
 *   edge.uncaptured   uncaptured errors delivered to the second device's callback
 *   edge.lost         the device-lost reason delivered (WGPUDeviceLostReason; 0 = none yet)
 *   edge.frames       frames rendered
 *   edge.size         the size the cart configured last ([w, h])
 * Frame colour: green before frame 10, blue after (so a host's readback of
 * the resized surface can be checked).
 *
 * Build: as wgputex.c (emcc + the pinned emdawnwebgpu port), name wgpuedges.
 */
#include <stdlib.h>
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"
#include "wc_cart.h"

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;

static WGPUDevice device, second;
static WGPUQueue queue;
static WGPUSurface surface;
static WGPUTextureFormat format;

static uint32_t edge_adapter, edge_device, edge_separate, edge_uncaptured, edge_lost, edge_frames;
static uint32_t edge_size[2] = { 128, 96 };
WC_DEBUG_FIELDS(
    WC_DBG("edge.adapter", edge_adapter, WC_DBG_U32),
    WC_DBG("edge.device", edge_device, WC_DBG_U32),
    WC_DBG("edge.separate", edge_separate, WC_DBG_U32),
    WC_DBG("edge.uncaptured", edge_uncaptured, WC_DBG_U32),
    WC_DBG("edge.lost", edge_lost, WC_DBG_U32),
    WC_DBG("edge.frames", edge_frames, WC_DBG_U32),
    WC_DBG_ARR("edge.size", edge_size, WC_DBG_U32, 2)
)

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = edge_size[0];
    info.height = edge_size[1];
    info.gpu_api = 2;
    info.flags = WC_FLAG_DEBUG;
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    return &info;
}

static WGPUStringView sv(const char *s) { WGPUStringView v = { s, strlen(s) }; return v; }

static void configure(uint32_t w, uint32_t h) {
    WGPUSurfaceConfiguration cfg = { .device = device, .format = format, .usage = WGPUTextureUsage_RenderAttachment,
        .width = w, .height = h, .alphaMode = WGPUCompositeAlphaMode_Opaque, .presentMode = WGPUPresentMode_Fifo };
    wgpuSurfaceConfigure(surface, &cfg);
    edge_size[0] = w;
    edge_size[1] = h;
}

static void on_uncaptured(WGPUDevice const *dev, WGPUErrorType type, WGPUStringView msg, void *a, void *b) {
    edge_uncaptured++;
}
static void on_lost(WGPUDevice const *dev, WGPUDeviceLostReason reason, WGPUStringView msg, void *a, void *b) {
    edge_lost = (uint32_t)reason;
}
static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev, WGPUStringView msg, void *a, void *b) {
    if (status != WGPURequestDeviceStatus_Success) { edge_device = 2; return; }
    second = dev;
    edge_device = 1;
    WGPULimits mine = { 0 }, host = { 0 };
    wgpuDeviceGetLimits(second, &mine);
    wgpuDeviceGetLimits(device, &host);
    edge_separate = mine.maxTextureDimension2D != host.maxTextureDimension2D;
}
static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView msg, void *a, void *b) {
    if (status != WGPURequestAdapterStatus_Success) { edge_adapter = 2; return; }
    edge_adapter = 1;
    WGPULimits want = WGPU_LIMITS_INIT;
    want.maxTextureDimension2D = 8192;
    WGPUDeviceDescriptor dd = {
        .requiredLimits = &want,
        .deviceLostCallbackInfo = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_lost },
        .uncapturedErrorCallbackInfo = { .callback = on_uncaptured },
    };
    WGPURequestDeviceCallbackInfo ci = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_device };
    wgpuAdapterRequestDevice(adapter, &dd, ci);
}

static void bad_buffer(WGPUDevice dev) {
    WGPUBufferDescriptor bad = { .usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_MapWrite, .size = 4 };
    WGPUBuffer b = wgpuDeviceCreateBuffer(dev, &bad);
    wgpuBufferRelease(b);
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
    configure(128, 96);

    WGPURequestAdapterCallbackInfo ci = { .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_adapter };
    wgpuInstanceRequestAdapter(instance, NULL, ci);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    edge_frames++;
    if (edge_frames == 4 && second) bad_buffer(second);
    if (edge_frames == 5) bad_buffer(device);
    if (edge_frames == 8 && second) wgpuDeviceDestroy(second);
    if (edge_frames == 10) {
        configure(160, 120);
        info.width = 160;
        info.height = 120;
    }
    WGPUSurfaceTexture st = { 0 };
    wgpuSurfaceGetCurrentTexture(surface, &st);
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    double g = edge_frames < 10 ? 1.0 : 0.0, b = edge_frames < 10 ? 0.0 : 1.0;
    WGPURenderPassColorAttachment att = { .view = view, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
        .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store, .clearValue = { 0.0, g, b, 1.0 } };
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
}
