// `wasmcart art`: a cart's launcher art (SPEC: manifest `art`) copied out to
// ES-DE's media folders, libretro's thumbnail folders, or a plain folder that
// packs back with `wasmcart-pack --art`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { zipSync, unzipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASMCART = join(HERE, '..', 'bin', 'wasmcart.js');
const PACK = join(HERE, '..', 'bin', 'wasmcart-pack.js');
const HELLO_WASC = join(HERE, 'fixtures', 'hello.wasc');

// the first bytes of a PNG or a JPEG: all the picture checks read
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
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(8)]);
}

const wasm = () => unzipSync(readFileSync(HELLO_WASC))['cart.wasm'];
const ART = {
  icon: 'art/icon.png', cover: 'art/cover.jpg', background: 'art/background.jpg', logo: 'art/logo.png', title: 'art/title.png',
  screenshots: [{ path: 'art/shot-1.png', label: 'The first level' }, { path: 'art/shot-2.jpg' }],
};
const PICS = {
  'art/icon.png': png(512, 512), 'art/cover.jpg': jpeg(600, 900), 'art/background.jpg': jpeg(1920, 1080),
  'art/logo.png': png(1280, 400), 'art/title.png': png(1280, 720, 2), 'art/shot-1.png': png(1280, 720, 2), 'art/shot-2.jpg': jpeg(1280, 720),
};
function cart(path, art = ART, pics = PICS) {
  const manifest = { name: 'Test', version: '1.0.0', abi: 4, entry: 'cart.wasm', ...(art ? { art } : {}) };
  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'cart.wasm': wasm() };
  for (const [p, b] of Object.entries(pics)) files[p] = b;
  writeFileSync(path, zipSync(files));
}
const run = (args) => spawnSync(process.execPath, [WASMCART, 'art', ...args], { encoding: 'utf8' });
function withTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-artx-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('--esde writes the media folders by cart name, the bytes as packed', () =>
  withTmp((tmp) => {
    cart(join(tmp, 'game.wasc'));
    const media = join(tmp, 'media');
    const r = run([join(tmp, 'game.wasc'), '--esde', media]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'game: esde: wrote 5');
    const want = {
      'covers/game.jpg': 'art/cover.jpg', 'screenshots/game.png': 'art/shot-1.png', 'titlescreens/game.png': 'art/title.png',
      'marquees/game.png': 'art/logo.png', 'fanart/game.jpg': 'art/background.jpg',
    };
    for (const [dest, src] of Object.entries(want)) assert.deepEqual(readFileSync(join(media, dest)), PICS[src], dest);
    assert.deepEqual(readdirSync(media).sort(), ['covers', 'fanart', 'marquees', 'screenshots', 'titlescreens']);
  }));

test('an existing file is kept, --force overwrites it, and a picture in another format counts as existing', () =>
  withTmp((tmp) => {
    cart(join(tmp, 'game.wasc'));
    const media = join(tmp, 'media');
    mkdirSync(join(media, 'covers'), { recursive: true });
    writeFileSync(join(media, 'covers', 'game.png'), 'mine'); // the user's own cover, as PNG
    let r = run([join(tmp, 'game.wasc'), '--esde', media]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'game: esde: wrote 4, kept 1 already there');
    assert.equal(readFileSync(join(media, 'covers', 'game.png'), 'utf8'), 'mine');
    assert.ok(!existsSync(join(media, 'covers', 'game.jpg')), 'no second cover beside the user\'s');
    r = run([join(tmp, 'game.wasc'), '--esde', media]);
    assert.equal(r.stdout.trim(), 'game: esde: kept 5 already there');
    r = run([join(tmp, 'game.wasc'), '--esde', media, '--force']);
    assert.equal(r.stdout.trim(), 'game: esde: wrote 5');
    assert.deepEqual(readFileSync(join(media, 'covers', 'game.jpg')), PICS['art/cover.jpg']);
    assert.ok(!existsSync(join(media, 'covers', 'game.png')), 'the replaced cover is not left to shadow the new one');
  }));

