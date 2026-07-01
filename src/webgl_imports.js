// webgl_imports.js - builds the `gl` WASM import module for GL-enabled carts
// using a WebGL2RenderingContext as the backend.
//
// The cart imports GL functions from a module named "gl":
//   __attribute__((import_module("gl"), import_name("glClear")))
//   extern void glClear(unsigned int mask);
//
// This factory maps those WASM imports to WebGL2 method calls, maintaining
// integer ID ↔ WebGL object mapping tables (like emscripten's GL.textures[]).
//
// Backend: WebGL2RenderingContext (from webgl-node or browser)

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readCString(u8, ptr) {
  let end = ptr;
  while (u8[end] !== 0) end++;
  return decoder.decode(u8.subarray(ptr, end));
}

/**
 * Create the GL import object for WASM instantiation.
 *
 * @param {object} options
 * @param {function} options.getMemory - returns the WASM memory object
 * @param {WebGL2RenderingContext} options.ctx - WebGL2 rendering context
 * @returns {object} import object with GL functions
 */
export function createWebGLImports({ getMemory, ctx, getMalloc, nativeGL }) {
  function u8() { return new Uint8Array(getMemory().buffer); }
  function u16() { return new Uint16Array(getMemory().buffer); }
  function u32() { return new Uint32Array(getMemory().buffer); }
  function i32() { return new Int32Array(getMemory().buffer); }
  function f32() { return new Float32Array(getMemory().buffer); }

  // Enable WebGL2 extensions upfront
  const _extAniso = ctx.getExtension('EXT_texture_filter_anisotropic');
  ctx.getExtension('OES_texture_float_linear');
  ctx.getExtension('EXT_color_buffer_float');
  ctx.getExtension('EXT_float_blend');
  ctx.getExtension('EXT_texture_norm16');
  ctx.getExtension('WEBGL_compressed_texture_s3tc');
  ctx.getExtension('WEBGL_compressed_texture_s3tc_srgb');
  ctx.getExtension('EXT_texture_compression_bptc');
  ctx.getExtension('EXT_texture_compression_rgtc');

  // Build extension list with "GL_" prefix (native GLES convention).
  // Also include custom extensions for compatibility with engine feature detection.
  const _extraExtensions = [
    'GL_OES_packed_depth_stencil',
    'GL_OES_texture_npot',
    'GL_EXT_texture_filter_anisotropic',
    'GL_OES_texture_float_linear',
    'GL_EXT_color_buffer_float',
    'GL_EXT_float_blend',
    'GL_EXT_texture_compression_s3tc',
    'GL_EXT_texture_compression_dxt1',
    'GL_EXT_texture_compression_bptc',
    'GL_EXT_texture_compression_rgtc',
    'WEBGL_compressed_texture_s3tc',
    'WEBGL_compressed_texture_s3tc_srgb',
  ];
  const _allExtensions = (() => {
    const browserExts = ctx.getSupportedExtensions() || [];
    const set = new Set();
    for (const ext of browserExts) {
      set.add(ext);
      if (!ext.startsWith('GL_')) set.add('GL_' + ext);
    }
    for (const ext of _extraExtensions) set.add(ext);
    // Remove GLES2-only extensions that are built-in in GLES3/WebGL2.
    // Ganesh adds #extension directives for these which fail in GLSL 300 es.
    const gles2Builtins = ['OES_standard_derivatives', 'GL_OES_standard_derivatives',
                           'EXT_shader_texture_lod', 'GL_EXT_shader_texture_lod'];
    for (const e of gles2Builtins) set.delete(e);
    return Array.from(set);
  })();

  // ─── Object ID tables ─────────────────────────────────────────────────
  // WebGL uses opaque objects; C code uses integer IDs.
  // ID 0 = null (no object), IDs start at 1.
  const _buffers = [null];       // id → WebGLBuffer
  const _textures = [null];      // id → WebGLTexture
  const _framebuffers = [null];  // id → WebGLFramebuffer
  const _renderbuffers = [null]; // id → WebGLRenderbuffer
  const _programs = [null];      // id → WebGLProgram
  const _shaders = [null];       // id → WebGLShader
  const _vaos = [null];          // id → WebGLVertexArrayObject
  const _samplers = [null];      // id → WebGLSampler
  const _queries = [null];       // id → WebGLQuery
  const _syncs = [null];         // id → WebGLSync

  // Uniform locations: per-program map of integer loc → WebGLUniformLocation
  // Key: program ID, Value: Map<int, WebGLUniformLocation>
  const _uniformLocs = new Map(); // programId → { byName: Map<string, {loc, id}>, byId: Map<int, loc> }
  let _currentProgramId = 0;
  let _nextUniformId = 0;

  // ─── FBO redirect (same as wasmcart-native gl_imports.cpp) ──────────
  // Cart's glBindFramebuffer(0) → redirect FBO with depth+stencil.
  // After each frame, blit redirect FBO → real canvas (FBO null).
  let _redirectFBO = null;
  let _redirectTex = null;
  let _redirectRBO = null;
  let _redirectW = 0;
  let _redirectH = 0;

  function _ensureRedirectFBO(w, h) {
    if (_redirectFBO && _redirectW === w && _redirectH === h) return;
    if (_redirectFBO) {
      ctx.deleteFramebuffer(_redirectFBO);
      ctx.deleteTexture(_redirectTex);
      ctx.deleteRenderbuffer(_redirectRBO);
    }
    _redirectFBO = ctx.createFramebuffer();
    _redirectTex = ctx.createTexture();
    _redirectRBO = ctx.createRenderbuffer();

    ctx.bindTexture(0x0DE1, _redirectTex);
    ctx.texImage2D(0x0DE1, 0, ctx.RGBA8, w, h, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, null);
    ctx.texParameteri(0x0DE1, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
    ctx.texParameteri(0x0DE1, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);

    ctx.bindRenderbuffer(ctx.RENDERBUFFER, _redirectRBO);
    ctx.renderbufferStorage(ctx.RENDERBUFFER, ctx.DEPTH24_STENCIL8, w, h);

    ctx.bindFramebuffer(ctx.FRAMEBUFFER, _redirectFBO);
    ctx.framebufferTexture2D(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, 0x0DE1, _redirectTex, 0);
    ctx.framebufferRenderbuffer(ctx.FRAMEBUFFER, ctx.DEPTH_STENCIL_ATTACHMENT, ctx.RENDERBUFFER, _redirectRBO);

    _redirectW = w;
    _redirectH = h;
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
  }

  function _blitRedirectToCanvas() {
    if (!_redirectFBO) return;
    const cw = ctx.drawingBufferWidth;
    const ch = ctx.drawingBufferHeight;
    ctx.bindFramebuffer(ctx.READ_FRAMEBUFFER, _redirectFBO);
    ctx.bindFramebuffer(ctx.DRAW_FRAMEBUFFER, null);
    ctx.blitFramebuffer(0, 0, _redirectW, _redirectH, 0, 0, cw, ch,
      ctx.COLOR_BUFFER_BIT, ctx.LINEAR);
    // Restore redirect for next frame
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, _redirectFBO);
  }

  function _allocId(table, obj) {
    const id = table.length;
    table.push(obj);
    return id;
  }

  // WebGL2 requires sized internal formats for texImage2D.
  // GLES2 carts often pass unsized formats (e.g. GL_RGBA instead of GL_RGBA8).
  // Map unsized → sized based on format+type, and handle ARB suffixed constants.
  function _fixInternalFormat(ifmt, format, type) {
    const GL_UNSIGNED_BYTE = 0x1401;
    const GL_FLOAT = 0x1406;
    const GL_HALF_FLOAT = 0x140B;
    const GL_HALF_FLOAT_OES = 0x8D61;

    // ARB/EXT suffixed constants → core WebGL2
    switch (ifmt) {
      case 0x881A: return 0x881A; // GL_RGBA16F_ARB → GL_RGBA16F (same value, valid in WebGL2)
      case 0x881B: return 0x881B; // GL_RGB16F
      case 0x8814: return 0x8814; // GL_RGBA32F
      case 0x8815: return 0x8815; // GL_RGB32F
      case 0x822D: return 0x822D; // GL_R16F
      case 0x822E: return 0x822E; // GL_RG16F
      case 0x8D62: return 0x8D62; // GL_RGB16UI (not a float, but valid)
    }

    // Unsized → sized internal format
    if (type === GL_UNSIGNED_BYTE) {
      switch (ifmt) {
        case 0x1906: return 0x8229; // GL_ALPHA → GL_R8 (no GL_ALPHA8 in WebGL2)
        case 0x1909: return 0x8229; // GL_LUMINANCE → GL_R8
        case 0x190A: return 0x8227; // GL_LUMINANCE_ALPHA → GL_RG8
        case 0x1907: return 0x8051; // GL_RGB → GL_RGB8
        case 0x1908: return 0x8058; // GL_RGBA → GL_RGBA8
        case 0x1903: return 0x8229; // GL_RED → GL_R8
        case 0x8227: return 0x8227; // GL_RG → GL_RG8
      }
    } else if (type === GL_FLOAT) {
      switch (ifmt) {
        case 0x1907: return 0x8815; // GL_RGB → GL_RGB32F
        case 0x1908: return 0x8814; // GL_RGBA → GL_RGBA32F
        case 0x1903: return 0x822E; // GL_RED → GL_R32F
      }
    } else if (type === GL_HALF_FLOAT || type === GL_HALF_FLOAT_OES) {
      switch (ifmt) {
        case 0x1907: return 0x881B; // GL_RGB → GL_RGB16F
        case 0x1908: return 0x881A; // GL_RGBA → GL_RGBA16F
        case 0x1903: return 0x822D; // GL_RED → GL_R16F
      }
    } else if (type === 0x1403) { // GL_UNSIGNED_SHORT
      // EXT_texture_norm16 provides GL_R16, GL_RG16, GL_RGBA16 (normalized)
      switch (ifmt) {
        case 0x1903: return 0x822A; // GL_RED → GL_R16_EXT
        case 0x8227: return 0x822C; // GL_RG → GL_RG16_EXT
        case 0x1908: return 0x805B; // GL_RGBA → GL_RGBA16_EXT
      }
    }

    // Formats WebGL2 doesn't support - map to closest equivalent
    switch (ifmt) {
      // GL_RGBA16: keep as-is if EXT_texture_norm16 available, else fall back to RGBA16F
      case 0x805B: return (type === 0x1403) ? 0x805B : 0x881A; // GL_RGBA16 → keep or GL_RGBA16F
      case 0x8F9B: return 0x8058; // GL_RGBA16_SNORM → GL_RGBA8
      case 0x8054: return 0x8051; // GL_RGB12 → GL_RGB8
      case 0x80E1: return 0x8058; // GL_BGRA → GL_RGBA8
      case 0x80E0: return 0x8051; // GL_BGR → GL_RGB8
    }

    return ifmt;
  }

  // WebGL2 doesn't support legacy GL_LUMINANCE/GL_LUMINANCE_ALPHA/GL_ALPHA as format params.
  // Map them to their WebGL2 equivalents.
  function _fixFormat(fmt) {
    switch (fmt) {
      case 0x1906: return 0x1903; // GL_ALPHA → GL_RED
      case 0x1909: return 0x1903; // GL_LUMINANCE → GL_RED
      case 0x190A: return 0x8227; // GL_LUMINANCE_ALPHA → GL_RG
      default: return fmt;
    }
  }

  // Convert BGRA/BGR pixel data to RGBA/RGB (WebGL2 doesn't support BGRA/BGR formats)
  const GL_BGR = 0x80E0;
  const GL_BGRA = 0x80E1;

  function _fixBGRA(format, type, pixelsPtr, pixelCount) {
    if (format !== GL_BGRA && format !== GL_BGR) return null;
    if (pixelsPtr === 0) return null;

    const mem = u8();
    const channels = format === GL_BGRA ? 4 : 3;
    const bpp = channels; // Assumes GL_UNSIGNED_BYTE
    const size = pixelCount * bpp;
    const swizzled = new Uint8Array(size);
    const src = pixelsPtr;

    for (let i = 0; i < pixelCount; i++) {
      const si = src + i * bpp;
      const di = i * bpp;
      swizzled[di]     = mem[si + 2]; // R ← B
      swizzled[di + 1] = mem[si + 1]; // G ← G
      swizzled[di + 2] = mem[si];     // B ← R
      if (channels === 4) {
        swizzled[di + 3] = mem[si + 3]; // A ← A
      }
    }

    return {
      format: format === GL_BGRA ? 0x1908 : 0x1907, // GL_RGBA : GL_RGB
      data: swizzled,
    };
  }

  function _genObjects(table, createFn, n, ptr) {
    const view = u32();
    for (let i = 0; i < n; i++) {
      const obj = createFn();
      const id = _allocId(table, obj);
      view[(ptr >> 2) + i] = id;
    }
  }

  function _deleteObjects(table, deleteFn, n, ptr) {
    const view = u32();
    for (let i = 0; i < n; i++) {
      const id = view[(ptr >> 2) + i];
      if (id > 0 && id < table.length && table[id]) {
        deleteFn(table[id]);
        table[id] = null;
      }
    }
  }

  // Get or create uniform location entry for current program
  function _getUniformLoc(locId) {
    if (locId < 0) return null;
    const progEntry = _uniformLocs.get(_currentProgramId);
    if (!progEntry) return null;
    return progEntry.byId.get(locId) || null;
  }

  // ─── Client-side vertex array support ─────────────────────────────────
  const GL_ARRAY_BUFFER = 0x8892;
  const GL_ELEMENT_ARRAY_BUFFER = 0x8893;

  let _boundArrayBuffer = 0;
  let _boundElementBuffer = 0;
  const _clientAttribs = new Map();

  function _bytesForType(type) {
    switch (type) {
      case 0x1400: return 1; // GL_BYTE
      case 0x1401: return 1; // GL_UNSIGNED_BYTE
      case 0x1402: return 2; // GL_SHORT
      case 0x1403: return 2; // GL_UNSIGNED_SHORT
      case 0x1404: return 4; // GL_INT
      case 0x1405: return 4; // GL_UNSIGNED_INT
      case 0x1406: return 4; // GL_FLOAT
      case 0x140B: return 2; // GL_HALF_FLOAT
      default: return 4;
    }
  }

  // Temp buffers for client-side vertex data uploads
  let _tempVBOs = null;
  let _tempEBO = null;

  function _ensureTempVBO(index) {
    if (!_tempVBOs) _tempVBOs = new Map();
    if (!_tempVBOs.has(index)) {
      _tempVBOs.set(index, ctx.createBuffer());
    }
    return _tempVBOs.get(index);
  }

  function _ensureTempEBO() {
    if (!_tempEBO) _tempEBO = ctx.createBuffer();
    return _tempEBO;
  }

  function _uploadClientAttribs(firstVertex, vertexCount) {
    if (_clientAttribs.size === 0) return;
    const mem = u8();
    for (const [index, attr] of _clientAttribs) {
      const elemBytes = attr.size * _bytesForType(attr.type);
      const effectiveStride = attr.stride || elemBytes;
      const startByte = attr.wasmPtr + firstVertex * effectiveStride;
      const totalBytes = vertexCount * effectiveStride;

      const vbo = _ensureTempVBO(index);
      ctx.bindBuffer(GL_ARRAY_BUFFER, vbo);
      ctx.bufferData(GL_ARRAY_BUFFER, mem.subarray(startByte, startByte + totalBytes), 0x88E0); // GL_STREAM_DRAW
      ctx.vertexAttribPointer(index, attr.size, attr.type, attr.normalized, attr.stride, 0);
    }
    // Restore user's binding
    ctx.bindBuffer(GL_ARRAY_BUFFER, _boundArrayBuffer ? _buffers[_boundArrayBuffer] : null);
  }

  function _uploadClientIndices(wasmPtr, count, type) {
    const elemSize = _bytesForType(type);
    const totalBytes = count * elemSize;
    const mem = u8();
    const ebo = _ensureTempEBO();
    ctx.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, ebo);
    ctx.bufferData(GL_ELEMENT_ARRAY_BUFFER, mem.subarray(wasmPtr, wasmPtr + totalBytes), 0x88E0);
  }

  let _compressedTexWarnedFormats = null;

  // ─── String pool for glGetString / glGetStringi ─────────────────────
  let _glStringCache = null;
  let _glStringiCache = null;
  let _glStringPool = null;

  function _writeStringToWasm(str) {
    const encoded = encoder.encode(str);
    const size = encoded.length + 1; // +1 for null terminator

    // Use the cart's malloc if available (safe - properly tracked by heap)
    const malloc = getMalloc && getMalloc();
    if (malloc) {
      const ptr = malloc(size);
      if (ptr) {
        const mem = u8();
        mem.set(encoded, ptr);
        mem[ptr + encoded.length] = 0;
        return ptr;
      }
    }

    // Fallback: static pool at end of memory (only safe before heap grows there)
    if (!_glStringPool) _glStringPool = { offset: 0, base: 0 };
    if (!_glStringPool.base) {
      _glStringPool.base = getMemory().buffer.byteLength - 16384;
      _glStringPool.offset = 0;
    }
    const ptr = _glStringPool.base + _glStringPool.offset;
    const mem = u8();
    if (ptr + size < mem.length) {
      mem.set(encoded, ptr);
      mem[ptr + encoded.length] = 0;
      _glStringPool.offset += size;
      _glStringPool.offset = (_glStringPool.offset + 3) & ~3;
      return ptr;
    }
    return 0;
  }

  // ─── Buffer mapping emulation ──────────────────────────────────────────
  const _mappedBuffers = new Map();
  const MAP_SCRATCH_SIZE = 1024 * 1024;
  let _mapScratchBase = 0;
  let _mapScratchUsed = 0;

  function _getMapScratch(length) {
    const mem = getMemory();
    if (_mapScratchBase === 0) {
      _mapScratchBase = mem.buffer.byteLength - 16384 - MAP_SCRATCH_SIZE;
    }
    if (_mapScratchUsed + length > MAP_SCRATCH_SIZE) return 0;
    const ptr = _mapScratchBase + _mapScratchUsed;
    _mapScratchUsed += length;
    _mapScratchUsed = ((_mapScratchUsed + 7) & ~7);
    return ptr;
  }

  let _shaderFailLogged = false;
  const _shaderTypes = new Map(); // shader id → GL_VERTEX_SHADER or GL_FRAGMENT_SHADER

  // Upgrade #version 100 shaders to #version 300 es for WebGL2 compatibility.
  // GLSL ES 1.00 forbids dynamic array indexing; GLSL ES 3.00 allows it.
  function _patchShaderV100toV300(source, shaderType) {
    if (!source.includes('#version 100')) return source;

    // Replace version
    let patched = source.replace('#version 100', '#version 300 es');

    if (shaderType === 0x8B30) { // GL_FRAGMENT_SHADER (0x8B30)
      // Add output variable declaration after precision qualifiers
      // varying → in
      patched = patched.replace(/\bvarying\b/g, 'in');
      // gl_FragColor → FragColor, add output declaration
      if (patched.includes('gl_FragColor')) {
        patched = patched.replace(/\bgl_FragColor\b/g, 'FragColor');
        // Insert output declaration after the last precision statement
        const precisionMatch = patched.match(/(precision\s+\w+\s+\w+\s*;[^\n]*\n)/g);
        if (precisionMatch) {
          const lastPrecision = precisionMatch[precisionMatch.length - 1];
          const insertPos = patched.lastIndexOf(lastPrecision) + lastPrecision.length;
          patched = patched.slice(0, insertPos) + 'out vec4 FragColor;\n' + patched.slice(insertPos);
        } else {
          // Fallback: insert after #version line
          patched = patched.replace(/(#version 300 es\n)/, '$1out vec4 FragColor;\n');
        }
      }
      // gl_FragData[n] → FragData_n (rare, but handle it)
      patched = patched.replace(/\bgl_FragData\s*\[\s*0\s*\]/g, 'FragColor');
    } else { // GL_VERTEX_SHADER
      // attribute → in
      patched = patched.replace(/\battribute\b/g, 'in');
      // varying → out
      patched = patched.replace(/\bvarying\b/g, 'out');
    }

    // texture2D → texture, textureCube → texture, shadow2DEXT → texture
    patched = patched.replace(/\btexture2D\b/g, 'texture');
    patched = patched.replace(/\btexture2DProj\b/g, 'textureProj');
    patched = patched.replace(/\btextureCube\b/g, 'texture');
    patched = patched.replace(/\bshadow2DEXT\b/g, 'texture');
    patched = patched.replace(/\bshadow2DProjEXT\b/g, 'textureProj');

    // Strip extension declarations that are core in ES 3.00
    patched = patched.replace(/^\s*#extension\s+GL_EXT_shadow_samplers\s*:.*$/gm, '// (shadow_samplers is core in ES 3.00)');

    // Keep v100 code paths despite v300es syntax - we only upgraded for dynamic indexing.
    // The shaders use __VERSION__ checks to enable features (bone uvec4, etc.) that
    // require matching vertex attribute types not available in the v100-era VBO layout.
    patched = patched.replace(/#if\s+__VERSION__\s*>=\s*300/g, '#if 0 /* v100 compat: __VERSION__ >= 300 */');
    patched = patched.replace(/#if\s+__VERSION__\s*<\s*300/g, '#if 1 /* v100 compat: __VERSION__ < 300 */');

    return patched;
  }

  // ─── Debug ─────────────────────────────────────────────────────────────
  const GL_DEBUG = typeof process !== 'undefined' && process.env?.GL_DEBUG === '1';

  function _checkGL(name, args) {
    if (!GL_DEBUG) return;
    const err = ctx.getError();
    if (err !== 0) {
      console.error(`GL ERROR 0x${err.toString(16)} after ${name}(${Array.from(args).map(a => typeof a === 'number' ? '0x'+a.toString(16) : a).join(', ')})`);
    }
  }

  const funcs = {
    // ─── State ──────────────────────────────────────────────────────────
    glEnable: (cap) => ctx.enable(cap),
    glDisable: (cap) => ctx.disable(cap),
    glGetError: () => ctx.getError(),
    glFinish: () => ctx.finish(),
    glFlush: () => ctx.flush(),
    glHint: (target, mode) => ctx.hint(target, mode),
    glPixelStorei: (pname, param) => ctx.pixelStorei(pname, param),

    glGetIntegerv: (pname, paramsPtr) => {
      const view = i32();
      // GL_NUM_EXTENSIONS: return full extension count including custom extensions
      if (pname === 0x821D) {
        view[paramsPtr >> 2] = _allExtensions.length;
        return;
      }
      // Binding queries return WebGL objects - reverse-lookup to integer IDs
      const bindingTable = {
        0x8069: _textures,    // GL_TEXTURE_BINDING_2D
        0x806A: _textures,    // GL_TEXTURE_BINDING_3D
        0x8514: _textures,    // GL_TEXTURE_BINDING_CUBE_MAP
        0x8C1D: _textures,    // GL_TEXTURE_BINDING_2D_ARRAY
        0x8894: _buffers,     // GL_ARRAY_BUFFER_BINDING
        0x8895: _buffers,     // GL_ELEMENT_ARRAY_BUFFER_BINDING
        0x8CA6: _framebuffers, // GL_FRAMEBUFFER_BINDING
        0x8CA7: _renderbuffers, // GL_RENDERBUFFER_BINDING
        0x8B8D: _programs,    // GL_CURRENT_PROGRAM
        0x85B5: _vaos,        // GL_VERTEX_ARRAY_BINDING
        0x8919: _samplers,    // GL_SAMPLER_BINDING
      };
      const table = bindingTable[pname];
      if (table) {
        const obj = ctx.getParameter(pname);
        if (!obj) { view[paramsPtr >> 2] = 0; return; }
        for (let i = 1; i < table.length; i++) {
          if (table[i] === obj) { view[paramsPtr >> 2] = i; return; }
        }
        view[paramsPtr >> 2] = 0;
        return;
      }
      const result = ctx.getParameter(pname);
      if (typeof result === 'number') {
        view[paramsPtr >> 2] = result;
      } else if (typeof result === 'boolean') {
        view[paramsPtr >> 2] = result ? 1 : 0;
      } else if (result && typeof result === 'object' && result.length) {
        // Array result (e.g. GL_MAX_VIEWPORT_DIMS)
        for (let i = 0; i < result.length && i < 4; i++) {
          view[(paramsPtr >> 2) + i] = result[i];
        }
      } else {
        view[paramsPtr >> 2] = 0;
      }
    },

    glGetString: (name) => {
      if (!_glStringCache) _glStringCache = {};
      if (_glStringCache[name] !== undefined) return _glStringCache[name];

      let str;
      switch (name) {
        case 0x1F00: str = 'wasmcart'; break; // GL_VENDOR
        case 0x1F01: str = 'wasmcart WebGL2'; break; // GL_RENDERER
        case 0x1F02: str = 'OpenGL ES 3.0 wasmcart'; break; // GL_VERSION - must start with "OpenGL ES" for GLES mode detection
        case 0x1F03: {
          str = _allExtensions.join(' ');
          break;
        }
        case 0x8B8C: str = 'OpenGL ES GLSL ES 1.00'; break; // GL_SHADING_LANGUAGE_VERSION
        default: str = null;
      }
      if (!str) { _glStringCache[name] = 0; return 0; }
      const ptr = _writeStringToWasm(str);
      _glStringCache[name] = ptr;
      return ptr;
    },

    // ─── Viewport / Clear ───────────────────────────────────────────────
    glViewport: (x, y, w, h) => ctx.viewport(x, y, w, h),
    glScissor: (x, y, w, h) => ctx.scissor(x, y, w, h),
    glClear: (mask) => ctx.clear(mask),
    glClearColor: (r, g, b, a) => ctx.clearColor(r, g, b, a),
    glClearDepthf: (d) => ctx.clearDepth(d),
    glClearStencil: (s) => ctx.clearStencil(s),

    // ─── Blending ───────────────────────────────────────────────────────
    glBlendFunc: (sf, df) => ctx.blendFunc(sf, df),
    glBlendFuncSeparate: (sRGB, dRGB, sA, dA) => ctx.blendFuncSeparate(sRGB, dRGB, sA, dA),
    glBlendEquation: (mode) => ctx.blendEquation(mode),
    glBlendEquationSeparate: (mR, mA) => ctx.blendEquationSeparate(mR, mA),
    glBlendColor: (r, g, b, a) => ctx.blendColor(r, g, b, a),
    glColorMask: (r, g, b, a) => ctx.colorMask(!!r, !!g, !!b, !!a),

    // ─── Depth / Stencil ────────────────────────────────────────────────
    glDepthFunc: (f) => ctx.depthFunc(f),
    glDepthMask: (flag) => ctx.depthMask(!!flag),
    glDepthRangef: (n, f) => ctx.depthRange(n, f),
    glStencilFunc: (func, ref, mask) => ctx.stencilFunc(func, ref, mask),
    glStencilFuncSeparate: (face, func, ref, mask) => ctx.stencilFuncSeparate(face, func, ref, mask),
    glStencilOp: (fail, zfail, zpass) => ctx.stencilOp(fail, zfail, zpass),
    glStencilOpSeparate: (face, sf, dpf, dpp) => ctx.stencilOpSeparate(face, sf, dpf, dpp),
    glStencilMask: (mask) => ctx.stencilMask(mask),
    glStencilMaskSeparate: (face, mask) => ctx.stencilMaskSeparate(face, mask),

    // ─── Face culling ───────────────────────────────────────────────────
    glCullFace: (mode) => ctx.cullFace(mode),
    glFrontFace: (mode) => ctx.frontFace(mode),
    glPolygonOffset: (factor, units) => ctx.polygonOffset(factor, units),
    glLineWidth: (width) => ctx.lineWidth(width),

    // ─── Buffers ────────────────────────────────────────────────────────
    glGenBuffers: (n, ptr) => _genObjects(_buffers, () => ctx.createBuffer(), n, ptr),
    glDeleteBuffers: (n, ptr) => _deleteObjects(_buffers, (b) => ctx.deleteBuffer(b), n, ptr),
    glBindBuffer: (target, id) => {
      if (target === GL_ARRAY_BUFFER) _boundArrayBuffer = id;
      else if (target === GL_ELEMENT_ARRAY_BUFFER) _boundElementBuffer = id;
      ctx.bindBuffer(target, id ? _buffers[id] : null);
    },
    glBufferData: (target, size, dataPtr, usage) => {
      if (dataPtr === 0) {
        ctx.bufferData(target, size, usage);
      } else {
        ctx.bufferData(target, u8().subarray(dataPtr, dataPtr + size), usage);
      }
    },
    glBufferSubData: (target, offset, size, dataPtr) => {
      ctx.bufferSubData(target, offset, u8().subarray(dataPtr, dataPtr + size));
    },

    // ─── Textures ───────────────────────────────────────────────────────
    glGenTextures: (n, ptr) => _genObjects(_textures, () => ctx.createTexture(), n, ptr),
    glDeleteTextures: (n, ptr) => _deleteObjects(_textures, (t) => ctx.deleteTexture(t), n, ptr),
    glBindTexture: (target, id) => ctx.bindTexture(target, id ? _textures[id] : null),
    glActiveTexture: (unit) => ctx.activeTexture(unit),
    glTexImage2D: (target, level, internalformat, width, height, border, format, type, pixelsPtr) => {
      internalformat = _fixInternalFormat(internalformat, format, type);
      format = _fixFormat(format);
      const converted = _fixBGRA(format, type, pixelsPtr, width * height);
      const actualFormat = converted ? converted.format : format;
      const byteLen = width * height * _bytesPerPixel(format, type);
      const actualData = converted ? converted.data
        : pixelsPtr === 0 ? null
        : _getTypedPixelView(getMemory, type, pixelsPtr, byteLen);
      try {
        ctx.texImage2D(target, level, internalformat, width, height, border, actualFormat, type, actualData);
      } catch (e) {
        console.warn(`glTexImage2D fail: ifmt=0x${internalformat.toString(16)} fmt=0x${actualFormat.toString(16)} type=0x${type.toString(16)} ${width}x${height}`, e.message);
      }
    },
    glTexSubImage2D: (target, level, xoff, yoff, width, height, format, type, pixelsPtr) => {
      format = _fixFormat(format);
      const converted = _fixBGRA(format, type, pixelsPtr, width * height);
      const actualFormat = converted ? converted.format : format;
      const byteLen = width * height * _bytesPerPixel(format, type);
      const actualData = converted ? converted.data
        : _getTypedPixelView(getMemory, type, pixelsPtr, byteLen);
      try {
        ctx.texSubImage2D(target, level, xoff, yoff, width, height, actualFormat, type, actualData);
      } catch (e) {
        console.warn(`glTexSubImage2D fail: fmt=0x${actualFormat.toString(16)} type=0x${type.toString(16)} ${width}x${height}`, e.message);
      }
    },
    glTexParameteri: (target, pname, param) => {
      // GL_TEXTURE_SWIZZLE_R/G/B/A/RGBA (0x8E42-0x8E46) not supported in WebGL2 - silently skip
      if (pname >= 0x8E42 && pname <= 0x8E46) return;
      ctx.texParameteri(target, pname, param);
    },
    glTexParameterf: (target, pname, param) => {
      if (pname >= 0x8E42 && pname <= 0x8E46) return;
      ctx.texParameterf(target, pname, param);
    },
    glTexParameterfv: (target, pname, paramsPtr) => {
      if (pname >= 0x8E42 && pname <= 0x8E46) return;
      const view = new Float32Array(getMemory().buffer, paramsPtr, 4);
      ctx.texParameterf(target, pname, view[0]);
    },
    glTexParameteriv: (target, pname, paramsPtr) => {
      if (pname >= 0x8E42 && pname <= 0x8E46) return;
      const view = new Int32Array(getMemory().buffer, paramsPtr, 4);
      ctx.texParameteri(target, pname, view[0]);
    },
    glGenerateMipmap: (target) => ctx.generateMipmap(target),
    glCompressedTexImage2D: (target, level, internalformat, width, height, border, imageSize, dataPtr) => {
      const data = dataPtr ? u8().subarray(dataPtr, dataPtr + imageSize) : new Uint8Array(imageSize);
      // Use native GL for compressed textures - WebGL2 context gates them behind extensions
      if (nativeGL?.glCompressedTexImage2D) {
        nativeGL.glCompressedTexImage2D(target, level, internalformat, width, height, border, data);
      } else {
        try {
          ctx.compressedTexImage2D(target, level, internalformat, width, height, border, data);
        } catch (e) {}
      }
    },
    glCompressedTexSubImage2D: (target, level, xoff, yoff, width, height, format, imageSize, dataPtr) => {
      const data = u8().subarray(dataPtr, dataPtr + imageSize);
      if (nativeGL?.glCompressedTexSubImage2D) {
        nativeGL.glCompressedTexSubImage2D(target, level, xoff, yoff, width, height, format, data);
      } else {
        try {
          ctx.compressedTexSubImage2D(target, level, xoff, yoff, width, height, format, data);
        } catch (e) {}
      }
    },
    glCopyTexSubImage2D: (target, level, xoff, yoff, x, y, w, h) => ctx.copyTexSubImage2D(target, level, xoff, yoff, x, y, w, h),

    // ─── Shaders ────────────────────────────────────────────────────────
    glCreateShader: (type) => {
      const obj = ctx.createShader(type);
      if (!obj) return 0;
      const id = _allocId(_shaders, obj);
      _shaderTypes.set(id, type);
      return id;
    },
    glDeleteShader: (id) => {
      if (id > 0 && id < _shaders.length && _shaders[id]) {
        ctx.deleteShader(_shaders[id]);
        _shaders[id] = null;
      }
    },
    glShaderSource: (id, count, stringsPtr, lengthsPtr) => {
      const mem = u8();
      const ptrs = u32();
      const lens = lengthsPtr ? i32() : null;
      let fullSource = '';
      for (let i = 0; i < count; i++) {
        const strPtr = ptrs[(stringsPtr >> 2) + i];
        if (lens && lens[(lengthsPtr >> 2) + i] > 0) {
          const len = lens[(lengthsPtr >> 2) + i];
          fullSource += decoder.decode(mem.subarray(strPtr, strPtr + len));
        } else {
          fullSource += readCString(mem, strPtr);
        }
      }
      const shaderType = _shaderTypes.get(id) || 0x8B30;
      fullSource = _patchShaderV100toV300(fullSource, shaderType);
      // Strip GLES2 extensions that are built-in in GLSL 300 es / WebGL2
      fullSource = fullSource.replace(/^\s*#extension\s+GL_OES_standard_derivatives\s*:.*$/gm, '');
      ctx.shaderSource(_shaders[id], fullSource);
    },
    glCompileShader: (id) => {
      ctx.compileShader(_shaders[id]);
      if (!ctx.getShaderParameter(_shaders[id], 0x8B81)) { // GL_COMPILE_STATUS
        const log = ctx.getShaderInfoLog(_shaders[id]);
        if (!_shaderFailLogged) {
          _shaderFailLogged = true;
          const src = ctx.getShaderSource(_shaders[id]);
          console.error(`[GL] shader ${id} compile FAILED:\n${log}\nFull source:\n${src}`);
        } else {
          console.error(`[GL] shader ${id} compile FAILED: ${log.split('\n')[0]}`);
        }
      }
    },
    glGetShaderiv: (id, pname, paramsPtr) => {
      if (!paramsPtr) return;
      const s = _shaders[id];
      const GL_INFO_LOG_LENGTH = 0x8B84;
      const GL_SHADER_SOURCE_LENGTH = 0x8B88;
      if (pname === GL_INFO_LOG_LENGTH) {
        const log = ctx.getShaderInfoLog(s) || '';
        i32()[paramsPtr >> 2] = log.length + 1;
        return;
      }
      if (pname === GL_SHADER_SOURCE_LENGTH) {
        const src = ctx.getShaderSource(s) || '';
        i32()[paramsPtr >> 2] = src.length + 1;
        return;
      }
      const result = ctx.getShaderParameter(s, pname);
      i32()[paramsPtr >> 2] = typeof result === 'boolean' ? (result ? 1 : 0) : result;
    },
    glGetShaderInfoLog: (id, bufSize, lengthPtr, infoLogPtr) => {
      const log = ctx.getShaderInfoLog(_shaders[id]) || '';
      const mem = u8();
      const encoded = encoder.encode(log);
      const copyLen = Math.min(encoded.length, bufSize - 1);
      mem.set(encoded.subarray(0, copyLen), infoLogPtr);
      mem[infoLogPtr + copyLen] = 0;
      if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
    },

    // ─── Programs ───────────────────────────────────────────────────────
    glCreateProgram: () => {
      const obj = ctx.createProgram();
      return obj ? _allocId(_programs, obj) : 0;
    },
    glDeleteProgram: (id) => {
      if (id > 0 && id < _programs.length && _programs[id]) {
        ctx.deleteProgram(_programs[id]);
        _programs[id] = null;
        _uniformLocs.delete(id);
      }
    },
    glAttachShader: (prog, shader) => ctx.attachShader(_programs[prog], _shaders[shader]),
    glDetachShader: (prog, shader) => ctx.detachShader(_programs[prog], _shaders[shader]),
    glLinkProgram: (prog) => {
      ctx.linkProgram(_programs[prog]);
      if (!ctx.getProgramParameter(_programs[prog], 0x8B82)) { // GL_LINK_STATUS
        console.error(`[GL] program ${prog} link FAILED:`, ctx.getProgramInfoLog(_programs[prog]));
      }
    },
    glUseProgram: (prog) => {
      _currentProgramId = prog;
      ctx.useProgram(prog ? _programs[prog] : null);
    },
    glGetProgramiv: (prog, pname, paramsPtr) => {
      if (!paramsPtr) return;
      const p = _programs[prog];

      // Emulate GLES pnames not supported by WebGL2's getProgramParameter
      const GL_INFO_LOG_LENGTH = 0x8B84;
      const GL_ACTIVE_UNIFORM_MAX_LENGTH = 0x8B87;
      const GL_ACTIVE_ATTRIBUTE_MAX_LENGTH = 0x8B8A;
      const GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH = 0x8A35;

      if (pname === GL_ACTIVE_ATTRIBUTE_MAX_LENGTH) {
        const count = ctx.getProgramParameter(p, ctx.ACTIVE_ATTRIBUTES) || 0;
        let maxLen = 0;
        for (let i = 0; i < count; i++) {
          const info = ctx.getActiveAttrib(p, i);
          if (info && info.name.length > maxLen) maxLen = info.name.length;
        }
        i32()[paramsPtr >> 2] = maxLen + 1; // +1 for null terminator
        return;
      }
      if (pname === GL_ACTIVE_UNIFORM_MAX_LENGTH) {
        const count = ctx.getProgramParameter(p, ctx.ACTIVE_UNIFORMS) || 0;
        let maxLen = 0;
        for (let i = 0; i < count; i++) {
          const info = ctx.getActiveUniform(p, i);
          if (info && info.name.length > maxLen) maxLen = info.name.length;
        }
        i32()[paramsPtr >> 2] = maxLen + 1;
        return;
      }
      if (pname === GL_INFO_LOG_LENGTH) {
        const log = ctx.getProgramInfoLog(p) || '';
        i32()[paramsPtr >> 2] = log.length + 1;
        return;
      }
      if (pname === GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH) {
        const count = ctx.getProgramParameter(p, ctx.ACTIVE_UNIFORM_BLOCKS) || 0;
        let maxLen = 0;
        for (let i = 0; i < count; i++) {
          const name = ctx.getActiveUniformBlockName(p, i);
          if (name && name.length > maxLen) maxLen = name.length;
        }
        i32()[paramsPtr >> 2] = maxLen + 1;
        return;
      }

      const result = ctx.getProgramParameter(p, pname);
      i32()[paramsPtr >> 2] = typeof result === 'boolean' ? (result ? 1 : 0) : result;
    },
    glGetProgramInfoLog: (prog, bufSize, lengthPtr, infoLogPtr) => {
      const log = ctx.getProgramInfoLog(_programs[prog]) || '';
      const mem = u8();
      const encoded = encoder.encode(log);
      const copyLen = Math.min(encoded.length, bufSize - 1);
      mem.set(encoded.subarray(0, copyLen), infoLogPtr);
      mem[infoLogPtr + copyLen] = 0;
      if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
    },
    glValidateProgram: (prog) => ctx.validateProgram(_programs[prog]),

    // ─── Attributes / Uniforms ──────────────────────────────────────────
    glBindAttribLocation: (prog, index, namePtr) => {
      ctx.bindAttribLocation(_programs[prog], index, readCString(u8(), namePtr));
    },
    glGetAttribLocation: (prog, namePtr) => {
      return ctx.getAttribLocation(_programs[prog], readCString(u8(), namePtr));
    },
    glGetUniformLocation: (prog, namePtr) => {
      const name = readCString(u8(), namePtr);
      const loc = ctx.getUniformLocation(_programs[prog], name);
      if (!loc) return -1;

      // Get or create uniform table for this program
      if (!_uniformLocs.has(prog)) {
        _uniformLocs.set(prog, { byName: new Map(), byId: new Map() });
      }
      const entry = _uniformLocs.get(prog);

      // Check if we already mapped this name
      if (entry.byName.has(name)) {
        return entry.byName.get(name).id;
      }

      // Assign new integer ID
      const id = _nextUniformId++;
      entry.byName.set(name, { loc, id });
      entry.byId.set(id, loc);
      return id;
    },

    // ─── Uniforms ───────────────────────────────────────────────────────
    glUniform1i: (loc, v0) => { const l = _getUniformLoc(loc); if (l) ctx.uniform1i(l, v0); },
    glUniform2i: (loc, v0, v1) => { const l = _getUniformLoc(loc); if (l) ctx.uniform2i(l, v0, v1); },
    glUniform3i: (loc, v0, v1, v2) => { const l = _getUniformLoc(loc); if (l) ctx.uniform3i(l, v0, v1, v2); },
    glUniform4i: (loc, v0, v1, v2, v3) => { const l = _getUniformLoc(loc); if (l) ctx.uniform4i(l, v0, v1, v2, v3); },
    glUniform1f: (loc, v0) => { const l = _getUniformLoc(loc); if (l) ctx.uniform1f(l, v0); },
    glUniform2f: (loc, v0, v1) => { const l = _getUniformLoc(loc); if (l) ctx.uniform2f(l, v0, v1); },
    glUniform3f: (loc, v0, v1, v2) => { const l = _getUniformLoc(loc); if (l) ctx.uniform3f(l, v0, v1, v2); },
    glUniform4f: (loc, v0, v1, v2, v3) => { const l = _getUniformLoc(loc); if (l) ctx.uniform4f(l, v0, v1, v2, v3); },

    glUniform1iv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform1iv(l, new Int32Array(getMemory().buffer, ptr, count)); },
    glUniform2iv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform2iv(l, new Int32Array(getMemory().buffer, ptr, count * 2)); },
    glUniform3iv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform3iv(l, new Int32Array(getMemory().buffer, ptr, count * 3)); },
    glUniform4iv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform4iv(l, new Int32Array(getMemory().buffer, ptr, count * 4)); },
    glUniform1fv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform1fv(l, new Float32Array(getMemory().buffer, ptr, count)); },
    glUniform2fv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform2fv(l, new Float32Array(getMemory().buffer, ptr, count * 2)); },
    glUniform3fv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform3fv(l, new Float32Array(getMemory().buffer, ptr, count * 3)); },
    glUniform4fv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform4fv(l, new Float32Array(getMemory().buffer, ptr, count * 4)); },

    glUniformMatrix2fv: (loc, count, transpose, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniformMatrix2fv(l, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 4)); },
    glUniformMatrix3fv: (loc, count, transpose, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniformMatrix3fv(l, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 9)); },
    glUniformMatrix4fv: (loc, count, transpose, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniformMatrix4fv(l, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 16)); },

    // ─── Vertex attribs ─────────────────────────────────────────────────
    glEnableVertexAttribArray: (index) => ctx.enableVertexAttribArray(index),
    glDisableVertexAttribArray: (index) => {
      _clientAttribs.delete(index);
      ctx.disableVertexAttribArray(index);
    },
    glVertexAttribPointer: (index, size, type, normalized, stride, offset) => {
      if (_boundArrayBuffer === 0 && offset !== 0) {
        _clientAttribs.set(index, { size, type, normalized, stride, wasmPtr: offset });
      } else {
        _clientAttribs.delete(index);
        ctx.vertexAttribPointer(index, size, type, !!normalized, stride, offset);
      }
    },

    // ─── Drawing ────────────────────────────────────────────────────────
    glDrawArrays: (mode, first, count) => {
      if (_clientAttribs.size > 0) {
        _uploadClientAttribs(first, count);
        ctx.drawArrays(mode, 0, count);
      } else {
        ctx.drawArrays(mode, first, count);
      }
    },
    glDrawElements: (mode, count, type, offsetPtr) => {
      const hasClientIndices = _boundElementBuffer === 0 && offsetPtr !== 0;
      const hasClientAttribs = _clientAttribs.size > 0;

      if (hasClientAttribs || hasClientIndices) {
        let maxVertex = 0;
        if (hasClientIndices) {
          const mem = getMemory().buffer;
          if (type === 0x1403) {
            const indices = new Uint16Array(mem, offsetPtr, count);
            for (let i = 0; i < count; i++) if (indices[i] > maxVertex) maxVertex = indices[i];
          } else if (type === 0x1405) {
            const indices = new Uint32Array(mem, offsetPtr, count);
            for (let i = 0; i < count; i++) if (indices[i] > maxVertex) maxVertex = indices[i];
          } else {
            const indices = new Uint8Array(mem, offsetPtr, count);
            for (let i = 0; i < count; i++) if (indices[i] > maxVertex) maxVertex = indices[i];
          }
        } else {
          maxVertex = count * 2;
        }

        if (hasClientAttribs) _uploadClientAttribs(0, maxVertex + 1);

        if (hasClientIndices) {
          _uploadClientIndices(offsetPtr, count, type);
          ctx.drawElements(mode, count, type, 0);
          ctx.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, _boundElementBuffer ? _buffers[_boundElementBuffer] : null);
        } else {
          ctx.drawElements(mode, count, type, offsetPtr);
        }
      } else {
        ctx.drawElements(mode, count, type, offsetPtr);
      }
    },

    // ─── FBOs ───────────────────────────────────────────────────────────
    glGenFramebuffers: (n, ptr) => _genObjects(_framebuffers, () => ctx.createFramebuffer(), n, ptr),
    glDeleteFramebuffers: (n, ptr) => _deleteObjects(_framebuffers, (f) => ctx.deleteFramebuffer(f), n, ptr),
    glBindFramebuffer: (target, id) => {
      if (id === 0 && _redirectFBO) {
        ctx.bindFramebuffer(target, _redirectFBO);
      } else {
        ctx.bindFramebuffer(target, id ? _framebuffers[id] : null);
      }
      _checkGL('glBindFramebuffer', [target, id]);
    },
    glCheckFramebufferStatus: (target) => {
      const status = ctx.checkFramebufferStatus(target);
      if (status !== 0x8CD5) { // GL_FRAMEBUFFER_COMPLETE
        console.warn(`glCheckFramebufferStatus: 0x${status.toString(16)} (incomplete)`);
      }
      return status;
    },
    glFramebufferTexture2D: (target, attachment, textarget, tex, level) => {
      ctx.framebufferTexture2D(target, attachment, textarget, tex ? _textures[tex] : null, level);
      _checkGL('glFramebufferTexture2D', arguments);
    },
    glFramebufferRenderbuffer: (target, attachment, rbtarget, rb) => {
      ctx.framebufferRenderbuffer(target, attachment, rbtarget, rb ? _renderbuffers[rb] : null);
      _checkGL('glFramebufferRenderbuffer', arguments);
    },

    // ─── RBOs ───────────────────────────────────────────────────────────
    glGenRenderbuffers: (n, ptr) => _genObjects(_renderbuffers, () => ctx.createRenderbuffer(), n, ptr),
    glDeleteRenderbuffers: (n, ptr) => _deleteObjects(_renderbuffers, (r) => ctx.deleteRenderbuffer(r), n, ptr),
    glBindRenderbuffer: (target, id) => ctx.bindRenderbuffer(target, id ? _renderbuffers[id] : null),
    glRenderbufferStorage: (target, internalformat, width, height) => {
      const origFmt = internalformat;
      internalformat = _fixInternalFormat(internalformat, 0x1908, 0x1401);
      try {
        ctx.renderbufferStorage(target, internalformat, width, height);
      } catch (e) {
        console.warn(`glRenderbufferStorage fail: orig=0x${origFmt.toString(16)} fixed=0x${internalformat.toString(16)} ${width}x${height}`, e.message);
      }
      _checkGL('glRenderbufferStorage', [target, origFmt, width, height]);
    },

    // ─── Readback ───────────────────────────────────────────────────────
    glReadPixels: (x, y, width, height, format, type, pixelsPtr) => {
      const byteLen = width * height * _bytesPerPixel(format, type);
      ctx.readPixels(x, y, width, height, format, type, _getTypedPixelView(getMemory, type, pixelsPtr, byteLen));
    },

    // ─── VAOs ───────────────────────────────────────────────────────────
    glGenVertexArrays: (n, ptr) => _genObjects(_vaos, () => ctx.createVertexArray(), n, ptr),
    glDeleteVertexArrays: (n, ptr) => _deleteObjects(_vaos, (v) => ctx.deleteVertexArray(v), n, ptr),
    glBindVertexArray: (id) => ctx.bindVertexArray(id ? _vaos[id] : null),

    glDrawArraysInstanced: (mode, first, count, instancecount) => ctx.drawArraysInstanced(mode, first, count, instancecount),
    glDrawElementsInstanced: (mode, count, type, offsetPtr, instancecount) => ctx.drawElementsInstanced(mode, count, type, offsetPtr, instancecount),
    glVertexAttribDivisor: (index, divisor) => ctx.vertexAttribDivisor(index, divisor),

    glDrawBuffers: (n, bufsPtr) => {
      const view = u32();
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(view[(bufsPtr >> 2) + i]);
      ctx.drawBuffers(arr);
    },

    // ─── Tex params / state queries ─────────────────────────────────────
    glTexParameteriv: (target, pname, paramsPtr) => {
      try { ctx.texParameteri(target, pname, i32()[paramsPtr >> 2]); } catch (e) { /* unsupported */ }
    },
    glGetBooleanv: (pname, dataPtr) => {
      const val = ctx.getParameter(pname);
      u8()[dataPtr] = val ? 1 : 0;
    },
    glGetFloatv: (pname, dataPtr) => {
      const result = ctx.getParameter(pname);
      const view = new Float32Array(getMemory().buffer, dataPtr, 16);
      if (typeof result === 'number') {
        view[0] = result;
      } else if (result && result.length) {
        for (let i = 0; i < result.length; i++) view[i] = result[i];
      }
    },
    glGetStringi: (name, index) => {
      if (!_glStringiCache) _glStringiCache = {};
      const key = `${name}_${index}`;
      if (_glStringiCache[key] !== undefined) return _glStringiCache[key];

      let str;
      if (name === 0x1F03) { // GL_EXTENSIONS
        str = index < _allExtensions.length ? _allExtensions[index] : null;
      } else {
        str = null;
      }
      if (!str) { _glStringiCache[key] = 0; return 0; }
      const ptr = _writeStringToWasm(str);
      _glStringiCache[key] = ptr;
      return ptr;
    },

    glVertexAttrib1f: (index, x) => ctx.vertexAttrib1f(index, x),
    glVertexAttrib2f: (index, x, y) => ctx.vertexAttrib2f(index, x, y),
    glVertexAttrib3f: (index, x, y, z) => ctx.vertexAttrib3f(index, x, y, z),
    glVertexAttrib4f: (index, x, y, z, w) => ctx.vertexAttrib4f(index, x, y, z, w),
    glVertexAttrib4fv: (index, vPtr) => {
      ctx.vertexAttrib4fv(index, new Float32Array(getMemory().buffer, vPtr, 4));
    },
    glVertexAttribIPointer: (index, size, type, stride, offset) => {
      if (_boundArrayBuffer === 0 && offset !== 0) {
        _clientAttribs.set(index, { size, type, normalized: false, stride, wasmPtr: offset, integer: true });
      } else {
        _clientAttribs.delete(index);
        ctx.vertexAttribIPointer(index, size, type, stride, offset);
      }
    },
    glSampleCoverage: (value, invert) => ctx.sampleCoverage(value, !!invert),

    // ─── Samplers ───────────────────────────────────────────────────────
    glGenSamplers: (n, ptr) => _genObjects(_samplers, () => ctx.createSampler(), n, ptr),
    glDeleteSamplers: (n, ptr) => _deleteObjects(_samplers, (s) => ctx.deleteSampler(s), n, ptr),
    glBindSampler: (unit, id) => ctx.bindSampler(unit, id ? _samplers[id] : null),
    glSamplerParameteri: (id, pname, param) => ctx.samplerParameteri(_samplers[id], pname, param),
    glSamplerParameterf: (id, pname, param) => ctx.samplerParameterf(_samplers[id], pname, param),

    // ─── Sync ───────────────────────────────────────────────────────────
    glFenceSync: (condition, flags) => {
      const obj = ctx.fenceSync(condition, flags);
      return obj ? _allocId(_syncs, obj) : 0;
    },
    glClientWaitSync: (id, flags, timeout) => {
      return ctx.clientWaitSync(_syncs[id], flags, timeout);
    },
    glDeleteSync: (id) => {
      if (id > 0 && id < _syncs.length && _syncs[id]) {
        ctx.deleteSync(_syncs[id]);
        _syncs[id] = null;
      }
    },

    // ─── Buffer mapping (emulated) ──────────────────────────────────────
    glMapBufferRange: (target, offset, length, access) => {
      const wasmPtr = _getMapScratch(length);
      if (wasmPtr === 0) return 0;
      _mappedBuffers.set(target, { offset, length, access, wasmPtr });
      return wasmPtr;
    },
    glFlushMappedBufferRange: () => {},
    glUnmapBuffer: (target) => {
      const mapping = _mappedBuffers.get(target);
      if (!mapping) return 0;
      if (mapping.access & 0x0002) { // GL_MAP_WRITE_BIT
        ctx.bufferSubData(target, mapping.offset, u8().subarray(mapping.wasmPtr, mapping.wasmPtr + mapping.length));
      }
      _mappedBuffers.delete(target);
      _mapScratchUsed = 0;
      return 1;
    },

    // ─── Occlusion queries ──────────────────────────────────────────────
    glGenQueries: (n, ptr) => _genObjects(_queries, () => ctx.createQuery(), n, ptr),
    glDeleteQueries: (n, ptr) => _deleteObjects(_queries, (q) => ctx.deleteQuery(q), n, ptr),
    glBeginQuery: (target, id) => ctx.beginQuery(target, _queries[id]),
    glEndQuery: (target) => ctx.endQuery(target),
    glGetQueryObjectiv: (id, pname, paramsPtr) => {
      const result = ctx.getQueryParameter(_queries[id], pname);
      i32()[paramsPtr >> 2] = typeof result === 'boolean' ? (result ? 1 : 0) : (result || 0);
    },
    glGetQueryObjectuiv: (id, pname, paramsPtr) => {
      const result = ctx.getQueryParameter(_queries[id], pname);
      u32()[paramsPtr >> 2] = typeof result === 'boolean' ? (result ? 1 : 0) : (result || 0);
    },

    // ─── FBO extensions ─────────────────────────────────────────────────
    glBlitFramebuffer: (srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter) => {
      ctx.blitFramebuffer(srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter);
      _checkGL('glBlitFramebuffer', arguments);
    },
    glRenderbufferStorageMultisample: (target, samples, internalformat, width, height) => {
      internalformat = _fixInternalFormat(internalformat, 0x1908, 0x1401);
      ctx.renderbufferStorageMultisample(target, samples, internalformat, width, height);
      _checkGL('glRenderbufferStorageMultisample', arguments);
    },
    glInvalidateFramebuffer: (target, numAttachments, attachmentsPtr) => {
      const view = new Uint32Array(getMemory().buffer, attachmentsPtr, numAttachments);
      ctx.invalidateFramebuffer(target, Array.from(view));
    },

    // ─── Shader introspection ───────────────────────────────────────────
    glGetActiveUniform: (prog, index, bufSize, lengthPtr, sizePtr, typePtr, namePtr) => {
      const info = ctx.getActiveUniform(_programs[prog], index);
      const mem = u8();
      if (info && info.name) {
        const encoded = encoder.encode(info.name);
        const copyLen = Math.min(encoded.length, bufSize - 1);
        mem.set(encoded.subarray(0, copyLen), namePtr);
        mem[namePtr + copyLen] = 0;
        if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
        if (sizePtr) i32()[sizePtr >> 2] = info.size;
        if (typePtr) u32()[typePtr >> 2] = info.type;
      } else {
        if (lengthPtr) u32()[lengthPtr >> 2] = 0;
        if (namePtr) mem[namePtr] = 0;
      }
    },
    glGetActiveAttrib: (prog, index, bufSize, lengthPtr, sizePtr, typePtr, namePtr) => {
      const info = ctx.getActiveAttrib(_programs[prog], index);
      const mem = u8();
      if (info && info.name) {
        const encoded = encoder.encode(info.name);
        const copyLen = Math.min(encoded.length, bufSize - 1);
        mem.set(encoded.subarray(0, copyLen), namePtr);
        mem[namePtr + copyLen] = 0;
        if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
        if (sizePtr) i32()[sizePtr >> 2] = info.size;
        if (typePtr) u32()[typePtr >> 2] = info.type;
      } else {
        if (lengthPtr) u32()[lengthPtr >> 2] = 0;
        if (namePtr) mem[namePtr] = 0;
      }
    },
    glGetShaderSource: (id, bufSize, lengthPtr, sourcePtr) => {
      const source = ctx.getShaderSource(_shaders[id]) || '';
      const mem = u8();
      const encoded = encoder.encode(source);
      const copyLen = Math.min(encoded.length, bufSize - 1);
      mem.set(encoded.subarray(0, copyLen), sourcePtr);
      mem[sourcePtr + copyLen] = 0;
      if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
    },

    // ─── State queries ──────────────────────────────────────────────────
    glGetInternalformativ: (target, internalformat, pname, count, paramsPtr) => {
      const view = new Int32Array(getMemory().buffer, paramsPtr, count);
      try {
        // WebGL2 doesn't support GL_NUM_SAMPLE_COUNTS - derive from GL_SAMPLES
        const GL_NUM_SAMPLE_COUNTS = 0x9380;
        const GL_SAMPLES = 0x80A9;
        if (pname === GL_NUM_SAMPLE_COUNTS) {
          const samples = ctx.getInternalformatParameter(target, internalformat, GL_SAMPLES);
          view[0] = (samples && samples.length) ? samples.length + 1 : 1; // +1 for non-MSAA (1 sample)
          return;
        }
        const result = ctx.getInternalformatParameter(target, internalformat, pname);
        if (result === null) {
          view[0] = 0;
        } else if (typeof result === 'number') {
          view[0] = result;
        } else if (result && result.length !== undefined) {
          // For GL_SAMPLES, prepend 1 (non-MSAA) if not present
          let vals = Array.from(result);
          if (pname === GL_SAMPLES && !vals.includes(1)) vals.push(1);
          for (let i = 0; i < Math.min(vals.length, count); i++) view[i] = vals[i];
        }
      } catch (e) {
        // If format not renderable, return 0
        view[0] = 0;
      }
    },
    glGetShaderPrecisionFormat: (shaderType, precisionType, rangePtr, precisionPtr) => {
      const result = ctx.getShaderPrecisionFormat(shaderType, precisionType);
      const view = new Int32Array(getMemory().buffer);
      if (result) {
        view[rangePtr >> 2] = result.rangeMin;
        view[(rangePtr >> 2) + 1] = result.rangeMax;
        view[precisionPtr >> 2] = result.precision;
      }
    },
    glGetBufferParameteriv: (target, pname, paramsPtr) => {
      const view = new Int32Array(getMemory().buffer, paramsPtr, 1);
      view[0] = ctx.getBufferParameter(target, pname) || 0;
    },
    glGetFramebufferAttachmentParameteriv: (target, attachment, pname, paramsPtr) => {
      const view = new Int32Array(getMemory().buffer, paramsPtr, 1);
      const result = ctx.getFramebufferAttachmentParameter(target, attachment, pname);
      view[0] = typeof result === 'number' ? result : 0;
    },
    glGetRenderbufferParameteriv: (target, pname, paramsPtr) => {
      const view = new Int32Array(getMemory().buffer, paramsPtr, 1);
      view[0] = ctx.getRenderbufferParameter(target, pname) || 0;
    },
    glIsEnabled: (cap) => ctx.isEnabled(cap) ? 1 : 0,
    glIsTexture: (id) => (id > 0 && _textures[id]) ? (ctx.isTexture(_textures[id]) ? 1 : 0) : 0,
    glIsBuffer: (id) => (id > 0 && _buffers[id]) ? (ctx.isBuffer(_buffers[id]) ? 1 : 0) : 0,
    glIsFramebuffer: (id) => (id > 0 && _framebuffers[id]) ? (ctx.isFramebuffer(_framebuffers[id]) ? 1 : 0) : 0,
    glIsRenderbuffer: (id) => (id > 0 && _renderbuffers[id]) ? (ctx.isRenderbuffer(_renderbuffers[id]) ? 1 : 0) : 0,
    glIsProgram: (id) => (id > 0 && _programs[id]) ? (ctx.isProgram(_programs[id]) ? 1 : 0) : 0,
    glIsShader: (id) => (id > 0 && _shaders[id]) ? (ctx.isShader(_shaders[id]) ? 1 : 0) : 0,

    glGetVertexAttribiv: (index, pname, paramsPtr) => {
      const val = ctx.getVertexAttrib(index, pname);
      i32()[paramsPtr >> 2] = typeof val === 'boolean' ? (val ? 1 : 0) : (val || 0);
    },
    glGetVertexAttribfv: (index, pname, paramsPtr) => {
      const val = ctx.getVertexAttrib(index, pname);
      new Float32Array(getMemory().buffer, paramsPtr, 1)[0] = val || 0;
    },
    glGetVertexAttribPointerv: (index, pname, pointerPtr) => {
      const val = ctx.getVertexAttribOffset(index, pname);
      u32()[pointerPtr >> 2] = val || 0;
    },
    glGetRenderbufferParameteriv: (target, pname, paramsPtr) => {
      const val = ctx.getRenderbufferParameter(target, pname);
      i32()[paramsPtr >> 2] = val || 0;
    },
    glGetFramebufferAttachmentParameteriv: (target, attachment, pname, paramsPtr) => {
      const val = ctx.getFramebufferAttachmentParameter(target, attachment, pname);
      // Value might be a WebGL object (texture/renderbuffer) for OBJECT_TYPE/OBJECT_NAME queries
      if (val && typeof val === 'object' && val._id !== undefined) {
        i32()[paramsPtr >> 2] = val._id;
      } else {
        i32()[paramsPtr >> 2] = val || 0;
      }
    },
    glGetBufferParameteriv: (target, pname, paramsPtr) => {
      const val = ctx.getBufferParameter(target, pname);
      i32()[paramsPtr >> 2] = val || 0;
    },
    glGetTexParameteriv: (target, pname, paramsPtr) => {
      const val = ctx.getTexParameter(target, pname);
      i32()[paramsPtr >> 2] = val || 0;
    },
    glGetTexParameterfv: (target, pname, paramsPtr) => {
      const val = ctx.getTexParameter(target, pname);
      new Float32Array(getMemory().buffer, paramsPtr, 1)[0] = val || 0;
    },
    glGetUniformiv: (prog, loc, paramsPtr) => {
      const l = _getUniformLoc(loc);
      if (!l) { i32()[paramsPtr >> 2] = 0; return; }
      const val = ctx.getUniform(_programs[prog], l);
      i32()[paramsPtr >> 2] = val || 0;
    },
    glGetUniformfv: (prog, loc, paramsPtr) => {
      const l = _getUniformLoc(loc);
      if (!l) { new Float32Array(getMemory().buffer, paramsPtr, 1)[0] = 0; return; }
      const val = ctx.getUniform(_programs[prog], l);
      new Float32Array(getMemory().buffer, paramsPtr, 1)[0] = val || 0;
    },

    // ─── 3D textures ────────────────────────────────────────────────────
    glTexImage3D: (target, level, internalformat, width, height, depth, border, format, type, pixelsPtr) => {
      internalformat = _fixInternalFormat(internalformat, format, type);
      format = _fixFormat(format);
      if (pixelsPtr === 0) {
        ctx.texImage3D(target, level, internalformat, width, height, depth, border, format, type, null);
      } else {
        const byteLen = width * height * depth * _bytesPerPixel(format, type);
        ctx.texImage3D(target, level, internalformat, width, height, depth, border, format, type, _getTypedPixelView(getMemory, type, pixelsPtr, byteLen));
      }
    },
    glTexSubImage3D: (target, level, xoff, yoff, zoff, width, height, depth, format, type, pixelsPtr) => {
      format = _fixFormat(format);
      const byteLen = width * height * depth * _bytesPerPixel(format, type);
      ctx.texSubImage3D(target, level, xoff, yoff, zoff, width, height, depth, format, type, _getTypedPixelView(getMemory, type, pixelsPtr, byteLen));
    },
    glTexStorage2D: (target, levels, internalformat, width, height) => {
      internalformat = _fixInternalFormat(internalformat, 0x1908, 0x1401);
      ctx.texStorage2D(target, levels, internalformat, width, height);
    },
    glTexStorage3D: (target, levels, internalformat, width, height, depth) => {
      internalformat = _fixInternalFormat(internalformat, 0x1908, 0x1401);
      ctx.texStorage3D(target, levels, internalformat, width, height, depth);
    },
    glCompressedTexImage3D: (target, level, internalformat, width, height, depth, border, imageSize, dataPtr) => {
      ctx.compressedTexImage3D(target, level, internalformat, width, height, depth, border, u8().subarray(dataPtr, dataPtr + imageSize));
    },
    glCompressedTexSubImage3D: (target, level, xoff, yoff, zoff, width, height, depth, format, imageSize, dataPtr) => {
      ctx.compressedTexSubImage3D(target, level, xoff, yoff, zoff, width, height, depth, format, u8().subarray(dataPtr, dataPtr + imageSize));
    },
    glFramebufferTextureLayer: (target, attachment, tex, level, layer) => {
      ctx.framebufferTextureLayer(target, attachment, tex ? _textures[tex] : null, level, layer);
    },
    glReadBuffer: (mode) => {
      ctx.readBuffer(mode);
      _checkGL('glReadBuffer', [mode]);
    },

    // ─── UBO / buffer binding ───────────────────────────────────────────
    glBindBufferBase: (target, index, id) => ctx.bindBufferBase(target, index, id ? _buffers[id] : null),
    glBindBufferRange: (target, index, id, offset, size) => ctx.bindBufferRange(target, index, id ? _buffers[id] : null, offset, size),
    glGetUniformBlockIndex: (prog, namePtr) => {
      return ctx.getUniformBlockIndex(_programs[prog], readCString(u8(), namePtr));
    },
    glUniformBlockBinding: (prog, blockIndex, blockBinding) => {
      ctx.uniformBlockBinding(_programs[prog], blockIndex, blockBinding);
    },
    glCopyBufferSubData: (readTarget, writeTarget, readOffset, writeOffset, size) => {
      ctx.copyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size);
    },

    // ─── Unsigned int uniforms ──────────────────────────────────────────
    glUniform1ui: (loc, v0) => { const l = _getUniformLoc(loc); if (l) ctx.uniform1ui(l, v0); },
    glUniform1uiv: (loc, count, ptr) => { const l = _getUniformLoc(loc); if (l) ctx.uniform1uiv(l, new Uint32Array(getMemory().buffer, ptr, count)); },

    // ─── Clear buffer ───────────────────────────────────────────────────
    glClearBufferfv: (buffer, drawbuffer, valuePtr) => {
      const GL_COLOR = 0x1800;
      const numFloats = (buffer === GL_COLOR) ? 4 : 1;
      ctx.clearBufferfv(buffer, drawbuffer, new Float32Array(getMemory().buffer, valuePtr, numFloats));
    },

    // ─── Transform feedback ─────────────────────────────────────────────
    glBeginTransformFeedback: (primitiveMode) => ctx.beginTransformFeedback(primitiveMode),
    glEndTransformFeedback: () => ctx.endTransformFeedback(),
    glTransformFeedbackVaryings: (prog, count, varyingsPtr, bufferMode) => {
      const ptrs = new Uint32Array(getMemory().buffer, varyingsPtr, count);
      const names = [];
      const mem = u8();
      for (let i = 0; i < count; i++) names.push(readCString(mem, ptrs[i]));
      ctx.transformFeedbackVaryings(_programs[prog], names, bufferMode);
    },

    // ─── Program binary (no-op for WebGL) ───────────────────────────────
    glGetProgramBinary: () => {},
    glProgramBinary: () => {},

    // ─── Integer attribs ────────────────────────────────────────────────
    glVertexAttribI4ui: (index, x, y, z, w) => ctx.vertexAttribI4ui(index, x, y, z, w),
  };

  // GL call tracing
  if (typeof process !== 'undefined' && process.env?.GL_TRACE === '1') {
    process.stderr.write(`[webgl-trace] Wrapping ${Object.keys(funcs).length} GL functions\n`);
    const raw = { ...funcs };
    for (const name of Object.keys(funcs)) {
      const orig = raw[name];
      funcs[name] = (...args) => {
        const ret = orig(...args);
        process.stderr.write(`[gl] ${name}(${args.map(a => typeof a === 'number' ? '0x'+a.toString(16) : a).join(',')}) => ${ret}\n`);
        return ret;
      };
    }
  }

  if (typeof process !== 'undefined' && process.env?.GL_CHECK_ALL === '1') {
    const skip = new Set(['glGetError']);
    const raw = { ...funcs };
    for (const name of Object.keys(funcs)) {
      if (skip.has(name)) continue;
      const orig = raw[name];
      funcs[name] = (...args) => {
        const ret = orig(...args);
        const err = ctx.getError();
        if (err !== 0) {
          console.error(`GL ERROR 0x${err.toString(16)} after ${name}(${Array.from(args).map(a => typeof a === 'number' ? '0x'+a.toString(16) : a).join(', ')})`);
        }
        return ret;
      };
    }
    process.stderr.write(`[webgl-check-all] Wrapped ${Object.keys(funcs).length} GL functions\n`);
  }

  // Expose FBO redirect controls to the host
  funcs._setupRedirectFBO = _ensureRedirectFBO;
  funcs._blitToCanvas = _blitRedirectToCanvas;

  return funcs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const GL_ALPHA = 0x1906;
