/**
 * jit.js - the host side of runtime code generation (SPEC.md, "Runtime code
 * generation").
 *
 * A cart that generates WebAssembly at runtime (a language VM compiling its
 * hot functions) cannot instantiate it itself: wasm has no instruction for
 * that. It hands the bytes to the host, the host compiles and instantiates
 * them against the cart's own exports, and drops the new functions into the
 * cart's function table, where the cart reaches them with call_indirect. The
 * host's wasm engine compiling those bytes is the JIT.
 *
 * Imports (module `env`; optional for carts, every host provides them):
 *
 *   int32_t wc_jit_link(const uint8_t *bytes, uint32_t len, int32_t *result);
 *     >= 0  installed: the table slot of the module's first exported
 *           function; its other exports follow in consecutive slots.
 *     -1    refused: invalid module, an import outside namespace `cart`, a
 *           limit exceeded, or the host's switch is off.
 *     -2    pending: compiling asynchronously. The first slot (or -1) is
 *           written to *result later, always between two calls into the cart.
 *     -3    try later: too many compiles in flight.
 *     Every outcome is also written to *result (when result is not 0).
 *
 *   void wc_jit_unlink(int32_t first_slot);
 *     Frees the slots of a module linked by wc_jit_link. Calling through them
 *     then traps; a later link may reuse them.
 *
 *   int32_t wc_jit_config(int32_t key);   -1 = no opinion
 *     0 hotness threshold  1 compile nothing (1 = the host's switch is off)
 *     2 tier-up interval   3 max module bytes   4 max total linked bytes
 *     5 max linked functions   6 max compiles in flight
 *     7 restore generation: 0 until the host first restores a state into this
 *       instance; every restore then sets restoreGeneration(memory, current)
 *       (a hash of the restored memory in 1..2^31-1, never the current value),
 *       so the same state gives the same value on every host and peer. Engines
 *       compare it with the value they stored and, when it differs, forget
 *       every slot and pending cell and re-link.
 *
 * Ownership: every link belongs to the instance that asked for it, and its
 * slots, limits and in-flight compiles are that instance's alone (a worker
 * instance has its own). An asynchronous result for an instance that is gone,
 * or whose slots were reset by a state restore, is dropped: it is never
 * installed into, or written into the memory of, anything else.
 *
 * Restores: unlinkAll() unlinks every slot and changes key 7 in one step. The
 * slots it frees are not reused until the cart has read key 7 since the
 * restore, so a slot number from before a restore can only trap, never reach
 * different code, until the engine has seen the new generation.
 */

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * The restore generation for a state just written back (SPEC.md, wc_jit_config
 * key 7): FNV-1a 32 over the memory as little-endian 32-bit words (offset basis
 * 2166136261, prime 16777619, one xor + multiply per word), masked to 31 bits;
 * 0 becomes 1, and a value equal to `current` becomes the next one (2^31-1
 * wraps to 1). Every host computes exactly this, so it is deterministic.
 * @param {ArrayBuffer|SharedArrayBuffer|Uint8Array} memory
 * @param {number} current
 */
export function restoreGeneration(memory, current) {
  const bytes = memory instanceof Uint8Array ? memory : new Uint8Array(memory);
  const n = bytes.byteLength >>> 2;
  let h = 2166136261;
  if (LITTLE_ENDIAN && (bytes.byteOffset & 3) === 0) {
    const w = new Uint32Array(bytes.buffer, bytes.byteOffset, n);
    for (let i = 0; i < n; i++) h = Math.imul(h ^ w[i], 16777619);
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
    for (let i = 0; i < n; i++) h = Math.imul(h ^ dv.getUint32(i * 4, true), 16777619);
  }
  let g = (h & 0x7fffffff) || 1;
  if (g === current) g = g === 0x7fffffff ? 1 : g + 1;
  return g;
}

/** Spec minimums: every host accepts at least this much per cart instance. */
export const JIT_LIMITS = Object.freeze({
  maxModuleBytes: 4 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFunctions: 65536,
  maxPending: 32,
});

