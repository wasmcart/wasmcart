// A large threaded test cart (bigcart.c): cart.wasm, any amount of stored
// filler, then song.pcm and tail.bin as the last entries.
//
//   node test/fixtures/bigcart/bigcart.build.mjs <out.wasc> [fillMB=1024]
//       writes the archive entry by entry, so a 1 GB cart never sits in memory
//   WASM_CLANG=<clang with wasm-ld> node test/fixtures/bigcart/bigcart.build.mjs --wasm
//       rebuilds the checked-in bigcart.wasm from bigcart.c
//
// Only bigcart.wasm is checked in: the archive is made where it is tested
// (bigCartBytes() for a small one in memory) and deleted after.
import { execFileSync } from 'node:child_process';
import { openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomFillSync } from 'node:crypto';
import { crc32 } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, 'bigcart.wasm');

export const SONG_FRAMES = 1 << 20;
export const TAIL_SIZE = 4096;
export const FILL_ENTRY = 16 << 20;

export function songBytes() {
  const s = new Int16Array(SONG_FRAMES * 2);
  for (let i = 0; i < SONG_FRAMES; i++) {
    s[i * 2] = ((((i * 37) >>> 0) & 0xfff) - 2048) * 4;
    s[i * 2 + 1] = ((((i * 37 + 11) >>> 0) & 0xfff) - 2048) * 4;
  }
  return Buffer.from(s.buffer);
}
export const tailBytes = () => Buffer.from(Uint8Array.from({ length: TAIL_SIZE }, (_, i) => (i * 13 + 5) & 255));

function buildWasm() {
  execFileSync(process.env.WASM_CLANG || 'clang', ['--target=wasm32', '-nostdlib', '-O2', '-matomics', '-mbulk-memory',
    `-I${join(HERE, '..', '..', '..', 'include')}`, '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,--shared-memory',
    '-Wl,--initial-memory=8388608', '-Wl,--max-memory=16777216', '-Wl,--export=wasi_thread_start',
    join(HERE, 'bigcart.c'), '-o', WASM], { stdio: 'inherit' });
}

// The archive, written to put(buffer) in order. Every entry is stored.
function writeCart(put, fillMB) {
  let at = 0;
  const central = [];
  const out = (b) => { put(b); at += b.length; };
  const add = (name, data) => {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    central.push({ nameBuf, crc, size: data.length, offset: at });
    out(h); out(nameBuf); out(data);
  };
  add('manifest.json', Buffer.from(JSON.stringify({ name: 'bigcart', title: 'Big Cart', version: '1.0.0', abi: 4, entry: 'cart.wasm' })));
  add('cart.wasm', readFileSync(WASM));
  if (fillMB > 0) {
    const fill = randomFillSync(Buffer.alloc(FILL_ENTRY));
    const n = Math.ceil((fillMB * (1 << 20)) / FILL_ENTRY);
    for (let i = 0; i < n; i++) add(`fill/${String(i).padStart(3, '0')}.bin`, fill);
  }
  add('song.pcm', songBytes());
  add('tail.bin', tailBytes());
  const cdStart = at;
  for (const e of central) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.offset, 42);
    out(c); out(e.nameBuf);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(at - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
  out(eocd);
  return at;
}

/** A small bigcart in memory (fillMB of filler). */
export function bigCartBytes(fillMB = 0) {
  const parts = [];
  writeCart((b) => parts.push(b), fillMB);
  return Buffer.concat(parts);
}

/** Write the cart to `outPath` with `fillMB` MiB of stored filler; returns its size. */
export function writeBigCart(outPath, fillMB = 1024) {
  const fd = openSync(outPath, 'w');
  try {
    return writeCart((b) => writeSync(fd, b), fillMB);
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--wasm') {
    buildWasm();
    console.log(`wrote ${WASM}`);
  } else if (process.argv[2]) {
    console.log(`wrote ${process.argv[2]}: ${writeBigCart(process.argv[2], Number(process.argv[3] ?? 1024))} bytes`);
  } else {
    console.error('usage: bigcart.build.mjs <out.wasc> [fillMB] | --wasm');
    process.exit(2);
  }
}
