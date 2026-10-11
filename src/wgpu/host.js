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
import { createCartAllocator } from '../cartMemory.js';
import { createReleaseTracker } from './release.js';

/**
 * The adapter request every host makes for a WebGPU cart. The tier's floor is
 * WebGPU compatibility mode (GLES 3.1 / D3D11 class), so carts run on a
 * compatibility device everywhere: Dawn enforces the restrictions even on a
 * Vulkan adapter (measured), so a cart developed on a desktop GPU cannot
 * quietly depend on core features a GLES-class host lacks. Defold's adapter,
 * three.js WebGPURenderer and the test carts render identically at both
 * levels. An embedder may override it with `adapterOptions`.
 */
export const WGPU_ADAPTER_OPTIONS = Object.freeze({ featureLevel: 'compatibility' });

const POWER_PREFERENCES = ['low-power', 'high-performance'];

/**
 * The adapter request for one cart: WGPU_ADAPTER_OPTIONS, then the
 * WASMCART_WGPU_POWER environment variable where there is one (Node hosts:
 * 'low-power' or 'high-performance', which picks the GPU on a machine with
 * two), then the embedder's `adapterOptions`. Host configuration only: a
 * cart cannot see or change it.
 * @param {object} [extra] - the embedder's adapterOptions
 */
export function wgpuAdapterOptions(extra) {
  const env = typeof process !== 'undefined' ? process.env?.WASMCART_WGPU_POWER : undefined;
  if (env && !POWER_PREFERENCES.includes(env)) {
    throw new Error(`WASMCART_WGPU_POWER=${env}: expected ${POWER_PREFERENCES.join(' or ')}`);
  }
  return { ...WGPU_ADAPTER_OPTIONS, ...(env ? { powerPreference: env } : {}), ...extra };
}

/**
 * Which GPU an adapter is, for callers that must assert it (two-GPU
 * machines): GPUAdapterInfo's strings, plus the options it was requested with.
 */
