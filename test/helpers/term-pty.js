// Run the --term player in a real pseudo-terminal (util-linux `script`), the
// way a person runs it, and hand back what it wrote. Linux only.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
// WASMCART_TERM_TEST_PLAY: run another build's player (the control run against an old release)
export const PLAY = process.env.WASMCART_TERM_TEST_PLAY || join(HERE, '..', '..', 'bin', 'wasmcart-play.js');

export const hasPty = process.platform === 'linux' &&
  spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;

const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;

/**
 * Play `cart` with --term in a cols x rows pty until `frames` frames have been
 * drawn (or `timeoutMs`), then press q. Resolves to the raw output.
 * Always on the low-power WebGPU adapter, never the GPU driving the display.
 */
export function runTerm(cart, args = [], { cols = 160, rows = 50, frames = 6, timeoutMs = 60000 } = {}) {
  const cmd = `stty cols ${cols} rows ${rows}; exec ${q(process.execPath)} ${q(PLAY)} ${q(cart)} --term ${args.map(q).join(' ')}`;
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], {
    env: { ...process.env, WASMCART_WGPU_POWER: 'low-power' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  return new Promise((resolve, reject) => {
    let quit = false;
    const stop = () => { if (!quit) { quit = true; child.stdin.write('q'); } };
    const timer = setTimeout(stop, timeoutMs);
    const hard = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 15000);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (out.split('\x1b[H').length - 1 > frames) stop();
    });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', () => { clearTimeout(timer); clearTimeout(hard); resolve(out); });
  });
}

/** Decode an 8-bit RGB/RGBA PNG (filters 0-4) to { width, height, rgba }. */
export function decodePng(path) {
  const b = readFileSync(path);
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
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += bpp) { rgba[i * 4] = px[j]; rgba[i * 4 + 1] = px[j + 1]; rgba[i * 4 + 2] = px[j + 2]; rgba[i * 4 + 3] = 255; }
  return { width: w, height: h, rgba };
}
