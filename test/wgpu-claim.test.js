// WebGPU textures, samplers and GPU memory over a long run, on the Node host
// (SPEC.md, "WebGPU"; docs/webgpu.md, "A frame loop must yield").
//
// Fixtures (sources beside them in test/fixtures):
//   wgputex.wasc   nine texture / sampler cases, checked by the cart itself
//                  (tex.pass) and here from the host's readback
//   wgpuvram.wasc  creates and releases ~1.3 MiB of GPU objects per frame
//
// GPU memory is read from the kernel's per-client DRM accounting
// (/proc/self/fdinfo, drm-memory-vram / drm-total-*), Linux only; elsewhere,
// or on a software adapter with no DRM client, the plateau test is skipped.
// WASMCART_VRAM_FRAMES sets its length (default 3000); WASMCART_VRAM_TEST=1 runs it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => path.join(HERE, 'fixtures', name);
const tick = () => new Promise(resolve => setImmediate(resolve));

// The cart's expected cell centres (wgputex.c's table)
const CELLS = [
  [255, 0, 0], [128, 0, 255], [128, 128, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [20, 200, 40], [200, 20, 180], [51, 102, 204],
];
const TOL = [1, 1, 3, 1, 1, 1, 1, 1, 1];

function pixel(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [...frame.data.slice(i, i + 4)];
}

/** This process's GPU memory in bytes (VRAM plus GTT), or null where the kernel does not say. */
export function processGpuBytes(pid = 'self') {
  let fds;
  try { fds = readdirSync(`/proc/${pid}/fdinfo`); } catch { return null; }
  const clients = new Map();
  for (const fd of fds) {
    let text;
    try { text = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'); } catch { continue; }
    const id = /drm-client-id:\s*(\d+)/.exec(text);
    if (!id) continue;
    let bytes = 0;
    for (const m of text.matchAll(/drm-(?:memory|total)-(vram|gtt):\s*(\d+)\s*(KiB|MiB)?/g)) {
      bytes += Number(m[2]) * (m[3] === 'MiB' ? 1 << 20 : m[3] === 'KiB' ? 1024 : 1);
    }
    clients.set(id[1], Math.max(clients.get(id[1]) || 0, bytes));
  }
  if (!clients.size) return null;
  return [...clients.values()].reduce((a, b) => a + b, 0);
}

test('textures and samplers: nearest, linear, repeat, clamp, mirror, explicit mips and a rendered texture', async () => {
  const host = new CartHost();
  await host.load(fixture('wgputex.wasc'));
  try {
    assert.equal(host.usesWgpu, true);
    // a software adapter (lavapipe, CI) answers the map later: keep yielding
    for (let i = 0; i < 400 && host.readDebugValue('tex.done').value === 0; i++) { host.runFrame(); await new Promise((r) => setTimeout(r, 5)); }
    assert.equal(host.readDebugValue('tex.done').value, 1, 'the cart\'s own readback arrived');
    assert.equal(host.readDebugValue('tex.errors').value, 0, 'no validation or out-of-memory errors');
    assert.equal(host.readDebugValue('tex.pass').value, 0x1ff,
      `every cell matched in the cart's check (bits: ${host.readDebugValue('tex.pass').value.toString(2)})`);
    const frame = await host.readGpuFrame();
    assert.equal(frame.width, 288);
    assert.equal(frame.height, 32);
    CELLS.forEach((want, c) => {
      const got = pixel(frame, c * 32 + 16, 16);
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(got[k] - want[k]) <= TOL[c], `cell ${c}: got ${got.slice(0, 3)}, want ${want}`);
      }
    });
  } finally {
    host.destroy();
  }
});

