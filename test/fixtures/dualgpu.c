/*
 * dualgpu - a cart importing BOTH `gl` and WebGPU (SPEC.md, "WebGPU": dual
 * carts). The host picks one and says which in host-info flags before
 * wc_init; the cart reads the bit once and uses only that API.
 *
 *   WebGPU selected: clears to GREEN (0, 255, 0) through the #canvas surface.
 *   GL selected:     clears to RED   (255, 0, 0) through the gl module.
 *
 * Built a second way with -DIGNORE_FLAG (dualgpu_bad.wasc): it calls GL no
 * matter what the host said, so on a WebGPU host its GL import must throw.
 *
 * Build: as wgpucart.c, adding -DIGNORE_FLAG for the bad variant.
 */
#include <string.h>
#include <webgpu/webgpu.h>
#include "wasmcart.h"
#include "wc_cart.h"

#define W 128
#define H 96
#define WC_HOST_FLAG_GPU_WGPU 0x02

__attribute__((import_module("gl"), import_name("glClearColor")))
extern void glClearColor(float r, float g, float b, float a);
__attribute__((import_module("gl"), import_name("glClear")))
extern void glClear(uint32_t mask);
__attribute__((import_module("gl"), import_name("glViewport")))
extern void glViewport(int x, int y, int w, int h);
#define GL_COLOR_BUFFER_BIT 0x4000

static wc_info_t info;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_host_info_t host_info;
static int use_wgpu;
static WGPUDevice device;
static WGPUQueue queue;
static WGPUSurface surface;

static WGPUStringView sv(const char *s) { WGPUStringView v = { s, strlen(s) }; return v; }

__attribute__((export_name("wc_get_info")))
wc_info_t *wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = W;
    info.height = H;
    info.gpu_api = 2;  /* imports WebGPU; the host may still pick GL */
    info.input_ptr = (uint32_t)pads;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    return &info;
}

__attribute__((export_name("dualgpu_uses_wgpu"))) int dualgpu_uses_wgpu(void) { return use_wgpu; }

__attribute__((export_name("wc_init")))
void wc_init(void) {
    use_wgpu = (host_info.flags & WC_HOST_FLAG_GPU_WGPU) != 0;
    if (!use_wgpu) return;
    device = emscripten_webgpu_get_device();
    queue = wgpuDeviceGetQueue(device);
    WGPUInstance instance = wgpuCreateInstance(NULL);
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvas = {
        .chain = { .sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector }, .selector = sv("#canvas") };
    WGPUSurfaceDescriptor sd = { .nextInChain = &canvas.chain };
    surface = wgpuInstanceCreateSurface(instance, &sd);
    WGPUSurfaceCapabilities caps = {0};
    wgpuSurfaceGetCapabilities(surface, NULL, &caps);
    WGPUSurfaceConfiguration cfg = { .device = device, .format = caps.formats[0], .usage = WGPUTextureUsage_RenderAttachment,
        .width = W, .height = H, .alphaMode = WGPUCompositeAlphaMode_Opaque, .presentMode = WGPUPresentMode_Fifo };
    wgpuSurfaceConfigure(surface, &cfg);
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
#ifdef IGNORE_FLAG
    /* The bug this variant exists to catch: GL regardless of the flag. */
    glClear(GL_COLOR_BUFFER_BIT);
#endif
    if (!use_wgpu) {
        glViewport(0, 0, W, H);
        glClearColor(1.0f, 0.0f, 0.0f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        return;
    }
    WGPUSurfaceTexture st = {0};
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
}
