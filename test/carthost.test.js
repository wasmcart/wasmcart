// CartHost reference-host integration - load a real cart and drive it. Uses the
// tiny vendored hello.wasc fixture (a 2D, no-GL cart) so this runs headless in CI
// with no GL backend, no sibling-dir dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CartHost } from '../index.js';
import { makeSaver } from '../src/save.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO = join(HERE, 'fixtures', 'hello.wasc');

test('loads a .wasc cart and reports info', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  const info = cart.getInfo();
  assert.equal(cart.usesGL, false, 'hello is a 2D cart');
  assert.ok(info.width > 0 && info.height > 0);
  assert.ok(info.version >= 1 && info.version <= 3);
  cart.destroy();
});

test('runFrame returns a correctly-sized framebuffer', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  const { width, height } = cart.getInfo();
  const frame = cart.runFrame([]);
  assert.ok(frame.framebuffer instanceof Uint8Array);
  assert.equal(frame.framebuffer.length, width * height * 4, 'ARGB8888 = w*h*4 bytes');
  assert.equal(frame.width, width);
  assert.equal(frame.height, height);
  cart.destroy();
});

test('runs many frames without throwing', async () => {
  const cart = new CartHost();
  await cart.load(HELLO);
  for (let i = 0; i < 60; i++) cart.runFrame([]);
  cart.destroy();
});

test('loads from a Uint8Array of the .wasc bytes', async () => {
  const bytes = readFileSync(HELLO);
  const cart = new CartHost();
  await cart.load(bytes);
  assert.ok(cart.getInfo().width > 0);
  cart.destroy();
});

test('rejects non-wasc buffer data', async () => {
  const cart = new CartHost();
  await assert.rejects(
    () => cart.load(new Uint8Array([1, 2, 3, 4])),
    /wasc|ZIP|Invalid/i,
  );
});

// ── Debug ABI (opt-in) — the reader logic against hand-laid memory (no compiler
// needed; a real debug cart is built from C but the reader is what we test here).

test('debug ABI: readDebugState/readDebugValue/writeDebugValue round-trip', async () => {
  const host = new CartHost();
  const mem = new WebAssembly.Memory({ initial: 1 });
  host.memory = mem;
  host._u8 = new Uint8Array(mem.buffer);
  host._u32 = new Uint32Array(mem.buffer);
  host.info = { hasDebug: true, flags: 1 << 5 };
  const dv = new DataView(mem.buffer);
  // name "hp" @0x100, value u8=42 @0x200, table @0x300 (one entry + terminator)
  host._u8.set(new TextEncoder().encode('hp\0'), 0x100);
  host._u8[0x200] = 42;
  dv.setUint32(0x300, 0x100, true); // name_ptr
  dv.setUint32(0x304, 0x200, true); // value_ptr
  host._u8[0x308] = 0;              // type U8
  dv.setUint32(0x30C, 1, true);     // len
  dv.setUint32(0x310, 0, true);     // terminator (name_ptr = 0)
  host.instance = { exports: { wc_debug_state: () => 0x300 } };

  const fields = host.readDebugState();
  assert.equal(fields.length, 1);
  assert.deepEqual(fields[0], { name: 'hp', type: 0, typeName: 'u8', valuePtr: 0x200, len: 1 });
  assert.deepEqual(host.readDebugValue('hp'), { name: 'hp', type: 'u8', value: 42 });
  host.writeDebugValue('hp', 99);
  assert.equal(host.readDebugValue('hp').value, 99);
  assert.throws(() => host.readDebugValue('nope'), /not found/);
});

test('debug ABI: a non-debug cart returns null (default off, structurally absent)', () => {
  const host = new CartHost();
  host.info = { hasDebug: false, flags: 0 };
  host.instance = { exports: {} };
  assert.equal(host.readDebugState(), null);
});

test('debug ABI: FLAG_DEBUG set but no export → null (conformance catches it), no crash', () => {
  const host = new CartHost();
  host.info = { hasDebug: true, flags: 1 << 5 };
  host.instance = { exports: {} }; // claims debug but didn't export the table
  assert.equal(host.readDebugState(), null);
});

