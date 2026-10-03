// The optional manifest `files` list: `wasmcart index`, `wasmcart pack --files`,
// and the node host's stale-list warning for cart directories. The web host's
// half (fetching a directory's assets on demand, serving `files` as
// _filelist.txt) runs in a real browser: test/browser.test.mjs, sections 5-7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { CartHost } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'wasmcart.js');
const DIRCART = join(HERE, 'fixtures', 'dircart');   // no manifest.json, on purpose
const LISTED = ['data/key.txt', 'data/late.bin', 'hello.txt'];

function withCopy(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-files-'));
  const dir = join(tmp, 'cart');
  cpSync(DIRCART, dir, { recursive: true });
  return Promise.resolve(fn(dir, tmp)).finally(() => rmSync(tmp, { recursive: true, force: true }));
}
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const index = (...args) => spawnSync(process.execPath, [CLI, 'index', ...args], { encoding: 'utf8' });

// What the CART saw, from its results struct (field order: see dircart.c).
function cartResults(cart) {
  const p = cart.instance.exports.dc_results();
  const v = new Int32Array(cart.memory.buffer, p, 10);
  return { init_loaded: v[1], list_size: v[3], list_loaded: v[4] };
}

test('a cart directory runs with no manifest.json (the manifest is optional)', async () => {
  const cart = new CartHost();
  await cart.load(DIRCART);
  assert.equal(cart.getInfo().width, 64);
  // _filelist.txt comes from the real directory on the node host.
  const r = cartResults(cart);
  assert.equal(r.init_loaded, 22);
  assert.ok(r.list_size > 0, 'node host lists a directory itself');
  cart.destroy();
});

test('wasmcart index writes `files`, --check verifies it, --remove drops it', () => withCopy((dir) => {
  let r = index(dir, '--check');
  assert.equal(r.status, 1, 'no list yet: --check fails');
  assert.equal(existsSync(join(dir, 'manifest.json')), false, '--check changes nothing');

  r = index(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(manifestOf(dir), { files: LISTED }, 'a minimal manifest holding only the list');

  assert.equal(index(dir, '--check').status, 0);

  writeFileSync(join(dir, 'assets', 'new.txt'), 'x');
  r = index(dir, '--check');
  assert.equal(r.status, 1, 'a file added after indexing makes it stale');
  assert.match(r.stderr, /not listed: new\.txt/);

  r = index(dir, '--remove');
  assert.equal(r.status, 0);
  assert.equal('files' in manifestOf(dir), false);
}));

test('wasmcart index keeps every other manifest field', () => withCopy((dir) => {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'Keep', width: 64, files: ['old'] }));
  assert.equal(index(dir).status, 0);
  assert.deepEqual(manifestOf(dir), { name: 'Keep', width: 64, files: LISTED });
}));

test('the node host warns, by name, when `files` disagrees with the directory', () => withCopy(async (dir) => {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: ['hello.txt', 'gone.txt'] }));
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const cart = new CartHost();
    await cart.load(dir);
    cart.destroy();
  } finally {
    console.warn = orig;
  }
  const w = warnings.find((m) => m.includes('`files`'));
  assert.ok(w, `expected a stale-list warning, got: ${JSON.stringify(warnings)}`);
  assert.match(w, /not listed: data\/key\.txt, data\/late\.bin/);
  assert.match(w, /not on disk: gone\.txt/);
  assert.match(w, /wasmcart index/);
}));

test('a current `files` list loads without a warning', () => withCopy(async (dir) => {
  assert.equal(index(dir).status, 0);
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const cart = new CartHost();
    await cart.load(dir);
    cart.destroy();
  } finally {
    console.warn = orig;
  }
  assert.deepEqual(warnings.filter((m) => m.includes('`files`')), []);
}));

test('pack writes `files` only with --files, and lists exactly what it packed', () => withCopy((dir, tmp) => {
  writeFileSync(join(dir, 'assets', '.hidden'), 'x');   // pack skips dotfiles
  const pack = (out, ...extra) => {
    execFileSync(process.execPath, [CLI, 'pack', '--wasm', join(dir, 'cart.wasm'),
      '--assets', join(dir, 'assets'), '-o', out, ...extra], { stdio: 'pipe' });
    const zip = unzipSync(readFileSync(out));
    return { manifest: JSON.parse(new TextDecoder().decode(zip['manifest.json'])), zip };
  };
  const plain = pack(join(tmp, 'plain.wasc'));
  assert.equal('files' in plain.manifest, false, 'optional: not written by default');

  const listed = pack(join(tmp, 'listed.wasc'), '--files');
  assert.deepEqual(listed.manifest.files, LISTED);
  for (const p of listed.manifest.files) assert.ok(listed.zip['assets/' + p], `${p} is in the archive`);
}));