const GL_RGB = 0x1907;
const GL_RGBA = 0x1908;
const GL_LUMINANCE = 0x1909;
const GL_LUMINANCE_ALPHA = 0x190A;
const GL_RED = 0x1903;
const GL_RG = 0x8227;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_UNSIGNED_SHORT_5_6_5 = 0x8363;
const GL_UNSIGNED_SHORT_4_4_4_4 = 0x8033;
const GL_UNSIGNED_SHORT_5_5_5_1 = 0x8034;
const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140B;
const GL_UNSIGNED_INT = 0x1405;
const GL_UNSIGNED_SHORT = 0x1403;
const GL_DEPTH_COMPONENT = 0x1902;

function _bytesPerPixel(format, type) {
  let channels;
  switch (format) {
    case GL_ALPHA: case GL_LUMINANCE: case GL_RED: case GL_DEPTH_COMPONENT: channels = 1; break;
    case GL_LUMINANCE_ALPHA: case GL_RG: channels = 2; break;
    case GL_RGB: case 0x80E0: channels = 3; break; // GL_RGB, GL_BGR
    case GL_RGBA: case 0x80E1: channels = 4; break; // GL_RGBA, GL_BGRA
    default: channels = 4; break;
  }

  switch (type) {
    case GL_UNSIGNED_BYTE: return channels;
    case GL_UNSIGNED_SHORT_5_6_5:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1: return 2;
    case GL_HALF_FLOAT:
    case GL_UNSIGNED_SHORT: return channels * 2;
    case GL_FLOAT: return channels * 4;
    case GL_UNSIGNED_INT: return channels * 4;
    default: return channels;
  }
}

