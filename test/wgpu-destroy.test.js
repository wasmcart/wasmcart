// Destroying a WebGPU host with GPU work in flight (SPEC.md, "WebGPU").
//
// A page leaving a WebGPU cart destroys its host while results are pending: a
// mapAsync, an error scope, the host's own frame readback. Destroying the
// device settles them, and their callbacks used to reach a cart whose host had
// already dropped its memory: in the web host the glue's callback allocated
// through the cart allocator and threw "Cannot read properties of null
// (reading 'buffer')" into a promise nobody awaits. After destroy() nothing
// reaches the cart, nothing throws, and nothing rejects unhandled.
//
// wgpucart (fixtures/wgpucart.c) starts a mapAsync in wc_init and pops an
// error scope on frame 2; wgpucart_result() is -1 until its map callback
// runs (-2 when it runs with a failed map).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';
import { CartHostWeb } from '../src/CartHostWeb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cart = path.join(HERE, 'fixtures', 'wgpucart.wasc');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Every unhandled rejection and uncaught exception while `fn` runs, after
// letting the settled callbacks run.
async function strays(fn) {
  const seen = [];
  const onRej = e => seen.push(`unhandled rejection: ${e?.stack || e}`);
  const onExc = e => seen.push(`uncaught exception: ${e?.stack || e}`);
  process.on('unhandledRejection', onRej);
  process.on('uncaughtException', onExc);
  try {
    await fn();
    for (let i = 0; i < 20; i++) await tick();
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally {
    process.off('unhandledRejection', onRej);
    process.off('uncaughtException', onExc);
  }
  return seen;
}

// The web host as a browser runs it, on webgpu-node's GPU in place of
// navigator.gpu (and its WebGPU classes in place of window's).
async function webHost() {
  const mod = await import('webgpu-node');
  for (const [k, v] of Object.entries(mod.globals)) if (!(k in globalThis)) globalThis[k] = v;
  const host = new CartHostWeb();
  await host.load(new Uint8Array(fs.readFileSync(cart)), { gpu: mod.createGPU() });
  return host;
}

for (const [label, make] of [['web host', webHost], ['Node host', async () => { const h = new CartHost(); await h.load(cart); return h; }]]) {
  for (const frames of [0, 1, 2]) {
    test(`${label}: destroy with a mapAsync${frames >= 2 ? ", an error scope" : ""}${frames ? " and a frame read" : ""} in flight (after ${frames} frame(s)) reaches no cart and throws nothing`, async () => {
      let ex, read;
      const seen = await strays(async () => {
        const host = await make();
        ex = host.instance.exports;
        for (let i = 0; i < frames; i++) host.runFrame();
        assert.equal(ex.wgpucart_result(), -1, 'the map is still pending at destroy (no callback runs inside a frame)');
        read = frames ? host.readGpuFrame() : null;
        const session = host._wgpu;
        await host.destroy();
        await session.destroy(); // settles once Dawn delivered device.lost: every pending callback has settled
      });
      assert.deepEqual(seen, [], 'nothing thrown or rejected unhandled after destroy');
      assert.equal(ex.wgpucart_result(), -1, 'the map callback never reached the destroyed cart');
      if (read) assert.equal(await read, null, 'a frame read in flight at destroy resolves to null');
    });
  }
}

test('while the host is alive the same callbacks still arrive (the guard is only for a destroyed host)', async () => {
  const host = await webHost();
  try {
    const ex = host.instance.exports;
    const deadline = Date.now() + 10000;
    while (ex.wgpucart_result() < 0 && Date.now() < deadline) { host.runFrame(); await tick(); }
    assert.equal(ex.wgpucart_result(), 42, 'the map callback arrived');
    for (let i = 0; i < 10 && ex.wgpucart_scope_error() < 0; i++) { host.runFrame(); await tick(); }
    assert.equal(ex.wgpucart_scope_error(), 2, 'the error scope callback arrived');
  } finally {
    host.destroy();
  }
});