// ── Manifest is optional, and never gates a cart's own capabilities ──────────
// Two rules from SPEC "Manifest", both of which had silent-failure modes:
//   1. A cart with no manifest.json must run (it used to be refused outright).
//   2. A manifest field must never gate a capability the cart declares in
//      wc_info_t.flags. pointer/keyboard were double-gated: the flag AND the
//      manifest had to agree, so a cart with WC_FLAG_KEYBOARD whose manifest
//      omitted "keyboard" got no input and no error — the same silent failure
//      that GL detection was fixed for earlier.
test('a cart with NO manifest.json loads and runs', async () => {
  const bytes = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'nomanifest.wasc')));
  const host = new CartHost();
  await host.load(bytes, {});
  assert.equal(host.getManifest(), null, 'no manifest is reported as null, not an error');
  const r = host.runFrame([{ connected: true, buttons: 0 }]);
  assert.ok(r.width > 0 && r.height > 0, 'cart still reports its own resolution');
  assert.equal(r.framebuffer.length, r.width * r.height * 4);
  host.destroy();
});

test('pointer/keyboard are gated by the FLAG alone, not the manifest', async () => {
  // Guards against reintroducing the double gate. The delivery paths must
  // consult wc_info_t only; grep is the cheapest reliable check that no
  // manifest field crept back into them.
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    assert.ok(!/_manifest\?\.pointer/.test(src),
      `${f}: pointer delivery must not consult the manifest`);
    assert.ok(!/_manifest\?\.keyboard/.test(src),
      `${f}: keyboard delivery must not consult the manifest`);
  }
});

// --- Rumble (ABI v3) ---
// The fixture cart calls rumble on frames 1-4: a normal effect, one with
// out-of-range magnitudes and an over-long duration, one on an invalid pad
// slot, then a stop.

test('rumble reaches the device, clamped and slot-checked', async () => {
  const host = new CartHost();
  const calls = [];
  host.setRumbleHandler({
    hasRumble: (p) => p === 0,
    rumble: (p, low, high, ms) => calls.push({ p, low, high, ms }),
    stopRumble: (p) => calls.push({ p, stop: true }),
  });
  await host.load(join(HERE, 'fixtures/rumble.wasc'));
  for (let i = 0; i < 5; i++) host.runFrame([{ connected: true, buttons: 0 }]);

  assert.deepEqual(calls[0], { p: 0, low: 0.5, high: 0.25, ms: 200 },
    'in-range values pass through untouched');

  // 99.0 -> 1, -5.0 -> 0, 999999ms -> the 5s cap. Clamping (not rejecting)
  // matters because a cart deriving intensity from game state overshoots at
  // the edges, and a dropped rumble is harder to notice than a saturated one.
  assert.deepEqual(calls[1], { p: 0, low: 1, high: 0, ms: 5000 },
    'magnitudes clamp to 0..1 and duration caps at MAX_RUMBLE_MS');

  // The cart also asked pad 99 to rumble; that must never reach the device.
  assert.ok(!calls.some((c) => c.p !== 0), 'out-of-range pad slots are dropped');
  assert.deepEqual(calls[2], { p: 0, stop: true }, 'stop is delivered');
  host.destroy();
});

test('a cart that rumbles runs fine with no rumble handler at all', async () => {
  // Headless runs, --frames captures and tests wire no handler. Rumble must
  // degrade to a silent no-op rather than faulting the cart.
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/rumble.wasc'));
  for (let i = 0; i < 5; i++) host.runFrame([{ connected: true, buttons: 0 }]);
  host.destroy();
});

test('a throwing rumble handler cannot fault the cart', async () => {
  // A pad unplugged mid-effect makes SDL throw. That is the host's problem,
  // not the cart's.
  const host = new CartHost();
  host.setRumbleHandler({
    hasRumble: () => { throw new Error('unplugged'); },
    rumble: () => { throw new Error('unplugged'); },
    stopRumble: () => { throw new Error('unplugged'); },
  });
  await host.load(join(HERE, 'fixtures/rumble.wasc'));
  for (let i = 0; i < 5; i++) host.runFrame([{ connected: true, buttons: 0 }]);
  host.destroy();
});

test('both hosts expose the same three rumble imports', async () => {
  // Divergence between the node and web hosts is the failure mode here: a cart
  // that rumbles in the terminal but silently does not in the browser.
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const imp of ['wc_pad_has_rumble', 'wc_pad_rumble', 'wc_pad_rumble_stop']) {
      assert.ok(src.includes(imp), `${f} must provide ${imp}`);
    }
  }
});

