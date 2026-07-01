/**
 * cartWorkerWeb.js - WASI threads worker for browser
 *
 * Receives a compiled WebAssembly.Module and shared WebAssembly.Memory
 * via postMessage, instantiates the module, and calls
 * wasi_thread_start(tid, start_arg).
 */

let inflateSync = null;

let memory;
let tid;
let assetBuf = null;
let assetIndex = null;

function readZipEntryFromBuffer(buf, entry) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nameLen = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLen = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;

  const compressedData = buf.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressedData;
  if (entry.compressionMethod === 8) {
    if (!inflateSync) throw new Error('fflate not loaded - cannot decompress asset');
    return inflateSync(compressedData);
  }
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
  if (assetBuf) {
    data = readZipEntryFromBuffer(assetBuf, entry);
  } else {
    return -1;
  }
  if (!data) return -1;

  const dest = new Uint8Array(memory.buffer, destPtr, data.length);
  dest.set(data.subarray ? data.subarray(0, data.length) : new Uint8Array(data, 0, data.length));
  return data.length;
}

self.onmessage = async function(e) {
  const { module: wasmModule, memory: sharedMemory, tid: threadId, startArg, assetConfig } = e.data;
  memory = sharedMemory;
  tid = threadId;

  // Set up asset access
  if (assetConfig && assetConfig.type === 'buffer' && assetConfig.buffer) {
    assetBuf = new Uint8Array(assetConfig.buffer);
    assetIndex = new Map(assetConfig.index);
    // Load fflate dynamically for asset decompression
    try {
      const fflate = await import('fflate');
      inflateSync = fflate.inflateSync;
    } catch (e) {
      console.warn(`[thread] fflate not available - compressed assets will fail`);
    }
  }

  const imports = {
    env: {
      memory,
      wc_log: (ptr, len) => {
        const bytes = new Uint8Array(memory.buffer).slice(ptr, ptr + len);
        const text = new TextDecoder().decode(bytes);
        console.warn(`[cart:t${tid}]`, text);
      },
      wc_asset_size: assetSize,
      wc_load_asset: loadAsset,
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
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    instance.exports.wasi_thread_start(tid, startArg);
    self.postMessage({ type: 'exit', tid });
  } catch (err) {
    console.error(`[thread ${tid}] fatal:`, err.message);
    self.postMessage({ type: 'exit', tid, error: err.message });
  }
};
