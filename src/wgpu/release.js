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
// So this tracks who holds whom, from the glue's own object table
// (scripts/wgpu/glue-release.mjs adds three hooks to it): every object the
// glue looks up during one WebGPU call is "used" by that call, and
//   - an object the call makes (a view, bind group, command buffer, pass or
//     bundle) holds what the call used;
//   - an encoder the call is a method of holds what the call used or made
//     (a pass holds its bind groups and buffers; the command encoder holds
//     the pass, and the command buffer it finishes into holds the encoder).
// A texture or buffer is destroyed once the cart has released it and no
// holder that is still alive reaches it. Holders die when released, and a
// command buffer also when submitted (it cannot be submitted again), an
// encoder when finished. Work already submitted is safe: destroy() waits for
// it (WebGPU's destroy() semantics). Surface textures belong to the canvas
// and are never destroyed.

const RESOURCES = ['GPUTexture', 'GPUBuffer'];
const HOLDERS = ['GPUTextureView', 'GPUBindGroup', 'GPURenderBundle', 'GPUCommandBuffer'];
// encoders: holders whose methods record uses (the call's first argument)
const ENCODERS = {
  GPUCommandEncoder: 'wgpuCommandEncoder',
  GPURenderPassEncoder: 'wgpuRenderPassEncoder',
  GPUComputePassEncoder: 'wgpuComputePassEncoder',
  GPURenderBundleEncoder: 'wgpuRenderBundleEncoder',
};

/**
 * @param {object} globals - where the WebGPU classes live (window, or webgpu-node's globals)
 * @param {(ptr:number)=>object|undefined} lookup - the glue's table, read without the use hook
 * @returns the hooks the glue calls (made, used, released) and the call
 *   brackets host.js puts around every WebGPU import (enter, leave). Inert
 *   where the implementation lacks a class it needs.
 */
export function createReleaseTracker(globals, lookup) {
  const classes = [...RESOURCES, ...HOLDERS, ...Object.keys(ENCODERS)];
  if (classes.some(c => typeof globals[c] !== 'function')) {
    const nop = () => {};
    return { made: nop, used: o => o, released: nop, enter: nop, leave: nop, stats: () => null };
  }
  const kindOf = obj => {
    if (!obj || typeof obj !== 'object') return null;
    for (const c of classes) if (obj instanceof globals[c]) return c;
    return null;
  };

  /** @type {WeakMap<object, Node>} */
  const nodes = new WeakMap();
  const calls = [];
  let destroyed = 0;

  class Node {
    constructor(obj, kind) {
      this.obj = obj;
      this.kind = kind;
      this.refs = 0;          // glue handles (pointers) naming this object
      this.done = false;      // submitted or finished: holds nothing for the future
      this.external = false;  // a surface texture: the canvas owns it
      this.holds = new Set();
      this.heldBy = new Set();
    }
    get live() { return this.refs > 0 && !this.done; }
  }

  const hold = (holder, held) => {
    if (holder === held) return;
    holder.holds.add(held);
    held.heldBy.add(holder);
  };

  // True if a live holder reaches n (through holders that are themselves dead
  // but held, e.g. a released view inside a live bind group).
  function isHeld(n) {
    const seen = new Set([n]);
    const stack = [...n.heldBy];
    while (stack.length) {
      const h = stack.pop();
      if (seen.has(h)) continue;
      seen.add(h);
      if (h.live) return true;
      for (const up of h.heldBy) stack.push(up);
    }
    return false;
  }

  // n died or lost a holder: if nothing live reaches it any more it is
  // garbage. A garbage texture or buffer is destroyed; a garbage holder lets
  // go of what it held, which may make those garbage in turn.
  function settle(start) {
    const work = [start];
    while (work.length) {
      const n = work.pop();
      if (n.live || isHeld(n)) continue;
      for (const h of n.heldBy) h.holds.delete(n);
      n.heldBy.clear();
      for (const child of n.holds) { child.heldBy.delete(n); work.push(child); }
      n.holds.clear();
      if (n.refs === 0 && !n.external && RESOURCES.includes(n.kind) && !n.destroyed) {
        n.destroyed = true;
        destroyed++;
        try { n.obj.destroy(); } catch {}
      }
    }
  }

  return {
    // the glue made a handle for obj
    made(obj) {
      let n = nodes.get(obj);
      if (!n) {
        const kind = kindOf(obj);
        if (!kind) return;
        n = new Node(obj, kind);
        nodes.set(obj, n);
      }
      n.refs++;
      calls.at(-1)?.made.push(n);
    },
    // the glue looked obj up (returns it)
    used(obj) {
      const call = calls.at(-1);
      if (call && obj) {
        const n = nodes.get(obj);
        if (n) call.used.add(n);
      }
      return obj;
    },
    // the cart released the glue's last reference to a handle for obj
    released(obj) {
      const n = obj && nodes.get(obj);
      if (!n) return;
      n.refs--;
      if (n.refs <= 0) { n.refs = 0; settle(n); }
    },
    // around every WebGPU import the cart calls
    enter(name, firstArg) {
      let receiver = null;
      if (typeof firstArg === 'number' && firstArg) {
        const n = nodes.get(lookup(firstArg));
        if (n && ENCODERS[n.kind] && name.startsWith(ENCODERS[n.kind])) receiver = n;
      }
      calls.push({ name, receiver, used: new Set(), made: [] });
    },
    leave() {
      const { name, receiver, used, made } = calls.pop();
      const external = name === 'wgpuSurfaceGetCurrentTexture';
      for (const m of made) {
        if (external) { m.external = true; continue; }
        if (RESOURCES.includes(m.kind)) continue;
        for (const u of used) hold(m, u);
      }
      if (receiver) {
        for (const u of used) hold(receiver, u);
        for (const m of made) hold(receiver, m);
      }
      const finished = [];
      if (name === 'wgpuQueueSubmit') {
        for (const u of used) if (u.kind === 'GPUCommandBuffer') { u.done = true; finished.push(u); }
      } else if (receiver && name.endsWith('EncoderFinish')) {
        receiver.done = true;
        finished.push(receiver);
      }
      for (const f of finished) settle(f);
    },
    /** For tests: how many textures and buffers this session destroyed. */
    stats: () => ({ destroyed }),
  };
}
