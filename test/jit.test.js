// Runtime code generation (SPEC.md, "Runtime code generation"): a cart hands
// the host a wasm module it generated; the host compiles it against the
// cart's own exports and installs its functions in the cart's table. Every
// module here is assembled by hand, so this exercises the host protocol with
// no compiler anywhere. The must-fail controls each pair with a passing twin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJitImports, jitOptionsFromEnv, JIT_LIMITS, JIT_OFF_NOTICE } from '../src/jit.js';

const uleb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const str = (s) => [...uleb(s.length), ...Buffer.from(s)];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const I32 = 0x7f;
const functype = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const body = (locals, code) => { const b = [...vec(locals), ...code, 0x0b]; return [...uleb(b.length), ...b]; };
const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// The cart: imports the three JIT functions; exports memory, a growable
// table, a helper `add1`, and thin wrappers so the test drives the imports
// from INSIDE the cart, as an engine would:
//   go(ptr, len, res) = wc_jit_link(...)   callslot(slot, x) = call_indirect
//   unlink(slot) = wc_jit_unlink(slot)     cfg(key) = wc_jit_config(key)
function cartModule() {
  const types = section(1, vec([
    functype([I32, I32, I32], [I32]), // 0: link / go
    functype([I32], [I32]),           // 1: add1 / jitted fn / config / cfg
    functype([I32, I32], [I32]),      // 2: callslot
    functype([I32], []),              // 3: unlink
  ]));
  const imports = section(2, vec([
    [...str('env'), ...str('wc_jit_link'), 0x00, 0],
    [...str('env'), ...str('wc_jit_unlink'), 0x00, 3],
    [...str('env'), ...str('wc_jit_config'), 0x00, 1],
  ]));
  // add1=3 go=4 callslot=5 unlink=6 cfg=7
  const funcs = section(3, vec([[1], [0], [2], [3], [1]]));
  const table = section(4, vec([[0x70, 0x00, 1]]));
  const mem = section(5, vec([[0x00, 1]]));
  const exports = section(7, vec([
    [...str('memory'), 0x02, 0],
    [...str('__indirect_function_table'), 0x01, 0],
    [...str('add1'), 0x00, 3],
    [...str('go'), 0x00, 4],
    [...str('callslot'), 0x00, 5],
    [...str('unlink'), 0x00, 6],
    [...str('cfg'), 0x00, 7],
  ]));
  const code = section(10, vec([
    body([], [0x20, 0, 0x41, 1, 0x6a]),             // add1: x + 1
    body([], [0x20, 0, 0x20, 1, 0x20, 2, 0x10, 0]), // go
    body([], [0x20, 1, 0x20, 0, 0x11, 1, 0x00]),    // callslot
    body([], [0x20, 0, 0x10, 1]),                   // unlink
    body([], [0x20, 0, 0x10, 2]),                   // cfg
  ]));
  return new Uint8Array([...header, ...types, ...imports, ...funcs, ...table, ...mem, ...exports, ...code]);
}

// A generated module: imports cart.add1 and cart.memory, exports
//   f(x) = add1(x) * 2 + i32.load(0)   and, with two exports, g(x) = x * 3.
// `ns` renames the import namespace; `name` renames the imported function.
function jitModule({ ns = 'cart', name = 'add1', two = false } = {}) {
  const types = section(1, vec([functype([I32], [I32])]));
  const imports = section(2, vec([
    [...str(ns), ...str(name), 0x00, 0],
    [...str('cart'), ...str('memory'), 0x02, 0x00, 0],
  ]));
  const funcs = section(3, vec(two ? [[0], [0]] : [[0]]));
  const exports = section(7, vec(two
    ? [[...str('f'), 0x00, 1], [...str('g'), 0x00, 2]]
    : [[...str('f'), 0x00, 1]]));
  const code = section(10, vec([
    body([], [0x20, 0, 0x10, 0, 0x41, 2, 0x6c, 0x41, 0, 0x28, 2, 0, 0x6a]),
    ...(two ? [body([], [0x20, 0, 0x41, 3, 0x6c])] : []),
  ]));
  return new Uint8Array([...header, ...types, ...imports, ...funcs, ...exports, ...code]);
}

const MOD = 64;   // where the generated module sits in cart memory
const CELL = 32;  // the *result cell

async function instantiate(jit, getRef) {
  const { instance } = await WebAssembly.instantiate(cartModule(), { env: jit.imports });
  getRef(instance);
  const ex = instance.exports;
  new DataView(ex.memory.buffer).setInt32(0, 100, true);
  return ex;
}

