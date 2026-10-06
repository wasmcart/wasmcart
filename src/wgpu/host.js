// wgpu/host.js - the host half of the `wgpu` capability, shared by CartHost
// (Node, on webgpu-node) and CartHostWeb (the browser's navigator.gpu).
//
// A WebGPU cart is an Emscripten build against Dawn's emdawnwebgpu port: the
// port's C++ half is inside the cart, and its JavaScript half is
// emdawnwebgpu-glue.mjs, generated from the same pinned release (see
// scripts/build-wgpu-glue.mjs). This module runs that glue for one cart:
//
//   - the glue's imports are handed to the cart's instantiation, and the cart's
//     instance is handed back to the glue (Emscripten's instantiateWasm hook);
//   - the device is the HOST's: emscripten_webgpu_get_device() returns it, and
//     a cart that requests an adapter and device gets the host's adapter and
//     that same device;
//   - the cart renders into the surface it creates from the selector
//     "#canvas": a host canvas the cart's own size, which the host reads back
//     and presents.
//
// Async results (buffer maps, error scopes, work-done) reach the cart on the
// host's event loop, never during a wc_render call.

import gluePromise from './glue-loader.js';

/** True for a function name the WebGPU glue provides. */
export function isWgpuImportName(name) {
  return /^(wgpu|emwgpu)[A-Z]/.test(name) || name.startsWith('emscripten_webgpu_');
}

/** True if a module's import list makes it a WebGPU cart. */
export function importsWgpu(moduleImports) {
  return moduleImports.some(imp => imp.kind === 'function'
    && (imp.module === 'env' || imp.module === 'wgpu') && isWgpuImportName(imp.name));
}

/**
 * The binding for a GPU import the host did NOT select for a dual cart (one
 * importing both `gl` and WebGPU). It throws, naming the call: a cart that
 * ignored the host-info flag fails loudly instead of rendering nothing.
 * @param {string} name - the import's name
 * @param {'GL'|'WebGPU'} selected - what the host picked instead
 */
export function gpuImportTrap(name, selected) {
  return () => {
    throw new Error(`wasmcart: the cart called ${name}, but this host selected ${selected} for it. A cart importing both GPU APIs must read WC_HOST_FLAG_GPU_WGPU in host-info flags at wc_init and use only that API.`);
  };
}

/**
 * The default cart canvas: a host-owned texture behind the canvas API, the
 * WebGPU counterpart of the GL redirect FBO. The cart configures it and takes
 * its current texture exactly as with a real canvas; the host reads it back
 * or draws it into whatever it presents on (drawTo).
 *
 * Why not a real canvas: a browser hands a canvas's texture back to its
 * compositor at the end of the task, so a host could only read a frame in the
 * same task that drew it, and a headless Chromium was measured failing EVERY
 * later mapAsync on a device once it had taken a canvas texture. A texture the
 * host owns has neither problem and behaves the same in Node and a browser.
 *
 * Like a canvas, present() ends the frame: the next getCurrentTexture() is a
 * fresh texture, so a cart cannot depend on last frame's contents here and
 * then break on a real canvas.
 */
export function createTextureCanvas(width, height) {
  let w = width, h = height, config = null, texture = null;
  const drop = () => { texture?.destroy(); texture = null; };
  const canvas = {
    get width() { return w; },
    set width(v) { if (v !== w) { w = v; drop(); } },
    get height() { return h; },
    set height(v) { if (v !== h) { h = v; drop(); } },
    getContext: type => (type === 'webgpu' ? context : null),
  };
  const context = {
    canvas,
    configure(c) { drop(); config = { ...c, viewFormats: [...(c.viewFormats || [])] }; },
    unconfigure() { drop(); config = null; },
    getConfiguration() { return config ? { ...config } : null; },
    getCurrentTexture() {
      if (!config) throw new Error('the cart canvas is not configured');
      texture ??= config.device.createTexture({
        label: 'wasmcart cart canvas', size: [w, h, 1], format: config.format,
        usage: config.usage, viewFormats: config.viewFormats,
      });
      return texture;
    },
    present() { drop(); },
    destroy() { drop(); config = null; },
  };
  return canvas;
}

// The cart's canvas always gets COPY_SRC (host readback) and TEXTURE_BINDING
// (host drawing it into a window), whatever usage the cart configured.
const HOST_USAGE = 0x01 /* COPY_SRC */ | 0x04 /* TEXTURE_BINDING */;

