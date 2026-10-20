// Builds testcart/testcart.wasc from testcart.c (see the comment there).
//
//   WASM_CLANG=<a clang with wasm-ld, e.g. emsdk/upstream/bin/clang> node testcart/build.mjs
//
// No libc: the cart needs none. -fno-builtin keeps clang from turning its own
// loops back into strlen/memset calls, and bulk memory makes the block clears
// memory.fill.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'testcart-build-'));
const wasm = join(work, 'cart.wasm');
try {
  execFileSync(process.env.WASM_CLANG || 'clang', ['--target=wasm32', '-nostdlib', '-O2', '-mbulk-memory', '-fno-builtin',
    `-I${join(HERE, '..', 'include')}`, '-Wall', '-Wextra', '-Werror',
    '-Wl,--no-entry', '-Wl,--export=__indirect_function_table', join(HERE, 'testcart.c'), '-o', wasm],
    { stdio: 'inherit' });
  execFileSync(process.execPath, [join(HERE, '..', 'bin', 'wasmcart-pack.js'), '--wasm', wasm,
    '--name', 'wasmcart test cart', '--width', '640', '--height', '360', '--players', '4',
    '--controls', 'dpad,a,b,x,y,l,r,start,select,left_stick,right_stick,left_trigger,right_trigger,l3,r3',
    '-o', join(HERE, 'testcart.wasc')], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
