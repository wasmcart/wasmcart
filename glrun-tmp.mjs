// Headless GL harness: real webgl-node context, run the cart, readPixels,
// write a PNG so the result can actually be looked at.
import { CartHost } from '/home/monteslu/code/cliemu/wasmcart/index.js';
import { createWebGL2Context } from 'webgl-node';
import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , cartPath, outPng, framesArg] = process.argv;
const FRAMES = Number(framesArg || 30);
const W = 640, H = 480;

const ctx = createWebGL2Context(W, H);
const gl = ctx.gl ?? ctx;

const host = new CartHost();
await host.load(cartPath, { glBackend: gl });
console.log('usesGL =', host.usesGL, ' size =', host.info.width + 'x' + host.info.height);

for (let i = 0; i < FRAMES; i++) host.runFrame([{ connected: true, buttons: 0 }]);

const px = new Uint8Array(W * H * 4);
gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);

// Histogram: a blank frame is one colour; a rendered triangle is several.
const counts = new Map();
for (let i = 0; i < px.length; i += 4) {
  const k = `${px[i]},${px[i + 1]},${px[i + 2]}`;
  counts.set(k, (counts.get(k) || 0) + 1);
}
const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6);
const total = W * H;
console.log('distinct colours:', counts.size);
for (const [c, n] of top) console.log(`  rgb(${c}) ${(100 * n / total).toFixed(2)}%`);
console.log('dominant share:', (100 * top[0][1] / total).toFixed(2) + '%');

// PNG encode (flip vertically: GL origin is bottom-left).
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  const src = (H - 1 - y) * W * 4;
  raw[y * (W * 4 + 1)] = 0;
  Buffer.from(px.buffer, src, W * 4).copy(raw, y * (W * 4 + 1) + 1);
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
};
let TAB = null;
function crc32(buf) {
  if (!TAB) { TAB = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TAB[n] = c; } }
  let c = -1; for (const b of buf) c = TAB[(c ^ b) & 0xff] ^ (c >>> 8); return c ^ -1;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
fs.writeFileSync(outPng, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote', outPng);
host.destroy();
process.exit(0);