/**
 * Prepare a WebGPU session for one cart, before it is instantiated.
 *
 * @param {object} o
 * @param {WebAssembly.ModuleImportDescriptor[]} o.moduleImports
 * @param {object} o.gpu        - a navigator.gpu (browser) or webgpu-node GPU
 * @param {GPUAdapter} [o.adapter] - already requested from gpu; else requested here
 * @param {(w:number,h:number)=>object} [o.createCanvas] - makes a canvas with
 *   getContext('webgpu'); default createTextureCanvas (a host-owned texture)
 * @param {number} o.width      - initial canvas size (the cart's resolution)
 * @param {number} o.height
 * @param {GPURequestAdapterOptions} [o.adapterOptions]
 * @param {(msg:string)=>void} [o.log]
 */
export async function createWgpuSession({ moduleImports, gpu, adapter: givenAdapter, createCanvas = createTextureCanvas, width, height, adapterOptions, log = () => {} }) {
  const { factory, manifest } = await gluePromise();

  // Every WebGPU function the cart imports must exist in this glue. A missing
  // one is a load error naming it, never a stub: a stubbed GPU call returns 0
  // and the cart renders nothing with no error anywhere.
  const wanted = moduleImports.filter(imp => imp.kind === 'function'
    && (imp.module === 'env' || imp.module === 'wgpu')
    && (isWgpuImportName(imp.name) || imp.name === 'emscripten_has_asyncify'));
  const known = new Set(manifest.imports);
  const missing = wanted.filter(imp => !known.has(imp.name)).map(imp => imp.name);
  if (missing.length) {
    throw new Error(`WebGPU cart imports ${missing.length} function(s) this host's glue (emdawnwebgpu ${manifest.release}) does not provide: ${missing.join(', ')}. Build the cart against emdawnwebgpu ${manifest.release}.`);
  }

  const adapter = givenAdapter || await gpu.requestAdapter(adapterOptions);
  if (!adapter) throw new Error('This host has no WebGPU adapter (check the GPU driver), so it cannot run a WebGPU cart');
  const device = await adapter.requestDevice();
  let lost = null;
  device.lost.then(info => { lost = info; if (info.reason !== 'destroyed') log(`wasmcart: WebGPU device lost: ${info.message}`); });

  // The canvas the cart renders into. Its context is the real one, with
  // COPY_SRC forced into every configuration so frames can be read back.
  const canvas = createCanvas(width, height);
  const realContext = canvas.getContext('webgpu');
  if (!realContext) throw new Error('the host canvas has no WebGPU context');
  // Tracked here rather than read from getConfiguration(), which older
  // browsers lack.
  let configured = false;
  const context = new Proxy(realContext, {
    get(target, prop) {
      if (prop === 'configure') {
        return cfg => {
          target.configure({
            ...cfg,
            usage: (cfg.usage ?? 0x10) | HOST_USAGE,
            alphaMode: cfg.alphaMode === 'premultiplied' ? 'premultiplied' : 'opaque',
          });
          configured = true;
        };
      }
      if (prop === 'unconfigure') return () => { configured = false; target.unconfigure(); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const cartCanvas = new Proxy(canvas, {
    get(target, prop) {
      if (prop === 'getContext') return type => (type === 'webgpu' ? context : null);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });

  // The cart's view of navigator.gpu and its adapter: the host's adapter, and
  // the host's device whatever it asks for (the host owns the device).
  const cartAdapter = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'requestDevice') return async () => device;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const cartGpu = {
    requestAdapter: async () => cartAdapter,
    getPreferredCanvasFormat: () => gpu.getPreferredCanvasFormat(),
    get wgslLanguageFeatures() { return gpu.wgslLanguageFeatures; },
  };
  const cartDocument = {
    querySelector: sel => (sel === '#canvas' || sel === 'canvas' ? cartCanvas : null),
    getElementById: id => (id === 'canvas' ? cartCanvas : null),
  };

  // Start the glue; it stops at instantiateWasm and hands over its imports.
  let gotImports, giveInstance;
  const importsReady = new Promise(resolve => { gotImports = resolve; });
  const Module = {
    wcNavigator: { gpu: cartGpu, userAgent: 'wasmcart' },
    wcDocument: cartDocument,
    preinitializedWebGPUDevice: device,
    print: log,
    printErr: log,
    instantiateWasm(info, receive) { gotImports(info); giveInstance = receive; return {}; },
  };
  const ready = factory(Module);
  const info = await importsReady;

  let memory = null;
  // The cart can grow its memory without the glue knowing (a standalone cart
  // grows inside wasm), which detaches the glue's typed-array views. Refresh
  // them on the way into every glue function and after every call back into
  // the cart.
  const refresh = () => {
    if (memory && Module.HEAPU8 && Module.HEAPU8.buffer !== memory.buffer) Module.wcUpdateMemoryViews();
  };
  const env = {};
  for (const { name } of wanted) {
    const fn = info.env[name];
    env[name] = (...args) => { refresh(); return fn(...args); };
  }

  let readbackBuffer = null;
  let closed = false;

  // One full-screen-triangle pipeline per target format, for drawTo().
  const blitters = new Map();
  function blitter(format) {
    let b = blitters.get(format);
    if (b) return b;
    const module = device.createShaderModule({ code: `
      struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
      @vertex fn vs(@builtin(vertex_index) i: u32) -> V {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        var v: V;
        v.pos = vec4f(p[i], 0, 1);
        v.uv = vec2f((p[i].x + 1) * 0.5, (1 - p[i].y) * 0.5);
        return v;
      }
      @group(0) @binding(0) var s: sampler;
      @group(0) @binding(1) var t: texture_2d<f32>;
      @fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(textureSample(t, s, v.uv).rgb, 1); }
    ` });
    b = {
      pipeline: device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } }),
      sampler: device.createSampler({ magFilter: 'nearest', minFilter: 'linear' }),
    };
    blitters.set(format, b);
    return b;
  }

  return {
    env,
    device,
    context: realContext,
    canvas,

    /** Give the instantiated cart to the glue. memory: the cart's memory
     *  (exported, or the shared one a threaded cart imports). */
    async attach(instance, cartMemory) {
      memory = cartMemory;
      const exports = { memory: cartMemory, __wasm_call_ctors: () => {} };
      for (const [name, value] of Object.entries(instance.exports)) {
        if (name === 'memory' || name === '_initialize') continue;
        exports[name] = typeof value === 'function'
          ? (...args) => { const r = value(...args); refresh(); return r; }
          : value;
      }
      giveInstance({ exports }, null);
      await ready;
      Module.wcUpdateMemoryViews();
    },

    /** Called before wc_render: ends the previous frame (a browser compositor
     *  does this itself; Node has none). */
    beginFrame() {
      if (closed || !configured) return;
      if (typeof realContext.present === 'function') realContext.present();
    },

    /** The last rendered frame as top-down RGBA, or null if the cart has not
     *  configured its canvas. Asynchronous: GPU readback always is. */
    async readFrame() {
      if (closed) return null;
      if (!configured) return null;
      const texture = realContext.getCurrentTexture();
      const w = texture.width, h = texture.height;
      const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
      const size = bytesPerRow * h;
      if (!readbackBuffer || readbackBuffer.size !== size) {
        readbackBuffer?.destroy();
        readbackBuffer = device.createBuffer({ size, usage: 0x0008 /* COPY_DST */ | 0x0001 /* MAP_READ */ });
      }
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer: readbackBuffer, bytesPerRow, rowsPerImage: h }, [w, h, 1]);
      device.queue.submit([encoder.finish()]);
      const buffer = readbackBuffer;
      await buffer.mapAsync(0x0001 /* READ */);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
      buffer.unmap();
      if (texture.format.startsWith('bgra')) {
        for (let i = 0; i < out.length; i += 4) { const b = out[i]; out[i] = out[i + 2]; out[i + 2] = b; }
      }
      return { width: w, height: h, data: out, format: texture.format };
    },

    /** Draw the cart's current frame into `target` (another configured
     *  canvas context on this device, e.g. a window), scaled into `dst`
     *  ({x,y,w,h}, top-down target pixels; the whole target if omitted) on a
     *  black background. The caller presents the target. */
    drawTo(target, dst) {
      if (closed || !configured) return false;
      const source = realContext.getCurrentTexture();
      const out = target.getCurrentTexture();
      const blit = blitter(out.format);
      const bind = device.createBindGroup({
        layout: blit.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: blit.sampler }, { binding: 1, resource: source.createView() }],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      const r = dst || { x: 0, y: 0, w: out.width, h: out.height };
      const x = Math.max(0, Math.min(out.width, r.x)), y = Math.max(0, Math.min(out.height, r.y));
      const w = Math.max(1, Math.min(out.width - x, r.w)), h = Math.max(1, Math.min(out.height - y, r.h));
      pass.setViewport(x, y, w, h, 0, 1);
      pass.setPipeline(blit.pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      return true;
    },

    get lost() { return lost; },

    destroy() {
      if (closed) return;
      closed = true;
      readbackBuffer?.destroy();
      try { realContext.unconfigure?.(); } catch {}
      try { realContext.destroy?.(); } catch {}
      device.destroy();
    },
  };
}