// Get a properly typed ArrayBufferView for texture upload.
// WebGL2 requires the view type to match the GL type parameter.
function _getTypedPixelView(getMemory, type, pixelsPtr, byteLen) {
  const buf = getMemory().buffer;
  switch (type) {
    case GL_FLOAT:
      if (pixelsPtr & 3) return new Float32Array(new Uint8Array(buf, pixelsPtr, byteLen).slice().buffer);
      return new Float32Array(buf, pixelsPtr, byteLen >> 2);
    case GL_HALF_FLOAT:
    case 0x8D61: // GL_HALF_FLOAT_OES
    case GL_UNSIGNED_SHORT:
    case GL_UNSIGNED_SHORT_5_6_5:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
      if (pixelsPtr & 1) return new Uint16Array(new Uint8Array(buf, pixelsPtr, byteLen).slice().buffer);
      return new Uint16Array(buf, pixelsPtr, byteLen >> 1);
    case GL_UNSIGNED_INT:
    case 0x84FA: // GL_UNSIGNED_INT_24_8
      if (pixelsPtr & 3) return new Uint32Array(new Uint8Array(buf, pixelsPtr, byteLen).slice().buffer);
      return new Uint32Array(buf, pixelsPtr, byteLen >> 2);
    default:
      return new Uint8Array(buf, pixelsPtr, byteLen);
  }
}
