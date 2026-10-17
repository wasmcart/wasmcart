// Builds prefetch.wasc from prefetch.c (see the comment there): the cart,
// big.bin (8 MiB of (i * 31 + 7) & 255, DEFLATED so a prefetch has to inflate)
// and small.bin (4096 bytes of (i * 7 + 3) & 255, STORED). The tests unzip
// this archive to make the cart-directory forms.
//
//   WASM_CLANG=<a clang with wasm-ld, e.g. emsdk/upstream/bin/clang> node test/fixtures/prefetch.build.mjs
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

const HERE = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'prefetch-build-'));
const wasm = join(work, 'cart.wasm');
execFileSync(process.env.WASM_CLANG || 'clang', ['--target=wasm32', '-nostdlib', '-O2', `-I${join(HERE, '..', '..', 'include')}`,
  '-Wl,--no-entry', join(HERE, 'prefetch.c'), '-o', wasm], { stdio: 'inherit' });

export const BIG_SIZE = 8 << 20;
export const SMALL_SIZE = 4096;
export const bigBytes = () => Uint8Array.from({ length: BIG_SIZE }, (_, i) => (i * 31 + 7) & 255);
export const smallBytes = () => Uint8Array.from({ length: SMALL_SIZE }, (_, i) => (i * 7 + 3) & 255);

const zip = new ZipFile();
zip.addBuffer(Buffer.from(JSON.stringify({
  name: 'prefetch', version: '1.0.0', abi: 4, entry: 'cart.wasm',
  files: ['big.bin', 'small.bin'],
}, null, 2)), 'manifest.json', { compress: false });
zip.addBuffer(readFileSync(wasm), 'cart.wasm', { compress: false });
zip.addBuffer(Buffer.from(bigBytes()), 'assets/big.bin', { compress: true });
zip.addBuffer(Buffer.from(smallBytes()), 'assets/small.bin', { compress: false });
const out = createWriteStream(join(HERE, 'prefetch.wasc'));
zip.outputStream.pipe(out).on('close', () => {
  rmSync(work, { recursive: true, force: true });
  console.log('wrote', join(HERE, 'prefetch.wasc'));
});
zip.end();
