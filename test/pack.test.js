// wasmcart-pack round-trip - pack a cart.wasm into a .wasc, then load the result
// with CartHost. Proves the authoring tool produces carts the reference host runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { CartHost } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..', 'bin', 'wasmcart-pack.js');
const HELLO_WASC = join(HERE, 'fixtures', 'hello.wasc');

test('pack a cart.wasm into a .wasc that CartHost can load', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-pack-'));
  try {
    // Extract cart.wasm from the fixture .wasc to use as pack input.
    const entries = unzipSync(readFileSync(HELLO_WASC));
    const cartWasm = entries['cart.wasm'];
    assert.ok(cartWasm, '.wasc contains cart.wasm');
    const wasmPath = join(tmp, 'cart.wasm');
    const outPath = join(tmp, 'out.wasc');
    writeFileSync(wasmPath, cartWasm);

    // Pack it.
    execFileSync(process.execPath, [
      PACK, '--wasm', wasmPath, '--output', outPath,
      '--name', 'Test Cart', '--version', '9.9.9',
    ], { stdio: 'pipe' });

    // The packed .wasc must be a valid ZIP with cart.wasm + manifest.json.
    const packed = unzipSync(readFileSync(outPath));
    assert.ok(packed['cart.wasm'], 'packed .wasc has cart.wasm');
    assert.ok(packed['manifest.json'], 'packed .wasc has manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(packed['manifest.json']));
    assert.equal(manifest.name, 'Test Cart');
    assert.equal(manifest.version, '9.9.9');

    // And it must actually run.
    const cart = new CartHost();
    await cart.load(outPath);
    assert.ok(cart.getInfo().width > 0);
    cart.runFrame([]);
    cart.destroy();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--source packs a dev directory, keeping its manifest verbatim', async () => {
  // The flag form generates a manifest, which cannot express a cart whose
  // manifest already says something specific (a custom `assets` root, a
  // `pointer`/`debug` declaration, a field this CLI has no flag for). A dev
  // directory is the tree `npx wasmcart <dir>` runs, so it should pack as-is.
  const tmp = mkdtempSync(join(tmpdir(), 'wc-src-'));
  try {
    const files = unzipSync(new Uint8Array(readFileSync(HELLO_WASC)));
    const wasm = files['cart.wasm'];
    const dir = join(tmp, 'game');
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'main.wasm'), Buffer.from(wasm));
    writeFileSync(join(dir, 'app', 'note.txt'), 'hello');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      name: 'devdir', version: '2.0.0', abi: 3,
      entry: 'main.wasm', assets: 'app/', pointer: true,
    }));

    const out = join(tmp, 'out.wasc');
    execFileSync(process.execPath, [PACK, '--source', dir, '--output', out]);

    const packed = unzipSync(new Uint8Array(readFileSync(out)));
    const m = JSON.parse(new TextDecoder().decode(packed['manifest.json']));
    assert.equal(m.version, '2.0.0', 'version kept');
    assert.equal(m.assets, 'app/', 'assets root kept');
    assert.equal(m.pointer, true, 'flagless field kept');
    assert.equal(m.entry, 'cart.wasm', 'entry renamed to the archive name');
    assert.ok(packed['app/note.txt'], 'assets keep their original paths');
    assert.ok(!packed['main.wasm'], 'the entry wasm is not duplicated');

    const host = new CartHost();
    await host.load(out, {});
    host.destroy();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an assets root without a trailing slash still resolves', async () => {
  // The prefix is stripped as a PATH PREFIX, so "app" turns "app/x" into
  // "/x" and every lookup misses -- while dev mode joins the same field as a
  // directory and works. A cart authored from a dev directory therefore
  // booted fine and failed the moment it was packed. Normalized in the host.
  const tmp = mkdtempSync(join(tmpdir(), 'wc-slash-'));
  try {
    const files = unzipSync(new Uint8Array(readFileSync(HELLO_WASC)));
    const dir = join(tmp, 'game');
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'main.wasm'), Buffer.from(files['cart.wasm']));
    writeFileSync(join(dir, 'app', 'note.txt'), 'hello');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      name: 'noslash', version: '1.0.0', abi: 3,
      entry: 'main.wasm', assets: 'app',      // <- no trailing slash
    }));

    const out = join(tmp, 'out.wasc');
    execFileSync(process.execPath, [PACK, '--source', dir, '--output', out]);

    const host = new CartHost();
    await host.load(out, {});
    // The cart asks for "note.txt"; the archive stores "app/note.txt". If the
    // prefix keeps its slash the index holds the stripped name, and if it does
    // not the index holds "/note.txt" and the lookup misses. Asserting the
    // LOAD alone proves nothing -- the fixture has no assets at all, so it
    // loads either way. (That is exactly how the first version of this test
    // passed against a deliberately reverted fix.)
    assert.ok(host._assetIndex.has('note.txt'),
      `asset prefix not stripped: index has ${[...host._assetIndex.keys()].join(', ')}`);
    host.destroy();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
