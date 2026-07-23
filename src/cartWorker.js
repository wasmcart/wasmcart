/**
 * cartWorker.js - WASI threads worker entry point
 *
 * Runs in a Node.js worker_thread. Receives a compiled WebAssembly.Module
 * and shared WebAssembly.Memory, instantiates the module, and calls
 * wasi_thread_start(tid, start_arg).
 *
 * All pthread logic (mutexes, condvars, TLS) lives inside the WASM module
 * via wasi-libc. This worker just provides the host-side imports.
 */

import { workerData, parentPort } from 'worker_threads';
import { openSync, readSync, closeSync, statSync } from 'fs';
import { inflateRawSync } from 'zlib';

const { module: wasmModule, memory, tid, startArg, assetConfig } = workerData;

// --- Asset access (worker opens its own fd for the .wasc file) ---

let assetIndex = null; // Map<path, entry>
let assetFd = null;
let assetBuf = null;

if (assetConfig) {
  if (assetConfig.type === 'zip' && assetConfig.filePath) {
    assetFd = openSync(assetConfig.filePath, 'r');
    assetIndex = new Map(assetConfig.index);
  } else if (assetConfig.type === 'buffer' && assetConfig.buffer) {
    assetBuf = assetConfig.buffer;
    assetIndex = new Map(assetConfig.index);
  } else if (assetConfig.type === 'dir' && assetConfig.dir) {
    // Directory-based dev mode - not supported in worker yet
    // (would need readFileSync, rarely used with threaded carts)
  }
}

function readZipEntry(fd, entry) {
  const buf = Buffer.alloc(entry.compressedSize);
  readSync(fd, buf, 0, entry.compressedSize, entry.dataOffset);
  if (entry.compressionMethod === 0) return buf;
  if (entry.compressionMethod === 8) return inflateRawSync(buf);
  return null;
}

function readZipEntryFromBuffer(buf, entry) {
  const data = buf.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) return data;
  if (entry.compressionMethod === 8) return inflateRawSync(data);
  return null;
}

function assetSize(pathPtr, pathLen) {
  if (!assetIndex) return -1;
  const path = new TextDecoder().decode(new Uint8Array(memory.buffer, pathPtr, pathLen));
  const entry = assetIndex.get(path);
  return entry ? entry.uncompressedSize : -1;
}

function loadAsset(pathPtr, pathLen, destPtr, maxSize) {
  if (!assetIndex) return -1;
  const path = new TextDecoder().decode(new Uint8Array(memory.buffer, pathPtr, pathLen));
  const entry = assetIndex.get(path);
  if (!entry) return -1;
  if (entry.uncompressedSize > maxSize) return -1;

  let data;
  if (assetFd !== null) {
    data = readZipEntry(assetFd, entry);
  } else if (assetBuf) {
    data = readZipEntryFromBuffer(assetBuf, entry);
  } else {
    return -1;
  }
  if (!data) return -1;

  // Write into shared WASM memory
  const dest = new Uint8Array(memory.buffer, destPtr, data.length);
  dest.set(new Uint8Array(data.buffer || data, data.byteOffset, data.length));
  return data.length;
}

// --- Build import object ---

const imports = {
  env: {
    memory,
    wc_log: (ptr, len) => {
      const bytes = new Uint8Array(memory.buffer).slice(ptr, ptr + len);
      const text = new TextDecoder().decode(bytes);
      console.log(`[cart:t${tid}]`, text);
    },
    wc_asset_size: assetSize,
    wc_load_asset: loadAsset,
    wc_debug_mark: () => {}, // debug-ABI annotation — main-thread host captures; workers no-op
    emscripten_notify_memory_growth: () => {},
    emscripten_asm_const_int: () => 0,
    emscripten_asm_const_double: () => 0.0,
    emscripten_get_element_css_size: () => 0,
    __syscall_getcwd: () => -1,
    __syscall_getdents64: () => -1,
  },
  wasi_snapshot_preview1: {
    fd_close: () => 0,
    fd_write: (fd, iovs, iovs_len, nwritten_ptr) => {
      try {
        const view = new DataView(memory.buffer);
        const u8 = new Uint8Array(memory.buffer);
        let totalWritten = 0;
        let text = '';
        for (let i = 0; i < iovs_len; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          if (len > 0) text += new TextDecoder().decode(u8.slice(ptr, ptr + len));
          totalWritten += len;
        }
        if (text && (fd === 1 || fd === 2)) {
          for (const line of text.split('\n')) {
            if (line.length > 0) process.stderr.write(`[cart:t${tid}] ${line}\n`);
          }
        }
        if (nwritten_ptr) view.setUint32(nwritten_ptr, totalWritten, true);
      } catch {}
      return 0;
    },
    fd_seek: () => 0,
    fd_read: () => 0,
    environ_get: () => 0,
    environ_sizes_get: () => 0,
    proc_exit: () => {},
    clock_time_get: (id, precision, resultPtr) => {
      try {
        const ns = BigInt(Math.round(performance.now() * 1e6));
        new DataView(memory.buffer).setBigUint64(resultPtr, ns, true);
      } catch {}
      return 0;
    },
    sched_yield: () => 0,
  },
  wasi: {
    'thread-spawn': (arg) => {
      // Nested thread spawning: request main thread to do it
      // For now, use synchronous message exchange
      // TODO: use Atomics.wait/notify for true sync if needed
      parentPort.postMessage({ type: 'spawn', startArg: arg });
      // Return -1 for now (nested spawn needs async handling)
      // Full implementation would use Atomics.wait on a shared buffer
      return -1;
    },
  },
};

// Provide GL stubs if the module imports GL functions (they must not be called from workers)
const moduleImports = WebAssembly.Module.imports(wasmModule);
for (const imp of moduleImports) {
  if (imp.kind !== 'function') continue;
  // GL functions in 'gl' module
  if (imp.module === 'gl') {
    if (!imports.gl) imports.gl = {};
    imports.gl[imp.name] = () => {
      throw new Error(`GL call ${imp.name}() not allowed from worker thread ${tid}`);
    };
  }
  // GL functions in 'env' module (gl4es pattern)
  if (imp.module === 'env' && (imp.name.startsWith('gl') || imp.name.startsWith('emscripten_gl'))) {
    if (!(imp.name in imports.env)) {
      imports.env[imp.name] = () => {
        throw new Error(`GL call ${imp.name}() not allowed from worker thread ${tid}`);
      };
    }
  }
  // Other unknown env functions - provide no-op stubs to avoid instantiation failure
  if (imp.module === 'env' && !(imp.name in imports.env)) {
    imports.env[imp.name] = () => 0;
  }
  // Unknown wasi_snapshot_preview1 functions - no-op stubs
  if (imp.module === 'wasi_snapshot_preview1' && !(imp.name in imports.wasi_snapshot_preview1)) {
    imports.wasi_snapshot_preview1[imp.name] = () => 0;
  }
}

// --- Instantiate and run ---

async function run() {
  const instance = await WebAssembly.instantiate(wasmModule, imports);

  // Call the thread entry point
  instance.exports.wasi_thread_start(tid, startArg);

  // Thread function returned - clean up and notify main thread
  if (assetFd !== null) {
    try { closeSync(assetFd); } catch {}
  }
  parentPort.postMessage({ type: 'exit', tid });
}

run().catch(err => {
  console.error(`[thread ${tid}] fatal:`, err.message);
  if (assetFd !== null) {
    try { closeSync(assetFd); } catch {}
  }
  parentPort.postMessage({ type: 'exit', tid, error: err.message });
});
