import { readFile, stat } from 'fs/promises';
import { openSync, readSync, closeSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { open as yauzlOpen } from 'yauzl';
import { inflateRawSync } from 'zlib';
import { Worker } from 'worker_threads';
import {
  ABI_VERSION,
  MIN_ABI_VERSION,
  INFO_FIELDS,
  HOST_INFO_FIELDS,
  PAD_SIZE,
  MAX_PADS,
  TIME_SIZE,
  FLAG_NET_WS,
  FLAG_NET_DC,
  FLAG_POINTER,
  FLAG_KEYBOARD,
  POINTER_SIZE,
  MAX_POINTERS,
  KEYS_STATE_SIZE,
} from './abi.js';
import { createWebGLImports } from './webgl_imports.js';

// --- Path validation for asset security ---

function validateAssetPath(path) {
  // Reject absolute paths
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  // Reject Windows drive letters
  if (/^[a-zA-Z]:/.test(path)) return false;
  // Reject path traversal
  if (path.includes('..')) return false;
  // Reject null bytes (C string truncation attacks)
  if (path.includes('\0')) return false;
  // Reject backslashes (normalize to forward slash only)
  if (path.includes('\\')) return false;
  return true;
}

// --- ZIP central directory parser for random-access reads ---

function parseZipCentralDirectory(fd, fileSize) {
  // Find End of Central Directory record (last 65KB max)
  const searchSize = Math.min(fileSize, 65536 + 22);
  const searchBuf = Buffer.alloc(searchSize);
  readSync(fd, searchBuf, 0, searchSize, fileSize - searchSize);

  // Find EOCD signature (0x06054b50)
  let eocdOffset = -1;
  for (let i = searchBuf.length - 22; i >= 0; i--) {
    if (searchBuf[i] === 0x50 && searchBuf[i + 1] === 0x4b &&
        searchBuf[i + 2] === 0x05 && searchBuf[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file (EOCD not found)');

  const entryCount = searchBuf.readUInt16LE(eocdOffset + 10);
  const cdSize = searchBuf.readUInt32LE(eocdOffset + 12);
  const cdOffset = searchBuf.readUInt32LE(eocdOffset + 16);

  // Read entire central directory
  const cdBuf = Buffer.alloc(cdSize);
  readSync(fd, cdBuf, 0, cdSize, cdOffset);

  const index = new Map();
  let pos = 0;

  for (let i = 0; i < entryCount; i++) {
    // Central directory file header signature (0x02014b50)
    if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;

    const compressionMethod = cdBuf.readUInt16LE(pos + 10);
    const compressedSize = cdBuf.readUInt32LE(pos + 20);
    const uncompressedSize = cdBuf.readUInt32LE(pos + 24);
    const nameLen = cdBuf.readUInt16LE(pos + 28);
    const extraLen = cdBuf.readUInt16LE(pos + 30);
    const commentLen = cdBuf.readUInt16LE(pos + 32);
    const externalAttrs = cdBuf.readUInt32LE(pos + 38);
    const localHeaderOffset = cdBuf.readUInt32LE(pos + 42);

    const fileName = cdBuf.toString('utf8', pos + 46, pos + 46 + nameLen);

    // Skip directories and symlinks
    const isDir = fileName.endsWith('/');
    const isSymlink = ((externalAttrs >> 16) & 0xF000) === 0xA000;

    if (!isDir && !isSymlink) {
      index.set(fileName, {
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return index;
}

function readZipEntry(fd, entry) {
  // Read local file header to get actual data offset
  const localBuf = Buffer.alloc(30);
  readSync(fd, localBuf, 0, 30, entry.localHeaderOffset);

  const nameLen = localBuf.readUInt16LE(26);
  const extraLen = localBuf.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;

  // Read compressed data
  const compressedBuf = Buffer.alloc(entry.compressedSize);
  readSync(fd, compressedBuf, 0, entry.compressedSize, dataOffset);

  // Decompress if needed
  if (entry.compressionMethod === 0) {
    // Stored (no compression)
    return compressedBuf;
  } else if (entry.compressionMethod === 8) {
    // Deflate
    return inflateRawSync(compressedBuf);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
  }
}

// --- In-memory ZIP parser for ArrayBuffer-based loading ---

function parseZipFromBuffer(buf) {
  // Find EOCD
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b &&
        buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const index = new Map();
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;

    const compressionMethod = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const externalAttrs = view.getUint32(pos + 38, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const decoder = new TextDecoder();
    const fileName = decoder.decode(buf.subarray(pos + 46, pos + 46 + nameLen));

    const isDir = fileName.endsWith('/');
    const isSymlink = ((externalAttrs >> 16) & 0xF000) === 0xA000;

    if (!isDir && !isSymlink) {
      index.set(fileName, {
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return index;
}

function readZipEntryFromBuffer(buf, entry) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nameLen = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLen = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;

  const compressedData = buf.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressedData;
  } else if (entry.compressionMethod === 8) {
    return inflateRawSync(compressedData);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
  }
}

// Max single asset size (256MB)
const MAX_ASSET_SIZE = 256 * 1024 * 1024;
// Max entries in a .wasc archive
const MAX_ARCHIVE_ENTRIES = 100000;

export class CartHost {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.info = null;       // parsed WCInfo
    this.frameCount = 0;
    this.startTime = 0;
    this.lastFrameTime = 0;
    this.audioReadCursor = 0;

    // Views into cart memory (set after init)
    this._u8 = null;
    this._u16 = null;
    this._i16 = null;
    this._u32 = null;
    this._f64 = null;
    this._lastByteLength = 0;

    // Thread support (WASI threads)
    this.isThreaded = false;
    this._sharedMemory = null;
    this._compiledModule = null;
    this._workers = new Map();   // tid → Worker
    this._nextTid = 1;

    // GL state
    this.usesGL = false;       // true if cart imports from 'gl' module

    // Asset index for .wasc carts
    this._assetIndex = null;   // Map<path, entry>
    this._assetFd = null;      // file descriptor for on-disk zip reading
    this._assetBuf = null;     // in-memory zip buffer (for Uint8Array source)
    this._assetDir = null;     // directory path for dev-mode loading
    this._hasAssets = false;

    // Networking (ABI v3)
    this._manifest = null;     // parsed manifest.json
    this._wsConnections = new Map();  // conn_id → { ws, eventQueue: [] }
    this._wsNextId = 0;
    this._dcPeers = new Map();        // peer_id → { dc, label, eventQueue: [] }

    // Pointer input (ABI v3)
    this._pointerState = new Array(MAX_POINTERS).fill(null).map(() => ({
      x: 0, y: 0, buttons: 0, active: 0,
    }));
    this._pointerEvents = [];  // { type, id, x, y, button }

    // Keyboard input (ABI v3)
    this._keyState = new Uint8Array(KEYS_STATE_SIZE); // 256-bit bitmask
    this._keyEvents = [];  // { type, keycode, modifiers }

    // Pad names (populated each frame from pad objects)
    this._padNames = ['', '', '', ''];
  }

  /**
   * Load and instantiate a .wasc cart file.
   * @param {string|Uint8Array} source - file path (.wasc), directory path (dev mode), or .wasc zip bytes
   * @param {object} [options]
   * @param {Uint8Array} [options.saveData] - existing save data to load
   * @param {object} [options.glBackend] - WebGL2RenderingContext (from webgl-node or browser). Required if cart uses GL.
   */
  async load(source, options = {}) {
    let wasmBytes;

    if (typeof source === 'string') {
      const s = await stat(source);

      if (s.isDirectory()) {
        // Dev mode: load from directory
        wasmBytes = await this._loadFromDirectory(source);
      } else {
        wasmBytes = await this._loadFromWasc(source);
      }
    } else {
      // Uint8Array - must be a .wasc zip
      if (source.length >= 4 && source[0] === 0x50 && source[1] === 0x4b &&
          source[2] === 0x03 && source[3] === 0x04) {
        wasmBytes = this._loadFromWascBuffer(source);
      } else {
        throw new Error('Invalid cart data: expected .wasc (ZIP) format');
      }
    }

    // Validate module before instantiation
    const module = await WebAssembly.compile(wasmBytes);
    this._validateModule(module);

    // Detect thread usage (WASI threads model)
    const threadAnalysis = this._analyzeModule(module);
    this.isThreaded = threadAnalysis.isThreaded;

    // For threaded carts: create shared memory and store module for worker reuse
    if (this.isThreaded) {
      const memLimits = CartHost._parseMemoryImportLimits(wasmBytes);
      if (!memLimits || !memLimits.shared) {
        throw new Error('Threaded cart must have shared memory import (compile with --shared-memory)');
      }
      this._sharedMemory = new WebAssembly.Memory({
        initial: memLimits.initial,
        maximum: memLimits.maximum,
        shared: true,
      });
      this._compiledModule = module;
    }

    // Detect GL usage: check gpu_api field first, fall back to import scanning for old carts
    const moduleImports = WebAssembly.Module.imports(module);
    const importsGL = moduleImports.some(imp =>
      imp.module === 'gl' ||
      (imp.module === 'env' && imp.kind === 'function' && /^gl[A-Z]/.test(imp.name))
    );
    // gpu_api will be read after wc_get_info - for now detect from imports
    this._importsGL = importsGL;
    this.usesGL = importsGL;

    if (this.usesGL && !options.glBackend) {
      // Cart imports GL but no GL backend provided - stub GL imports.
      // Cart can still use 2D framebuffer.
      this.usesGL = false;
    }
    // If glBackend IS provided, keep usesGL = true even with fbPtr (hybrid cart)

    // Eagerly resolve WebSocket implementation for Node.js (must be sync at call time)
    if (this._manifest?.net?.websocket) {
      if (globalThis.WebSocket) {
        this._WebSocketImpl = globalThis.WebSocket;
      } else {
        try {
          const ws = await import('ws');
          this._WebSocketImpl = ws.default || ws.WebSocket;
        } catch {
          // No WebSocket support - _wsOpen will return -1
        }
      }
    }

    // Minimal host imports
    const imports = {
      env: {
        wc_log: (ptr, len) => {
          this._updateViews();
          if (this._u8) {
            const bytes = this._u8.slice(ptr, ptr + len);
            const text = new TextDecoder().decode(bytes);
            console.error('[cart]', text);
          }
        },
        // Asset API (v2) - always provided, returns -1 if no assets loaded
        wc_asset_size: (pathPtr, pathLen) => {
          return this._assetSize(pathPtr, pathLen);
        },
        wc_load_asset: (pathPtr, pathLen, destPtr, maxSize) => {
          return this._loadAsset(pathPtr, pathLen, destPtr, maxSize);
        },
        // Pad name query - returns the device name for a given pad slot
        wc_pad_name: (padId, bufPtr, bufLen) => {
          return this._padName(padId, bufPtr, bufLen);
        },
        // --- WebSocket API (ABI v3) ---
        wc_ws_open: (urlPtr, urlLen) => {
          return this._wsOpen(urlPtr, urlLen);
        },
        wc_ws_close: (connId, code) => {
          this._wsClose(connId, code);
        },
        wc_ws_send: (connId, dataPtr, len) => {
          return this._wsSend(connId, dataPtr, len, false);
        },
        wc_ws_send_text: (connId, strPtr, len) => {
          return this._wsSend(connId, strPtr, len, true);
        },
        wc_ws_state: (connId) => {
          return this._wsState(connId);
        },
        // --- Data Channel API (ABI v3) ---
        wc_dc_peer_count: () => {
          return this._dcPeers.size;
        },
        wc_dc_peer_info: (index, destPtr, maxLen) => {
          return this._dcPeerInfo(index, destPtr, maxLen);
        },
        wc_dc_send: (peerId, dataPtr, len) => {
          return this._dcSend(peerId, dataPtr, len);
        },
        wc_dc_broadcast: (dataPtr, len) => {
          return this._dcBroadcast(dataPtr, len);
        },
        // memfs - in-memory filesystem for engine carts (Godot etc.)
        // The cart calls memfs_register_file to map a name to a region of
        // its own WASM linear memory. We record the pointer+size so the
        // cart's filesystem layer can read from it later.
        memfs_register_file: (namePtr, dataPtr, size) => {
          try {
            const name = new TextDecoder().decode(
              new Uint8Array(this.memory.buffer, namePtr,
                new Uint8Array(this.memory.buffer).indexOf(0, namePtr) - namePtr));
            if (!this._memfsFiles) this._memfsFiles = new Map();
            this._memfsFiles.set(name, { ptr: dataPtr, size });
            return 0;
          } catch(e) { return -1; }
        },
        // Emscripten memory growth notification
        emscripten_notify_memory_growth: () => { this._updateViews(); },
        // Emscripten stubs (used by gl4es and emscripten libc)
        emscripten_asm_const_int: () => 0,
        emscripten_asm_const_double: () => 0.0,
        emscripten_get_element_css_size: (targetPtr, widthPtr, heightPtr) => {
          try {
            const view = new DataView(this.memory.buffer);
            view.setFloat64(widthPtr, this.info ? this.info.width : 800, true);
            view.setFloat64(heightPtr, this.info ? this.info.height : 600, true);
          } catch(e) {}
          return 0;
        },
        __syscall_getcwd: () => -1,
        __syscall_getdents64: () => -1,
      },
      // Safe no-op WASI stubs (emscripten libc may require these for snprintf/math)
      wasi_snapshot_preview1: {
        fd_close: () => 0,
        fd_write: (fd, iovs, iovs_len, nwritten_ptr) => {
          try {
            this._updateViews();
            const view = new DataView(this.memory.buffer);
            let totalWritten = 0;
            let text = '';
            for (let i = 0; i < iovs_len; i++) {
              const ptr = view.getUint32(iovs + i * 8, true);
              const len = view.getUint32(iovs + i * 8 + 4, true);
              if (this._u8 && len > 0) {
                text += new TextDecoder().decode(this._u8.slice(ptr, ptr + len));
              }
              totalWritten += len;
            }
            if (text && (fd === 1 || fd === 2)) {
              // stdout or stderr
              const lines = text.split('\n');
              for (const line of lines) {
                if (line.length > 0) process.stderr.write('[cart] ' + line + '\n');
              }
            }
            if (nwritten_ptr) view.setUint32(nwritten_ptr, totalWritten, true);
            return 0;
          } catch(e) { return 0; }
        },
        fd_seek: () => 0,
        fd_read: () => 0,
        environ_get: () => 0,
        environ_sizes_get: () => 0,
        proc_exit: () => {},
        clock_time_get: (id, precision, resultPtr) => {
          // Return monotonic time in nanoseconds (used by SDL_GetTicks)
          try {
            const ns = BigInt(Math.round(performance.now() * 1e6));
            const view = new DataView(this.memory.buffer);
            view.setBigUint64(resultPtr, ns, true);
          } catch (e) { /* memory not ready yet */ }
          return 0;
        },
        sched_yield: () => 0,
      },
    };

    // Provide no-op stubs for any wasi_snapshot_preview1 imports not explicitly handled
    for (const imp of moduleImports) {
      if (imp.module === 'wasi_snapshot_preview1' && imp.kind === 'function') {
        if (!(imp.name in imports.wasi_snapshot_preview1)) {
          imports.wasi_snapshot_preview1[imp.name] = () => 0;
        }
      }
    }

    // Auto-stub any env functions not explicitly handled (syscalls, emscripten,
    // pthread, networking, etc.). These appear in engine-level carts like Godot.
    for (const imp of moduleImports) {
      if (imp.module === 'env' && imp.kind === 'function') {
        if (!(imp.name in imports.env)) {
          imports.env[imp.name] = () => -1; // -1 = ENOSYS/error for syscalls
        }
      }
    }

    // Stub GL imports for hybrid carts that import GL but don't use it
    if (!this.usesGL) {
      const glStubs = {};
      for (const imp of moduleImports) {
        if (imp.module === 'gl' && imp.kind === 'function') {
          glStubs[imp.name] = () => 0;
        }
      }
      if (Object.keys(glStubs).length > 0) {
        imports.gl = glStubs;
      }
    }

    // Wire up GL imports if cart uses GL
    if (this.usesGL) {
      const glFuncs = createWebGLImports({
        getMemory: () => this.memory,
        ctx: options.glBackend,
        getMalloc: () => this.instance?.exports?.malloc || null,
        nativeGL: options.nativeGL || null,
      });
      imports.gl = glFuncs;
      // Auto-stub any GL imports not covered by webgl_imports.js
      for (const imp of moduleImports) {
        if (imp.module === 'gl' && imp.kind === 'function' && !(imp.name in glFuncs)) {
          glFuncs[imp.name] = () => 0;
        }
      }
      // Also provide GL functions under 'env' module for carts that use
      // gl4es (which imports GLES2 functions from 'env' internally).
      // Covers both env.glXxx and env.emscripten_glXxx patterns.
      for (const imp of moduleImports) {
        if (imp.module !== 'env' || imp.kind !== 'function') continue;
        // Direct GL function in env (e.g. env.glStencilFunc)
        // Note: must overwrite auto-stubs (which run before GL wiring)
        if (imp.name.startsWith('gl') && imp.name in glFuncs) {
          imports.env[imp.name] = glFuncs[imp.name];
        }
        // Emscripten GL wrapper (e.g. env.emscripten_glEnable -> glEnable)
        else if (imp.name.startsWith('emscripten_gl')) {
          const glName = imp.name.replace('emscripten_', '');
          // Strip OES/EXT/ANGLE/WEBGL suffixes to find base function
          const baseName = glName.replace(/(OES|EXT|ANGLE|WEBGL)$/, '');
          if (glName in glFuncs) {
            imports.env[imp.name] = glFuncs[glName];
          } else if (baseName in glFuncs) {
            imports.env[imp.name] = glFuncs[baseName];
          } else {
            // Stub for unsupported emscripten GL extensions
            imports.env[imp.name] = () => 0;
          }
        }
      }
    }

    // For threaded carts: provide shared memory as import and thread-spawn
    if (this.isThreaded) {
      imports.env.memory = this._sharedMemory;
      imports.wasi = imports.wasi || {};
      imports.wasi['thread-spawn'] = (startArg) => this._spawnThread(startArg);
    }

    // Instantiate
    this.instance = await WebAssembly.instantiate(module, imports);
    const exports = this.instance.exports;

    // Memory access - threaded carts use the shared memory we created,
    // non-threaded carts use the module's exported memory
    if (this.isThreaded) {
      this.memory = exports.memory || this._sharedMemory;
    } else {
      this.memory = exports.memory;
      if (!this.memory) {
        throw new Error('Cart must export memory');
      }
    }

    this._updateViews();

    // Read info struct BEFORE wc_init so we can load save data first
    if (typeof exports.wc_get_info !== 'function') {
      throw new Error('Cart must export wc_get_info');
    }

    this._infoPtr = exports.wc_get_info();
    this.info = this._readInfo(this._infoPtr);

    // Validate ABI version (accept v1 and v2)
    if (this.info.version < MIN_ABI_VERSION || this.info.version > ABI_VERSION) {
      throw new Error(`ABI version mismatch: cart=${this.info.version}, host supports ${MIN_ABI_VERSION}-${ABI_VERSION}`);
    }


    // Load save data BEFORE wc_init so cart can read it during init
    if (options.saveData && this.info.saveSize > 0) {
      const saveRegion = this._u8.subarray(this.info.savePtr, this.info.savePtr + this.info.saveSize);
      const copyLen = Math.min(options.saveData.length, this.info.saveSize);
      saveRegion.set(options.saveData.subarray(0, copyLen));
    }

    // Write host info BEFORE wc_init so cart can read preferred resolution etc.
    if (this.info.hostInfoPtr) {
      this._writeHostInfo(this.info.hostInfoPtr, options);
    }

    // Call WASI reactor _initialize (emscripten static constructors) if present
    if (typeof exports._initialize === 'function') {
      exports._initialize();
      this._updateViews(); // memory may have grown
    }

    // Call wc_init after save data and host info are loaded
    if (typeof exports.wc_init === 'function') {
      exports.wc_init();
      this._updateViews(); // memory may have grown
    }

    // Re-read info after wc_init - cart may have changed resolution based on host prefs
    this.info = this._readInfo(this._infoPtr);

    // Update GL detection from gpu_api field (authoritative) with import fallback for old carts
    if (this.info.gpuApi > 0) {
      this.usesGL = true;
    } else if (this.info.gpuApi === 0 && this._importsGL) {
      // Old cart that imports GL but doesn't set gpu_api - use import detection
      // (will be removed once all carts set gpu_api)
      this.usesGL = !!options.glBackend;
    }

    // Initialize timing
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this.frameCount = 0;
    this.audioReadCursor = 0;
  }

  /**
   * Run one frame: write time + input, call wc_render, return frame data.
   * @param {Array} [pads] - array of up to 4 pad objects
   * @returns {{ framebuffer: Uint8Array, width: number, height: number, audio: Int16Array|Float32Array|null }}
   */
  runFrame(pads) {
    const now = performance.now();
    const deltaMs = now - this.lastFrameTime;
    const timeMs = now - this.startTime;
    this.lastFrameTime = now;

    this._updateViews(); // in case memory grew

    // Write time
    this._writeTime(timeMs, deltaMs, this.frameCount);

    // Write input pads
    this._writePads(pads || []);

    // Write pointer/keyboard state and deliver events before render
    this._writePointerState();
    this._writeKeyState();
    this._deliverNetEvents();
    this._deliverPointerEvents();
    this._deliverKeyEvents();

    // Call wc_render
    this.instance.exports.wc_render();
    this._updateViews(); // in case memory grew during render

    // Re-read width/height from WASM memory (cart may update during deferred init)
    const base = this._infoPtr >> 2;
    const newW = this._u32[base + 1];
    const newH = this._u32[base + 2];
    if (newW > 0 && newH > 0 && (newW !== this.info.width || newH !== this.info.height)) {
      this.info.width = newW;
      this.info.height = newH;
    }

    this.frameCount++;

    // Read framebuffer
    const fbSize = this.info.width * this.info.height * 4;
    const framebuffer = this._u8.subarray(this.info.fbPtr, this.info.fbPtr + fbSize);

    // Drain audio ring buffer
    const audio = this._drainAudio();

    return {
      framebuffer,
      width: this.info.width,
      height: this.info.height,
      audio,
    };
  }

  /**
   * Get the current save data.
   * @returns {Uint8Array|null}
   */
  getSaveData() {
    if (!this.info || this.info.saveSize === 0) return null;
    // Return a copy so caller owns the buffer
    return new Uint8Array(
      this._u8.slice(this.info.savePtr, this.info.savePtr + this.info.saveSize)
    );
  }

  /**
   * Get cart info (dimensions, save size, etc.)
   */
  getInfo() {
    return this.info ? { ...this.info } : null;
  }

  /**
   * Get the parsed manifest (includes players, net, etc.)
   */
  getManifest() {
    return this._manifest ? { ...this._manifest } : null;
  }

  /**
   * Spawn a thread for WASI threads model.
   * Called when the cart invokes wasi.thread-spawn(start_arg).
   * Returns a positive tid on success, or negative on error.
   */
  _spawnThread(startArg) {
    if (!this.isThreaded || !this._compiledModule || !this._sharedMemory) return -1;

    const tid = this._nextTid++;

    // Serialize asset config for the worker (so it can do its own asset reads)
    const assetConfig = {};
    if (this._assetFd !== null) {
      // ZIP-based .wasc - pass file path and serialized index
      assetConfig.type = 'zip';
      assetConfig.filePath = this._assetFilePath;
      assetConfig.index = this._assetIndex ? [...this._assetIndex.entries()] : [];
    } else if (this._assetBuf) {
      // In-memory buffer - pass the buffer (SharedArrayBuffer compatible)
      assetConfig.type = 'buffer';
      assetConfig.buffer = this._assetBuf;
      assetConfig.index = this._assetIndex ? [...this._assetIndex.entries()] : [];
    } else if (this._assetDir) {
      assetConfig.type = 'dir';
      assetConfig.dir = this._assetDir;
    }

    const workerURL = new URL('./cartWorker.js', import.meta.url);
    const worker = new Worker(workerURL, {
      workerData: {
        module: this._compiledModule,
        memory: this._sharedMemory,
        tid,
        startArg,
        assetConfig,
      },
    });

    worker.on('message', (msg) => {
      if (msg.type === 'spawn') {
        // Nested thread spawning: worker thread requested a new thread
        const nestedTid = this._spawnThread(msg.startArg);
        worker.postMessage({ type: 'spawned', tid: nestedTid, requestId: msg.requestId });
      } else if (msg.type === 'exit') {
        this._workers.delete(msg.tid);
      }
    });

    worker.on('error', (err) => {
      console.error(`[thread ${tid}] error:`, err.message);
      this._workers.delete(tid);
    });

    worker.on('exit', () => {
      this._workers.delete(tid);
    });

    this._workers.set(tid, worker);
    return tid;
  }

  /**
   * Clean up resources (close file descriptor if open, terminate threads)
   */
  destroy() {
    // Terminate all worker threads
    for (const [tid, worker] of this._workers) {
      worker.terminate();
    }
    this._workers.clear();

    // Close all WebSocket connections
    for (const [, conn] of this._wsConnections) {
      try { conn.ws.close(); } catch {}
    }
    this._wsConnections.clear();
    this._dcPeers.clear();

    if (this._assetFd !== null) {
      try { closeSync(this._assetFd); } catch {}
      this._assetFd = null;
    }
    this._assetIndex = null;
    this._assetBuf = null;
    this._assetDir = null;
    this._sharedMemory = null;
    this._compiledModule = null;
  }

  // --- .wasc loading ---

  async _loadFromWasc(filePath) {
    const fd = openSync(filePath, 'r');
    const fileStats = statSync(filePath);
    const fileSize = fileStats.size;

    // Parse ZIP central directory
    const index = parseZipCentralDirectory(fd, fileSize);

    if (index.size > MAX_ARCHIVE_ENTRIES) {
      closeSync(fd);
      throw new Error(`Archive has too many entries (${index.size} > ${MAX_ARCHIVE_ENTRIES})`);
    }

    // Read manifest.json
    const manifestEntry = index.get('manifest.json');
    if (!manifestEntry) {
      closeSync(fd);
      throw new Error('.wasc archive missing manifest.json');
    }
    const manifestBuf = readZipEntry(fd, manifestEntry);
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    this._manifest = manifest;

    // Read cart.wasm (or whatever entry is specified)
    const wasmName = manifest.entry || 'cart.wasm';
    const wasmEntry = index.get(wasmName);
    if (!wasmEntry) {
      closeSync(fd);
      throw new Error(`.wasc archive missing ${wasmName}`);
    }
    const wasmBytes = readZipEntry(fd, wasmEntry);

    // Build asset index (strip 'assets/' prefix if the manifest specifies an assets root)
    const assetsPrefix = manifest.assets || 'assets/';
    this._assetIndex = new Map();
    for (const [path, entry] of index) {
      if (path === 'manifest.json' || path === wasmName) continue;

      // Validate entry sizes
      if (entry.uncompressedSize > MAX_ASSET_SIZE) continue;

      // Store with prefix stripped for lookup
      let assetPath = path;
      if (assetsPrefix && path.startsWith(assetsPrefix)) {
        assetPath = path.slice(assetsPrefix.length);
      }
      this._assetIndex.set(assetPath, entry);
      // Also store with full path for carts that use full paths
      if (assetPath !== path) {
        this._assetIndex.set(path, entry);
      }
    }

    // Generate virtual _filelist.txt with all asset paths
    const fileList = [...this._assetIndex.keys()].filter(p => !p.startsWith('assets/')).join('\n');
    this._fileListBuf = Buffer.from(fileList, 'utf8');

    this._assetFd = fd;
    this._assetFilePath = filePath; // stored for worker thread asset access
    this._hasAssets = this._assetIndex.size > 0;

    return wasmBytes;
  }

  _loadFromWascBuffer(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const index = parseZipFromBuffer(u8);

    if (index.size > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive has too many entries (${index.size} > ${MAX_ARCHIVE_ENTRIES})`);
    }

    // Read manifest
    const manifestEntry = index.get('manifest.json');
    if (!manifestEntry) throw new Error('.wasc archive missing manifest.json');
    const manifestBuf = readZipEntryFromBuffer(u8, manifestEntry);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuf));
    this._manifest = manifest;

    // Read wasm
    const wasmName = manifest.entry || 'cart.wasm';
    const wasmEntry = index.get(wasmName);
    if (!wasmEntry) throw new Error(`.wasc archive missing ${wasmName}`);
    const wasmBytes = readZipEntryFromBuffer(u8, wasmEntry);

    // Build asset index
    const assetsPrefix = manifest.assets || 'assets/';
    this._assetIndex = new Map();
    for (const [path, entry] of index) {
      if (path === 'manifest.json' || path === wasmName) continue;
      if (entry.uncompressedSize > MAX_ASSET_SIZE) continue;

      let assetPath = path;
      if (assetsPrefix && path.startsWith(assetsPrefix)) {
        assetPath = path.slice(assetsPrefix.length);
      }
      this._assetIndex.set(assetPath, entry);
      if (assetPath !== path) {
        this._assetIndex.set(path, entry);
      }
    }

    // Generate virtual _filelist.txt with all asset paths
    const fileList = [...this._assetIndex.keys()].filter(p => !p.startsWith('assets/')).join('\n');
    this._fileListBuf = new TextEncoder().encode(fileList);

    this._assetBuf = u8;
    this._hasAssets = this._assetIndex.size > 0;

    return wasmBytes;
  }

  async _loadFromDirectory(dirPath) {
    // Dev mode: load manifest.json + cart.wasm + assets from a directory
    const manifestPath = join(dirPath, 'manifest.json');
    const manifestBuf = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    this._manifest = manifest;

    const wasmName = manifest.entry || 'cart.wasm';
    const wasmBytes = await readFile(join(dirPath, wasmName));

    // Set up directory-based asset loading
    const assetsDir = join(dirPath, manifest.assets || 'assets');
    this._assetDir = assetsDir;
    this._hasAssets = true;
    // No index needed - we'll read files directly from disk

    return wasmBytes;
  }

  // --- Asset API implementation ---

  _readPath(pathPtr, pathLen) {
    this._updateViews();
    if (!this._u8 || pathLen === 0 || pathLen > 4096) return null;
    const bytes = this._u8.slice(pathPtr, pathPtr + pathLen);
    const path = new TextDecoder().decode(bytes);
    if (!validateAssetPath(path)) return null;
    return path;
  }

  _assetSize(pathPtr, pathLen) {
    if (!this._hasAssets) return -1;
    const path = this._readPath(pathPtr, pathLen);
    if (!path) return -1;

    // Virtual _filelist.txt
    if (path === '_filelist.txt' && this._fileListBuf) {
      return this._fileListBuf.length;
    }

    // Directory-based dev mode
    if (this._assetDir) {
      try {
        const s = statSync(join(this._assetDir, path));
        return s.size;
      } catch {
        return -1;
      }
    }

    // ZIP-based
    const entry = this._assetIndex.get(path);
    if (!entry) return -1;
    return entry.uncompressedSize;
  }

  _loadAsset(pathPtr, pathLen, destPtr, maxSize) {
    if (!this._hasAssets) return -1;
    const path = this._readPath(pathPtr, pathLen);
    if (!path) return -1;

    let data;

    // Virtual _filelist.txt
    if (path === '_filelist.txt' && this._fileListBuf) {
      data = this._fileListBuf;
    } else if (this._assetDir) {
      // Directory-based dev mode - read file directly
      try {
        const filePath = join(this._assetDir, path);
        const fd = openSync(filePath, 'r');
        const s = statSync(filePath);
        const size = Math.min(s.size, maxSize);
        const buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, 0);
        closeSync(fd);
        data = buf;
      } catch {
        return -1;
      }
    } else if (this._assetFd !== null) {
      // On-disk ZIP - read just the requested entry
      const entry = this._assetIndex.get(path);
      if (!entry) return -1;
      try {
        data = readZipEntry(this._assetFd, entry);
      } catch {
        return -1;
      }
    } else if (this._assetBuf) {
      // In-memory ZIP
      const entry = this._assetIndex.get(path);
      if (!entry) return -1;
      try {
        data = readZipEntryFromBuffer(this._assetBuf, entry);
      } catch {
        return -1;
      }
    } else {
      return -1;
    }

    // Copy into cart memory
    const copyLen = Math.min(data.length, maxSize);
    this._updateViews();
    this._u8.set(data.subarray ? data.subarray(0, copyLen) : new Uint8Array(data.buffer || data, 0, copyLen), destPtr);

    return copyLen;
  }

  // --- Private ---

  /**
   * Analyze module for threading support (WASI threads model).
   * Returns { isThreaded, importsMemory } without throwing.
   */
  _analyzeModule(module) {
    const imports = WebAssembly.Module.imports(module);
    const exports = WebAssembly.Module.exports(module);

    const hasThreadSpawn = imports.some(
      i => i.module === 'wasi' && i.name === 'thread-spawn' && i.kind === 'function'
    );
    const hasThreadStart = exports.some(
      e => e.name === 'wasi_thread_start' && e.kind === 'function'
    );
    const importsMemory = imports.some(i => i.kind === 'memory');

    // Detect Emscripten pthreads (different from WASI threads)
    const hasEmscriptenThreads = imports.some(
      i => i.module === 'env' && i.name === '_emscripten_thread_init' && i.kind === 'function'
    );

    // Validate: thread-spawn and wasi_thread_start must come in pairs
    if (hasThreadSpawn && !hasThreadStart) {
      throw new Error(
        'Cart imports wasi.thread-spawn but does not export wasi_thread_start. ' +
        'Both are required for WASI threads.'
      );
    }
    if (hasThreadStart && !hasThreadSpawn) {
      throw new Error(
        'Cart exports wasi_thread_start but does not import wasi.thread-spawn. ' +
        'Both are required for WASI threads.'
      );
    }

    return {
      isThreaded: (hasThreadSpawn && hasThreadStart) || hasEmscriptenThreads,
      importsMemory,
    };
  }

  _validateModule(module) {
    const moduleImports = WebAssembly.Module.imports(module);
    const moduleExports = WebAssembly.Module.exports(module);

    // Check imports - allow env, WASI stubs, and gl
    for (const imp of moduleImports) {
      if (imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi') {
        // Allow WASI imports - we provide safe no-op stubs
        continue;
      }
      if (imp.module === 'gl') {
        // Allow GL imports - provided by createWebGLImports()
        continue;
      }
      if (imp.module !== 'env') {
        throw new Error(`Cart imports unknown module: "${imp.module}"`);
      }
      // Allow memory imports (used by threaded carts with shared memory)
      if (imp.kind === 'memory') continue;
      // Allow known env imports + GL/emscripten functions (for gl4es carts)
      if (imp.kind === 'function') {
        // GL, emscripten GL, gl4es-internal, syscalls, emscripten, and
        // common libc functions are all allowed under env
        if (imp.name.startsWith('gl') || imp.name.startsWith('gles_')
            || imp.name.startsWith('emscripten_gl')
            || imp.name.startsWith('emscripten_')
            || imp.name.startsWith('__syscall_')
            || imp.name.startsWith('wc_')
            || imp.name.startsWith('memfs_')
            || imp.name.startsWith('pthread_')
            || ['getaddrinfo', 'getnameinfo'].includes(imp.name)) {
          continue;
        }
        // For large engine carts (Godot, etc.), allow any env function  - 
        // we auto-stub unknowns below
      }
    }

    // Require wc_render export
    const exportNames = moduleExports.map(e => e.name);
    if (!exportNames.includes('wc_render')) {
      throw new Error('Cart must export wc_render');
    }
    if (!exportNames.includes('wc_get_info')) {
      throw new Error('Cart must export wc_get_info');
    }
    // Threaded carts may import memory instead of exporting it
    // (they can also re-export it, but it's not required)
    const analysis = this._analyzeModule(module);
    if (!exportNames.includes('memory') && !analysis.importsMemory) {
      throw new Error('Cart must export memory');
    }
  }

  /**
   * Parse WASM binary import section to find memory import limits.
   * Returns { initial, maximum, shared } or null if no memory import.
   */
  static _parseMemoryImportLimits(wasmBytes) {
    const buf = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
    let pos = 8; // skip 8-byte header (magic + version)

    function readLEB128() {
      let result = 0, shift = 0;
      while (pos < buf.length) {
        const byte = buf[pos++];
        result |= (byte & 0x7F) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      return result;
    }

    function skipBytes(n) { pos += n; }

    while (pos < buf.length) {
      const sectionId = buf[pos++];
      const sectionSize = readLEB128();
      const sectionEnd = pos + sectionSize;

      if (sectionId === 2) { // Import section
        const count = readLEB128();
        for (let i = 0; i < count; i++) {
          const modLen = readLEB128();
          skipBytes(modLen); // module name
          const fieldLen = readLEB128();
          skipBytes(fieldLen); // field name
          const kind = buf[pos++];

          if (kind === 0x02) { // memory import
            const flags = buf[pos++];
            const shared = !!(flags & 0x02);
            const hasMax = !!(flags & 0x01);
            const initial = readLEB128();
            const maximum = hasMax ? readLEB128() : undefined;
            return { initial, maximum, shared };
          } else if (kind === 0x00) { // function import
            readLEB128(); // type index
          } else if (kind === 0x01) { // table import
            pos++; // reftype
            const tFlags = buf[pos++];
            readLEB128(); // initial
            if (tFlags & 0x01) readLEB128(); // maximum
          } else if (kind === 0x03) { // global import
            pos++; // valtype
            pos++; // mutability
          }
        }
        return null; // no memory import in section
      }

      pos = sectionEnd; // skip to next section
    }
    return null;
  }

  _updateViews() {
    const buf = this.memory.buffer;
    // For SharedArrayBuffer, reference stays the same after grow but byteLength changes
    if (buf === this._lastBuffer && buf.byteLength === this._lastByteLength) return;
    this._lastBuffer = buf;
    this._lastByteLength = buf.byteLength;
    this._u8 = new Uint8Array(buf);
    this._u16 = new Uint16Array(buf);
    this._i16 = new Int16Array(buf);
    this._u32 = new Uint32Array(buf);
    this._f32 = new Float32Array(buf);
    this._f64 = new Float64Array(buf);
  }

  // --- Networking (ABI v3) ---

  /**
   * Write binary data to a temporary location in WASM memory and invoke a callback.
   * Uses malloc if available, otherwise uses a scratch region after the stack.
   */
  _withTempWasmData(data, callback) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const len = bytes.length;
    const malloc = this.instance.exports.malloc;
    const free = this.instance.exports.free;

    if (malloc && free) {
      const ptr = malloc(len);
      if (ptr === 0) return;
      this._updateViews();
      this._u8.set(bytes, ptr);
      try { callback(ptr, len); } finally { free(ptr); }
    } else {
      // Fallback: write to end of memory (risky but acceptable for small payloads)
      // Use the last 64KB of memory as scratch space
      const memSize = this.memory.buffer.byteLength;
      const scratchStart = memSize - 65536;
      if (len > 65536 || len === 0) return;
      this._updateViews();
      this._u8.set(bytes, scratchStart);
      callback(scratchStart, len);
    }
  }

  _wsOpen(urlPtr, urlLen) {
    const allowlist = this._manifest?.net?.websocket;
    if (!allowlist) return -1;
    if (!this._WebSocketImpl) return -1;

    this._updateViews();
    const url = new TextDecoder().decode(this._u8.slice(urlPtr, urlPtr + urlLen));

    // Validate against manifest allowlist
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return -1;
    }
    if (!allowlist.includes(hostname)) return -1;

    const id = this._wsNextId++;
    try {
      const ws = new this._WebSocketImpl(url);
      if (ws.binaryType !== undefined) ws.binaryType = 'arraybuffer';

      const conn = { ws, eventQueue: [] };
      ws.onopen = () => conn.eventQueue.push({ type: 'open' });
      ws.onmessage = (e) => {
        const data = e.data;
        if (typeof data === 'string') {
          conn.eventQueue.push({ type: 'text', data });
        } else {
          conn.eventQueue.push({ type: 'binary', data });
        }
      };
      ws.onclose = (e) => conn.eventQueue.push({ type: 'close', code: e.code || 1000 });
      ws.onerror = () => conn.eventQueue.push({ type: 'error' });

      this._wsConnections.set(id, conn);
      return id;
    } catch {
      return -1;
    }
  }

  _wsClose(connId, code) {
    const conn = this._wsConnections.get(connId);
    if (!conn) return;
    try { conn.ws.close(code || 1000); } catch {}
  }

  _wsSend(connId, dataPtr, len, isText) {
    const conn = this._wsConnections.get(connId);
    if (!conn) return -1;
    try {
      if (conn.ws.readyState !== 1) return -1; // not OPEN
      this._updateViews();
      if (isText) {
        const str = new TextDecoder().decode(this._u8.slice(dataPtr, dataPtr + len));
        conn.ws.send(str);
      } else {
        const bytes = this._u8.slice(dataPtr, dataPtr + len);
        conn.ws.send(bytes);
      }
      return len;
    } catch {
      return -1;
    }
  }

  _wsState(connId) {
    const conn = this._wsConnections.get(connId);
    if (!conn) return 3; // CLOSED
    return conn.ws.readyState;
  }

  _dcPeerInfo(index, destPtr, maxLen) {
    const peers = [...this._dcPeers.entries()];
    if (index >= peers.length) return -1;
    const [peerId, peer] = peers[index];
    this._updateViews();
    const labelBytes = new TextEncoder().encode(peer.label + '\0');
    const copyLen = Math.min(labelBytes.length, maxLen);
    this._u8.set(labelBytes.subarray(0, copyLen), destPtr);
    return peerId;
  }

  _dcSend(peerId, dataPtr, len) {
    const peer = this._dcPeers.get(peerId);
    if (!peer || !peer.dc) return -1;
    try {
      this._updateViews();
      const bytes = this._u8.slice(dataPtr, dataPtr + len);
      peer.dc.send(bytes);
      return len;
    } catch {
      return -1;
    }
  }

  _dcBroadcast(dataPtr, len) {
    this._updateViews();
    const bytes = this._u8.slice(dataPtr, dataPtr + len);
    let count = 0;
    for (const [, peer] of this._dcPeers) {
      if (!peer.dc) continue;
      try {
        peer.dc.send(bytes);
        count++;
      } catch {}
    }
    return count || -1;
  }

  /**
   * Deliver buffered network events as callbacks into WASM.
   * Called before each wc_render().
   */
  _deliverNetEvents() {
    const exports = this.instance.exports;

    // WebSocket events
    for (const [id, conn] of this._wsConnections) {
      while (conn.eventQueue.length > 0) {
        const evt = conn.eventQueue.shift();
        if (evt.type === 'open' && exports.wc_ws_on_open) {
          exports.wc_ws_on_open(id);
        } else if (evt.type === 'binary' && exports.wc_ws_on_message) {
          const buf = evt.data instanceof ArrayBuffer ? new Uint8Array(evt.data)
            : evt.data instanceof Uint8Array ? evt.data
            : new Uint8Array(evt.data);
          this._withTempWasmData(buf, (ptr, len) => {
            exports.wc_ws_on_message(id, ptr, len);
          });
        } else if (evt.type === 'text' && exports.wc_ws_on_message_text) {
          const bytes = new TextEncoder().encode(evt.data);
          this._withTempWasmData(bytes, (ptr, len) => {
            exports.wc_ws_on_message_text(id, ptr, len);
          });
        } else if (evt.type === 'close' && exports.wc_ws_on_close) {
          exports.wc_ws_on_close(id, evt.code);
        } else if (evt.type === 'error' && exports.wc_ws_on_error) {
          exports.wc_ws_on_error(id);
        }
      }
    }

    // Data channel events
    for (const [peerId, peer] of this._dcPeers) {
      while (peer.eventQueue.length > 0) {
        const evt = peer.eventQueue.shift();
        if (evt.type === 'connect' && exports.wc_dc_on_connect) {
          const labelBytes = new TextEncoder().encode(peer.label);
          this._withTempWasmData(labelBytes, (ptr, len) => {
            exports.wc_dc_on_connect(peerId, ptr, len);
          });
        } else if (evt.type === 'message' && exports.wc_dc_on_message) {
          const buf = evt.data instanceof ArrayBuffer ? new Uint8Array(evt.data)
            : evt.data instanceof Uint8Array ? evt.data
            : new Uint8Array(evt.data);
          this._withTempWasmData(buf, (ptr, len) => {
            exports.wc_dc_on_message(peerId, ptr, len);
          });
        } else if (evt.type === 'disconnect' && exports.wc_dc_on_disconnect) {
          exports.wc_dc_on_disconnect(peerId);
        }
      }
    }
  }

  /**
   * Add a data channel peer (called by the host application managing signaling).
   * @param {number} peerId - unique peer ID
   * @param {string} label - username or identifier
   * @param {object} dc - data channel object with send(), onmessage, onclose
   */
  addDataChannelPeer(peerId, label, dc) {
    const peer = { dc, label, eventQueue: [{ type: 'connect' }] };
    dc.onmessage = (e) => {
      peer.eventQueue.push({ type: 'message', data: e.data });
    };
    dc.onclose = () => {
      peer.eventQueue.push({ type: 'disconnect' });
    };
    this._dcPeers.set(peerId, peer);
  }

  /**
   * Remove a data channel peer.
   */
  removeDataChannelPeer(peerId) {
    const peer = this._dcPeers.get(peerId);
    if (peer) {
      peer.eventQueue.push({ type: 'disconnect' });
    }
  }

  // --- Pointer Input (ABI v3) ---

  /**
   * Update pointer state. Called by the host application.
   * @param {number} id - pointer index (0=mouse, 1+=touch)
   * @param {number} x - cart-space X
   * @param {number} y - cart-space Y
   * @param {number} buttons - button bitmask
   * @param {boolean} active - whether pointer exists
   */
  setPointer(id, x, y, buttons, active) {
    if (id < 0 || id >= MAX_POINTERS) return;
    this._pointerState[id] = { x, y, buttons, active: active ? 1 : 0 };
  }

  /**
   * Queue a pointer event. Called by the host application.
   */
  pointerDown(id, x, y, button) {
    if (id < 0 || id >= MAX_POINTERS) return;
    this._pointerState[id].active = 1;
    this._pointerState[id].x = x;
    this._pointerState[id].y = y;
    this._pointerState[id].buttons |= (1 << button);
    this._pointerEvents.push({ type: 'down', id, x, y, button });
  }

  pointerMove(id, x, y) {
    if (id < 0 || id >= MAX_POINTERS) return;
    this._pointerState[id].x = x;
    this._pointerState[id].y = y;
    this._pointerEvents.push({ type: 'move', id, x, y });
  }

  pointerUp(id, button) {
    if (id < 0 || id >= MAX_POINTERS) return;
    this._pointerState[id].buttons &= ~(1 << button);
    if (this._pointerState[id].buttons === 0 && id > 0) {
      // Touch: deactivate when all buttons released
      this._pointerState[id].active = 0;
    }
    this._pointerEvents.push({ type: 'up', id, button });
  }

  _writePointerState() {
    if (!this.info || !this.info.pointerPtr || !this.info.wantsPointer) return;
    if (!this._manifest?.pointer) return;
    this._updateViews();
    const base = this.info.pointerPtr;
    for (let i = 0; i < MAX_POINTERS; i++) {
      const p = this._pointerState[i];
      const off = base + i * POINTER_SIZE;
      this._i16[off >> 1] = p.x;
      this._i16[(off + 2) >> 1] = p.y;
      this._u8[off + 4] = p.buttons;
      this._u8[off + 5] = p.active;
      this._u8[off + 6] = 0;
      this._u8[off + 7] = 0;
    }
  }

  _deliverPointerEvents() {
    if (!this.info?.wantsPointer || !this._manifest?.pointer) return;
    const exports = this.instance.exports;
    while (this._pointerEvents.length > 0) {
      const evt = this._pointerEvents.shift();
      if (evt.type === 'down' && exports.wc_ptr_on_down) {
        exports.wc_ptr_on_down(evt.id, evt.x, evt.y, evt.button);
      } else if (evt.type === 'move' && exports.wc_ptr_on_move) {
        exports.wc_ptr_on_move(evt.id, evt.x, evt.y);
      } else if (evt.type === 'up' && exports.wc_ptr_on_up) {
        exports.wc_ptr_on_up(evt.id, evt.button);
      }
    }
  }

  // --- Keyboard Input (ABI v3) ---

  /**
   * Queue a key down event. Called by the host application.
   * @param {number} keycode - USB HID scancode
   * @param {number} modifiers - modifier bitmask
   */
  keyDown(keycode, modifiers) {
    if (keycode < 0 || keycode > 255) return;
    this._keyState[keycode >> 3] |= (1 << (keycode & 7));
    this._keyEvents.push({ type: 'down', keycode, modifiers: modifiers || 0 });
  }

  /**
   * Queue a key up event. Called by the host application.
   */
  keyUp(keycode, modifiers) {
    if (keycode < 0 || keycode > 255) return;
    this._keyState[keycode >> 3] &= ~(1 << (keycode & 7));
    this._keyEvents.push({ type: 'up', keycode, modifiers: modifiers || 0 });
  }

  _writeKeyState() {
    if (!this.info || !this.info.keysPtr || !this.info.wantsKeyboard) return;
    if (!this._manifest?.keyboard) return;
    this._updateViews();
    this._u8.set(this._keyState, this.info.keysPtr);
  }

  _deliverKeyEvents() {
    if (!this.info?.wantsKeyboard || !this._manifest?.keyboard) return;
    const exports = this.instance.exports;
    while (this._keyEvents.length > 0) {
      const evt = this._keyEvents.shift();
      if (evt.type === 'down' && exports.wc_kb_on_down) {
        exports.wc_kb_on_down(evt.keycode, evt.modifiers);
      } else if (evt.type === 'up' && exports.wc_kb_on_up) {
        exports.wc_kb_on_up(evt.keycode, evt.modifiers);
      }
    }
  }

  _readInfo(ptr) {
    const u32 = this._u32;
    const base = ptr >> 2; // byte offset to u32 index

    const info = {
      version:    u32[base + 0],
      width:      u32[base + 1],
      height:     u32[base + 2],
      fbPtr:      u32[base + 3],
      audioPtr:   u32[base + 4],
      audioCap:   u32[base + 5],
      audioWritePtr: u32[base + 6], // pointer to cart's write cursor
      inputPtr:   u32[base + 7],
      savePtr:    u32[base + 8],
      saveSize:   u32[base + 9],
      timePtr:    u32[base + 10],
      hostInfoPtr: 0,
    };

    // Read host_info_ptr if cart provides it (ABI v2+, field at offset 44)
    // Validate: must be non-zero, 4-byte aligned, reasonable WASM address
    if (info.version >= 2) {
      const hip = u32[base + 11];
      if (hip > 0 && hip < 0x10000000 && (hip & 3) === 0) {
        info.hostInfoPtr = hip;
      }
    }

    // Read flags (offset 48, u32 index 12) - 0 for old carts (WASM zero-init)
    info.flags = u32[base + 12] || 0;
    info.audioIsF32 = !!(info.flags & 1); // WC_FLAG_AUDIO_F32

    // Read audio_sample_rate (offset 52, u32 index 13) - 0 = host decides
    info.audioSampleRate = u32[base + 13] || 0;

    // Read v3 fields (offset 56, 60)
    info.pointerPtr = 0;
    info.keysPtr = 0;
    if (info.version >= 3) {
      const pp = u32[base + 14];
      if (pp > 0 && pp < 0x10000000 && (pp & 1) === 0) {
        info.pointerPtr = pp;
      }
      const kp = u32[base + 15];
      if (kp > 0 && kp < 0x10000000) {
        info.keysPtr = kp;
      }
    }
    info.wantsPointer = !!(info.flags & FLAG_POINTER);
    info.wantsKeyboard = !!(info.flags & FLAG_KEYBOARD);

    // Read gpu_api (offset 64, u32 index 16) - 0=2D, 1=WebGL2, 2=WebGPU, 3=Vulkan
    info.gpuApi = u32[base + 16] || 0;

    return info;
  }

  _writeHostInfo(hostInfoPtr, options) {
    if (!hostInfoPtr) return;
    const u32 = this._u32;
    const base = hostInfoPtr >> 2;
    u32[base + 0] = options.preferredWidth || 0;
    u32[base + 1] = options.preferredHeight || 0;
    u32[base + 2] = 0; // reserved (was hostFps - unused, carts use delta_ms)
    u32[base + 3] = options.audioSampleRate || 48000;
    u32[base + 4] = options.flags || 0;
  }

  _writeTime(timeMs, deltaMs, frame) {
    const ptr = this.info.timePtr;
    // f64 at byte offset requires 8-byte alignment
    const f64Base = ptr >> 3;
    this._f64[f64Base + 0] = timeMs;
    this._f64[f64Base + 1] = deltaMs;
    // u32 frame at byte offset ptr + 16
    this._u32[(ptr + 16) >> 2] = frame;
  }

  _writePads(pads) {
    const basePtr = this.info.inputPtr;

    for (let i = 0; i < MAX_PADS; i++) {
      const pad = pads[i];
      const offset = basePtr + (i * PAD_SIZE);

      // Capture pad name (if provided by caller)
      this._padNames[i] = (pad && pad.name) ? pad.name : '';

      if (!pad || !pad.connected) {
        // Zero the pad
        this._u8.fill(0, offset, offset + PAD_SIZE);
        continue;
      }

      this._u16[offset >> 1] = pad.buttons || 0;
      this._i16[(offset + 2) >> 1] = pad.leftX || 0;
      this._i16[(offset + 4) >> 1] = pad.leftY || 0;
      this._i16[(offset + 6) >> 1] = pad.rightX || 0;
      this._i16[(offset + 8) >> 1] = pad.rightY || 0;
      this._u8[offset + 10] = pad.leftTrigger || 0;
      this._u8[offset + 11] = pad.rightTrigger || 0;
      this._u8[offset + 12] = 1; // connected
      this._u8[offset + 13] = 0; // padding
    }
  }

  _padName(padId, bufPtr, bufLen) {
    if (padId >= MAX_PADS || !bufLen) return 0;
    const name = this._padNames[padId] || '';
    if (!name.length) return 0;
    this._updateViews();
    const encoded = new TextEncoder().encode(name);
    const len = Math.min(encoded.length, bufLen);
    this._u8.set(encoded.subarray(0, len), bufPtr);
    return len;
  }

  _drainAudio() {
    if (!this.info.audioPtr || this.info.audioCap === 0) return null;

    // Read cart's write cursor
    const writeCursor = this._u32[this.info.audioWritePtr >> 2];
    const readCursor = this.audioReadCursor;

    if (writeCursor === readCursor) return null; // nothing to drain

    const cap = this.info.audioCap;
    const audioBase = this.info.audioPtr;

    // Calculate how many stereo frames to read
    let available;
    if (writeCursor >= readCursor) {
      available = writeCursor - readCursor;
    } else {
      // Wrapped around
      available = cap - readCursor + writeCursor;
    }

    if (available === 0) return null;

    const needed = available * 2; // 2 samples per stereo frame

    if (this.info.audioIsF32) {
      // Float32 audio path
      if (!this._audioBufF32 || this._audioBufF32.length < needed) {
        this._audioBufF32 = new Float32Array(needed);
      }
      const samples = this._audioBufF32;
      const ringF32Base = audioBase >> 2; // byte offset to f32 index

      for (let i = 0; i < available; i++) {
        const ringIdx = ((readCursor + i) % cap) * 2;
        samples[i * 2] = this._f32[ringF32Base + ringIdx];
        samples[i * 2 + 1] = this._f32[ringF32Base + ringIdx + 1];
      }

      this.audioReadCursor = writeCursor;
      return samples.subarray(0, needed);
    }

    // Int16 audio path (default)
    if (!this._audioBuf || this._audioBuf.length < needed) {
      this._audioBuf = new Int16Array(needed);
    }
    const samples = this._audioBuf;
    const ringI16Base = audioBase >> 1;

    for (let i = 0; i < available; i++) {
      const ringIdx = ((readCursor + i) % cap) * 2;
      samples[i * 2] = this._i16[ringI16Base + ringIdx];
      samples[i * 2 + 1] = this._i16[ringI16Base + ringIdx + 1];
    }

    this.audioReadCursor = writeCursor;

    return samples.subarray(0, needed);
  }
}
