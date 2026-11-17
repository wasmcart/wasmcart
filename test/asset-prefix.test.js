// An asset named WITH the asset prefix ("assets/hello.txt") resolves the same
// way packed and unpacked. The archive loaders index every entry under both
// spellings, so a cart that names its assets with the prefix (wasmcart-pygame's
// importer asks for "assets/main.py") booted packed and failed as a directory.
// The web host's half is in test/browser.test.mjs, section 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { CartHost } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'wasmcart.js');
const DIRCART = join(HERE, 'fixtures', 'dircart');

// wc_asset_size as the cart calls it: the path written into its own memory.
function sizeOf(cart, path) {
  const bytes = new TextEncoder().encode(path);
  const ptr = cart.memory.buffer.byteLength - 4096;
  new Uint8Array(cart.memory.buffer).set(bytes, ptr);
  return cart._assetSize(ptr, bytes.length);
}

async function sizes(source) {
  const cart = new CartHost();
  await cart.load(source);
  try {
    return {
      bare: sizeOf(cart, 'hello.txt'),
      prefixed: sizeOf(cart, 'assets/hello.txt'),
      nested: sizeOf(cart, 'assets/data/key.txt'),
      missing: sizeOf(cart, 'assets/nope.txt'),
    };
  } finally {
    cart.destroy();
  }
}

test('a prefixed asset path resolves from a directory as it does from a .wasc', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-prefix-'));
  try {
    const wasc = join(tmp, 'dircart.wasc');
    execFileSync(process.execPath, [CLI, 'pack', '--wasm', join(DIRCART, 'cart.wasm'),
      '--assets', join(DIRCART, 'assets'), '--name', 'dircart', '-o', wasc], { stdio: 'pipe' });
    const packed = await sizes(wasc);
    const dir = await sizes(DIRCART);
    assert.deepEqual(packed, { bare: 22, prefixed: 22, nested: 9, missing: -1 }, 'packed answers both spellings');
    assert.deepEqual(dir, packed, 'a directory answers exactly what the packed cart does');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('in a directory, a real file under assets/assets/ wins over the stripped spelling', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-prefix-'));
  try {
    const dir = join(tmp, 'cart');
    mkdirSync(join(dir, 'assets', 'assets'), { recursive: true });
    execFileSync('cp', [join(DIRCART, 'cart.wasm'), dir]);
    writeFileSync(join(dir, 'assets', 'hello.txt'), 'x'.repeat(22));
    writeFileSync(join(dir, 'assets', 'assets', 'hello.txt'), 'nested');
    const r = await sizes(dir);
    assert.equal(r.bare, 22);
    assert.equal(r.prefixed, 6, 'the path as given, when it exists');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
