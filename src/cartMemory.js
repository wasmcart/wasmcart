// cartMemory.js - how a host gets memory INSIDE a cart to write into.
//
// Some host calls must hand the cart bytes at an address the host picks:
// glGetString returns a pointer to a string, glMapBufferRange a pointer to a
// mapping, the WebGPU glue passes error messages and adapter info, and text
// and network payloads are delivered as (ptr, len). The host never owns any
// of the cart's memory, so it asks the cart to allocate: the cart's optional
// exports
//
//     wc_alloc(size, align) -> ptr   (0 on failure)
//     wc_free(ptr)
//
// (SPEC.md, "Cart memory the host writes"). wasmcart.h, the CMake helper and
// the wasmcart-alloc Rust crate define and export them, so a cart author never
// writes them. A cart that never reaches such a path needs neither.
//
// Every pointer the cart returns is checked against its memory before the
// host writes through it. There is no fallback that writes anywhere else: the
// old one wrote at the top of memory, which is the cart's live heap.
//
// Transition: a cart built before 0.32 exports malloc/free (Emscripten does by
// default) instead. That still works, with one deprecation warning per cart.

const DOCS = 'See SPEC.md, "Cart memory the host writes".';

/** The error a cart gets when a host path needs an allocator it lacks. */
export function missingAllocatorMessage(what) {
  return `wasmcart: ${what} must write into the cart's memory, but the cart exports no allocator. ` +
    'Export wc_alloc(size, align) and wc_free(ptr): wasmcart.h defines them for C/C++ (include it), ' +
    "wasmcart's CMake helper exports them, and Rust carts get them from the wasmcart-alloc crate. " + DOCS;
}

export const DEPRECATED_MALLOC_MESSAGE =
  'wasmcart: this cart has no wc_alloc/wc_free, so the host is allocating in it through its exported malloc/free. ' +
  "That fallback is deprecated and will be removed: rebuild against wasmcart 0.32's wasmcart.h " +
  '(or export wc_alloc and wc_free yourself).';

/** A host-to-cart allocation failed or was refused; `code` says which. */
export class CartMemoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CartMemoryError';
    this.code = code; // 'missing' | 'oom' | 'bounds' | 'align'
  }
}

/**
 * The allocator for one cart instance.
 *
 * @param {object} o
 * @param {() => object|null} o.getExports - the cart's exports (null before instantiation)
 * @param {() => WebAssembly.Memory|null} o.getMemory - the cart's memory
 * @param {(msg: string) => void} [o.warn] - where the deprecation warning goes (console.warn)
 */
export function createCartAllocator({ getExports, getMemory, warn = (m) => console.warn(m) }) {
  let resolved = null; // { kind, alloc(size, align), free(ptr)|null, name }
  let warned = false;
  // For a malloc-only cart (no free): the largest released block, reused.
  let spare = null;

  function resolve() {
    if (resolved) return resolved;
    const ex = getExports() || {};
    if (typeof ex.wc_alloc === 'function' && typeof ex.wc_free === 'function') {
      resolved = { kind: 'wc_alloc', name: 'wc_alloc', alloc: (s, a) => ex.wc_alloc(s, a) >>> 0, free: (p) => ex.wc_free(p) };
    } else if (typeof ex.malloc === 'function' || typeof ex.memalign === 'function') {
      const malloc = ex.malloc, memalign = ex.memalign, cfree = typeof ex.free === 'function' ? ex.free : null;
      // malloc only promises 8-byte alignment on wasm32. For more, use
      // memalign, or over-allocate and hand out an aligned pointer inside the
      // block (remembering the block's own pointer for free).
      const inner = new Map(); // aligned pointer -> malloc's pointer
      resolved = {
        kind: 'malloc',
        name: 'malloc',
        alloc: (s, a) => {
          if (typeof memalign === 'function' && (a > 8 || typeof malloc !== 'function')) {
            resolved.name = 'memalign';
            return memalign(a, s) >>> 0;
          }
          resolved.name = 'malloc';
          if (a <= 8) return malloc(s) >>> 0;
          const base = malloc(s + a - 1) >>> 0;
          if (!base) return 0;
          const p = (base + a - 1) & ~(a - 1);
          if (p !== base) inner.set(p, base);
          return p >>> 0;
        },
        free: cfree ? (p) => { const base = inner.get(p); if (base !== undefined) inner.delete(p); cfree(base ?? p); } : null,
      };
    } else {
      return null;
    }
    return resolved;
  }

  return {
    /** 'wc_alloc', 'malloc' (deprecated) or null: what this cart offers. */
    get kind() { return resolve()?.kind || null; },

    /**
     * Allocate `size` bytes aligned to `align` in the cart, checked. Throws a
     * CartMemoryError naming `what` (the host call that needed it) when the
     * cart has no allocator, is out of memory, or returns a bad pointer.
     * Read memory views AFTER this: the cart may have grown its memory.
     */
    alloc(size, align, what) {
      size = Math.max(1, size >>> 0);
      align = Math.max(1, align >>> 0);
      if (align & (align - 1)) throw new RangeError(`cartMemory: alignment ${align} is not a power of two`);
      const a = resolve();
      if (!a) throw new CartMemoryError(missingAllocatorMessage(what), 'missing');
      if (a.kind === 'malloc' && !warned) { warned = true; warn(DEPRECATED_MALLOC_MESSAGE); }
      if (!a.free && spare && spare.size >= size && spare.ptr % align === 0) {
        const p = spare.ptr; spare = null; return p;
      }
      const ptr = a.alloc(size, align);
      const call = `the cart's ${a.name}(${size}, ${align})`;
      if (ptr === 0) throw new CartMemoryError(`wasmcart: ${what}: ${call} returned 0 (out of memory)`, 'oom');
      const memSize = getMemory().buffer.byteLength;
      if (ptr + size > memSize) {
        throw new CartMemoryError(`wasmcart: ${what}: ${call} returned 0x${ptr.toString(16)}, which is outside its ${memSize}-byte memory`, 'bounds');
      }
      if (ptr % align !== 0) {
        throw new CartMemoryError(`wasmcart: ${what}: ${call} returned 0x${ptr.toString(16)}, which is not ${align}-byte aligned`, 'align');
      }
      return ptr;
    },

    /** Release a block from alloc(). `size` lets a cart without free reuse it. */
    free(ptr, size = 0) {
      if (!ptr) return;
      const a = resolve();
      if (!a) return;
      if (a.free) { a.free(ptr); return; }
      if (!spare || size > spare.size) spare = { ptr, size };
    },

    /** Copy `bytes` into a fresh cart allocation; returns its pointer. */
    allocBytes(bytes, what, { terminate = false, align = 1 } = {}) {
      const ptr = this.alloc(bytes.length + (terminate ? 1 : 0), align, what);
      const u8 = new Uint8Array(getMemory().buffer);
      u8.set(bytes, ptr);
      if (terminate) u8[ptr + bytes.length] = 0;
      return ptr;
    },
  };
}