export function describeAdapter(adapter, options) {
  const i = adapter?.info || {};
  return {
    vendor: i.vendor || '', architecture: i.architecture || '',
    device: i.device || '', description: i.description || '',
    featureLevel: adapter?.featureLevel || options?.featureLevel || '',
    powerPreference: options?.powerPreference || null,
  };
}

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
 * Like a canvas, present() ends the frame: the next getCurrentTexture() is
 * another texture, so a cart cannot depend on last frame's contents here and
 * then break on a real canvas. The textures come from a ring, as a swap
 * chain's do (webgpu-node's offscreen canvas, 2746769): allocating and
 * destroying a full-size texture every frame cost ~90 us at 1280x720. A
 * presented texture comes back two presents later, so the next frame never
 * gets the one just presented; the ring is dropped on resize and reconfigure.
 *
 * A host presenting into a window the cart's size can have the cart draw
 * straight into the window's texture: setDirect(() => texture) makes
 * getCurrentTexture() return what the function gives (null: the ring's), so
 * no copy into the window is needed (drawTo then reports it drew nothing).
 */
export function createTextureCanvas(width, height) {
  let w = width, h = height, config = null, texture = null, direct = null, fromDirect = false;
  let spare = [];
  const drop = (recycle = false) => {
    const t = texture;
    texture = null;
    if (!t || fromDirect) { fromDirect = false; return; }
    if (recycle && spare.length < 3) spare.push(t); else t.destroy();
  };
  const flush = () => { drop(); for (const t of spare) t.destroy(); spare = []; };
  const canvas = {
    get width() { return w; },
    set width(v) { if (v !== w) { w = v; flush(); direct = null; } },
    get height() { return h; },
    set height(v) { if (v !== h) { h = v; flush(); direct = null; } },
    getContext: type => (type === 'webgpu' ? context : null),
    /** (host) draw straight into another texture of the canvas's size and
     *  configuration: fn() gives it, or null. Cleared when the canvas is
     *  resized or reconfigured. */
    setDirect(fn) { if (fn !== direct) { drop(); direct = fn; } },
    /** (host) a setDirect function is in place */
    get hasDirect() { return direct !== null; },
    /** (host) the current texture came from setDirect's function */
    get isDirect() { return fromDirect; },
  };
  const context = {
    canvas,
    configure(c) { flush(); direct = null; config = { ...c, viewFormats: [...(c.viewFormats || [])] }; },
    unconfigure() { flush(); direct = null; config = null; },
    getConfiguration() { return config ? { ...config } : null; },
    getCurrentTexture() {
      if (!config) throw new Error('the cart canvas is not configured');
      if (texture) return texture;
      const d = direct?.();
      if (d) { fromDirect = true; return (texture = d); }
      texture = (spare.length >= 2 ? spare.shift() : null) ?? config.device.createTexture({
        label: 'wasmcart cart canvas', size: [w, h, 1], format: config.format,
        usage: config.usage, viewFormats: config.viewFormats,
      });
      return texture;
    },
    present() { drop(true); },
    destroy() { flush(); config = null; },
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
 * @param {object} [o.globals] - where the WebGPU classes live (GPUValidationError, ...):
 *   globalThis in a browser, webgpu-node's `globals` in Node
 * @param {(msg:string)=>void} [o.log]
 * @param {(info:{reason:string,message:string})=>void} [o.onLost] - called once
 *   if the host's device is lost while the session is open (a driver reset, a
 *   GPU removed, or something destroying it); the host stops the cart then
 * @param {(handle:number, object:object)=>void} [o.onObject] - every WebGPU
 *   object the cart gets a handle to, with that handle (its pointer in cart
 *   memory): an embedder that serves some of the cart's WebGPU imports
 *   natively keeps its own handle -> object table (wasmcart-native)
 * @param {(handle:number, object:object)=>void} [o.onRelease] - the cart
 *   released its last reference to that handle
 */
export async function createWgpuSession({ moduleImports, gpu, adapter: givenAdapter, createCanvas = createTextureCanvas, width, height, adapterOptions, globals = globalThis, log = () => {}, onLost = () => {}, onObject = null, onRelease = null }) {
  const { factory, manifest } = await gluePromise();
  // The WebGPU classes the glue names as globals (GPUValidationError, ...):
  // window's in a browser, the implementation's own (webgpu-node `globals`)
  // in Node. Missing ones are a host bug, so say which.
  const missingClasses = manifest.globals.filter(c => typeof globals[c] !== 'function');
  if (missingClasses.length) throw new Error(`this host's WebGPU implementation does not provide ${missingClasses.join(', ')}; pass its classes as \`globals\``);

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

  const adapterOpts = wgpuAdapterOptions(adapterOptions);
  const adapter = givenAdapter || await gpu.requestAdapter(adapterOpts);
  if (!adapter) throw new Error('This host has no WebGPU adapter (check the GPU driver), so it cannot run a WebGPU cart');
  // The host's device has the default features and limits: the tier's
  // floor, which is what emscripten_webgpu_get_device() hands a cart. A cart
  // that asks for more through wgpuAdapterRequestDevice gets a device made
  // for exactly that request (see cartAdapter below), as in a browser.
  const device = await adapter.requestDevice();
  const extraDevices = [];
  // The host's device lost while the cart runs: every WebGPU call after it
  // does nothing, so the host stops calling wc_render and tells its embedder
  // (docs/webgpu.md, "Errors and device loss"). Not when the host itself
  // destroyed it at teardown.
  let closed = false;
  let lost = null;
  device.lost.then(info => {
    if (closed) return;
    lost = { reason: info.reason || 'unknown', message: info.message || '' };
    log(`wasmcart: the WebGPU device was lost (${lost.reason}${lost.message ? ': ' + lost.message : ''}); the cart is stopped`);
    onLost(lost);
  });

  // The canvas the cart renders into. Its context is the real one, with
  // COPY_SRC forced into every configuration so frames can be read back.
  const canvas = createCanvas(width, height);
  const realContext = canvas.getContext('webgpu');
  if (!realContext) throw new Error('the host canvas has no WebGPU context');
  // Tracked here rather than read from getConfiguration(), which older
  // browsers lack.
  let configured = false;
  // The device the cart configured its canvas with: the host's, or one it
  // requested with more features or limits. Reads and draws use it.
  let canvasDevice = null;
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
          canvasDevice = cfg.device;
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

  // The cart's view of navigator.gpu and its adapter. A request the host's
  // device already satisfies returns that device. One asking for features or
  // limits beyond it gets a new device with exactly those (from a fresh
  // adapter: a browser adapter makes one device only); a request the
  // hardware cannot meet fails, as in a browser. The host owns and destroys
  // both.
  const satisfies = desc => {
    for (const f of desc?.requiredFeatures || []) if (!device.features.has(f)) return false;
    for (const [k, v] of Object.entries(desc?.requiredLimits || {})) {
      if (v === undefined || v === null) continue;
      const have = device.limits[k];
      if (typeof have !== 'number') return false;
      // "min..." limits are better when lower (alignments); the rest higher.
      if (k.startsWith('min') ? have > v : have < v) return false;
    }
    return true;
  };
  const cartAdapter = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'requestDevice') {
        return async desc => {
          if (satisfies(desc)) return device;
          const fresh = await gpu.requestAdapter(adapterOpts);
          if (!fresh) throw new Error('no WebGPU adapter for the requested device');
          const d = await fresh.requestDevice(desc);
          extraDevices.push(d);
          return d;
        };
      }
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
    wcGlobals: globals,
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

  // Every allocation the glue makes in cart memory goes through the cart's
  // wc_alloc/wc_free (scripts/wgpu/glue-alloc.mjs; SPEC.md "Cart memory the
  // host writes"). The allocator is set at attach.
  let allocator = null;
  // The cart's glue call in progress, so an allocation error names it; none
  // means an async result or callback (an error message, a device loss).
  let inCall = null;
  // An allocation failure can happen inside an async callback (the glue's or
  // the cart's), where a throw reaches no caller: it is kept and thrown from
  // the host's next frame (takeFatal), so the cart stops with the reason.
  let fatal = null;
  const what = () => (inCall ? `WebGPU ${inCall}` : 'a WebGPU callback (an async result, error message or device loss)');
  const cartAlloc = (size, align) => {
    try {
      const p = allocator.alloc(size, align, what());
      refresh();
      return p;
    } catch (e) {
      fatal ??= e;
      throw e;
    }
  };
  // Emscripten's stack helpers, as heap allocations freed at the matching
  // restore: a scope per stackSave, released by stackRestore.
  const scopes = [];
  Module.wcAlloc = cartAlloc;
  // the glue's handleException: a cart-memory error from a callback is kept
  // for the next frame (true = handled); anything else the glue handles
  Module.wcAsyncError = e => (e?.name === 'CartMemoryError' ? ((fatal ??= e), true) : false);
  Module.wcFree = ptr => { allocator.free(ptr); };
  Module.wcScopeOpen = () => { scopes.push([]); return scopes.length; };
  Module.wcScopeAlloc = size => {
    const p = cartAlloc(size, 16);
    if (scopes.length) scopes[scopes.length - 1].push(p);
    return p;
  };
  Module.wcScopeClose = mark => {
    while (scopes.length >= mark && scopes.length) for (const p of scopes.pop()) allocator.free(p);
  };

  // Released textures and buffers are destroyed once nothing the cart still
  // holds uses them (release.js; the glue's hooks: scripts/wgpu/glue-release.mjs).
  const tracker = createReleaseTracker(globals, ptr => Module.WebGPU.Internals.jsObjects[ptr >>> 0],
    fn => { Module.WebGPU.wcRecord = fn; });
  Module.wcGpuMade = onObject ? (obj, ptr) => { tracker.made(obj); onObject(ptr >>> 0, obj); } : tracker.made;
  Module.wcGpuRelease = onRelease ? (obj, ptr) => { onRelease(ptr >>> 0, obj); tracker.released(obj); } : tracker.released;

  // The cart's imports: each glue function behind a wrapper of its own arity
  // (a rest-args wrapper allocated an array per call), refreshing the memory
  // views and naming the call for an allocation error. The few calls the
  // release tracker needs to see (release.js) get their own wrappers.
  const env = {};
  for (const { name } of wanted) env[name] = wrapImport(name, info.env[name]);

  function wrapImport(name, fn) {
    const enter = () => { refresh(); const outer = inCall; inCall = name; return outer; };
    if (name === 'wgpuTextureCreateView') {
      return (tex, desc) => { const o = enter(); try { return tracker.view(tex, () => fn(tex, desc)); } finally { inCall = o; } };
    }
    if (name === 'wgpuDeviceCreateBindGroup') {
      return (dev, desc) => { const o = enter(); try { return tracker.bindGroup(() => fn(dev, desc)); } finally { inCall = o; } };
    }
    if (name === 'wgpuSurfaceGetCurrentTexture') {
      return (surface, out) => { const o = enter(); try { return tracker.surfaceTexture(() => fn(surface, out)); } finally { inCall = o; } };
    }
    if (name.startsWith('wgpuRenderBundleEncoder')) {
      return (enc, ...rest) => { const o = enter(); try { return tracker.bundle(enc, () => fn(enc, ...rest)); } finally { inCall = o; } };
    }
    if (name === 'wgpuCommandEncoderFinish') {
      return (enc, desc) => { const o = enter(); try { return fn(enc, desc); } finally { tracker.finish(enc); inCall = o; } };
    }
    if (name === 'wgpuQueueSubmit') {
      return (queue, count, cbs) => { const o = enter(); try { return fn(queue, count, cbs); } finally { tracker.submit(count, cbs, Module.HEAPU32); inCall = o; } };
    }
    switch (fn.length) {
      case 0: return () => { const o = enter(); try { return fn(); } finally { inCall = o; } };
      case 1: return (a) => { const o = enter(); try { return fn(a); } finally { inCall = o; } };
      case 2: return (a, b) => { const o = enter(); try { return fn(a, b); } finally { inCall = o; } };
      case 3: return (a, b, c) => { const o = enter(); try { return fn(a, b, c); } finally { inCall = o; } };
      case 4: return (a, b, c, d) => { const o = enter(); try { return fn(a, b, c, d); } finally { inCall = o; } };
      case 5: return (a, b, c, d, e) => { const o = enter(); try { return fn(a, b, c, d, e); } finally { inCall = o; } };
      case 6: return (a, b, c, d, e, f) => { const o = enter(); try { return fn(a, b, c, d, e, f); } finally { inCall = o; } };
      case 7: return (a, b, c, d, e, f, g) => { const o = enter(); try { return fn(a, b, c, d, e, f, g); } finally { inCall = o; } };
      case 8: return (a, b, c, d, e, f, g, h) => { const o = enter(); try { return fn(a, b, c, d, e, f, g, h); } finally { inCall = o; } };
      default: return (...args) => { const o = enter(); try { return fn(...args); } finally { inCall = o; } };
    }
  }

  // One full-screen-triangle pipeline per target format, for drawTo(), and
  // its bind group per source texture (the canvas's ring of up to three).
  const blitters = new Map();
  const blitGroups = new WeakMap();
  // the target the cart draws straight into (presentTo), if any
  let directTarget = null;
  function blitter(dev, format) {
    const key = format + (dev === device ? '' : ':extra');
    let b = blitters.get(key);
    if (b) return b;
    const module = dev.createShaderModule({ code: `
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
      pipeline: dev.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } }),
      sampler: dev.createSampler({ magFilter: 'nearest', minFilter: 'linear' }),
    };
    blitters.set(key, b);
    return b;
  }

  return {
    env,
    /** Which GPU the cart runs on (describeAdapter). */
    adapterInfo: describeAdapter(adapter, adapterOpts),
    /** The device the cart renders with: present windows on THIS one. */
    get device() { return canvasDevice || device; },
    context: realContext,
    canvas,

    /** Give the instantiated cart to the glue. memory: the cart's memory
     *  (exported, or the shared one a threaded cart imports). cartAllocator:
     *  the host's allocator for this cart (src/cartMemory.js), shared with
     *  its other paths; made from the cart's exports if not given. */
    async attach(instance, cartMemory, cartAllocator) {
      memory = cartMemory;
      allocator = cartAllocator || createCartAllocator({ getExports: () => instance.exports, getMemory: () => memory });
      const exports = { memory: cartMemory, __wasm_call_ctors: () => {} };
      for (const [name, value] of Object.entries(instance.exports)) {
        if (name === 'memory' || name === '_initialize') continue;
        exports[name] = typeof value === 'function'
          ? (...args) => { const r = value(...args); refresh(); return r; }
          : value;
      }
      giveInstance({ exports }, null);
      await ready;
      Module.WebGPU.wcRecord = null; // the release tracker's lookup recorder (none installed)
      Module.wcUpdateMemoryViews();
    },

    /** Called before wc_render: ends the previous frame (a browser compositor
     *  does this itself; Node has none). */
    beginFrame() {
      if (closed || !configured) return;
      if (typeof realContext.present === 'function') realContext.present();
    },

    /** Called after wc_render returns, after the frame's last submit:
     *  destroys the textures and buffers the cart released that nothing
     *  uses (release.js). */
    endFrame() {
      if (!closed) tracker.frameEnd();
    },

    /** The last rendered frame as top-down RGBA, or null if the cart has not
     *  configured its canvas. Asynchronous: GPU readback always is. */
    //
    // The copy is encoded and submitted synchronously, at the call: the frame
    // read is the one current NOW, even if the caller runs more frames before
    // awaiting. Each call has its own buffer, so reads may overlap.
    readFrame() {
      if (closed || !configured) return Promise.resolve(null);
      const texture = realContext.getCurrentTexture();
      const w = texture.width, h = texture.height, format = texture.format;
      const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
      const dev = canvasDevice || device;
      const buffer = dev.createBuffer({ size: bytesPerRow * h, usage: 0x0008 /* COPY_DST */ | 0x0001 /* MAP_READ */ });
      const encoder = dev.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: h }, [w, h, 1]);
      dev.queue.submit([encoder.finish()]);
      return readMapped(buffer, w, h, bytesPerRow, format);
    },

    /** Show the cart's current frame in `target` (a canvas context on this
     *  device, e.g. a window), scaled into `dst` ({x,y,w,h}, top-down target
     *  pixels; the whole target if omitted). The caller presents the target.
     *  When the frame fills a target exactly the cart's size, the target is
     *  configured as the cart configured its canvas and the cart draws
     *  straight into the target's texture from its next frame on: no copy.
     *  Any other size draws the frame letterboxed (drawTo). */
    presentTo(target, dst) {
      if (closed || !configured) return false;
      const tc = target.canvas, cfg = realContext.getConfiguration?.();
      const fills = !!(tc && cfg && canvas.setDirect && tc.width === canvas.width && tc.height === canvas.height &&
        (!dst || (dst.x === 0 && dst.y === 0 && dst.w === tc.width && dst.h === tc.height)));
      if (canvas.isDirect) {
        // the cart drew straight into target's texture; from the next frame
        // on it draws into its own again if the frame no longer fills target
        if (!fills || directTarget !== target) { canvas.setDirect(null); directTarget = null; }
        return true;
      }
      if (fills && directTarget === target && canvas.hasDirect) return false;  // the cart drew nothing this frame
      if (fills && directTarget !== target) {
        try {
          target.configure({ device: cfg.device, format: cfg.format, usage: cfg.usage, viewFormats: cfg.viewFormats, alphaMode: cfg.alphaMode });
          directTarget = target;
        } catch { directTarget = null; }
      } else if (!fills && directTarget) {
        canvas.setDirect(null);
        directTarget = null;
      }
      const drew = this.drawTo(target, dst);
      if (directTarget === target) canvas.setDirect(() => target.getCurrentTexture());
      return drew;
    },

    /** Draw the cart's current frame into `target` (another configured
     *  canvas context on this device, e.g. a window), scaled into `dst`
     *  ({x,y,w,h}, top-down target pixels; the whole target if omitted) on a
     *  black background. The caller presents the target. */
    drawTo(target, dst) {
      if (closed || !configured) return false;
      const source = realContext.getCurrentTexture();
      const out = target.getCurrentTexture();
      const dev = canvasDevice || device;
      const blit = blitter(dev, out.format);
      let cached = blitGroups.get(source);
      if (cached?.blit !== blit) {
        cached = { blit, group: dev.createBindGroup({
          layout: blit.pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: blit.sampler }, { binding: 1, resource: source.createView() }],
        }) };
        blitGroups.set(source, cached);
      }
      const bind = cached.group;
      const encoder = dev.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      const r = dst || { x: 0, y: 0, w: out.width, h: out.height };
      const x = Math.max(0, Math.min(out.width, r.x)), y = Math.max(0, Math.min(out.height, r.y));
      const w = Math.max(1, Math.min(out.width - x, r.w)), h = Math.max(1, Math.min(out.height - y, r.h));
      pass.setViewport(x, y, w, h, 0, 1);
      pass.setPipeline(blit.pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      dev.queue.submit([encoder.finish()]);
      return true;
    },

    /** {reason, message} once the host's device was lost while the cart
     *  ran (not at teardown), else null. */
    get lost() { return lost; },

    /** Textures and buffers destroyed after the cart released them (tests). */
    get released() { return tracker.stats(); },

    /** An allocation error from an async WebGPU callback (the cart has no
     *  allocator, or it failed), once; the host throws it from its next frame. */
    takeFatal() { const e = fatal; fatal = null; return e; },

    /** Release the device. Returns a promise that settles once Dawn has
     *  delivered device.lost, by which point every callback the cart still
     *  had pending (a mapAsync, an error scope) has been answered; an
     *  embedder tearing Node down must let it settle first, or Dawn's Node
     *  binding aborts on a promise destroyed unresolved. */
    destroy() {
      if (closed) return device.lost.then(() => {});
      closed = true;
      try { realContext.unconfigure?.(); } catch {}
      try { realContext.destroy?.(); } catch {}
      for (const d of extraDevices) d.destroy();
      device.destroy();
      return device.lost.then(() => {});
    },
  };

  async function readMapped(buffer, w, h, bytesPerRow, format) {
    try {
      await buffer.mapAsync(0x0001 /* READ */);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
      buffer.unmap();
      if (format.startsWith('bgra')) {
        for (let i = 0; i < out.length; i += 4) { const b = out[i]; out[i] = out[i + 2]; out[i + 2] = b; }
      }
      return { width: w, height: h, data: out, format };
    } finally {
      buffer.destroy();
    }
  }
}
