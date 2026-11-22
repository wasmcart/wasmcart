/**
 * cartWorkerWeb.js - WASI threads worker for browser
 *
 * Receives a compiled WebAssembly.Module and shared WebAssembly.Memory
 * via postMessage, instantiates the module, and calls
 * wasi_thread_start(tid, start_arg).
 */

import { createJitImports } from './jit.js';
import { WORKER_ACTION_IMPORTS } from './actions.js';

let inflateSync = null;

let memory;
let tid;
let assetBlob = null;
let assetIndex = null;
let reader = null;

// Bytes [start, end) of the archive Blob, read synchronously (a worker may).
function blobBytes(start, end) {
  reader ??= new FileReaderSync();
  return new Uint8Array(reader.readAsArrayBuffer(assetBlob.slice(start, end)));
}

/* One entry from the archive Blob: its local header (the data starts after
 * the header's own name and extra field), then only its data. The archive is
 * never read whole: the host passes the Blob as a handle. */
function readZipEntry(entry) {
  if (entry.dataOffset === undefined) {
    const h = blobBytes(entry.localHeaderOffset, entry.localHeaderOffset + 30);
    if (h.length < 30) return null;
    entry.dataOffset = entry.localHeaderOffset + 30 + (h[26] | (h[27] << 8)) + (h[28] | (h[29] << 8));
  }
  const compressedData = blobBytes(entry.dataOffset, entry.dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressedData;
  if (entry.compressionMethod === 8) {
    if (!inflateSync) throw new Error('fflate not loaded - cannot decompress asset');
    return inflateSync(compressedData);
  }
  return null;
}

function assetSize(pathPtr, pathLen) {
  if (!assetIndex) return -1;
  const path = new TextDecoder().decode(new Uint8Array(memory.buffer, pathPtr, pathLen).slice());
  const entry = assetIndex.get(path);
  return entry ? entry.uncompressedSize : -1;
}

function loadAsset(pathPtr, pathLen, destPtr, maxSize) {
  if (!assetIndex) return -1;
  const path = new TextDecoder().decode(new Uint8Array(memory.buffer, pathPtr, pathLen).slice());
  const entry = assetIndex.get(path);
  if (!entry) return -1;
  if (entry.uncompressedSize > maxSize) return -1;

  if (!assetBlob) return -1;
  let data;
  try {
    data = readZipEntry(entry);
  } catch (e) {
    console.warn(`[thread] could not read asset ${path}: ${e?.message ?? e}`);
    return -1;
  }
  if (!data) return -1;

  const dest = new Uint8Array(memory.buffer, destPtr, data.length);
  dest.set(data.subarray ? data.subarray(0, data.length) : new Uint8Array(data, 0, data.length));
  return data.length;
}

self.onmessage = async function(e) {
  const { module: wasmModule, memory: sharedMemory, tid: threadId, startArg, assetConfig, jitDisabled } = e.data;
  memory = sharedMemory;
  tid = threadId;

  // Set up asset access
  if (assetConfig && assetConfig.type === 'blob' && assetConfig.blob) {
    assetBlob = assetConfig.blob;
    assetIndex = new Map(assetConfig.index);
    // Load fflate dynamically for asset decompression (only an archive with
    // deflated entries needs it)
    if ([...assetIndex.values()].some((e) => e.compressionMethod === 8)) try {
      const fflate = await import('fflate');
      inflateSync = fflate.inflateSync;
    } catch (e) {
      console.warn(`[thread] fflate not available - compressed assets will fail`);
    }
  }

  // Runtime code generation: this thread's instance has its own table and
  // links into its own slots. A worker may compile synchronously; the
  // off-switch notice is the main thread's to show.
  let instance = null;
  const jit = createJitImports({
    getInstance: () => instance,
    getMemory: () => memory,
    mode: 'sync',
    disabled: !!jitDisabled,
    onNotice: () => {},
  });
  const imports = {
    env: {
      memory,
      ...jit.imports,
      ...WORKER_ACTION_IMPORTS, // input actions are main-thread state; threads get "unknown"
      wc_log: (ptr, len) => {
        const bytes = new Uint8Array(memory.buffer).slice(ptr, ptr + len);
        const text = new TextDecoder().decode(bytes);
        console.warn(`[cart:t${tid}]`, text);
      },
      wc_asset_size: assetSize,
      wc_load_asset: loadAsset,
      // Asset prefetch is main-thread state (SPEC.md, "Asset prefetch"): a cart
      // thread's call is REFUSED (-3) and its reads go to the archive as before.
      wc_asset_prefetch: () => -3,
      wc_asset_prefetch_cancel: () => {},
      wc_debug_mark: () => {}, // debug-ABI annotation — main-thread host captures; workers no-op
      // Loop inversion is a MAIN-THREAD protocol: only the thread inside
      // wc_render can unwind out of it. A spawned pthread never yields, so
      // this is a no-op here -- but it must still be PRESENT, because the
      // worker instantiates the same module and a missing import is a
      // LinkError, which would make every loop-inverted threaded cart fail
      // to spawn threads at all.
      wc_frame_yield: () => {},
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
            console.warn(`[cart:t${tid}]`, text);
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
        self.postMessage({ type: 'spawn', startArg: arg });
        return -1;
      },
    },
  };

  // Stub GL and unknown imports
  const moduleImports = WebAssembly.Module.imports(wasmModule);
  for (const imp of moduleImports) {
    if (imp.kind !== 'function') continue;
    if (imp.module === 'gl') {
      if (!imports.gl) imports.gl = {};
      imports.gl[imp.name] = () => {
        throw new Error(`GL call ${imp.name}() not allowed from worker thread ${tid}`);
      };
    }
    if (imp.module === 'env' && (imp.name.startsWith('gl') || imp.name.startsWith('emscripten_gl'))) {
      if (!(imp.name in imports.env)) {
        imports.env[imp.name] = () => {
          throw new Error(`GL call ${imp.name}() not allowed from worker thread ${tid}`);
        };
      }
    }
    if (imp.module === 'env' && !(imp.name in imports.env)) {
      imports.env[imp.name] = () => 0;
    }
    if (imp.module === 'wasi_snapshot_preview1' && !(imp.name in imports.wasi_snapshot_preview1)) {
      imports.wasi_snapshot_preview1[imp.name] = () => 0;
    }
  }

  try {
    instance = await WebAssembly.instantiate(wasmModule, imports);
    instance.exports.wasi_thread_start(tid, startArg);
    self.postMessage({ type: 'exit', tid });
  } catch (err) {
    console.error(`[thread ${tid}] fatal:`, err.message);
    self.postMessage({ type: 'exit', tid, error: err.message });
  }
};