// --- Resize validation ---
// The cart writes width/height into its own memory, so they are untrusted. The
// danger is not a throw but a silent one: subarray() CLAMPS, so an unchecked
// host reports a resolution whose pixels do not exist.

test('a resize the framebuffer cannot back is rejected, not silently clamped', async () => {
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/hello.wasc'));
  const base = host._infoPtr >> 2;
  const first = host.runFrame([{ connected: true, buttons: 0 }]);
  const { width: w0, height: h0 } = first;

  // Poke an absurd resolution, as a buggy or hostile cart would. 4096x4096
  // needs 64MB; the cart's memory is ~17MB.
  host._u32[base + 1] = 4096;
  host._u32[base + 2] = 4096;
  const r = host.runFrame([{ connected: true, buttons: 0 }]);

  assert.equal(r.width, w0, 'keeps the last good width');
  assert.equal(r.height, h0, 'keeps the last good height');
  assert.equal(r.framebuffer.length, r.width * r.height * 4,
    'the reported size and the returned bytes MUST agree');
  host.destroy();
});

test('w*h*4 overflowing 32 bits is caught', async () => {
  // 65536x65536x4 is 17GB and wraps to 0 in int32 math, which would make an
  // absurd request look like a tiny one.
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/hello.wasc'));
  const base = host._infoPtr >> 2;
  const { width: w0, height: h0 } = host.runFrame([{ connected: true, buttons: 0 }]);
  host._u32[base + 1] = 65536;
  host._u32[base + 2] = 65536;
  const r = host.runFrame([{ connected: true, buttons: 0 }]);
  assert.equal(r.width, w0);
  assert.equal(r.height, h0);
  assert.equal(r.framebuffer.length, r.width * r.height * 4);
  host.destroy();
});

test('a resize the framebuffer DOES back is still accepted', async () => {
  // The guard must not be so strict that legitimate resolution changes break.
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/hello.wasc'));
  const base = host._infoPtr >> 2;
  host.runFrame([{ connected: true, buttons: 0 }]);
  host._u32[base + 1] = 640;
  host._u32[base + 2] = 480;
  const r = host.runFrame([{ connected: true, buttons: 0 }]);
  assert.equal(r.width, 640);
  assert.equal(r.height, 480);
  assert.equal(r.framebuffer.length, 640 * 480 * 4);
  host.destroy();
});

test('both hosts validate resize the same way', async () => {
  // Divergence here means a cart sized correctly in the browser and wrong in a
  // window, or vice versa.
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    assert.ok(/_applyResize\(newW, newH\)/.test(src),
      `${f} must route the post-render resize through _applyResize`);
    // The per-frame path must call the validator, never assign directly. The
    // validator's own body legitimately contains that assignment, so anchor on
    // the caller: the newW/newH read must be followed by the call.
    const caller = src.slice(src.indexOf('const newW = this._u32[base + 1];'));
    const upToCall = caller.slice(0, caller.indexOf('_applyResize(newW, newH)'));
    assert.ok(!/this\.info\.width\s*=/.test(upToCall),
      `${f} must not assign a cart-supplied size before validating it`);
  }
});

// --- Save durability ---
// savecart writes a magic word plus a per-frame counter into its save region,
// so a reload is provable rather than merely plausible.

test('a save round-trips through the host', async () => {
  const first = new CartHost();
  await first.load(join(HERE, 'fixtures/savecart.wasc'));
  for (let i = 0; i < 5; i++) first.runFrame([{ connected: true, buttons: 0 }]);
  const blob = first.getSaveData();
  first.destroy();

  assert.ok(blob && blob.length === 8, 'cart declares an 8-byte save region');
  const counter = new Uint32Array(blob.buffer, blob.byteOffset, 2)[1];
  assert.equal(counter, 5, 'counter reflects the frames that ran');

  // A second host handed that blob must RESUME, not restart.
  const second = new CartHost();
  await second.load(join(HERE, 'fixtures/savecart.wasc'), { saveData: blob });
  second.runFrame([{ connected: true, buttons: 0 }]);
  const after = new Uint32Array(
    second.getSaveData().buffer, second.getSaveData().byteOffset, 2)[1];
  assert.equal(after, 6, 'resumed from the saved counter instead of resetting to 1');
  second.destroy();
});

