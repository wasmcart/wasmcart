// wc_host_info_t.hardware_threads (SPEC.md, "wc_host_info_t"): written for a
// cart that sets FLAG_HOST_THREADS, never for one that does not. The fixtures
// (test/fixtures/hostthreads.c) copy what they read at wc_init into debug fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { CartHost } from '../index.js';
import { FLAG_HOST_THREADS, HOST_INFO_FIELDS } from '../src/abi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CART = join(HERE, 'fixtures', 'hostthreads.wasc');
const LEGACY = join(HERE, 'fixtures', 'hostthreads_legacy.wasc');
const SENTINEL = 0x5e771e15;

test('FLAG_HOST_THREADS is 1 << 7; hardware_threads sits at offset 20', () => {
  assert.equal(FLAG_HOST_THREADS, 1 << 7);
  assert.equal(HOST_INFO_FIELDS.HARDWARE_THREADS, 20);
});

test('CartHost writes os.availableParallelism() for a cart that sets the flag', async () => {
  const cart = new CartHost();
  await cart.load(CART);
  assert.equal(cart.info.wantsHostThreads, true);
  assert.equal(cart.readDebugValue('threads').value, availableParallelism(), 'what wc_init read');
  cart.destroy();
});

test('CartHost writes nothing past a 20-byte host info (a cart without the flag)', async () => {
  const cart = new CartHost();
  await cart.load(LEGACY);
  assert.equal(cart.info.wantsHostThreads, false);
  assert.equal(cart.readDebugValue('sentinel').value, SENTINEL, 'the word after the struct is the cart\'s');
  cart.destroy();
});

test('CartHostWeb writes navigator.hardwareConcurrency, and nothing for a cart without the flag', async () => {
  const { CartHostWeb } = await import('../src/CartHostWeb.js');
  const web = new CartHostWeb();
  await web.load(new Uint8Array(readFileSync(CART)), {});
  assert.equal(web.info.wantsHostThreads, true);
  assert.equal(web.readDebugValue('threads').value, globalThis.navigator?.hardwareConcurrency >>> 0);
  web.destroy();
  const legacy = new CartHostWeb();
  await legacy.load(new Uint8Array(readFileSync(LEGACY)), {});
  assert.equal(legacy.readDebugValue('sentinel').value, SENTINEL);
  legacy.destroy();
});

// A cart thread that dies after it was spawned (test/fixtures/threaddie.c
// traps in wasi_thread_start) is an error, not a log line: the cart's pool
// would silently run a worker short. The next runFrame throws it.
test('a cart thread that dies stops the cart with an error naming the thread (CartHost)', async () => {
  const cart = new CartHost();
  await cart.load(join(HERE, 'fixtures', 'threaddie.wasc'));
  try {
    assert.ok(cart.readDebugValue('spawned').value > 0, 'the thread was spawned');
    let err = null;
    for (let i = 0; i < 200 && !err; i++) {
      try { cart.runFrame(); } catch (e) { err = e; }
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(err, 'runFrame threw');
    assert.match(err.message, /cart thread \d+ died/);
    assert.throws(() => cart.runFrame(), /cart thread \d+ died/, 'and keeps throwing');
  } finally {
    cart.destroy();
  }
});

// A cart thread reads an asset (test/fixtures/bigcart: thread 1 reads tail.bin,
// the archive's last entry, and checks every byte). Node's thread worker read
// from an offset the host never set, so a thread's asset read returned the
// archive's first bytes (its "PK\3\4" header) for every entry.
test('a cart thread reads an asset from a .wasc file and from bytes (CartHost)', async () => {
  const { bigCartBytes } = await import('./fixtures/bigcart/bigcart.build.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const bytes = bigCartBytes(0);
  const dir = mkdtempSync(join(tmpdir(), 'bigcart-'));
  const file = join(dir, 'bigcart.wasc');
  writeFileSync(file, bytes);
  try {
    for (const source of [file, new Uint8Array(bytes)]) {
      const cart = new CartHost();
      await cart.load(source);
      try {
        for (let i = 0; i < 200 && !(cart.readDebugValue('threads_ran').value === 4 && cart.readDebugValue('song_ok').value); i++) {
          cart.runFrame();
          await new Promise((r) => setTimeout(r, 5));
        }
        const v = (n) => cart.readDebugValue(n).value;
        assert.deepEqual({ spawned: v('spawned'), ran: v('threads_ran'), tail: v('tail_bytes'), tailOk: v('tail_ok'), song: v('song_ok') },
          { spawned: 4, ran: 4, tail: 4096, tailOk: 1, song: 1 }, typeof source === 'string' ? 'from the file' : 'from bytes');
      } finally {
        cart.destroy();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