test('--libretro writes PNG thumbnails and names the JPEG ones it cannot convert', () =>
  withTmp((tmp) => {
    cart(join(tmp, 'a: game.wasc'));
    const thumbs = join(tmp, 'thumbs');
    const r = run([join(tmp, 'a: game.wasc'), '--libretro', thumbs]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'a: game: libretro: wrote 2 (cover is JPEG; libretro thumbnails must be PNG, not converted)');
    // libretro's thumbnail names replace : (and & * / ` < > ? \ |) with _
    assert.deepEqual(readFileSync(join(thumbs, 'Named_Snaps', 'a_ game.png')), PICS['art/shot-1.png']);
    assert.deepEqual(readFileSync(join(thumbs, 'Named_Titles', 'a_ game.png')), PICS['art/title.png']);
    assert.ok(!existsSync(join(thumbs, 'Named_Boxarts')), 'a JPEG is never written under a .png name');
  }));

test('--out dumps every picture with an art.json that packs back to the same art', () =>
  withTmp((tmp) => {
    cart(join(tmp, 'game.wasc'));
    const out = join(tmp, 'out');
    const r = run([join(tmp, 'game.wasc'), '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'game: out: wrote 8');
    assert.deepEqual(readdirSync(join(out, 'game')).sort(), [
      'art.json', 'background.jpg', 'cover.jpg', 'icon.png', 'logo.png', 'screenshot-1.png', 'screenshot-2.jpg', 'title.png',
    ]);
    writeFileSync(join(tmp, 'cart.wasm'), wasm());
    const p = spawnSync(process.execPath, [PACK, '--wasm', join(tmp, 'cart.wasm'), '--art', join(out, 'game'), '-o', join(tmp, 'again.wasc')], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const zip = unzipSync(readFileSync(join(tmp, 'again.wasc')));
    const art = JSON.parse(new TextDecoder().decode(zip['manifest.json'])).art;
    assert.deepEqual(art.screenshots, [{ path: 'art/screenshot-1.png', label: 'The first level' }, { path: 'art/screenshot-2.jpg' }]);
    for (const k of ['icon', 'cover', 'background', 'logo', 'title']) assert.deepEqual(Buffer.from(zip[art[k]]), PICS[ART[k]], k);
  }));

test('a directory of carts: one line each, a cart without art is not an error', () =>
  withTmp((tmp) => {
    const dir = join(tmp, 'carts');
    mkdirSync(dir);
    cart(join(dir, 'one.wasc'));
    cart(join(dir, 'two.wasc'), null, {});
    cart(join(dir, 'three.wasc'), { cover: 'art/cover.jpg', screenshots: [{ path: 'art/missing.png' }] }, { 'art/cover.jpg': Buffer.from('not a picture') });
    writeFileSync(join(dir, 'readme.txt'), 'not a cart');
    const r = run([dir, '--esde', join(tmp, 'media')]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'one: esde: wrote 5',
      'three: esde: nothing to write (cover art/cover.jpg is not a PNG or JPEG; screenshot art/missing.png is not in the cart)',
      'two: no art',
    ]);
  }));

test('a cart directory reads its art off disk; an unreadable cart fails the run', () =>
  withTmp((tmp) => {
    const dir = join(tmp, 'mygame');
    mkdirSync(join(dir, 'art'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entry: 'cart.wasm', art: { cover: 'art/cover.jpg' } }));
    writeFileSync(join(dir, 'art', 'cover.jpg'), PICS['art/cover.jpg']);
    writeFileSync(join(tmp, 'broken.wasc'), 'not a zip');
    const r = run([dir, join(tmp, 'broken.wasc'), '--esde', join(tmp, 'media')]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^mygame: esde: wrote 1$/m);
    assert.match(r.stdout, /^broken: error: cannot read the cart/m);
    assert.deepEqual(readFileSync(join(tmp, 'media', 'covers', 'mygame.jpg')), PICS['art/cover.jpg']);
  }));

test('no target or no cart prints the usage and fails', () => {
  assert.equal(run([HELLO_WASC]).status, 1);
  assert.equal(run(['--esde', 'x']).status, 1);
  const h = run(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--libretro/);
});
