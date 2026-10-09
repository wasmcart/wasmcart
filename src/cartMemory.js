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
// Only wc_alloc/wc_free count. A cart's malloc/free (Emscripten exports them)
// are never used: the host cannot know they are the cart's real allocator, and
// a cart without wc_alloc gets the same error as one with nothing.

const DOCS = 'See SPEC.md, "Cart memory the host writes".';

/** The error a cart gets when a host path needs an allocator it lacks. */
export function missingAllocatorMessage(what) {
  return `wasmcart: ${what} must write into the cart's memory, but the cart does not export wc_alloc/wc_free ` +
    '(its malloc, if any, is not used). Export wc_alloc(size, align) and wc_free(ptr): wasmcart.h defines them for C/C++ (include it), ' +
    "wasmcart's CMake helper exports them, and Rust carts get them from the wasmcart-alloc crate. " + DOCS;
}

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
 */
export function createCartAllocator({ getExports, getMemory }) {
  let resolved = null; // { alloc(size, align), free(ptr) }

  function resolve() {
    if (resolved) return resolved;
    const ex = getExports() || {};
    if (typeof ex.wc_alloc !== 'function' || typeof ex.wc_free !== 'function') return null;
    resolved = { alloc: (s, a) => ex.wc_alloc(s, a) >>> 0, free: (p) => ex.wc_free(p) };
    return resolved;
  }

  return {
    /** True if the cart exports wc_alloc and wc_free. */
    get available() { return !!resolve(); },

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
      const ptr = a.alloc(size, align);
      const call = `the cart's wc_alloc(${size}, ${align})`;
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

    /** Release a block from alloc(). */
    free(ptr) {
      if (!ptr) return;
      resolve()?.free(ptr);
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