test('the save writer skips a never-written region but not a cleared one', async () => {
  // Two distinct cases that a naive `if (nonzero)` check conflates: never
  // saving (do not litter a .sav next to every cart) versus the player
  // clearing their data (must overwrite, or the old save resurrects).
  const dir = mkdtempSync(join(tmpdir(), 'wasmcart-save-'));
  try {
    const savPath = join(dir, 'x.sav');
    const zeroHost = { getSaveData: () => new Uint8Array(8) };

    makeSaver(zeroHost, savPath)();
    assert.ok(!existsSync(savPath), 'an all-zero region on first run writes nothing');

    // Now a real save exists...
    writeFileSync(savPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    makeSaver(zeroHost, savPath)();
    const after = readFileSync(savPath);
    assert.ok(after.every((b) => b === 0),
      'once a save exists, an all-zero region must overwrite it (cleared data)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both players persist saves on every exit path', async () => {
  // The bug this guards: saves that survived only a graceful window close.
  // Ctrl-C and `kill` are ordinary ways to stop a game.
  for (const f of ['../bin/play-window.js', '../bin/wasmcart-play.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    assert.ok(/makeSaver\(/.test(src), `${f} must build a save writer`);
    assert.ok(/process\.on\('SIGINT'/.test(src), `${f} must persist on SIGINT`);
    assert.ok(/process\.on\('SIGTERM'/.test(src), `${f} must persist on SIGTERM`);
    assert.ok(/loadSave\(/.test(src), `${f} must load an existing save on start`);
  }
});

// --- Loop inversion (wc_frame_yield / asyncify) ---
// yieldcart models a ported engine that owns its main loop: wc_render() runs
// forever and yields once per iteration. `counter` advances per iteration and
// `entered` counts fresh entries into wc_render, so resuming (correct) and
// restarting (wrong) are distinguishable.

const yieldFieldPtrs = (host) => {
  const p = {};
  for (const f of host.readDebugState()) p[f.name] = f.valuePtr;
  return p;
};

test('a loop-owning cart is suspended and resumed, not restarted', async () => {
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/yieldcart.wasc'));
  const ptrs = yieldFieldPtrs(host);
  const rd = (n) => new DataView(host._u8.buffer).getUint32(ptrs[n], true);

  for (let i = 1; i <= 5; i++) {
    host.runFrame([{ connected: true, buttons: 0 }]);
    assert.equal(rd('counter'), i, `frame ${i}: engine advanced exactly one iteration`);
    assert.equal(rd('entered'), 1,
      'wc_render must be entered ONCE — a second entry means the engine restarted');
  }
  host.destroy();
});

test('the web host inverts the loop identically to the node host', async () => {
  // The bug this guards: CartHostWeb had none of the asyncify machinery, and
  // its auto-stub backfilled wc_frame_yield as `() => -1`. That turned the
  // yield into a no-op, so the cart's infinite main loop never unwound and the
  // first runFrame() hung the tab forever. It did NOT fail to load, which is
  // why nothing caught it.
  const { CartHostWeb } = await import('../src/CartHostWeb.js');

  const ref = new CartHost();
  await ref.load(join(HERE, 'fixtures/yieldcart.wasc'));
  const ptrs = yieldFieldPtrs(ref);
  ref.destroy();

  const web = new CartHostWeb();
  await web.load(new Uint8Array(readFileSync(join(HERE, 'fixtures/yieldcart.wasc'))), {});
  const rd = (n) => new DataView(web._u8.buffer).getUint32(ptrs[n], true);

  for (let i = 1; i <= 5; i++) {
    web.runFrame([{ connected: true, buttons: 0 }]);
    assert.equal(rd('counter'), i, `web frame ${i}: same advance as the node host`);
    assert.equal(rd('entered'), 1, 'web host must resume, not restart');
  }
  web.destroy();
});

test('wc_frame_yield is a real import on every instantiation path', async () => {
  // It must be declared explicitly, not left to the web host's auto-stub:
  // a stub links fine and then hangs on the first frame. The workers matter
  // too, since a threaded cart instantiates the same module there.
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js',
                   '../src/cartWorker.js', '../src/cartWorkerWeb.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    assert.ok(/wc_frame_yield:\s*\(/.test(src),
      `${f} must declare wc_frame_yield explicitly`);
  }
});

// --- Lifecycle ---
// The lifecycle fixture tallies each callback and appends a digit per event
// (1=suspend 2=resume 3=focus_lost 4=focus_gained), so delivery AND ordering
// are provable rather than inferred.

const lifecycleReader = (host) => {
  const p = {};
  for (const f of host.readDebugState()) p[f.name] = f.valuePtr;
  return (n) => new DataView(host._u8.buffer).getUint32(p[n], true);
};

test('a suspended cart does not run, and resumes where it left off', async () => {
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/lifecycle.wasc'));
  const rd = lifecycleReader(host);

  host.runFrame([{ connected: true, buttons: 0 }]);
  host.runFrame([{ connected: true, buttons: 0 }]);
  assert.equal(rd('frames'), 2);

  host.suspend();
  host.runFrame([{ connected: true, buttons: 0 }]);
  host.runFrame([{ connected: true, buttons: 0 }]);
  assert.equal(rd('frames'), 2,
    'wc_render must not be called while suspended -- this is what makes a cart ' +
    'that ignores lifecycle entirely still correct');

  host.resume();
  host.runFrame([{ connected: true, buttons: 0 }]);
  assert.equal(rd('frames'), 3, 'frames resume after resume()');
  host.destroy();
});

test('lifecycle callbacks fire in a balanced order', async () => {
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/lifecycle.wasc'));
  const rd = lifecycleReader(host);

  host.suspend();
  host.resume();
  // focus_lost -> suspend -> resume -> focus_gained
  assert.equal(rd('sequence'), 3124,
    'suspend implies focus loss, and resume must restore it');
  assert.equal(rd('focus_lost'), 1);
  assert.equal(rd('focus_gained'), 1, 'the focus pair balances across a round trip');
  assert.equal(host.focused, true, 'a resumed cart is not left permanently unfocused');
  host.destroy();
});

test('lifecycle transitions are idempotent', async () => {
  // Hosts get duplicate visibility events routinely; a doubled suspend must
  // not deliver two callbacks.
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/lifecycle.wasc'));
  const rd = lifecycleReader(host);

  assert.equal(host.suspend(), true, 'first suspend transitions');
  assert.equal(host.suspend(), false, 'second is a no-op');
  assert.equal(rd('suspend'), 1, 'the cart saw exactly one wc_on_suspend');

  host.resume();
  assert.equal(host.resume(), false);
  assert.equal(rd('resume'), 1);
  host.destroy();
});

test('the clock is rebased across a suspend, not spiked', async () => {
  // The bug this prevents: delta_ms is now - lastFrameTime, so a ten-minute
  // background stint arrives as a 600000ms delta and teleports anything
  // integrating velocity by dt straight through the world.
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/hello.wasc'));
  const deltaMs = () =>
    new DataView(host._u8.buffer).getFloat64(host.info.timePtr + 8, true);

  host.runFrame([{ connected: true, buttons: 0 }]);
  host.runFrame([{ connected: true, buttons: 0 }]);

  host.suspend();
  host.lastFrameTime -= 600000; // simulate ten minutes suspended
  host.resume();
  host.runFrame([{ connected: true, buttons: 0 }]);

  assert.ok(deltaMs() < 1000,
    `first resumed frame reported ${deltaMs()}ms; the suspended gap is not elapsed game time`);
  host.destroy();
});

test('a cart with no lifecycle exports is unaffected', async () => {
  // hello.wasc exports none of them. Suspension must still work, because the
  // host owns it -- the callbacks are notification, not mechanism.
  const host = new CartHost();
  await host.load(join(HERE, 'fixtures/hello.wasc'));
  host.suspend();
  assert.equal(host.runFrame([{ connected: true, buttons: 0 }]), host._lastFrame,
    'suspended runFrame replays the last frame rather than throwing');
  host.resume();
  const r = host.runFrame([{ connected: true, buttons: 0 }]);
  assert.ok(r.width > 0 && r.framebuffer.length === r.width * r.height * 4);
  host.destroy();
});

test('both hosts implement the same lifecycle surface', async () => {
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const m of ['suspend()', 'resume()', 'blur()', 'focus()', '_rebaseClock', '_callLifecycle']) {
      assert.ok(src.includes(m), `${f} must implement ${m}`);
    }
    assert.ok(/if \(this\._suspended\) return this\._lastFrame/.test(src),
      `${f}: runFrame must be a no-op while suspended`);
  }
});
