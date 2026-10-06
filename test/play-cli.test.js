// wasmcart-play CLI — headless runner paths (.wasc + seed + PNG/WAV outputs).
// The interactive TTY player can't run in CI; these cover everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'wasmcart-play.js');
const FRONT = join(HERE, '..', 'bin', 'wasmcart.js');
const HELLO = join(HERE, 'fixtures', 'hello.wasc');
const DETRNG = join(HERE, 'fixtures', 'detrng.wasc');

function play(args) {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function runFront(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [FRONT, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

test('headless run writes a valid PNG with the cart resolution', async () => {
  const shot = join(os.tmpdir(), `play-hello-${process.pid}.png`);
  try {
    const out = play([HELLO, '--frames', '10', '--shot', shot]);
    assert.match(out, /ran 10 frames\s+320x240/);
    const png = readFileSync(shot);
    assert.equal(png.readUInt32BE(0), 0x89504e47, 'PNG magic');
    assert.equal(png.readUInt32BE(16), 320, 'IHDR width');
    assert.equal(png.readUInt32BE(20), 240, 'IHDR height');
  } finally {
    await rm(shot, { force: true });
  }
});

test('headless --shot of a WebGPU cart is its rendered frame', async () => {
  const shot = join(os.tmpdir(), `play-wgpu-${process.pid}.png`);
  try {
    const out = play([join(HERE, 'fixtures', 'wgpucart.wasc'), '--frames', '12', '--shot', shot]);
    assert.match(out, /ran 12 frames\s+256x192/);
    // Decode the PNG (filter types 0-4, 8-bit RGB or RGBA) to check pixels.
    const { inflateSync } = await import('node:zlib');
    const b = readFileSync(shot);
    let o = 8, w = 0, h = 0, ct = 0;
    const idat = [];
    while (o < b.length) {
      const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
      if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
      if (type === 'IDAT') idat.push(d);
      o += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat)), bpp = ct === 6 ? 4 : 3, stride = w * bpp, px = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)];
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0;
        const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
        let v = raw[y * (stride + 1) + 1 + x];
        if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
        else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
        px[y * stride + x] = v & 255;
      }
    }
    const at = (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)];
    assert.deepEqual(at(128, 110), [255, 128, 64], 'triangle');
    assert.deepEqual(at(2, 2), [42, 0, 255], 'background carries the compute result');
  } finally {
    await rm(shot, { force: true });
  }
});

test('same --seed → byte-identical PNG; different seed differs (detrng)', async () => {
  const a = join(os.tmpdir(), `play-det-a-${process.pid}.png`);
  const b = join(os.tmpdir(), `play-det-b-${process.pid}.png`);
  const c = join(os.tmpdir(), `play-det-c-${process.pid}.png`);
  try {
    play([DETRNG, '--frames', '8', '--seed', '1234', '--shot', a]);
    play([DETRNG, '--frames', '8', '--seed', '1234', '--shot', b]);
    play([DETRNG, '--frames', '8', '--seed', '9999', '--shot', c]);
    assert.ok(readFileSync(a).equals(readFileSync(b)), 'seeded runs reproduce exactly');
    assert.ok(!readFileSync(a).equals(readFileSync(c)), 'a different seed diverges');
  } finally {
    await rm(a, { force: true }); await rm(b, { force: true }); await rm(c, { force: true });
  }
});

test('--wav writes a WAV with a real sample rate header', async () => {
  const wav = join(os.tmpdir(), `play-wav-${process.pid}.wav`);
  try {
    play([DETRNG, '--frames', '10', '--wav', wav]);
    const buf = readFileSync(wav);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.readUInt32LE(24), 48000, 'sample rate is never 0');
  } finally {
    await rm(wav, { force: true });
  }
});

test('debug-capable carts list their named fields in the summary line', () => {
  const out = play([DETRNG, '--frames', '3']);
  assert.match(out, /debug=\[frame_n,noise_x,player_x\]/);
});

test('the `wasmcart` front-door bin plays a bare cart path and forwards pack', () => {
  const out = execFileSync(process.execPath, [FRONT, HELLO, '--frames', '3'], { encoding: 'utf8' });
  assert.match(out, /ran 3 frames\s+320x240/);
  const help = execFileSync(process.execPath, [FRONT, '--help'], { encoding: 'utf8' });
  assert.match(help, /wasmcart pack --wasm/);
});

test('the `wasmcart` front door fetches and plays an HTTP .wasc URL', async () => {
  const cartBytes = readFileSync(HELLO);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/games/hello.wasc')) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': cartBytes.length,
      });
      res.end(cartBytes);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/games/hello.wasc?release=1`;
    const result = await runFront([url, '--frames', '3']);
    assert.match(result.stderr, /wasmcart-play: fetching http:\/\/127\.0\.0\.1:/);
    assert.match(result.stdout, /ran 3 frames\s+320x240/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
