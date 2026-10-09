// Runtime code generation through the real hosts: CartHost (node, sync
// compiles) and CartHostWeb (async above 4 KB on a browser main thread; run
// under node here, forced async), with a C cart (fixtures/jitcart.c) that
// links, calls through a function pointer, unlinks and re-links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CartHost } from '../src/CartHost.js';
import { CartHostWeb } from '../src/CartHostWeb.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CART = join(HERE, 'fixtures/jitcart.wasc');
const PAD = [{ connected: true, buttons: 0 }];

// Debug-field addresses, taken once from the node host: the web host has no
// readDebugValue, and the addresses are the cart's, not the host's.
let PTRS = null;
async function ptrs() {
  if (PTRS) return PTRS;
  const h = new CartHost();
  await h.load(CART, { jit: false, onJitNotice: () => {} });
  PTRS = Object.fromEntries(h.readDebugState().map((f) => [f.name, f.valuePtr]));
  h.destroy();
  return PTRS;
}
const dbg = (host, name) => new DataView(host.memory.buffer).getInt32(PTRS[name], true);

async function run(host, load, frames = 1) {
  await ptrs();
  await load();
  for (let i = 0; i < frames; i++) await host.runFrame(PAD);
  const v = (n) => dbg(host, n);
  return { off: v('off'), max: v('max_module'), link: v('link_ret'), cell: v('cell'),
    call: v('call_result'), relink: v('relink_ret'), cell2: v('cell2'), done: v('done') };
}

const settle = async (host, name, frames = 40) => {
  for (let i = 0; i < frames && dbg(host, name) === -2; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await host.runFrame(PAD);
  }
};

test('CartHost: a cart links, calls, unlinks and re-links into the freed slot', async () => {
  const host = new CartHost();
  const r = await run(host, () => host.load(CART, { jit: {} }));
  assert.equal(r.off, -1);
  assert.equal(r.max, 4 * 1024 * 1024);
  assert.ok(r.link >= 1, `link ${r.link}`);
  assert.equal(r.cell, r.link);
  assert.equal(r.call, 12, 'f(5) = jit_add1(5) * 2, through call_indirect');
  assert.equal(r.relink, r.link, 'the unlinked slot is reused');
  assert.equal(host.jitStats.unlinked, 1);
  host.destroy();
});

test('MUST FAIL: CartHost off switch: -1 to the cart and one loud notice', async () => {
  const notices = [];
  const host = new CartHost();
  const r = await run(host, () => host.load(CART, { jit: false, onJitNotice: (m) => notices.push(m) }), 3);
  assert.equal(r.off, 1);
  assert.equal(r.link, -1);
  assert.equal(r.cell, -1);
  assert.equal(r.done, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /RUNTIME CODE GENERATION IS OFF/);
  assert.equal(host.jitNotice, notices[0]);
  host.destroy();
});

test('CartHost: WASMCART_JIT=0 is the same switch', async () => {
  const notices = [];
  process.env.WASMCART_JIT = '0';
  try {
    const host = new CartHost();
    const r = await run(host, () => host.load(CART, { onJitNotice: (m) => notices.push(m) }));
    assert.equal(r.link, -1);
    host.destroy();
  } finally { delete process.env.WASMCART_JIT; }
  assert.equal(notices.length, 1);
});

test('CartHostWeb: an async compile is delivered between frames', async () => {
  const host = new CartHostWeb();
  const bytes = new Uint8Array(readFileSync(CART));
  const r = await run(host, () => host.load(bytes, { jit: { mode: 'async' } }), 0);
  assert.equal(r.link, -2);
  await settle(host, 'cell');
  await host.runFrame(PAD);
  assert.equal(dbg(host, 'call_result'), 12);
  await settle(host, 'cell2');
  assert.equal(dbg(host, 'cell2'), dbg(host, 'cell'), 'freed slot reused');
  host.destroy();
});

test('MUST FAIL: CartHostWeb destroyed mid-compile: the result is dropped', async () => {
  const host = new CartHostWeb();
  const r = await run(host, () => host.load(new Uint8Array(readFileSync(CART)), { jit: { mode: 'async' } }), 0);
  assert.equal(r.link, -2);
  const u8 = host._u8;
  const stats = host.jitStats;
  host.destroy();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(stats.dropped, 1);
  assert.equal(stats.modules, 0);
  assert.ok(u8, 'had memory');
});

test('MUST FAIL: CartHostWeb off switch: -1 and one loud notice', async () => {
  const notices = [];
  const host = new CartHostWeb();
  const r = await run(host, () => host.load(new Uint8Array(readFileSync(CART)),
    { jit: false, onJitNotice: (m) => notices.push(m) }), 2);
  assert.equal(r.off, 1);
  assert.equal(r.link, -1);
  assert.equal(notices.length, 1);
  host.destroy();
});

test('every instantiation path provides the three JIT imports', () => {
  // A missing import would be auto-stubbed to 0, which a cart reads as
  // "installed at slot 0" -- so the workers must declare them too.
  for (const f of ['CartHost.js', 'CartHostWeb.js', 'cartWorker.js', 'cartWorkerWeb.js']) {
    const src = readFileSync(join(HERE, '..', 'src', f), 'utf8');
    assert.match(src, /\.\.\.(this\._)?jit\.imports/, `${f} must spread the JIT imports`);
  }
});
