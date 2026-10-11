// wgpu/release.js - destroys the textures and buffers a WebGPU cart released,
// once nothing still uses them (docs/webgpu.md, "GPU memory").
//
// The emdawnwebgpu glue only drops its handle when a cart releases an object;
// the GPU memory goes when the JavaScript engine collects the wrapper, and a
// browser's collector does not know how much GPU memory a small wrapper holds
// (Chromium was measured at 7 GB by frame 3000 of test/fixtures/wgpuvram.c).
// Destroying on release alone would be wrong: a cart may release a texture
// right after making a view of it, or a buffer after naming it in a bind
// group, and keep using the view or group.
//
// What can keep a released texture or buffer in use, and how each is covered:
//   - a view of it, a bind group naming it (or a view of it), a render bundle
//     that recorded it: holders that outlive a frame. Only the calls that make
//     them are tracked (wgpuTextureCreateView, wgpuDeviceCreateBindGroup and
//     the render bundle encoder's methods): the objects such a call looks up
//     in the glue's table become what the new object holds. A texture or
//     buffer the cart released is destroyed once no live holder reaches it.
//   - command encoders, passes and command buffers: not tracked. Destroys
//     wait for the end of the frame (the host calls frameEnd() after
//     wc_render returns), after the frame's last submit; WebGPU's destroy()
//     waits for submitted work. While the cart holds a command encoder it has
//     not finished or a command buffer it has not submitted (encoding across
//     frames), they wait for those too.
// Every other WebGPU call runs untracked: bookkeeping every object every call
// looked up cost about 14% of a WebGPU cart's main-thread CPU. Surface
// textures belong to the canvas and are never destroyed.

/**
 * @param {object} globals - where the WebGPU classes live (window, or webgpu-node's globals)
 * @param {(ptr:number)=>object|undefined} lookup - the glue's table, read directly
 * @param {(fn:((obj:object)=>void)|null)=>void} setRecorder - installs a
 *   function the glue calls with every object it looks up (null: none)
 * @returns the hooks the glue calls (made, released), the brackets host.js
 *   puts around the tracked calls, frameEnd() and stats(). Inert where the
 *   implementation lacks a class it needs.
 */