export const JIT_OFF_NOTICE =
  'wasmcart: RUNTIME CODE GENERATION IS OFF on this host (WASMCART_JIT=0 or the host\'s jit:false). ' +
  'This cart asked for it and now runs without it. If it is slow or misbehaves, the cause is this ' +
  'setting, not the cart or wasmcart.';

/**
 * @param {object} opts
 * @param {() => WebAssembly.Instance|null} opts.getInstance  the cart instance asking now
 * @param {(inst: WebAssembly.Instance) => WebAssembly.Memory|null} [opts.getMemory]
 *   the instance's memory, for carts that import (shared) memory rather than export it
 * @param {'sync'|'async'|'auto'} [opts.mode]  'auto' = sync up to syncLimit bytes, async above
 * @param {number} [opts.syncLimit]  largest module compiled synchronously in 'auto' (4096)
 * @param {boolean} [opts.disabled]  the loud off switch: refuse every link
 * @param {(msg: string) => void} [opts.onNotice]  shown once, on the first JIT call while off
 * @param {number} [opts.threshold]  wc_jit_config key 0
 * @param {number} [opts.tierUp]  wc_jit_config key 2
 * @param {number} [opts.maxModuleBytes]  default: JIT_LIMITS (hosts must not go lower)
 * @param {number} [opts.maxTotalBytes]
 * @param {number} [opts.maxFunctions]
 * @param {number} [opts.maxPending]
 */