async function boot(jitOpts = {}, mod = jitModule()) {
  let instance = null;
  const jit = createJitImports({ getInstance: () => instance, mode: 'sync', ...jitOpts });
  const ex = await instantiate(jit, (i) => { instance = i; });
  new Uint8Array(ex.memory.buffer).set(mod, MOD);
  const dv = new DataView(ex.memory.buffer);
  dv.setInt32(CELL, -2, true);
  return { ex, jit, dv, len: mod.length, setInstance: (i) => { instance = i; } };
}

const cell = (dv) => dv.getInt32(CELL, true);
const settle = async (dv) => { for (let i = 0; i < 100 && cell(dv) === -2; i++) await new Promise((r) => setTimeout(r, 5)); };
const tick = () => new Promise((r) => setTimeout(r, 50));

test('sync link installs the export into the cart table and writes *result', async () => {
  const { ex, jit, dv, len } = await boot();
  const slot = ex.go(MOD, len, CELL);
  assert.ok(slot >= 1, `slot ${slot}`);
  assert.equal(cell(dv), slot);
  assert.equal(ex.callslot(slot, 5), 6 * 2 + 100);
  dv.setInt32(0, 7, true); // the module sees the cart's live memory
  assert.equal(ex.callslot(slot, 5), 19);
  assert.equal(jit.stats.modules, 1);
  assert.equal(ex.go(MOD, len, CELL), slot + 1);
});

test('a module exporting two functions gets two consecutive slots, in export order', async () => {
  const { ex, len } = await boot({}, jitModule({ two: true }));
  const slot = ex.go(MOD, len, CELL);
  assert.equal(ex.callslot(slot, 5), 112);
  assert.equal(ex.callslot(slot + 1, 5), 15);
});

test('async link returns -2 and writes the slot between calls', async () => {
  const { ex, jit, dv, len } = await boot({ mode: 'async' });
  assert.equal(ex.go(MOD, len, CELL), -2);
  assert.equal(cell(dv), -2, 'cell untouched until installed');
  await settle(dv);
  const slot = cell(dv);
  assert.ok(slot >= 1, `slot ${slot}`);
  assert.equal(ex.callslot(slot, 1), 104);
  assert.equal(jit.stats.pending, 0);
});

test('an invalid module is refused with -1', async () => {
  const { ex, dv } = await boot();
  new Uint8Array(ex.memory.buffer).set([0, 0x61, 0x73, 0x6d, 9, 9], MOD);
  assert.equal(ex.go(MOD, 6, CELL), -1);
  assert.equal(cell(dv), -1);
});

test('MUST FAIL: an import outside namespace "cart" is refused (its "cart" twin links)', async () => {
  const bad = await boot({}, jitModule({ ns: 'env' }));
  assert.equal(bad.ex.go(MOD, bad.len, CELL), -1);
  assert.equal(cell(bad.dv), -1);
  assert.match(bad.jit.stats.lastError, /only "cart"/);
  assert.equal(bad.ex.__indirect_function_table.length, 1, 'nothing installed');
  const good = await boot({}, jitModule({ ns: 'cart' }));
  assert.ok(good.ex.go(MOD, good.len, CELL) >= 1);
});

test('MUST FAIL: a cart import the cart does not export is refused', async () => {
  const { ex, jit, len } = await boot({}, jitModule({ name: 'wc_jit_link' }));
  assert.equal(ex.go(MOD, len, CELL), -1);
  assert.match(jit.stats.lastError, /does not export/);
});

test('MUST FAIL: an async result for a destroyed instance is dropped', async () => {
  const { ex, jit, dv, len } = await boot({ mode: 'async' });
  assert.equal(ex.go(MOD, len, CELL), -2);
  jit.dispose(); // the host destroyed the cart while it compiled
  await tick();
  assert.equal(cell(dv), -2, 'nothing written into the dead cart');
  assert.equal(ex.__indirect_function_table.length, 1, 'nothing installed');
  assert.equal(jit.stats.dropped, 1);
  assert.equal(jit.stats.bytes, 0, 'its bytes are released');
});

test('MUST FAIL: an async result for a replaced instance never lands in the new one', async () => {
  const a = await boot({ mode: 'async' });
  let next;
  const exB = await instantiate(a.jit, (i) => { next = i; });
  assert.equal(a.ex.go(MOD, a.len, CELL), -2);
  // The same host loads the next cart before the compile finishes.
  a.setInstance(next);
  const dvB = new DataView(exB.memory.buffer);
  dvB.setInt32(CELL, 12345, true);
  await tick();
  assert.equal(dvB.getInt32(CELL, true), 12345, 'not written into the next cart');
  assert.equal(exB.__indirect_function_table.length, 1, 'not installed into the next cart');
  assert.equal(cell(a.dv), -2);
  assert.equal(a.jit.stats.dropped, 1);
});