export function createReleaseTracker(globals, lookup, setRecorder) {
  const PENDING = ['GPUCommandEncoder', 'GPUCommandBuffer'];
  const classes = ['GPUTexture', 'GPUBuffer', 'GPUTextureView', 'GPUBindGroup', 'GPURenderBundle', 'GPURenderBundleEncoder', ...PENDING];
  if (classes.some(c => typeof globals[c] !== 'function')) {
    const nop = () => {};
    const run = (...a) => a[a.length - 1]();
    return { made: nop, released: nop, frameEnd: nop, finish: nop, submit: nop,
      view: run, bindGroup: run, bundle: run, surfaceTexture: run, stats: () => null };
  }
  // Each object's kind by its constructor (one Map lookup per object made);
  // a subclass is matched with instanceof once and remembered.
  const kinds = new Map(classes.map(c => [globals[c], c]));
  const kindOf = obj => {
    const ctor = obj?.constructor;
    let k = kinds.get(ctor);
    if (k !== undefined) return k;
    k = classes.find(c => obj instanceof globals[c]) || null;
    if (ctor) kinds.set(ctor, k);
    return k;
  };
  const isResource = k => k === 'GPUTexture' || k === 'GPUBuffer';

  /** @type {WeakMap<object, Node>} */
  const nodes = new WeakMap();
  // command encoders not yet finished, command buffers not yet submitted
  const openEncoders = new Set();
  const unsubmitted = new Set();
  // released textures and buffers nothing holds, destroyed at the frame end
  let doomed = [];
  let destroyed = 0;
  // during a tracked call: the objects it made, and those it looked up
  let made = null;
  let used = null;
  const record = obj => { const n = obj && nodes.get(obj); if (n) used.push(n); };

  class Node {
    constructor(obj, kind) {
      this.obj = obj;
      this.kind = kind;
      this.refs = 0;          // glue handles (pointers) naming this object
      this.external = false;  // a surface texture: the canvas owns it
      this.queued = false;    // waiting in doomed
      this.holds = null;      // Set<Node>: what this holder keeps in use
      this.heldBy = null;     // Set<Node>: the holders keeping this
    }
  }

  const hold = (holder, held) => {
    if (holder === held) return;
    (holder.holds ??= new Set()).add(held);
    (held.heldBy ??= new Set()).add(holder);
  };

  // True if a holder the cart still has a handle to reaches n (through
  // holders that are released but held, e.g. a released view in a live group).
  function isHeld(n) {
    if (!n.heldBy?.size) return false;
    const visited = new Set([n]);
    const stack = [...n.heldBy];
    while (stack.length) {
      const h = stack.pop();
      if (visited.has(h)) continue;
      visited.add(h);
      if (h.refs > 0) return true;
      if (h.heldBy) for (const up of h.heldBy) stack.push(up);
    }
    return false;
  }

  // n was released or lost a holder: if nothing live reaches it any more it
  // is garbage. A garbage texture or buffer is queued for destroy; a garbage
  // holder lets go of what it held, which may make those garbage in turn.
  function settle(start) {
    const work = [start];
    while (work.length) {
      const n = work.pop();
      if (n.refs > 0 || isHeld(n)) continue;
      if (n.heldBy) { for (const h of n.heldBy) h.holds?.delete(n); n.heldBy = null; }
      if (n.holds) { for (const c of n.holds) { c.heldBy?.delete(n); work.push(c); } n.holds = null; }
      if (isResource(n.kind) && !n.external && !n.queued) {
        n.queued = true;
        doomed.push(n);
      }
    }
  }

  // Run a tracked call: what it makes, and (lookups) what it looks up.
  function tracked(call, lookups, after) {
    const outerMade = made, outerUsed = used;
    made = [];
    used = [];
    if (lookups) setRecorder(record);
    try { return call(); } finally {
      if (lookups) setRecorder(null);
      const m = made, u = used;
      made = outerMade;
      used = outerUsed;
      after(m, u);
    }
  }

  return {
    // the glue made a handle for obj
    made(obj) {
      const kind = kindOf(obj);
      if (!kind) return;
      if (kind === 'GPUCommandEncoder') { openEncoders.add(obj); return; }
      if (kind === 'GPUCommandBuffer') { unsubmitted.add(obj); return; }
      let n = nodes.get(obj);
      if (!n) { n = new Node(obj, kind); nodes.set(obj, n); }
      n.refs++;
      made?.push(n);
    },
    // the cart released the glue's last reference to a handle for obj
    released(obj) {
      if (!obj) return;
      const n = nodes.get(obj);
      if (!n) { openEncoders.delete(obj); unsubmitted.delete(obj); return; }
      n.refs--;
      if (n.refs <= 0) { n.refs = 0; settle(n); }
    },

    // The tracked calls; `call` runs the glue's function.
    // wgpuTextureCreateView(texture, ...): the view holds its texture.
    view(texPtr, call) {
      const tex = nodes.get(lookup(texPtr));
      return tracked(call, false, m => { if (tex) for (const v of m) hold(v, tex); });
    },
    // wgpuDeviceCreateBindGroup: the group holds every buffer and view it names.
    bindGroup(call) {
      return tracked(call, true, (m, u) => { for (const g of m) for (const x of u) if (x.kind !== 'GPUBindGroup') hold(g, x); });
    },
    // wgpuRenderBundleEncoder*(encoder, ...): the bundle encoder holds what
    // its calls name, and the bundle its Finish makes holds the encoder.
    bundle(encPtr, call) {
      const enc = nodes.get(lookup(encPtr));
      return tracked(call, true, (m, u) => {
        if (!enc) return;
        for (const x of u) hold(enc, x);
        for (const b of m) hold(b, enc);
      });
    },
    // wgpuSurfaceGetCurrentTexture: the texture it hands out is the canvas's
    surfaceTexture(call) {
      return tracked(call, false, m => { for (const t of m) t.external = true; });
    },
    // wgpuCommandEncoderFinish(encoder, ...): no longer encoding
    finish(encPtr) { openEncoders.delete(lookup(encPtr)); },
    // wgpuQueueSubmit(queue, count, commands): those command buffers are submitted
    submit(count, cbsPtr, heapU32) {
      for (let i = 0; i < count; i++) unsubmitted.delete(lookup(heapU32[(cbsPtr >>> 2) + i]));
    },

    // After the frame's last submit (the host calls it when wc_render
    // returns): destroy what was released and nothing uses, unless the cart
    // is still encoding commands that may name it.
    frameEnd() {
      if (!doomed.length || openEncoders.size || unsubmitted.size) return;
      const list = doomed;
      doomed = [];
      for (const n of list) {
        n.queued = false;
        if (n.refs > 0 || isHeld(n)) continue;
        destroyed++;
        try { n.obj.destroy(); } catch {}
      }
    },
    /** For tests: how many textures and buffers this session destroyed. */
    stats: () => ({ destroyed }),
  };
}
