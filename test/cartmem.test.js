// "Cart memory the host writes" (SPEC.md): every byte the host places in a
// cart at an address of its own choosing comes from the cart's wc_alloc, is
// bounds-checked, and a cart without an allocator gets a clear error only when
// it reaches such a path.
//
// Fixtures (test/fixtures/alloccart.c, built by alloc/build.sh):
//   alloc_header.wasc  wasmcart.h's own wc_alloc/wc_free, plus malloc/free exported
//   alloc_count.wasc   a counting wc_alloc/wc_free that can return bad pointers
//   alloc_malloc.wasc  malloc/free only (the deprecated fallback)
//   alloc_none.wasc    no allocator
//
// Text and network payloads: carthost.test.js and peer.test.js (textcart and
// peernet export wc_alloc and no malloc).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';
import { createCartAllocator, CartMemoryError, DEPRECATED_MALLOC_MESSAGE } from '../src/cartMemory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => path.join(HERE, 'fixtures', name);
const GL_VERSION = 0x1F02, GL_EXTENSIONS = 0x1F03;

function cString(host, ptr) {
  const u8 = new Uint8Array(host.memory.buffer);
  let end = ptr;
  while (u8[end]) end++;
  return new TextDecoder().decode(u8.subarray(ptr, end));
}

// console.warn, captured for one test
function captureWarnings() {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => { seen.push(a.join(' ')); };
  return { seen, restore: () => { console.warn = orig; } };
}

async function load(name) {
  const host = new CartHost();
  await host.load(fixture(name));
  return host;
}

// --- the allocator itself, against fake exports ---

function fakeCart(exports, bytes = 65536) {
  const memory = new WebAssembly.Memory({ initial: bytes / 65536 });
  return createCartAllocator({ getExports: () => exports, getMemory: () => memory, warn: () => {} });
}

test('allocator: wc_alloc is called with (size, align) and its pointer returned', () => {
  const calls = [];
  const a = fakeCart({ wc_alloc: (s, al) => { calls.push([s, al]); return 4096; }, wc_free: () => {} });
  assert.equal(a.kind, 'wc_alloc');
  assert.equal(a.alloc(10, 16, 'test'), 4096);
  assert.deepEqual(calls, [[10, 16]]);
});

test('allocator: wc_alloc wins over malloc when a cart exports both', () => {
  let mallocs = 0;
  const a = fakeCart({ wc_alloc: () => 64, wc_free: () => {}, malloc: () => { mallocs++; return 128; }, free: () => {} });
  assert.equal(a.alloc(4, 1, 'test'), 64);
  assert.equal(mallocs, 0);
});

test('allocator: out-of-range, misaligned and null pointers are refused with the reason', () => {
  for (const [ptr, code, re] of [
    [65530, 'bounds', /returned 0xfffa, which is outside its 65536-byte memory/],
    [0xFFFFFFF0, 'bounds', /outside its 65536-byte memory/],
    [4097, 'align', /returned 0x1001, which is not 16-byte aligned/],
    [0, 'oom', /returned 0 \(out of memory\)/],
  ]) {
    const a = fakeCart({ wc_alloc: () => ptr, wc_free: () => {} });
    assert.throws(() => a.alloc(16, 16, 'glThing'), e => e instanceof CartMemoryError && e.code === code
      && re.test(e.message) && e.message.includes('glThing') && e.message.includes('wc_alloc(16, 16)'));
  }
});

test('allocator: no allocator is an error naming the call and the fix', () => {
  const a = fakeCart({});
  assert.equal(a.kind, null);
  assert.throws(() => a.alloc(4, 1, 'glGetString'), e => e.code === 'missing'
    && /glGetString must write into the cart's memory/.test(e.message)
    && /wc_alloc\(size, align\) and wc_free\(ptr\)/.test(e.message)
    && /wasmcart\.h/.test(e.message) && /wasmcart-alloc crate/.test(e.message));
});

test('allocator: a malloc-only cart over-allocates to honour alignment above malloc\'s', () => {
  // malloc that only guarantees 8: the host must still hand out 64-aligned
  let next = 8;
  const freed = [];
  const a = fakeCart({ malloc: s => { const p = next; next += s + 8; return p; }, free: p => freed.push(p) });
  const p = a.alloc(100, 64, 'test');
  assert.equal(p % 64, 0);
  a.free(p);
  assert.deepEqual(freed, [8], 'free gets the pointer malloc returned, not the aligned one');
});

// --- the Node host ---

test('a cart with wasmcart.h\'s wc_alloc gets GL strings in its own heap, with no warning', async () => {
  const w = captureWarnings();
  const host = await load('alloc_header.wasc');
  try {
    const ex = host.instance.exports;
    assert.equal(typeof ex.wc_alloc, 'function', 'wasmcart.h exported wc_alloc');
    assert.equal(typeof ex.wc_free, 'function', 'wasmcart.h exported wc_free');
    const p = ex.t_gl_string(GL_VERSION);
    assert.ok(p > 0);
    assert.match(cString(host, p), /^OpenGL ES 3\.0/);
    assert.equal(ex.t_gl_string(GL_VERSION), p, 'GL strings are cached: one allocation per string');
    assert.ok(ex.t_map(256, 7) > 0, 'glMapBufferRange got a mapping');
    host.runFrame();
  } finally {
    host.destroy();
    w.restore();
  }
  assert.deepEqual(w.seen.filter(m => m.includes('deprecated')), [], 'wc_alloc wins: no deprecation warning although malloc is exported too');
});