export function createJitImports(opts) {
  const getInstance = opts.getInstance;
  const getMemory = opts.getMemory || ((inst) => inst.exports.memory || null);
  const mode = opts.mode || 'sync';
  const syncLimit = mode === 'async' ? -1 : (mode === 'auto' ? (opts.syncLimit ?? 4096) : Infinity);
  const maxModuleBytes = opts.maxModuleBytes ?? JIT_LIMITS.maxModuleBytes;
  const maxTotalBytes = opts.maxTotalBytes ?? JIT_LIMITS.maxTotalBytes;
  const maxFunctions = opts.maxFunctions ?? JIT_LIMITS.maxFunctions;
  const maxPending = opts.maxPending ?? JIT_LIMITS.maxPending;
  const stats = {
    modules: 0, functions: 0, bytes: 0, pending: 0, failures: 0, refused: 0,
    deferred: 0, dropped: 0, unlinked: 0, compileMs: 0, lastError: null, offNoticed: false,
  };
  const now = () => (globalThis.performance ? performance.now() : Date.now());

  /** @type {WeakMap<object, any>} per-instance state */
  const states = new WeakMap();
  function stateOf(inst) {
    let s = states.get(inst);
    if (!s) {
      s = { inst, dead: false, epoch: 0, generation: 0, bytes: 0, functions: 0, pending: 0, reserved: 0,
        links: new Map(), free: [], held: [] };
      states.set(inst, s);
    }
    return s;
  }

  function offNotice() {
    if (stats.offNoticed) return;
    stats.offNoticed = true;
    (opts.onNotice || ((m) => console.error(m)))(JIT_OFF_NOTICE);
  }

  function resolveImports(mod, s) {
    const ex = s.inst.exports;
    const imports = { cart: {} };
    for (const imp of WebAssembly.Module.imports(mod)) {
      if (imp.module !== 'cart') throw new Error(`jit module imports from "${imp.module}", only "cart" is allowed`);
      let v = ex[imp.name];
      if (v === undefined && imp.name === 'memory' && imp.kind === 'memory') v = getMemory(s.inst) || undefined;
      if (v === undefined) throw new Error(`jit module imports cart.${imp.name}, which the cart does not export`);
      imports.cart[imp.name] = v;
    }
    return imports;
  }

  // Take n consecutive free slots, first fit, or grow the table.
  function takeSlots(s, table, n) {
    for (let i = 0; i < s.free.length; i++) {
      const r = s.free[i];
      if (r.count < n) continue;
      const first = r.start;
      if (r.count === n) s.free.splice(i, 1);
      else { r.start += n; r.count -= n; }
      return first;
    }
    return table.grow(n);
  }

  function giveSlots(s, start, count) {
    s.free.push({ start, count });
    s.free.sort((a, b) => a.start - b.start);
    for (let i = s.free.length - 1; i > 0; i--) {
      const a = s.free[i - 1], b = s.free[i];
      if (a.start + a.count === b.start) { a.count += b.count; s.free.splice(i, 1); }
    }
  }

  function install(mod, s, len) {
    const table = s.inst.exports.__indirect_function_table;
    if (!table) throw new Error('cart does not export __indirect_function_table');
    const fns = WebAssembly.Module.exports(mod).filter((e) => e.kind === 'function');
    if (!fns.length) throw new Error('jit module exports no function');
    if (s.functions + fns.length > maxFunctions) throw new Error(`jit function limit (${maxFunctions}) reached`);
    const inst = new WebAssembly.Instance(mod, resolveImports(mod, s));
    const first = takeSlots(s, table, fns.length);
    for (let i = 0; i < fns.length; i++) table.set(first + i, inst.exports[fns[i].name]);
    s.links.set(first, { count: fns.length, bytes: len });
    s.functions += fns.length;
    stats.modules++;
    stats.functions += fns.length;
    return first;
  }

  function writeCell(s, ptr, v) {
    if (!ptr) return;
    const mem = getMemory(s.inst);
    if (mem) new DataView(mem.buffer).setInt32(ptr, v, true);
  }

  function fail(s, e) {
    stats.failures++;
    stats.lastError = String((e && e.message) || e);
  }

  function refuse(s, resultPtr, code, why) {
    if (code === -3) stats.deferred++; else stats.refused++;
    stats.lastError = why;
    writeCell(s, resultPtr, code);
    return code;
  }

  function wc_jit_link(ptr, len, resultPtr) {
    const owner = getInstance();
    if (!owner) return -1;
    const s = stateOf(owner);
    ptr >>>= 0; len >>>= 0; resultPtr >>>= 0;
    if (opts.disabled) { offNotice(); return refuse(s, resultPtr, -1, 'runtime code generation is off on this host'); }
    const mem = getMemory(owner);
    if (!mem) return -1;
    if (len > maxModuleBytes) return refuse(s, resultPtr, -1, `jit module of ${len} bytes exceeds ${maxModuleBytes}`);
    if (s.bytes + len > maxTotalBytes) return refuse(s, resultPtr, -1, `jit total of ${maxTotalBytes} bytes reached`);
    if (s.functions + s.reserved >= maxFunctions) return refuse(s, resultPtr, -1, `jit function limit (${maxFunctions}) reached`);
    const sync = len <= syncLimit;
    if (!sync && s.pending >= maxPending) return refuse(s, resultPtr, -3, `${maxPending} jit compiles already in flight`);
    // Copy now: the cart owns the buffer again the moment this returns.
    const bytes = new Uint8Array(mem.buffer, ptr, len).slice();
    s.bytes += len;
    stats.bytes += len;
    const release = () => { s.bytes -= len; stats.bytes -= len; };
    if (sync) {
      const t0 = now();
      let slot = -1;
      try { slot = install(new WebAssembly.Module(bytes), s, len); } catch (e) { fail(s, e); release(); }
      stats.compileMs += now() - t0;
      writeCell(s, resultPtr, slot);
      return slot;
    }
    s.pending++; s.reserved++; stats.pending++;
    const epoch = s.epoch;
    const t0 = now();
    // Delivered only to the same live instance, and only if no restore reset
    // its slots meanwhile (the result cell may then mean something else).
    const current = () => !s.dead && s.epoch === epoch && getInstance() === owner;
    const settle = () => { s.pending--; s.reserved--; stats.pending--; stats.compileMs += now() - t0; };
    WebAssembly.compile(bytes).then((mod) => {
      settle();
      if (!current()) { stats.dropped++; release(); return; }
      let slot = -1;
      try { slot = install(mod, s, len); } catch (e) { fail(s, e); release(); }
      writeCell(s, resultPtr, slot);
    }, (e) => {
      settle();
      fail(s, e);
      release();
      if (!current()) { stats.dropped++; return; }
      writeCell(s, resultPtr, -1);
    });
    return -2;
  }

  function unlinkIn(s, first, hold = false) {
    const link = s.links.get(first);
    if (!link) return;
    s.links.delete(first);
    const table = s.inst.exports.__indirect_function_table;
    for (let i = 0; i < link.count; i++) table.set(first + i, null);
    if (hold) s.held.push([first, link.count]); else giveSlots(s, first, link.count);
    s.functions -= link.count;
    s.bytes -= link.bytes;
    stats.functions -= link.count;
    stats.bytes -= link.bytes;
    stats.modules--;
    stats.unlinked++;
  }

  function wc_jit_unlink(first) {
    const owner = getInstance();
    if (!owner) return;
    const s = stateOf(owner);
    if (opts.disabled) offNotice();
    unlinkIn(s, first | 0);
  }

  function wc_jit_config(key) {
    if (opts.disabled) offNotice();
    switch (key) {
      case 0: return Number.isInteger(opts.threshold) ? opts.threshold : -1;
      case 1: return opts.disabled ? 1 : -1;
      case 2: return Number.isInteger(opts.tierUp) ? opts.tierUp : -1;
      case 3: return Math.min(maxModuleBytes, 0x7fffffff);
      case 4: return Math.min(maxTotalBytes, 0x7fffffff);
      case 5: return Math.min(maxFunctions, 0x7fffffff);
      case 6: return Math.min(maxPending, 0x7fffffff);
      case 7: {
        const inst = getInstance();
        if (!inst) return 0;
        const s = stateOf(inst);
        // The cart has now seen this generation: slots freed by the restore
        // may be handed out again.
        for (const [first, count] of s.held.splice(0)) giveSlots(s, first, count);
        return s.generation;
      }
      default: return -1;
    }
  }

  return {
    imports: { wc_jit_link, wc_jit_unlink, wc_jit_config },
    stats,
    /**
     * Unlink every slot of the current instance, drop its in-flight
     * compiles and change its restore generation (wc_jit_config key 7), as
     * one step. A host calls this right after writing a save state back
     * (restore, rewind): JIT slots are never carried across a restore. The
     * freed slots stay unused until the cart reads key 7.
     */
    unlinkAll() {
      const inst = getInstance();
      if (!inst) return;
      const s = stateOf(inst);
      s.epoch++;
      const mem = getMemory(inst);
      s.generation = restoreGeneration(mem ? mem.buffer : new ArrayBuffer(0), s.generation);
      for (const first of [...s.links.keys()]) unlinkIn(s, first, true);
    },
    /** The current instance is going away: drop anything still compiling for it. */
    dispose() {
      const inst = getInstance();
      if (inst) stateOf(inst).dead = true;
    },
  };
}

/**
 * The JIT knobs from the environment (Node). WASMCART_JIT=0 is the loud off
 * switch; WASMCART_JIT_THRESHOLD / WASMCART_JIT_TIERUP feed wc_jit_config
 * keys 0 and 2; WASMCART_JIT_MODE=sync|async|auto picks the compile path.
 */
export function jitOptionsFromEnv(env = (globalThis.process && process.env) || {}) {
  const o = {};
  if (env.WASMCART_JIT === '0') o.disabled = true;
  const int = (v) => { const n = Number(v); return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : undefined; };
  const t = int(env.WASMCART_JIT_THRESHOLD);
  if (t !== undefined) o.threshold = t;
  const u = int(env.WASMCART_JIT_TIERUP);
  if (u !== undefined) o.tierUp = u;
  if (env.WASMCART_JIT_MODE) o.mode = env.WASMCART_JIT_MODE;
  return o;
}
