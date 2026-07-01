// wasmcart-pack round-trip - pack a cart.wasm into a .wasc, then load the result
// with CartHost. Proves the authoring tool produces carts the reference host runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