// Opt-in (WASMCART_VRAM_TEST=1): it reads the machine's GPU memory, which other
// processes and the driver's own caching move, so it is a measurement for a
// quiet machine rather than a default test.
test('GPU memory levels off over thousands of frames when the loop yields between frames', async (t) => {
  if (process.env.WASMCART_VRAM_TEST !== '1') return t.skip('set WASMCART_VRAM_TEST=1 to measure');
  if (processGpuBytes() === null) {
    // a WebGPU device must exist before a DRM client shows; probe with the cart
    const probe = new CartHost();
    await probe.load(fixture('wgpuvram.wasc'));
    probe.runFrame(); await tick();
    const seen = processGpuBytes();
    probe.destroy();
    if (seen === null) return t.skip('no per-process GPU memory accounting here (not Linux, or a software adapter)');
  }
  const frames = Number(process.env.WASMCART_VRAM_FRAMES || 3000);
  const host = new CartHost();
  await host.load(fixture('wgpuvram.wasc'));
  try {
    const samples = [];
    for (let i = 1; i <= frames; i++) {
      host.runFrame();
      await tick(); // the macrotask turn the host contract asks for
      if (i % 250 === 0) samples.push({ frame: i, mib: processGpuBytes() / (1 << 20) });
    }
    assert.equal(host.readDebugValue('vram.frames').value, frames);
    assert.equal(host.readDebugValue('vram.errors').value, 0);
    const frame = await host.readGpuFrame();
    const want = [[200, 40, 40], [40, 200, 40], [40, 40, 200], [200, 200, 40]][host.readDebugValue('vram.colour').value];
    assert.deepEqual(pixel(frame, 32, 32).slice(0, 3), want, 'the last frame drew this frame\'s texture');
    // Level after the first third of the run; the rest may wander by GC
    // timing but must not climb with the frame count (that would be ~1.3 MiB
    // a frame: thousands of MiB over the run).
    const settled = samples.filter(s => s.frame >= frames / 3);
    const first = settled[0].mib, peak = Math.max(...settled.map(s => s.mib)), last = settled.at(-1).mib;
    t.diagnostic(`GPU memory (MiB) by frame: ${samples.map(s => `${s.frame}:${s.mib.toFixed(0)}`).join(' ')}`);
    assert.ok(peak - first < 64, `GPU memory kept growing after frame ${settled[0].frame}: ${first.toFixed(0)} -> peak ${peak.toFixed(0)} MiB`);
    assert.ok(last - first < 64, `GPU memory ${first.toFixed(0)} -> ${last.toFixed(0)} MiB`);
  } finally {
    host.destroy();
  }
});

test('edges: a second device with its own callbacks, uncaptured errors, device loss, a resized surface', async (t) => {
  const host = new CartHost();
  await host.load(fixture('wgpuedges.wasc'));
  try {
    const v = (name) => { const r = host.readDebugValue(name); return r.values ?? r.value; };
    for (let i = 0; i < 9; i++) { host.runFrame(); await tick(); }
    const green = await host.readGpuFrame();
    for (let i = 0; i < 6; i++) { host.runFrame(); await tick(); }
    const blue = await host.readGpuFrame();
    const seen = { adapter: v('edge.adapter'), device: v('edge.device'), separate: v('edge.separate'),
      uncaptured: v('edge.uncaptured'), lost: v('edge.lost'), size: [...v('edge.size')], info: [host.getInfo().width, host.getInfo().height],
      before: [green.width, green.height, ...pixel(green, 4, 4).slice(0, 3)], after: [blue.width, blue.height, ...pixel(blue, 4, 4).slice(0, 3)] };
    t.diagnostic(JSON.stringify(seen));
    assert.equal(seen.adapter, 1, 'wgpuInstanceRequestAdapter answers between frames');
    assert.equal(seen.device, 1, 'a device above the floor is granted where the hardware allows');
    assert.equal(seen.separate, 1, 'it is a separate device from the host\'s');
    assert.equal(seen.uncaptured, 1, 'an error outside any scope reaches the requesting device\'s uncaptured-error callback');
    assert.equal(seen.lost, 2, 'destroying it delivers device-lost with WGPUDeviceLostReason_Destroyed');
    assert.deepEqual(seen.before, [128, 96, 0, 255, 0]);
    assert.deepEqual(seen.after, [160, 120, 0, 0, 255], 'reconfiguring the surface resizes the frame the host reads');
    assert.deepEqual(seen.info, [160, 120], 'and wc_info_t\'s new size is adopted');
  } finally {
    host.destroy();
  }
});
