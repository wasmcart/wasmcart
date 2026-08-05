// CartHostWeb.js - Browser version of CartHost
// No Node.js dependencies. Uses fflate for sync inflate.
// Accepts Uint8Array of .wasc (ZIP) or bare .wasm bytes.

import {
  ABI_VERSION,
  MIN_ABI_VERSION,
  INFO_FIELDS,
  HOST_INFO_FIELDS,
  PAD_SIZE,
  MAX_PADS,
  TIME_SIZE,
  FLAG_NET_PEER,
  PEER_OPEN,
  PEER_CLOSED,
  TRANSPORT_UNKNOWN,
  TRANSPORT_WS,
  FLAG_POINTER,
  FLAG_KEYBOARD,
  POINTER_SIZE,
  MAX_POINTERS,
  KEYS_STATE_SIZE,
  MAX_DELTA_MS,
  MAX_RUMBLE_MS,
  clamp01,
} from './abi.js';
import { createWebGLImports } from './webgl_imports.js';
import { inflateSync } from 'fflate';

/* The manifest's asset root is stripped as a PATH PREFIX from packed entries,
 * so it needs its trailing slash: "app" turns "app/main.lua" into "/main.lua"
 * and every lookup misses. Dev mode joins the same field as a directory,
 * where the slash is harmless -- so a cart written and tested from a dev
 * directory boots fine and then fails the moment it is packed, which is a
 * miserable way to find out. Normalize once instead of trusting authors to
 * remember. (Observed in the wild: wasmcart-lua and wasmcart-mruby both
 * shipped manifests saying "app".) */
function assetPrefixOf(manifest) {
  const raw = manifest && manifest.assets;
  if (raw === undefined || raw === null || raw === '') return 'assets/';
  const s = String(raw);
  return s.endsWith('/') ? s : s + '/';
}


// --- Path validation for asset security ---

function validateAssetPath(path) {
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.includes('..')) return false;
  if (path.includes('\0')) return false;
  if (path.includes('\\')) return false;
  return true;
}

// --- In-memory ZIP parser ---

function parseZipFromBuffer(buf) {
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
    return inflateSync(compressedData);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
  }
}

// Max single asset size (256MB)
const MAX_ASSET_SIZE = 256 * 1024 * 1024;
// Max entries in a .wasc archive
const MAX_ARCHIVE_ENTRIES = 100000;


export class CartHostWeb {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.info = null;
    this._ownedGl = null;
    this._callerGl = null;     // a context the CALLER supplied via glBackend   // GL context created BY this host (see load)
    this.frameCount = 0;
    this.startTime = 0;
    this.lastFrameTime = 0;
    this.audioReadCursor = 0;

    // Views into cart memory
    this._u8 = null;
    this._u16 = null;
    this._i16 = null;
    this._u32 = null;
    this._f32 = null;
    this._f64 = null;
    this._lastBuffer = null;
    this._lastByteLength = 0;

    // Thread support (WASI threads)
    this.isThreaded = false;
    this._sharedMemory = null;
    this._compiledModule = null;
    this._workers = new Map();
    this._nextTid = 1;

    // GL state
    this.usesGL = false;

    // Asset index for .wasc carts
    this._assetIndex = null;
    this._assetBuf = null;
    this._hasAssets = false;

    // Networking (ABI v3)
    this._manifest = null;
    this._peers = new Map();   // peer_id → { ws|dc, name, transport, eventQueue }
    this._peerNextId = 0;

    // Pointer input (ABI v3)
    this._pointerState = [];
    for (let i = 0; i < MAX_POINTERS; i++) {
      this._pointerState.push({ x: 0, y: 0, buttons: 0, active: 0 });
    }
    this._pointerEvents = [];

    // Keyboard input (ABI v3)
    this._keyState = new Uint8Array(KEYS_STATE_SIZE);
    this._keyEvents = [];
    this._textEvents = []; // committed UTF-8, only while text input is active
    this._textActive = false;

    // Pad names (populated each frame from pad objects)
    this._padNames = ['', '', '', ''];
    this._rumbleHandler = null; // set by the embedder via setRumbleHandler()

    // Lifecycle. See CartHost for the rationale; the split is the same.
    // `suspended` = the host has stopped driving frames; `focused` = running
    // but not the active window.
    this._suspended = false;
    this._focused = true;
    this._lastFrame = null;   // replayed while suspended
    this._visListener = null; // bound document listeners, if auto-wired

