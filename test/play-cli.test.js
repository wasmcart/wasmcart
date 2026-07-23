// wasmcart-play CLI — headless runner paths (.wasc + seed + PNG/WAV outputs).
// The interactive TTY player can't run in CI; these cover everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