test('slots are per instance: a link in one instance leaves another untouched', async () => {
  let cur = null;
  const jit = createJitImports({ getInstance: () => cur, mode: 'sync', maxFunctions: 1 });
  let A, B;
  const exA = await instantiate(jit, (i) => { A = i; });
  const exB = await instantiate(jit, (i) => { B = i; });
  const m = jitModule();
  new Uint8Array(exA.memory.buffer).set(m, MOD);
  new Uint8Array(exB.memory.buffer).set(m, MOD);
  cur = A;
  assert.equal(exA.go(MOD, m.length, CELL), 1);
  assert.equal(exB.__indirect_function_table.length, 1);
  cur = B; // its own function budget: A's link does not count against it
  assert.equal(exB.go(MOD, m.length, CELL), 1);
  cur = A;
  assert.equal(exA.go(MOD, m.length, CELL), -1, 'A is at its own limit');
});

test('MUST FAIL: unlink, then calling the slot traps; the slot is reused', async () => {
  const { ex, jit, len } = await boot();
  const slot = ex.go(MOD, len, CELL);
  assert.equal(ex.callslot(slot, 1), 104);
  ex.unlink(slot);
  assert.throws(() => ex.callslot(slot, 1), WebAssembly.RuntimeError);
  assert.equal(jit.stats.functions, 0);
  assert.equal(ex.go(MOD, len, CELL), slot, 'freed slot reused, table not grown');
  assert.equal(ex.__indirect_function_table.length, slot + 1);
  ex.unlink(9999); // not a linked first slot: no-op
  ex.unlink(-1);
  assert.equal(ex.callslot(slot, 1), 104);
});

test('a restore (unlinkAll) unlinks every slot and drops compiles in flight', async () => {
  const s = await boot({ mode: 'auto', syncLimit: 0 });
  // syncLimit 0: every module goes async
  assert.equal(s.ex.go(MOD, s.len, CELL), -2);
  await settle(s.dv);
  const slot = cell(s.dv);
  assert.ok(slot >= 1);
  s.dv.setInt32(CELL, -2, true);
  assert.equal(s.ex.go(MOD, s.len, CELL), -2);
  s.jit.unlinkAll(); // the host just wrote a save state back
  assert.throws(() => s.ex.callslot(slot, 1), WebAssembly.RuntimeError);
  await tick();
  assert.equal(cell(s.dv), -2, 'pre-restore compile not delivered');
  assert.equal(s.jit.stats.dropped, 1);
  // the engine re-links on its miss
  assert.equal(s.ex.go(MOD, s.len, CELL), -2);
  await settle(s.dv);
  assert.equal(s.ex.callslot(cell(s.dv), 1), 104);
});

test('a restore changes key 7 every time, never to the value it had', async () => {
  const { ex, jit } = await boot();
  const seen = [ex.cfg(7)];
  for (let i = 0; i < 20; i++) {
    jit.unlinkAll();
    const g = ex.cfg(7);
    assert.ok(g >= 1 && g <= 0x7fffffff);
    assert.notEqual(g, seen.at(-1));
    seen.push(g);
  }
});

test('MUST FAIL: an engine detects a stale slot through key 7; one that skips the check traps', async () => {
  const { ex, jit, len } = await boot();
  // A save state taken here carries the engine's slot number and generation.
  const engine = { gen: ex.cfg(7), slot: ex.go(MOD, len, CELL) };
  assert.equal(ex.callslot(engine.slot, 1), 104);
  const saved = new Uint8Array(ex.memory.buffer).slice();
  // Restore: memory is written back, then the host unlinks and bumps.
  new Uint8Array(ex.memory.buffer).set(saved);
  jit.unlinkAll();
  // Control: the engine that trusts its stored slot traps.
  assert.throws(() => ex.callslot(engine.slot, 1), WebAssembly.RuntimeError);
  // A link made before the engine reads key 7 never reuses the stale slot.
  const other = ex.go(MOD, len, CELL);
  assert.notEqual(other, engine.slot);
  assert.throws(() => ex.callslot(engine.slot, 1), WebAssembly.RuntimeError);
  ex.unlink(other);
  // The engine checks at frame entry, sees the change, re-links lazily.
  const g = ex.cfg(7);
  assert.notEqual(g, engine.gen, 'restore detected');
  engine.gen = g;
  engine.slot = ex.go(MOD, len, CELL);
  assert.equal(ex.callslot(engine.slot, 1), 104);
  // Having read key 7, the slots the restore freed are free again.
  assert.equal(engine.slot, 1, 'held slot reused after key 7 was read');
});

