// The cart's pictures for launchers (SPEC: manifest `art`): wasmcart-pack
// --art writes them, a host ignores fields it does not know, and the picture
// checks tell a PNG and a JPEG's size apart from anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { unzipSync, zipSync } from 'fflate';
import { CartHost } from '../index.js';
import { imageInfo, describeArtProblems } from '../src/cartArt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..', 'bin', 'wasmcart-pack.js');
const HELLO_WASC = join(HERE, 'fixtures', 'hello.wasc');

// the first bytes of a PNG (signature + IHDR) or a JPEG (SOI + SOF0): all imageInfo reads
function png(w, h, colour = 6) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = colour;
  return b;
}
function jpeg(w, h) {
  // SOI, APP0 (a marker to skip), SOF0
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-art-'));
  const wasm = join(tmp, 'cart.wasm');
  writeFileSync(wasm, unzipSync(readFileSync(HELLO_WASC))['cart.wasm']);
  return { tmp, wasm };
}
const pack = (args) => spawnSync(process.execPath, [PACK, ...args], { encoding: 'utf8' });
const readManifest = (wasc) => JSON.parse(new TextDecoder().decode(unzipSync(readFileSync(wasc))['manifest.json']));

test('imageInfo reads a PNG and a JPEG size, and nothing else', () => {
  assert.deepEqual(imageInfo(png(512, 256)), { type: 'png', width: 512, height: 256, alpha: true });
  assert.equal(imageInfo(png(10, 10, 2)).alpha, false);
  assert.deepEqual(imageInfo(jpeg(600, 900)), { type: 'jpeg', width: 600, height: 900, alpha: false });
  assert.equal(imageInfo(Buffer.from('GIF89a not a png or jpeg at all')), null);
  assert.equal(imageInfo(Buffer.alloc(4)), null);
});

test('--art packs pictures named for their key under art/, with description and author', async () => {
  const { tmp, wasm } = setup();
  try {
    const art = join(tmp, 'art');
    mkdirSync(art);
    writeFileSync(join(art, 'icon.png'), png(512, 512));
    writeFileSync(join(art, 'cover.jpg'), jpeg(600, 900));
    writeFileSync(join(art, 'background.jpg'), jpeg(1920, 1080));
    writeFileSync(join(art, 'logo.png'), png(1280, 400));
    writeFileSync(join(art, 'title.png'), png(1920, 1080, 2));
    writeFileSync(join(art, 'screenshot-10.png'), png(1920, 1080, 2));
    writeFileSync(join(art, 'screenshot-2.png'), png(1920, 1080, 2));
    const out = join(tmp, 'out.wasc');
    const r = pack(['--wasm', wasm, '--art', art, '--description', 'A test cart.', '--author', 'Someone', '-o', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/wasmcart-pack:/.test(r.stderr), `no warnings for well-formed art: ${r.stderr}`);
    const m = readManifest(out);
    assert.equal(m.description, 'A test cart.');
    assert.equal(m.author, 'Someone');
    assert.deepEqual(m.art, {
      icon: 'art/icon.png', cover: 'art/cover.jpg', background: 'art/background.jpg', logo: 'art/logo.png', title: 'art/title.png',
      screenshots: [{ path: 'art/screenshot-2.png' }, { path: 'art/screenshot-10.png' }],
    });
    const zip = unzipSync(readFileSync(out));
    for (const p of ['art/icon.png', 'art/cover.jpg', 'art/screenshot-10.png']) assert.ok(zip[p], `${p} in the archive`);
    // the archive's art checks clean, read back out of the zip
    assert.deepEqual(describeArtProblems(m.art, (p) => zip[p] || null), []);
    // and the cart runs as it would without art
    const host = new CartHost();
    await host.load(out);
    host.runFrame([]);
    host.destroy();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('art.json names the files and labels the screenshots', () => {
  const { tmp, wasm } = setup();
  try {
    const art = join(tmp, 'pics');
    mkdirSync(art);
    writeFileSync(join(art, 'box.jpg'), jpeg(1200, 1800));
    writeFileSync(join(art, 'a.png'), png(1280, 720, 2));
    writeFileSync(join(art, 'art.json'), JSON.stringify({ cover: 'box.jpg', screenshots: [{ path: 'a.png', label: 'The first level' }] }));
    const out = join(tmp, 'out.wasc');
    const r = pack(['--wasm', wasm, '--art', art, '-o', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readManifest(out).art, { cover: 'art/box.jpg', screenshots: [{ path: 'art/a.png', label: 'The first level' }] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a picture of the wrong shape warns and still packs; a file that is no picture fails', () => {
  const { tmp, wasm } = setup();
  try {
    const art = join(tmp, 'art');
    mkdirSync(art);
    writeFileSync(join(art, 'cover.png'), png(1920, 1080)); // landscape: a cover is 2:3
    writeFileSync(join(art, 'logo.jpg'), jpeg(1280, 400)); // a logo needs transparency
    let r = pack(['--wasm', wasm, '--art', art, '-o', join(tmp, 'a.wasc')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /art cover cover\.png is 1920 x 1080; it should be portrait 2:3/);
    assert.match(r.stderr, /art logo logo\.jpg has no transparency/);
    // control: the same check must not warn about a right-shaped cover
    writeFileSync(join(art, 'cover.png'), png(600, 900));
    r = pack(['--wasm', wasm, '--art', art, '-o', join(tmp, 'b.wasc')]);
    assert.doesNotMatch(r.stderr, /art cover/);
    // not a picture at all: an error, nothing written
    writeFileSync(join(art, 'icon.png'), 'not a png');
    r = pack(['--wasm', wasm, '--art', art, '-o', join(tmp, 'c.wasc')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /icon icon\.png is not a PNG or JPEG/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a host ignores manifest fields and art keys it does not know', async () => {
  const { tmp, wasm } = setup();
  try {
    // a cart from a later revision: an unknown top-level field, an unknown art key, an art file missing
    const manifest = {
      name: 'Later Cart', abi: 4, entry: 'cart.wasm',
      some_future_field: { anything: [1, 2, 3] },
      art: { cover: 'art/missing.jpg', hologram: 'art/h.bin' },
    };
    const out = join(tmp, 'later.wasc');
    writeFileSync(out, zipSync({ 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'cart.wasm': readFileSync(wasm) }));
    const host = new CartHost();
    await host.load(out);
    assert.ok(host.getInfo().width > 0);
    host.runFrame([]);
    host.destroy();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