    // Asyncify loop-inversion state (wc_frame_yield protocol). buf is the
    // cart-provided unwind stack (wc_yield_buffer export), resolved lazily.
    this._asyncify = { buf: 0, suspended: false, rewinding: false, unwound: false };
  }

  /**
   * Load and instantiate a cart.
   * @param {Uint8Array} source - .wasc (ZIP) bytes or bare .wasm bytes
   * @param {object} [options]
   * @param {Uint8Array} [options.saveData] - existing save data to load
   * @param {WebGL2RenderingContext|Function} [options.glBackend] - the context, OR a factory
   *   (sync/async) returning one; the factory runs once, only if the cart imports GL
   * @param {number} [options.preferredWidth] - hint for cart resolution
   * @param {number} [options.preferredHeight] - hint for cart resolution
   * @param {number} [options.audioSampleRate] - host audio sample rate (default 48000)
   */
  // Draw a progress bar on the GL canvas during loading.
  // Uses simple scissor+clear - no shaders or buffers needed.
  _drawProgress(ctx, progress, label) {
    if (!ctx || !ctx.canvas) return;
    const w = ctx.canvas.width || 320;
    const h = ctx.canvas.height || 240;

    ctx.viewport(0, 0, w, h);
    ctx.disable(ctx.SCISSOR_TEST);
    ctx.clearColor(0.07, 0.07, 0.07, 1.0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);

    // Bar dimensions: 60% width, 6px tall, centered
    const barW = Math.floor(w * 0.6);
    const barH = Math.max(4, Math.floor(h * 0.02));
    const barX = Math.floor((w - barW) / 2);
    const barY = Math.floor(h / 2 - barH / 2);

    // Background track
    ctx.enable(ctx.SCISSOR_TEST);
    ctx.scissor(barX, barY, barW, barH);
    ctx.clearColor(0.2, 0.2, 0.2, 1.0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);

    // Filled portion
    const fillW = Math.max(1, Math.floor(barW * Math.min(progress, 1)));
    ctx.scissor(barX, barY, fillW, barH);
    ctx.clearColor(0.3, 0.7, 1.0, 1.0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);

    ctx.disable(ctx.SCISSOR_TEST);
  }

  async load(source, options = {}) {
    // glBackend may be a factory (see below) - no context to draw progress
    // into until/unless it's invoked.
    let glCtx = typeof options.glBackend === 'function' ? null : (options.glBackend || null);
    this._drawProgress(glCtx, 0);

    const u8 = source instanceof Uint8Array ? source : new Uint8Array(source);
    let wasmBytes;

    // Detect ZIP vs bare WASM
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b &&
        u8[2] === 0x03 && u8[3] === 0x04) {
      wasmBytes = this._loadFromWascBuffer(u8);
    } else if (u8.length >= 4 && u8[0] === 0x00 && u8[1] === 0x61 &&
               u8[2] === 0x73 && u8[3] === 0x6d) {
      // Bare .wasm (magic: \0asm)
      wasmBytes = u8;
    } else {
      throw new Error('Invalid cart data: expected .wasc (ZIP) or .wasm bytes');
    }

    // Compile and validate
    this._drawProgress(glCtx, 0.1);
    const module = await WebAssembly.compile(wasmBytes);
    this._validateModule(module);

    // Detect thread usage
    const threadAnalysis = this._analyzeModule(module);
    this.isThreaded = threadAnalysis.isThreaded;

    // For threaded carts: create shared memory and store module for worker reuse
    if (this.isThreaded) {
      const memLimits = CartHostWeb._parseMemoryImportLimits(wasmBytes);
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

    // Detect GL usage
    const moduleImports = WebAssembly.Module.imports(module);
    this.usesGL = moduleImports.some(imp =>
      imp.module === 'gl' ||
      (imp.module === 'env' && imp.kind === 'function' && /^gl[A-Z]/.test(imp.name))
    );

    // glBackend factory: invoked once, only when the wasm import section says
    // the cart is GL - a page never has to know what kind of cart it's
    // loading (e.g. create the canvas + webgl2 context lazily here).
    if (typeof options.glBackend === 'function') {
      let made = null;
      if (this.usesGL) {
        made = await options.glBackend();
        if (!made) throw new Error('glBackend factory returned no GL context for a GL cart');
      }
      options = { ...options, glBackend: made };
      glCtx = made;
    }
    // Remember a caller-supplied context so getGlContext() can report it. The
    // host does NOT own it — destroy() must not lose a context the caller may
    // still be drawing into.
    if (options.glBackend) this._callerGl = options.glBackend;

    if (this.usesGL && !options.glBackend) {
      // A browser can ALWAYS produce a WebGL2 context — it has shipped
      // everywhere for over a decade — so the web host satisfies the "hosts
      // MUST be able to supply a GL context" rule itself rather than pushing
      // the requirement onto the page. A caller-supplied glBackend still wins
      // (that is how you render into your own on-screen canvas); this is the
      // fallback for a page that just calls load() and reads getFrame().
      //
      // Offscreen when available, otherwise a detached <canvas> — neither is
      // in the document, so nothing renders on screen until the page draws the
      // frame itself. Only reached for carts that actually import `gl`.
      // NOTE: this.info is not populated until wc_get_info runs, which is
      // after this point — use the same preferred* hints the cart is handed.
      const w = options.preferredWidth || 640;
      const h = options.preferredHeight || 480;
      let made = null;
      try {
        const surface = (typeof OffscreenCanvas !== 'undefined')
          ? new OffscreenCanvas(w, h)
          : (typeof document !== 'undefined' ? Object.assign(
              document.createElement('canvas'), { width: w, height: h }) : null);
        made = surface && surface.getContext('webgl2', { alpha: false });
      } catch { made = null; }

      if (!made) {
        // WebGL2 genuinely unavailable (ancient browser, blocklisted driver,
        // GL disabled). Stubbing would render black while reporting success,
        // so fail loudly and name the actual cause.
        throw new Error(
          'this cart imports the `gl` module but a WebGL2 context could not be ' +
          'created. wasmcart requires WebGL2; check that it is enabled and not ' +
          'blocked by the driver/browser, or pass your own glBackend.');
      }
      this._ownedGl = made;      // created here, so this host owns its lifetime
      options = { ...options, glBackend: made };
      glCtx = made;
    }

    // Build imports
    const imports = {
      env: {
        wc_log: (ptr, len) => {
          this._updateViews();
          if (this._u8) {
            const bytes = this._u8.slice(ptr, ptr + len);
            const text = new TextDecoder().decode(bytes);
            console.warn('[cart]', text);
          }
        },
        // Debug-ABI frame annotation — no-op stub on the play host (the intent
        // is zero call sites in a release cart; a debug build still instantiates).
        wc_debug_mark: () => {},
        // Loop-inversion protocol for ported engines that own their main
        // loop: the cart is post-processed with binaryen's asyncify pass
        // (asyncify-imports = env.wc_frame_yield) and calls this once per
        // frame from inside its loop. Unwind suspends the whole engine
        // stack out of wc_render; the next runFrame rewinds back to this
        // exact point. A cart without asyncify exports never triggers it.
        //
        // This import must exist even for carts that never call it: a wasm
        // module importing a function the host does not supply fails to
        // instantiate with a LinkError, so omitting it made every
        // loop-inverted cart unloadable rather than merely degraded.
        wc_frame_yield: () => {
          const ex = this.instance?.exports;
          if (!ex?.asyncify_start_unwind) return; // not an asyncify cart: no-op
          if (this._asyncify.rewinding) {
            ex.asyncify_stop_rewind();
            this._asyncify.rewinding = false;
            return; // arrived back at the yield point; engine continues
          }
          ex.asyncify_start_unwind(this._asyncify.buf);
          this._asyncify.unwound = true;
        },
        wc_asset_size: (pathPtr, pathLen) => {
          return this._assetSize(pathPtr, pathLen);
        },
        wc_load_asset: (pathPtr, pathLen, destPtr, maxSize) => {
          return this._loadAsset(pathPtr, pathLen, destPtr, maxSize);
        },
        // Pad name query
        wc_pad_name: (padId, bufPtr, bufLen) => {
          return this._padName(padId, bufPtr, bufLen);
        },
        // --- Rumble (cart -> host) ---
        wc_pad_has_rumble: (padId) => this._padHasRumble(padId),
        wc_pad_rumble: (padId, low, high, durationMs) =>
          this._padRumble(padId, low, high, durationMs),
        wc_pad_rumble_stop: (padId) => this._padRumbleStop(padId),
        // --- WebSocket API (ABI v3) ---
        // --- Text input (ABI v3) ---
        // Characters, not scancodes. See CartHost for the full rationale.
        wc_text_input_begin: () => { this._textActive = true; },
        wc_text_input_end: () => {
          this._textActive = false;
          this._textEvents.length = 0;
        },
        wc_text_input_active: () => (this._textActive ? 1 : 0),
        // --- Peer connections (ABI v3) ---
        // One family. Transport is opaque to the cart: WebSocket, WebRTC data
        // channel, TCP, relay, serial - the cart cannot tell and must not care.
        wc_peer_open: (addrPtr, addrLen) => {
          return this._peerOpen(addrPtr, addrLen);
        },
        wc_peer_close: (peerId) => {
          this._peerClose(peerId);
        },
        wc_peer_send: (peerId, dataPtr, len) => {
          return this._peerSend(peerId, dataPtr, len);
        },
        wc_peer_broadcast: (dataPtr, len) => {
          return this._peerBroadcast(dataPtr, len);
        },
        wc_peer_state: (peerId) => {
          return this._peerState(peerId);
        },
        wc_peer_count: () => {
          return this._peers.size;
        },
        wc_peer_id: (index) => {
          return this._peerIdAt(index);
        },
        wc_peer_name: (peerId, destPtr, maxLen) => {
          return this._peerName(peerId, destPtr, maxLen);
        },
        wc_peer_transport: (peerId) => {
          return this._peerTransport(peerId);
        },
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
        emscripten_notify_memory_growth: () => { this._updateViews(); },
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
              console.warn('[cart]', text);
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
          try {
            const ns = BigInt(Math.round(performance.now() * 1e6));
            const view = new DataView(this.memory.buffer);
            view.setBigUint64(resultPtr, ns, true);
          } catch (e) {}
          return 0;
        },
        sched_yield: () => 0,
      },
    };

    // Auto-stub missing WASI imports
    for (const imp of moduleImports) {
      if (imp.module === 'wasi_snapshot_preview1' && imp.kind === 'function') {
        if (!(imp.name in imports.wasi_snapshot_preview1)) {
          imports.wasi_snapshot_preview1[imp.name] = () => 0;
        }
      }
    }

    // Auto-stub missing env functions. This keeps carts built against a newer
    // ABI loadable, but it is a blunt instrument: a stub links cleanly and then
    // misbehaves at runtime, which is how the missing wc_frame_yield went
    // unnoticed -- the yield became `() => -1`, the cart's main loop never
    // unwound, and the first frame hung the tab. So warn: a silently stubbed
    // import is a real incompatibility, not a nothing.
    for (const imp of moduleImports) {
      if (imp.module === 'env' && imp.kind === 'function') {
        if (!(imp.name in imports.env)) {
          console.warn(
            `wasmcart: cart imports env.${imp.name}, which this host does not ` +
            `provide; stubbing it as () => -1. The cart may misbehave.`
          );
          imports.env[imp.name] = () => -1;
        }
      }
    }

    // Stub GL imports for carts that import GL but no backend was provided
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

    // Wire GL imports
    if (this.usesGL) {
      const glFuncs = createWebGLImports({
        getMemory: () => this.memory,
        ctx: options.glBackend,
        getMalloc: () => this.instance?.exports?.malloc || null,
      });
      this._glFuncs = glFuncs;
      imports.gl = glFuncs;
      // Auto-stub any GL imports not covered by webgl_imports.js
      for (const imp of moduleImports) {
        if (imp.module === 'gl' && imp.kind === 'function' && !(imp.name in glFuncs)) {
          glFuncs[imp.name] = () => 0;
        }
      }
      for (const imp of moduleImports) {
        if (imp.module !== 'env' || imp.kind !== 'function') continue;
        if (imp.name.startsWith('gl') && imp.name in glFuncs) {
          imports.env[imp.name] = glFuncs[imp.name];
        } else if (imp.name.startsWith('emscripten_gl')) {
          const glName = imp.name.replace('emscripten_', '');
          const baseName = glName.replace(/(OES|EXT|ANGLE|WEBGL)$/, '');
          if (glName in glFuncs) {
            imports.env[imp.name] = glFuncs[glName];
          } else if (baseName in glFuncs) {
            imports.env[imp.name] = glFuncs[baseName];
          } else {
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
    this._drawProgress(glCtx, 0.6);
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

    // Read info
    this._infoPtr = exports.wc_get_info();
    this.info = this._readInfo(this._infoPtr);

    if (this.info.version < MIN_ABI_VERSION || this.info.version > ABI_VERSION) {
      throw new Error(`ABI version mismatch: cart=${this.info.version}, host supports ${MIN_ABI_VERSION}-${ABI_VERSION}`);
    }

    // Load save data before init
    if (options.saveData && this.info.saveSize > 0) {
      const saveRegion = this._u8.subarray(this.info.savePtr, this.info.savePtr + this.info.saveSize);
      const copyLen = Math.min(options.saveData.length, this.info.saveSize);
      saveRegion.set(options.saveData.subarray(0, copyLen));
    }

    // Write host info before init
    if (this.info.hostInfoPtr) {
      this._writeHostInfo(this.info.hostInfoPtr, options);
    }

    // Seed the cart's RNG BEFORE _initialize as well as wc_init: entropy by
    // default so every page load deals differently. Same contract and same
    // ORDER as CartHost -- static constructors run game code, and seeding
    // after them hands any constructor-time RNG the compile-time seed. (This
    // host has no deterministic mode, so there is no pinned-seed branch.)
    if (typeof exports.wc_set_seed === 'function') {
      const s = new Uint32Array(1);
      (globalThis.crypto || {}).getRandomValues
        ? crypto.getRandomValues(s)
        : (s[0] = (Math.random() * 0x100000000) >>> 0);
      exports.wc_set_seed(s[0]);
    }

    // WASI reactor init
    if (typeof exports._initialize === 'function') {
      exports._initialize();
      this._updateViews();
    }

    // Cart init
    this._drawProgress(glCtx, 0.95);
    if (typeof exports.wc_init === 'function') {
      exports.wc_init();
      this._updateViews();
    }

    // Re-read info (cart may have changed resolution)
    this.info = this._readInfo(this._infoPtr);

    // Asyncify loop-inversion carts export their unwind-stack descriptor
    // (a pre-initialized {current, end} pair followed by the stack area).
    if (typeof exports.wc_yield_buffer === 'function' && typeof exports.asyncify_start_unwind === 'function') {
      this._asyncify.buf = exports.wc_yield_buffer();
    }

    // Set up FBO redirect for GL carts (same as wasmcart-native)
    if (this.usesGL && this._glFuncs?._setupRedirectFBO) {
      this._glFuncs._setupRedirectFBO(this.info.width, this.info.height);
    }

    // Free the wasm bytes from the ZIP buffer (keep assets, drop the wasm entry)
    // The compiled module holds the code now.

    // Initialize timing
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this.frameCount = 0;
    this.audioReadCursor = 0;
  }

  /**
   * Run one frame.
   * @param {Array} [pads] - array of up to 4 pad objects
   * @returns {{ framebuffer: Uint8Array|null, width: number, height: number, audio: Int16Array|Float32Array|null }}
   */
  runFrame(pads) {
    // A suspended cart does not run. Returning the last frame rather than
    // throwing keeps a host whose rAF loop is still ticking correct without it
    // having to know about lifecycle.
    if (this._suspended) return this._lastFrame ?? null;

    const now = performance.now();
    // Clamp: a long stall must not become a giant time step. See CartHost --
    // this is the general guard, since a GC pause or a background tab throttle
    // produces the same spike with no lifecycle event to hang a fix on.
    const raw = now - this.lastFrameTime;
    const deltaMs = raw > MAX_DELTA_MS ? MAX_DELTA_MS : raw;
    // Absorb the discarded time so time_ms stays consistent with the deltas the
    // cart was actually handed.
    if (raw > MAX_DELTA_MS) this.startTime += raw - MAX_DELTA_MS;
    const timeMs = now - this.startTime;
    this.lastFrameTime = now;

    this._updateViews();

    this._writeTime(timeMs, deltaMs, this.frameCount);
    this._writePads(pads || []);

    // Write pointer/keyboard state and deliver events before render
    this._writePointerState();
    this._writeKeyState();
    this._deliverNetEvents();
    this._deliverPointerEvents();
    this._deliverKeyEvents();
    this._deliverTextEvents();

    // Call wc_render (with asyncify resume/suspend for loop-owning carts)
    const asyncEx = this.instance.exports;
    if (this._asyncify.suspended) {
      asyncEx.asyncify_start_rewind(this._asyncify.buf);
      this._asyncify.rewinding = true;
      this._asyncify.suspended = false;
    }
    asyncEx.wc_render();
    if (this._asyncify.unwound) {
      asyncEx.asyncify_stop_unwind();
      this._asyncify.suspended = true;
      this._asyncify.unwound = false;
    }
    this._updateViews();

    // Blit redirect FBO → canvas (GL carts render to redirect, not canvas directly)
    if (this._glFuncs?._blitToCanvas) {
      this._glFuncs._blitToCanvas();
    }

    // Re-read width/height from WASM memory (cart may update during deferred init)
    const base = this._infoPtr >> 2;
    const newW = this._u32[base + 1];
    const newH = this._u32[base + 2];
    if (newW > 0 && newH > 0 && (newW !== this.info.width || newH !== this.info.height)) {
      this._applyResize(newW, newH);
    }

    this.frameCount++;

    // Read framebuffer (null for GL carts - they render to canvas directly)
    let framebuffer = null;
    if (this.info.fbPtr && !this.usesGL) {
      const fbSize = this.info.width * this.info.height * 4;
      framebuffer = this._u8.subarray(this.info.fbPtr, this.info.fbPtr + fbSize);
    }

    const audio = this._drainAudio();

    this._lastFrame = {
      framebuffer,
      width: this.info.width,
      height: this.info.height,
      audio,
    };
    return this._lastFrame;
  }

  /**
   * Get the current save data.
   */
  getSaveData() {
    if (!this.info || this.info.saveSize === 0) return null;
    return new Uint8Array(
      this._u8.slice(this.info.savePtr, this.info.savePtr + this.info.saveSize)
    );
  }

  /**
   * The live WebGL2 context this cart is rendering through, or null for a 2D
   * cart. Covers BOTH cases: one the host created for itself and one the
   * caller supplied via `glBackend`. Readback (screenshots, terminal output,
   * frame hashing) needs the context regardless of who made it, so keying off
   * the host-created one alone silently disables readback whenever a caller
   * passes its own — which is exactly the shape of bug this returns.
   */
  getGlContext() {
    return this._ownedGl || this._callerGl || null;
  }

  getInfo() {
    return this.info ? { ...this.info } : null;
  }

  destroy() {
    // Release a GL context this host created itself (a caller-supplied
    // glBackend belongs to the caller and is left alone).
    if (this._ownedGl) {
      try { this._ownedGl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
      this._ownedGl = null;
    }

    // Close only transports this host created. A channel the embedder supplied
    // via addPeer() belongs to the embedder: closing it breaks any host that
    // outlives a single cart instance, and for a real RTCDataChannel it is
    // unrecoverable -- once closed the peer connection must renegotiate.
    for (const [, peer] of this._peers) {
      if (!peer.hostOwned) {
        // Detach our handlers so a destroyed host stops queueing events into
        // an object nobody reads any more.
        if (peer.dc) {
          try { peer.dc.onmessage = null; peer.dc.onclose = null; } catch {}
        }
        continue;
      }
      try {
        if (peer.ws) peer.ws.close();
        else if (peer.dc && peer.dc.close) peer.dc.close();
      } catch {}
    }
    // Clearing is what stops delivery: _deliverNetEvents() iterates this map.
    this._peers.clear();

    // Terminate all worker threads
    for (const [tid, worker] of this._workers) {
      worker.terminate();
    }
    this._workers.clear();

    this._assetIndex = null;
    this._assetBuf = null;
    this._sharedMemory = null;
    this._compiledModule = null;
    this.instance = null;
    this.memory = null;
    this._u8 = null;
    this._u16 = null;
    this._i16 = null;
    this._u32 = null;
    this._f32 = null;
    this._f64 = null;
  }

  // --- .wasc loading ---

  _loadFromWascBuffer(buf) {
    const index = parseZipFromBuffer(buf);

    if (index.size > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive has too many entries (${index.size} > ${MAX_ARCHIVE_ENTRIES})`);
    }

    // Read manifest
    const manifestEntry = index.get('manifest.json');
    // The manifest is OPTIONAL (SPEC: "a host MUST NOT refuse a cart for
    // lacking one"). Absent it, every field takes its default and `entry`
    // falls back to cart.wasm.
    let manifest = {};
    if (manifestEntry) {
      const manifestBuf = readZipEntryFromBuffer(buf, manifestEntry);
      manifest = JSON.parse(new TextDecoder().decode(manifestBuf));
    }
    this._manifest = manifestEntry ? manifest : null;

    // Read wasm
    const wasmName = manifest.entry || 'cart.wasm';
    const wasmEntry = index.get(wasmName);
    if (!wasmEntry) throw new Error(`.wasc archive missing ${wasmName}`);
    const wasmBytes = readZipEntryFromBuffer(buf, wasmEntry);

    // Build asset index
    const assetsPrefix = assetPrefixOf(manifest);
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

    // Virtual _filelist.txt
    const fileList = [...this._assetIndex.keys()].filter(p => !p.startsWith('assets/')).join('\n');
    this._fileListBuf = new TextEncoder().encode(fileList);

    this._assetBuf = buf;
    this._hasAssets = this._assetIndex.size > 0;

    return wasmBytes;
  }

  // --- Asset API ---

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

    if (path === '_filelist.txt' && this._fileListBuf) {
      return this._fileListBuf.length;
    }

    const entry = this._assetIndex.get(path);
    if (!entry) return -1;
    return entry.uncompressedSize;
  }

  _loadAsset(pathPtr, pathLen, destPtr, maxSize) {
    if (!this._hasAssets) return -1;
    const path = this._readPath(pathPtr, pathLen);
    if (!path) return -1;

    let data;

    if (path === '_filelist.txt' && this._fileListBuf) {
      data = this._fileListBuf;
    } else {
      const entry = this._assetIndex.get(path);
      if (!entry) return -1;
      try {
        data = readZipEntryFromBuffer(this._assetBuf, entry);
      } catch {
        return -1;
      }
    }

    const copyLen = Math.min(data.length, maxSize);
    this._updateViews();
    this._u8.set(data.subarray ? data.subarray(0, copyLen) : new Uint8Array(data, 0, copyLen), destPtr);

    return copyLen;
  }

  // --- Threading ---

  _spawnThread(startArg) {
    if (!this.isThreaded || !this._compiledModule || !this._sharedMemory) return -1;

    const tid = this._nextTid++;

    // Serialize asset config for the worker
    const assetConfig = {};
    if (this._assetBuf) {
      // SharedArrayBuffer is needed to pass to worker.
      // If _assetBuf is on a regular ArrayBuffer, copy to SharedArrayBuffer.
      let sharedBuf = this._assetBuf.buffer;
      if (!(sharedBuf instanceof SharedArrayBuffer)) {
        // Can't share regular ArrayBuffer with worker via structured clone
        // in all browsers. Pass as transferable copy.
        assetConfig.type = 'buffer';
        assetConfig.buffer = this._assetBuf.buffer;
        assetConfig.index = this._assetIndex ? [...this._assetIndex.entries()] : [];
      } else {
        assetConfig.type = 'buffer';
        assetConfig.buffer = sharedBuf;
        assetConfig.index = this._assetIndex ? [...this._assetIndex.entries()] : [];
      }
    }

    const workerURL = new URL('./cartWorkerWeb.js', import.meta.url);
    const worker = new Worker(workerURL, { type: 'module' });

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'spawn') {
        const nestedTid = this._spawnThread(msg.startArg);
        worker.postMessage({ type: 'spawned', tid: nestedTid, requestId: msg.requestId });
      } else if (msg.type === 'exit') {
        this._workers.delete(msg.tid);
      }
    };

    worker.onerror = (err) => {
      console.error(`[thread ${tid}] error:`, err.message);
      this._workers.delete(tid);
    };

    worker.postMessage({
      module: this._compiledModule,
      memory: this._sharedMemory,
      tid,
      startArg,
      assetConfig,
    });

    this._workers.set(tid, worker);
    return tid;
  }

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
      isThreaded: hasThreadSpawn && hasThreadStart,
      importsMemory,
    };
  }

  static _parseMemoryImportLimits(wasmBytes) {
    const buf = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
    let pos = 8;

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

      if (sectionId === 2) {
        const count = readLEB128();
        for (let i = 0; i < count; i++) {
          const modLen = readLEB128();
          skipBytes(modLen);
          const fieldLen = readLEB128();
          skipBytes(fieldLen);
          const kind = buf[pos++];

          if (kind === 0x02) {
            const flags = buf[pos++];
            const shared = !!(flags & 0x02);
            const hasMax = !!(flags & 0x01);
            const initial = readLEB128();
            const maximum = hasMax ? readLEB128() : undefined;
            return { initial, maximum, shared };
          } else if (kind === 0x00) {
            readLEB128();
          } else if (kind === 0x01) {
            pos++;
            const tFlags = buf[pos++];
            readLEB128();
            if (tFlags & 0x01) readLEB128();
          } else if (kind === 0x03) {
            pos++;
            pos++;
          }
        }
        return null;
      }

      pos = sectionEnd;
    }
    return null;
  }

  getManifest() {
    return this._manifest ? { ...this._manifest } : null;
  }

  // --- Networking (ABI v3) ---

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
      const memSize = this.memory.buffer.byteLength;
      const scratchStart = memSize - 65536;
      if (len > 65536 || len === 0) return;
      this._updateViews();
      this._u8.set(bytes, scratchStart);
      callback(scratchStart, len);
    }
  }

  /**
   * Open a peer connection. `addr` is host-interpreted - this host understands
   * ws:// and wss:// URLs. A host that does not understand an address, or whose
   * manifest grant does not cover its transport class, fails the open.
   */
  _peerOpen(addrPtr, addrLen) {
    // Dual gate: the cart's flag requests networking, the manifest grants it.
    // Fail closed if either is missing.
    if (!this.info?.wantsNet) return -1;
    if (!this._manifest?.net) return -1;

    this._updateViews();
    const addr = new TextDecoder().decode(this._u8.slice(addrPtr, addrPtr + addrLen));

    // Domain-granted transports: only ws/wss are implemented here. LAN and
    // serial addresses would be gated by net.lan / net.serial respectively.
    let url;
    try {
      url = new URL(addr);
    } catch {
      return -1;
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return -1;

    // net.domains is the allowlist; net.websocket is the superseded spelling,
    // still read so older manifests keep working.
    const allowlist = this._manifest?.net?.domains ?? this._manifest?.net?.websocket;
    if (!allowlist) return -1;
    if (!allowlist.includes(url.hostname)) return -1;
    if (!globalThis.WebSocket) return -1;

    const id = this._peerNextId++;
    try {
      const ws = new WebSocket(addr);
      if (ws.binaryType !== undefined) ws.binaryType = 'arraybuffer';

      // name defaults to the hostname: display-only, never a handle.
      const peer = {
        ws,
        name: url.hostname,
        transport: TRANSPORT_WS,
        // The host dialled this socket, so the host closes it on destroy().
        hostOwned: true,
        eventQueue: [],
      };
      ws.onopen = () => peer.eventQueue.push({ type: 'connect' });
      ws.onmessage = (e) => {
        // Binary only. A text frame from the server is delivered as its UTF-8
        // bytes: framing is the cart's business, so we never drop the payload.
        const data = typeof e.data === 'string'
          ? new TextEncoder().encode(e.data)
          : e.data;
        peer.eventQueue.push({ type: 'message', data });
      };
      ws.onclose = () => peer.eventQueue.push({ type: 'disconnect' });
      ws.onerror = () => peer.eventQueue.push({ type: 'error' });

      this._peers.set(id, peer);
      return id;
    } catch {
      return -1;
    }
  }

  _peerClose(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) return;
    try {
      if (peer.ws) peer.ws.close(1000);
      else if (peer.dc && peer.dc.close) peer.dc.close();
    } catch {}
  }

  _peerSend(peerId, dataPtr, len) {
    const peer = this._peers.get(peerId);
    if (!peer) return -1;
    try {
      this._updateViews();
      const bytes = this._u8.slice(dataPtr, dataPtr + len);
      if (peer.ws) {
        if (peer.ws.readyState !== 1) return -1; // not OPEN
        peer.ws.send(bytes);
      } else if (peer.dc) {
        peer.dc.send(bytes);
      } else {
        return -1;
      }
      return len;
    } catch {
      return -1;
    }
  }

  _peerBroadcast(dataPtr, len) {
    this._updateViews();
    const bytes = this._u8.slice(dataPtr, dataPtr + len);
    let count = 0;
    for (const [, peer] of this._peers) {
      try {
        if (peer.ws) {
          if (peer.ws.readyState !== 1) continue;
          peer.ws.send(bytes);
        } else if (peer.dc) {
          peer.dc.send(bytes);
        } else {
          continue;
        }
        count++;
      } catch {}
    }
    return count || -1;
  }

  _peerState(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) return PEER_CLOSED;
    if (peer.ws) return peer.ws.readyState;
    // Host-registered peers are live from the moment they are added.
    return peer.closed ? PEER_CLOSED : PEER_OPEN;
  }

  /** Connection ID at an index, so a cart can enumerate without tracking events. */
  _peerIdAt(index) {
    const ids = [...this._peers.keys()];
    if (index >= ids.length) return -1;
    return ids[index];
  }

  /** Write the peer's display name. DISPLAY-ONLY - the id is the handle. */
  _peerName(peerId, destPtr, maxLen) {
    const peer = this._peers.get(peerId);
    if (!peer) return -1;
    if (maxLen === 0) return -1;
    this._updateViews();
    const nameBytes = new TextEncoder().encode(String(peer.name ?? ''));
    // Always NUL-terminate: truncate the text, never the terminator.
    const copyLen = Math.min(nameBytes.length, maxLen - 1);
    this._u8.set(nameBytes.subarray(0, copyLen), destPtr);
    this._u8[destPtr + copyLen] = 0;
    return copyLen + 1;
  }

  _peerTransport(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) return TRANSPORT_UNKNOWN;
    return peer.transport ?? TRANSPORT_UNKNOWN;
  }

  _deliverNetEvents() {
    const exports = this.instance.exports;

    for (const [peerId, peer] of this._peers) {
      while (peer.eventQueue.length > 0) {
        const evt = peer.eventQueue.shift();
        if (evt.type === 'connect' && exports.wc_peer_on_connect) {
          const nameBytes = new TextEncoder().encode(String(peer.name ?? ''));
          this._withTempWasmData(nameBytes, (ptr, len) => {
            exports.wc_peer_on_connect(peerId, ptr, len);
          });
        } else if (evt.type === 'message' && exports.wc_peer_on_message) {
          const buf = evt.data instanceof ArrayBuffer ? new Uint8Array(evt.data)
            : evt.data instanceof Uint8Array ? evt.data
            : new Uint8Array(evt.data);
          this._withTempWasmData(buf, (ptr, len) => {
            exports.wc_peer_on_message(peerId, ptr, len);
          });
        } else if (evt.type === 'disconnect') {
          peer.closed = true;
          if (exports.wc_peer_on_disconnect) exports.wc_peer_on_disconnect(peerId);
        } else if (evt.type === 'error' && exports.wc_peer_on_error) {
          exports.wc_peer_on_error(peerId);
        }
      }
    }
  }

  /**
   * Register a peer whose connection this host application manages (WebRTC data
   * channel, LAN socket, serial link - the cart cannot tell which).
   * @param {number} peerId - unique peer ID
   * @param {string} name - display name; NOT a handle, NOT trusted
   * @param {object} channel - object with send(), onmessage, onclose
   * @param {number} [transport] - TRANSPORT_* bitmask, 0 if uncharacterized
   */
  addPeer(peerId, name, channel, transport = TRANSPORT_UNKNOWN) {
    const peer = {
      dc: channel,
      // Borrowed: the embedder handed this over and still owns it. destroy()
      // forgets it without closing, so a lobby socket or a data channel can
      // outlive one cart instance -- which is what makes swapping carts on a
      // live session free. Same ownership line the GL context already draws
      // (_ownedGl vs _callerGl).
      hostOwned: false,
      name,
      transport,
      closed: false,
      eventQueue: [{ type: 'connect' }],
    };
    channel.onmessage = (e) => {
      peer.eventQueue.push({ type: 'message', data: e.data });
    };
    channel.onclose = () => {
      peer.eventQueue.push({ type: 'disconnect' });
    };
    this._peers.set(peerId, peer);
  }

  /** Remove a host-managed peer. */
  removePeer(peerId) {
    const peer = this._peers.get(peerId);
    if (peer) {
      peer.eventQueue.push({ type: 'disconnect' });
    }
  }


  // --- Pointer Input (ABI v3) ---

  setPointer(id, x, y, buttons, active) {
    if (id < 0 || id >= MAX_POINTERS) return;
    const p = this._pointerState[id];
    p.x = x;
    p.y = y;
    p.buttons = buttons;
    p.active = active ? 1 : 0;
  }

  pointerDown(id, x, y, button) {
    if (id < 0 || id >= MAX_POINTERS) return;
    const p = this._pointerState[id];
    p.x = x;
    p.y = y;
    p.buttons |= (1 << (button || 0));
    p.active = 1;
    this._pointerEvents.push({ type: 'down', id, x, y, button: button || 0 });
  }

  pointerMove(id, x, y) {
    if (id < 0 || id >= MAX_POINTERS) return;
    const p = this._pointerState[id];
    p.x = x;
    p.y = y;
    this._pointerEvents.push({ type: 'move', id, x, y });
  }

  pointerUp(id, button) {
    if (id < 0 || id >= MAX_POINTERS) return;
    const p = this._pointerState[id];
    p.buttons &= ~(1 << (button || 0));
    if (p.buttons === 0 && id > 0) {
      p.active = 0;
    }
    this._pointerEvents.push({ type: 'up', id, button: button || 0 });
  }

  _writePointerState() {
    if (!this.info || !this.info.pointerPtr || !this.info.wantsPointer) return;
    // The cart's WC_FLAG_POINTER is the ground truth — a manifest field
    // never gates a capability the cart already declares (the double-gate
    // lesson that GL detection already learned).
    if (!this.info?.wantsPointer) return;
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
    if (!this.info?.wantsPointer) return;
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

  keyDown(keycode, modifiers) {
    if (keycode < 0 || keycode > 255) return;
    this._keyState[keycode >> 3] |= (1 << (keycode & 7));
    this._keyEvents.push({ type: 'down', keycode, modifiers: modifiers || 0 });
  }

  keyUp(keycode, modifiers) {
    if (keycode < 0 || keycode > 255) return;
    this._keyState[keycode >> 3] &= ~(1 << (keycode & 7));
    this._keyEvents.push({ type: 'up', keycode, modifiers: modifiers || 0 });
  }

  _writeKeyState() {
    if (!this.info || !this.info.keysPtr || !this.info.wantsKeyboard) return;
    // WC_FLAG_KEYBOARD is the ground truth; see the pointer note above.
    if (!this.info?.wantsKeyboard) return;
    this._updateViews();
    this._u8.set(this._keyState, this.info.keysPtr);
  }

  /**
   * Queue committed text. In a browser this comes from `beforeinput` or a
   * `keypress`-equivalent -- never synthesized from keydown, since the browser
   * has already applied layout, dead keys and IME composition.
   */
  textInput(text) {
    if (!this._textActive || typeof text !== 'string' || text.length === 0) return;
    this._textEvents.push(text);
  }

  get textInputActive() { return this._textActive; }

  _deliverTextEvents() {
    if (this._textEvents.length === 0) return;
    const fn = this.instance?.exports?.wc_on_text;
    if (typeof fn !== 'function') { this._textEvents.length = 0; return; }
    while (this._textEvents.length > 0) {
      const bytes = new TextEncoder().encode(this._textEvents.shift());
      if (bytes.length === 0) continue;
      this._withTempWasmData(bytes, (ptr, len) => {
        try {
          fn(ptr, len);
        } catch (e) {
          console.warn("wasmcart: cart's wc_on_text() threw:", e?.message ?? e);
        }
      });
    }
  }

  _deliverKeyEvents() {
    if (!this.info?.wantsKeyboard) return;
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

  // --- Private ---

  _validateModule(module) {
    const moduleImports = WebAssembly.Module.imports(module);
    const moduleExports = WebAssembly.Module.exports(module);

    for (const imp of moduleImports) {
      if (imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi') continue;
      if (imp.module === 'gl') continue;
      if (imp.module !== 'env') {
        throw new Error(`Cart imports unknown module: "${imp.module}"`);
      }
      if (imp.kind === 'memory') continue;
    }

    const exportNames = moduleExports.map(e => e.name);
    if (!exportNames.includes('wc_render')) {
      throw new Error('Cart must export wc_render');
    }
    if (!exportNames.includes('wc_get_info')) {
      throw new Error('Cart must export wc_get_info');
    }
    // Threaded carts may import memory instead of exporting it
    const analysis = this._analyzeModule(module);
    if (!exportNames.includes('memory') && !analysis.importsMemory) {
      throw new Error('Cart must export memory');
    }
  }

  _updateViews() {
    const buf = this.memory.buffer;
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

  _readInfo(ptr) {
    const u32 = this._u32;
    const base = ptr >> 2;

    const info = {
      version:    u32[base + 0],
      width:      u32[base + 1],
      height:     u32[base + 2],
      fbPtr:      u32[base + 3],
      audioPtr:   u32[base + 4],
      audioCap:   u32[base + 5],
      audioWritePtr: u32[base + 6],
      inputPtr:   u32[base + 7],
      savePtr:    u32[base + 8],
      saveSize:   u32[base + 9],
      timePtr:    u32[base + 10],
      hostInfoPtr: 0,
    };

    if (info.version >= 2) {
      const hip = u32[base + 11];
      if (hip > 0 && hip < 0x10000000 && (hip & 3) === 0) {
        info.hostInfoPtr = hip;
      }
    }

    info.flags = u32[base + 12] || 0;
    info.audioIsF32 = !!(info.flags & 1);
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
    // Networking is the one dual gate: the flag REQUESTS it, the manifest
    // GRANTS it, and both are required. Reaching a remote machine is a
    // permission the packager gives, not one the cart may assert.
    info.wantsNet = !!(info.flags & FLAG_NET_PEER);

    // gpu_api (offset 64, u32 index 16) - 0=2D, 1=WebGL2, 2=WebGPU, 3=Vulkan
    info.gpuApi = u32[base + 16] || 0;

    return info;
  }

  _writeHostInfo(hostInfoPtr, options) {
    if (!hostInfoPtr) return;
    const u32 = this._u32;
    const base = hostInfoPtr >> 2;
    u32[base + 0] = options.preferredWidth || 0;
    u32[base + 1] = options.preferredHeight || 0;
    u32[base + 2] = 0; // reserved
    u32[base + 3] = options.audioSampleRate || 48000;
    u32[base + 4] = options.flags || 0;
  }

  _writeTime(timeMs, deltaMs, frame) {
    const ptr = this.info.timePtr;
    const f64Base = ptr >> 3;
    this._f64[f64Base + 0] = timeMs;
    this._f64[f64Base + 1] = deltaMs;
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

  /**
   * Adopt a cart-requested resolution, but only if the cart's framebuffer
   * actually backs it. See the node host for the full rationale: the cart
   * writes these numbers into its own memory, so they are untrusted, and
   * subarray() silently CLAMPS rather than throwing -- which would leave the
   * host reporting a resolution whose pixels do not exist.
   */
  _applyResize(newW, newH) {
    // Float math first: w*h*4 can exceed 2^32 and wrap in int math, turning an
    // absurd size into a small, plausible-looking one.
    const needed = newW * newH * 4;
    const available = this._u8.length - this.info.fbPtr;
    if (!Number.isFinite(needed) || needed > available) {
      if (!this._resizeRejected) {
        this._resizeRejected = true;
        console.warn(
          `wasmcart: cart requested ${newW}x${newH} (${needed} bytes) but its ` +
          `framebuffer only has ${available} bytes at fb_ptr; keeping ` +
          `${this.info.width}x${this.info.height}. The cart must grow its ` +
          `framebuffer before changing resolution.`
        );
      }
      return false;
    }
    this.info.width = newW;
    this.info.height = newH;
    return true;
  }

  // --- Lifecycle ---
  // Same contract as the node host. The browser is the one environment that
  // can source these itself, so autoWireLifecycle() exists; a host embedding
  // the cart in a larger app drives them manually instead.

  suspend() {
    if (this._suspended) return false;
    this._suspended = true;
    if (this._focused) this.blur();
    this._callLifecycle('wc_on_suspend');
    return true;
  }

  resume() {
    if (!this._suspended) return false;
    this._suspended = false;
    this._rebaseClock();
    this._callLifecycle('wc_on_resume');
    this.focus();
    return true;
  }

  blur() {
    if (!this._focused) return false;
    this._focused = false;
    this._callLifecycle('wc_on_focus_lost');
    return true;
  }

  focus() {
    if (this._focused) return false;
    this._focused = true;
    this._callLifecycle('wc_on_focus_gained');
    return true;
  }

  get suspended() { return this._suspended; }
  get focused() { return this._focused; }

  /**
   * Drive lifecycle from the browser's own signals: visibilitychange for
   * suspend/resume, window focus/blur for the focus pair.
   *
   * Opt-in rather than automatic, because a cart embedded in a larger page is
   * not necessarily suspended just because the tab is hidden, and the embedder
   * may have its own idea of when the cart should stop. Returns a teardown fn.
   */
  autoWireLifecycle(target = globalThis) {
    const doc = target.document;
    const onVis = () => (doc.hidden ? this.suspend() : this.resume());
    const onBlur = () => this.blur();
    const onFocus = () => this.focus();
    doc?.addEventListener('visibilitychange', onVis);
    target.addEventListener?.('blur', onBlur);
    target.addEventListener?.('focus', onFocus);
    // Adopt the CURRENT state rather than assuming visible+focused: a cart
    // loaded into an already-hidden tab should start suspended, not run one
    // stray frame and then stop.
    if (doc?.hidden) this.suspend();
    this._visListener = () => {
      doc?.removeEventListener('visibilitychange', onVis);
      target.removeEventListener?.('blur', onBlur);
      target.removeEventListener?.('focus', onFocus);
      this._visListener = null;
    };
    return this._visListener;
  }

  _rebaseClock() {
    // This host has no deterministic fixed-step clock (that is a node-side
    // harness feature), so there is only the wall-clock case to correct.
    const now = performance.now();
    const gap = now - this.lastFrameTime;
    if (gap > 0) {
      this.startTime += gap;
      this.lastFrameTime = now;
    }
  }

  _callLifecycle(name) {
    const fn = this.instance?.exports?.[name];
    if (typeof fn !== 'function') return;
    try {
      fn();
    } catch (e) {
      console.warn(`wasmcart: cart's ${name}() threw:`, e?.message ?? e);
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

  // --- Rumble ---
  // Cart-driven, so these are imports rather than fields in the shared pad
  // struct. Unlike the node host there is a sensible default here: the Gamepad
  // API is already the source of pad state, so rumble resolves against the live
  // navigator.getGamepads() entry unless the embedder overrides it.
  //
  // W3C 'dual-rumble' takes strongMagnitude/weakMagnitude/duration, which is
  // the same three parameters SDL's rumble() takes, so the ABI maps to both
  // backends without per-platform divergence.
  setRumbleHandler(handler) {
    this._rumbleHandler = handler || null;
  }

  /** The vibration actuator for a pad slot, or null if it has none. */
  _actuator(padId) {
    if (padId >= MAX_PADS) return null;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[padId];
    // Chrome exposes vibrationActuator; the spec also allows hapticActuators[].
    return gp?.vibrationActuator || gp?.hapticActuators?.[0] || null;
  }

  _padHasRumble(padId) {
    if (padId >= MAX_PADS) return 0;
    if (this._rumbleHandler) {
      try {
        return this._rumbleHandler.hasRumble(padId) ? 1 : 0;
      } catch {
        return 0;
      }
    }
    return this._actuator(padId) ? 1 : 0;
  }

  _padRumble(padId, low, high, durationMs) {
    if (padId >= MAX_PADS) return;
    // Clamp rather than reject: a cart deriving intensity from game state will
    // overshoot at the edges, and a dropped rumble is harder to notice than a
    // saturated one. NaN clamps to 0.
    const lo = clamp01(low);
    const hi = clamp01(high);
    // Cap duration so a cart cannot pin the motors indefinitely.
    const dur = Math.min(Math.max(durationMs | 0, 0), MAX_RUMBLE_MS);
    if (dur === 0) return;
    if (this._rumbleHandler) {
      try {
        this._rumbleHandler.rumble(padId, lo, hi, dur);
      } catch { /* a pad unplugged mid-effect must not fault the cart */ }
      return;
    }
    const act = this._actuator(padId);
    if (!act?.playEffect) return;
    // playEffect returns a promise that rejects if the pad vanishes; swallow it
    // so an unplug cannot surface as an unhandled rejection.
    try {
      act.playEffect('dual-rumble', {
        duration: dur,
        strongMagnitude: lo,
        weakMagnitude: hi,
      })?.catch?.(() => {});
    } catch { /* as above */ }
  }

  _padRumbleStop(padId) {
    if (padId >= MAX_PADS) return;
    if (this._rumbleHandler) {
      try {
        this._rumbleHandler.stopRumble(padId);
      } catch { /* as above */ }
      return;
    }
    const act = this._actuator(padId);
    try {
      act?.reset?.()?.catch?.(() => {});
    } catch { /* as above */ }
  }

  _drainAudio() {
    if (!this.info.audioPtr || this.info.audioCap === 0) return null;

    const writeCursor = this._u32[this.info.audioWritePtr >> 2];
    const readCursor = this.audioReadCursor;

    if (writeCursor === readCursor) return null;

    const cap = this.info.audioCap;
    const audioBase = this.info.audioPtr;

    let available;
    if (writeCursor >= readCursor) {
      available = writeCursor - readCursor;
    } else {
      available = cap - readCursor + writeCursor;
    }

    if (available === 0) return null;

    const needed = available * 2; // stereo

    if (this.info.audioIsF32) {
      if (!this._audioBufF32 || this._audioBufF32.length < needed) {
        this._audioBufF32 = new Float32Array(needed);
      }
      const samples = this._audioBufF32;
      const ringF32Base = audioBase >> 2;

      for (let i = 0; i < available; i++) {
        const ringIdx = ((readCursor + i) % cap) * 2;
        samples[i * 2] = this._f32[ringF32Base + ringIdx];
        samples[i * 2 + 1] = this._f32[ringF32Base + ringIdx + 1];
      }

      this.audioReadCursor = writeCursor;
      return samples.subarray(0, needed);
    }

    // Int16 path
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
