// WebGPU capability (SPEC.md, "WebGPU") on the Node host, through webgpu-node.
//
// Fixtures (sources beside them in test/fixtures):
//   wgpucart.wasc     host device, #canvas surface, a compute result read
//                     with mapAsync, and 32 MB of memory growth on frame 3
//   dualgpu.wasc      imports gl AND WebGPU; green on WebGPU, red on GL
//   dualgpu_bad.wasc  same, but calls GL whatever the host selected
//   gpuapi2.wasc      declares gpu_api 2 with no WebGPU imports
//   gpuapi3.wasc      declares the reserved gpu_api 3
//   wgpufake.wasc     imports a WebGPU function no glue provides
//
// Pixels are read the way a host must: readGpuFrame() for WebGPU, the GL
// redirect FBO for GL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => path.join(HERE, 'fixtures', name);
const tick = () => new Promise(resolve => setImmediate(resolve));

function pixel(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [...frame.data.slice(i, i + 4)];
}

function glPixel(host, x, y) {
  const gl = host.getGlContext();
  const out = new Uint8Array(4);
  host.withRenderedFrame(() => {
    gl.readPixels(x, host.getInfo().height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  });
  return [...out];
}

test('a WebGPU cart renders on the host device, gets async results between frames, and survives memory growth', async () => {
  const host = new CartHost();
  await host.load(fixture('wgpucart.wasc'));
  try {
    assert.equal(host.usesWgpu, true);
    assert.equal(host.usesGL, false);
    assert.equal(host.getInfo().gpuApi, 2);
    const ex = host.instance.exports;
    assert.equal(ex.wgpucart_host_flags() & 0x02, 0x02, 'host-info flags carry WC_HOST_FLAG_GPU_WGPU');

    const before = host.memory.buffer.byteLength;
    for (let i = 0; i < 20 && ex.wgpucart_result() < 0; i++) { host.runFrame(); await tick(); }
    assert.equal(ex.wgpucart_result(), 42, 'the compute shader result arrived through mapAsync');
    assert.equal(ex.wgpucart_mapped_during_render(), 0, 'no callback ran inside wc_render');
    for (let i = 0; i < 4; i++) { host.runFrame(); await tick(); }
    assert.ok(host.memory.buffer.byteLength > before, 'the cart grew its memory (32 MB malloc on frame 3)');

    const frame = await host.readGpuFrame();
    assert.equal(frame.width, 256);
    assert.equal(frame.height, 192);
    assert.deepEqual(pixel(frame, 128, 110), [255, 128, 64, 255], 'triangle');
    assert.deepEqual(pixel(frame, 2, 2), [42, 0, 255, 255], 'background carries the compute result');
  } finally {
    host.destroy();
  }
});

test('two WebGPU carts in one process each get their own device and canvas', async () => {
  const a = new CartHost();
  const b = new CartHost();
  await a.load(fixture('wgpucart.wasc'));
  await b.load(fixture('dualgpu.wasc'));
  try {
    assert.notEqual(a.getGpuDevice(), b.getGpuDevice());
    for (let i = 0; i < 10; i++) { a.runFrame(); b.runFrame(); await tick(); }
    assert.deepEqual(pixel(await a.readGpuFrame(), 128, 110), [255, 128, 64, 255]);
    const fb = await b.readGpuFrame();
    assert.equal(fb.width, 128);
    assert.deepEqual(pixel(fb, 5, 5), [0, 255, 0, 255]);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('a dual cart runs on WebGPU where the host has it', async () => {
  const host = new CartHost();
  await host.load(fixture('dualgpu.wasc'));
  try {
    assert.equal(host.usesWgpu, true);
    assert.equal(host.instance.exports.dualgpu_uses_wgpu(), 1);
    host.runFrame();
    assert.deepEqual(pixel(await host.readGpuFrame(), 64, 48), [0, 255, 0, 255]);
  } finally {
    host.destroy();
  }
});

test('the same dual cart runs on GL where the host has no WebGPU', async () => {
  const host = new CartHost();
  await host.load(fixture('dualgpu.wasc'), { wgpu: false });
  try {
    assert.equal(host.usesWgpu, false);
    assert.equal(host.usesGL, true);
    assert.equal(host.instance.exports.dualgpu_uses_wgpu(), 0);
    host.runFrame();
    assert.deepEqual(glPixel(host, 64, 48), [255, 0, 0, 255]);
  } finally {
    host.destroy();
  }
});

test('a dual cart that calls the API the host did not select fails loudly, naming the call', async () => {
  const host = new CartHost();
  await host.load(fixture('dualgpu_bad.wasc'));
  try {
    assert.equal(host.usesWgpu, true);
    assert.throws(() => host.runFrame(), /called glClear, but this host selected WebGPU/);
  } finally {
    host.destroy();
  }
});

test('a WebGPU-only cart is refused, with the reason, by a host that cannot provide WebGPU', async () => {
  const host = new CartHost();
  await assert.rejects(host.load(fixture('wgpucart.wasc'), { wgpu: false }),
    /this cart is a WebGPU cart, but this host cannot provide WebGPU: the embedder disabled it/);
});

test('gpu_api values a cart does not back are refused at load', async () => {
  await assert.rejects(new CartHost().load(fixture('gpuapi2.wasc')), /declares gpu_api 2 \(WebGPU\) but imports no WebGPU functions/);
  await assert.rejects(new CartHost().load(fixture('gpuapi3.wasc')), /declares gpu_api 3, which this host does not support/);
});

test('a WebGPU function the glue lacks is a load error naming it, never a stub', async () => {
  await assert.rejects(new CartHost().load(fixture('wgpufake.wasc')), /does not provide: wgpuDeviceDoesNotExistYet/);
});