test('MUST FAIL: over each limit the link is refused with -1 (under it, it links)', async () => {
  const m = jitModule();
  const size = await boot({ maxModuleBytes: m.length - 1 });
  assert.equal(size.ex.go(MOD, size.len, CELL), -1);
  assert.equal(cell(size.dv), -1);
  const sizeOk = await boot({ maxModuleBytes: m.length });
  assert.ok(sizeOk.ex.go(MOD, sizeOk.len, CELL) >= 1);

  const total = await boot({ maxTotalBytes: m.length * 2 });
  const first = total.ex.go(MOD, total.len, CELL);
  assert.ok(first >= 1);
  assert.ok(total.ex.go(MOD, total.len, CELL) >= 1);
  assert.equal(total.ex.go(MOD, total.len, CELL), -1);
  total.ex.unlink(first); // unlinking returns its bytes
  assert.ok(total.ex.go(MOD, total.len, CELL) >= 1);

  const fns = await boot({ maxFunctions: 1 });
  assert.ok(fns.ex.go(MOD, fns.len, CELL) >= 1);
  assert.equal(fns.ex.go(MOD, fns.len, CELL), -1);
  assert.match(fns.jit.stats.lastError, /function limit/);
});

test('too many compiles in flight answers -3 (try later), not -1', async () => {
  const { ex, dv, len, jit } = await boot({ mode: 'async', maxPending: 1 });
  assert.equal(ex.go(MOD, len, CELL), -2);
  assert.equal(ex.go(MOD, len, 40), -3);
  assert.equal(dv.getInt32(40, true), -3);
  assert.equal(jit.stats.deferred, 1);
  await settle(dv);
  dv.setInt32(40, -2, true);
  assert.equal(ex.go(MOD, len, 40), -2, 'accepted again once the first lands');
});

test('MUST FAIL: the off switch refuses every link with -1 and gives the loud notice once', async () => {
  const notices = [];
  const { ex, dv, len } = await boot({ disabled: true, onNotice: (m) => notices.push(m) });
  assert.equal(ex.cfg(1), 1, 'the cart can see the switch');
  assert.equal(ex.go(MOD, len, CELL), -1);
  assert.equal(cell(dv), -1);
  assert.equal(ex.go(MOD, len, CELL), -1);
  assert.deepEqual(notices, [JIT_OFF_NOTICE], 'exactly one notice');
  assert.match(notices[0], /RUNTIME CODE GENERATION IS OFF/);
  assert.equal(ex.__indirect_function_table.length, 1);
  // control: same cart, switch on, links and stays silent
  const on = await boot({ onNotice: (m) => notices.push(m) });
  assert.ok(on.ex.go(MOD, on.len, CELL) >= 1);
  assert.equal(on.ex.cfg(1), -1);
  assert.equal(notices.length, 1);
});

test('wc_jit_config reports the knobs and the spec-minimum limits', async () => {
  const { ex } = await boot({ threshold: 0, tierUp: 4 });
  assert.equal(ex.cfg(0), 0);
  assert.equal(ex.cfg(2), 4);
  assert.equal(ex.cfg(3), 4 * 1024 * 1024);
  assert.equal(ex.cfg(4), 256 * 1024 * 1024);
  assert.equal(ex.cfg(5), 65536);
  assert.equal(ex.cfg(6), 32);
  assert.equal(ex.cfg(7), 0, 'restore generation starts at 0');
  assert.equal(ex.cfg(8), -1);
  const plain = await boot();
  assert.equal(plain.ex.cfg(0), -1);
  assert.equal(plain.ex.cfg(1), -1);
  assert.equal(plain.ex.cfg(2), -1);
  assert.deepEqual({ ...JIT_LIMITS }, { maxModuleBytes: 4194304, maxTotalBytes: 268435456, maxFunctions: 65536, maxPending: 32 });
});

test('environment knobs', () => {
  assert.deepEqual(jitOptionsFromEnv({ WASMCART_JIT: '0', WASMCART_JIT_THRESHOLD: '0', WASMCART_JIT_TIERUP: '8', WASMCART_JIT_MODE: 'async' }),
    { disabled: true, threshold: 0, tierUp: 8, mode: 'async' });
  assert.deepEqual(jitOptionsFromEnv({ WASMCART_JIT: '1', WASMCART_JIT_THRESHOLD: 'x' }), {});
});