test('GL strings and buffer mappings go through wc_alloc, and mappings are freed at unmap', async () => {
  const host = await load('alloc_count.wasc');
  try {
    const ex = host.instance.exports;
    const p = ex.t_gl_string(GL_VERSION);
    assert.match(cString(host, p), /OpenGL ES/);
    assert.equal(ex.t_allocs(1), 1, 'glGetString allocated through wc_alloc');
    ex.t_gl_stringi(GL_EXTENSIONS, 0);
    assert.equal(ex.t_allocs(1), 2, 'glGetStringi too');
    const frees = ex.t_frees();
    const m = ex.t_map(1000, 0x5a);
    assert.ok(m > 0 && m % 16 === 0, 'mapping is 16-byte aligned');
    assert.equal(ex.t_allocs(2), 1, 'glMapBufferRange allocated through wc_alloc');
    assert.equal(ex.t_frees(), frees + 1, 'glUnmapBuffer released it with wc_free');
  } finally {
    host.destroy();
  }
});

test('a bad pointer from wc_alloc is refused before the host writes through it', async () => {
  const host = await load('alloc_count.wasc');
  try {
    const ex = host.instance.exports;
    ex.t_alloc_mode(1);
    assert.throws(() => ex.t_gl_string(GL_VERSION), e => e.code === 'bounds' && /glGetString/.test(e.message) && /outside its \d+-byte memory/.test(e.message));
    ex.t_alloc_mode(2);
    assert.throws(() => ex.t_map(64, 1), e => e.code === 'align' && /glMapBufferRange/.test(e.message) && /not 16-byte aligned/.test(e.message));
    ex.t_alloc_mode(3);
    assert.throws(() => ex.t_gl_string(GL_VERSION), e => e.code === 'oom');
  } finally {
    host.destroy();
  }
});

test('a cart with NO allocator that never needs one loads and runs', async () => {
  const w = captureWarnings();
  const host = await load('alloc_none.wasc');
  try {
    const ex = host.instance.exports;
    assert.equal(ex.wc_alloc, undefined);
    assert.equal(ex.malloc, undefined);
    for (let i = 0; i < 5; i++) host.runFrame();
  } finally {
    host.destroy();
    w.restore();
  }
  assert.deepEqual(w.seen.filter(m => m.includes('allocat')), [], 'no warning either');
});

test('a cart with NO allocator that calls glGetString gets the clear error, and nothing is written', async () => {
  const host = await load('alloc_none.wasc');
  try {
    const ex = host.instance.exports;
    const before = new Uint8Array(host.memory.buffer).slice();
    assert.throws(() => ex.t_gl_string(GL_VERSION), e => e instanceof CartMemoryError && e.code === 'missing'
      && /glGetString must write into the cart's memory, but the cart exports no allocator/.test(e.message)
      && /wasmcart\.h/.test(e.message));
    assert.throws(() => ex.t_map(64, 1), e => e.code === 'missing' && /glMapBufferRange/.test(e.message));
    // the old fallback wrote the string into the top of memory
    const after = new Uint8Array(host.memory.buffer);
    assert.equal(after.length, before.length, 'memory did not grow');
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
    assert.ok(changed < 64, `the host wrote nothing of its own into the cart (${changed} bytes changed, the cart's own stack only)`);
    assert.equal(new TextDecoder().decode(after).includes('OpenGL ES 3.0 wasmcart'), false, 'no GL string anywhere in cart memory');
  } finally {
    host.destroy();
  }
});

test('a malloc-only cart works through the deprecated fallback, warning exactly once', async () => {
  const w = captureWarnings();
  const host = await load('alloc_malloc.wasc');
  try {
    const ex = host.instance.exports;
    assert.equal(ex.wc_alloc, undefined);
    assert.equal(typeof ex.malloc, 'function');
    assert.match(cString(host, ex.t_gl_string(GL_VERSION)), /OpenGL ES/);
    ex.t_gl_stringi(GL_EXTENSIONS, 0);
    assert.ok(ex.t_map(4096, 3) > 0);
    assert.ok(ex.t_map(4096, 4) > 0);
    host.runFrame();
  } finally {
    host.destroy();
    w.restore();
  }
  assert.deepEqual(w.seen.filter(m => m.includes('wc_alloc')), [DEPRECATED_MALLOC_MESSAGE], 'one deprecation warning for the cart');
});

test('a Rust cart gets wc_alloc/wc_free from the wasmcart-alloc crate, and text through them', async () => {
  // rusttext.wasc: rust/wasmcart-alloc/examples/textcart.rs, wasm32-unknown-unknown
  const host = await load('rusttext.wasc');
  try {
    const ex = host.instance.exports;
    assert.equal(typeof ex.wc_alloc, 'function');
    assert.equal(ex.malloc, undefined);
    host.runFrame();
    host.textInput('héllo');
    const f = host.runFrame();
    const got = new TextDecoder().decode(new Uint8Array(host.memory.buffer, ex.rust_received_ptr(), ex.rust_received_len()));
    assert.equal(got, 'héllo');
    assert.deepEqual([...f.framebuffer.slice(0, 4)], [0, 255, 0, 255], 'green: text arrived');
    // the crate's pair round-trips and honours alignment
    const p = ex.wc_alloc(100, 64);
    assert.ok(p > 0 && p % 64 === 0);
    ex.wc_free(p);
  } finally {
    host.destroy();
  }
});
