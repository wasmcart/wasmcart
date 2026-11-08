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
    execFileSync(process.execPath, [PACK, '--source', dir, '--output', out], { cwd: tmp });

    const packed = unzipSync(new Uint8Array(readFileSync(out)));
    const m = JSON.parse(new TextDecoder().decode(packed['manifest.json']));
    assert.equal(m.version, '2.0.0', 'outside git, the manifest\'s own version is kept');
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

// ---- the cart's version (src/cartVersion.js) ----
//
// Without --version the version comes from the git checkout the cart is
// packed from, by the same rule as cartwheel's cw_add_app: a clean v<semver>
// tag gives the tag, anything else <last tag>-dev.g<commit>.

function git(dir, ...a) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
}

/** a git repo holding a cart.wasm and a --source tree whose manifest says 1.0.0 */
function cartRepo(tmp) {
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const wasm = unzipSync(new Uint8Array(readFileSync(HELLO_WASC)))['cart.wasm'];
  writeFileSync(join(repo, 'cart.wasm'), Buffer.from(wasm));
  writeFileSync(join(repo, 'src', 'main.wasm'), Buffer.from(wasm));
  writeFileSync(join(repo, 'src', 'manifest.json'), JSON.stringify({ name: 'g', version: '1.0.0', abi: 4, entry: 'main.wasm' }));
  writeFileSync(join(repo, 'notes.txt'), 'a');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

function packVersion(tmp, args) {
  const out = join(tmp, 'v.wasc');
  rmSync(out, { force: true });
  execFileSync(process.execPath, [PACK, ...args, '--output', out], { cwd: tmp, stdio: 'pipe' });
  return JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(out)))['manifest.json'])).version;
}

function packFails(tmp, args) {
  try {
    execFileSync(process.execPath, [PACK, ...args, '--output', join(tmp, 'bad.wasc')], { cwd: tmp, stdio: 'pipe' });
  } catch (e) {
    return String(e.stderr);
  }
  assert.fail(`packed with ${args.join(' ')}; expected it to refuse`);
}

test('no --version: the git rule (untagged, tagged, dirty, past the tag)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-ver-'));
  try {
    const repo = cartRepo(tmp);
    const wasm = join(repo, 'cart.wasm');
    const sha = () => git(repo, 'rev-parse', '--short=7', 'HEAD');

    assert.equal(packVersion(tmp, ['--wasm', wasm]), `0.0.0-dev.g${sha()}`, 'no tag yet');

    git(repo, 'tag', 'v1.4.2');
    assert.equal(packVersion(tmp, ['--wasm', wasm]), '1.4.2', 'clean at the tag');

    git(repo, 'tag', 'release-candidate');            // not v<semver>: ignored
    git(repo, 'tag', 'v1.4');                         // not semver: ignored
    assert.equal(packVersion(tmp, ['--wasm', wasm]), '1.4.2', 'other tags ignored');

    writeFileSync(join(repo, 'untracked.txt'), 'x');  // untracked files do not count
    assert.equal(packVersion(tmp, ['--wasm', wasm]), '1.4.2', 'untracked file ignored');

    writeFileSync(join(repo, 'notes.txt'), 'b');      // a tracked change does
    assert.equal(packVersion(tmp, ['--wasm', wasm]), `1.4.2-dev.g${sha()}`, 'tracked change at the tag');

    git(repo, 'commit', '-q', '-am', 'two');
    assert.equal(packVersion(tmp, ['--wasm', wasm]), `1.4.2-dev.g${sha()}`, 'a commit past the tag');

    assert.equal(packVersion(tmp, ['--wasm', wasm, '--version', '3.0.0-rc.1']), '3.0.0-rc.1', '--version wins');

    // a fork keeps its upstream's higher tags; its builds follow its own,
    // nearer, tag
    git(repo, 'tag', 'v2.1.20221123');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fork');
    git(repo, 'tag', 'v0.1.0');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'three');
    assert.equal(packVersion(tmp, ['--wasm', wasm]), `0.1.0-dev.g${sha()}`, 'the nearest tag, not the highest');
    git(repo, 'tag', 'v0.1');                         // a nearer v-tag that is not semver
    assert.equal(packVersion(tmp, ['--wasm', wasm]), `0.1.0-dev.g${sha()}`, 'a nearer non-semver tag is skipped');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--version-from reads the named checkout, not the wasm\'s', () => {
  // An SDK packs its own runtime wasm with a staging copy of the game, so the
  // wasm's checkout is the SDK's; the game's version is in the game's.
  const tmp = mkdtempSync(join(tmpdir(), 'wc-ver-'));
  try {
    const sdk = cartRepo(tmp);                        // the runtime's checkout, tagged v9.0.0
    git(sdk, 'tag', 'v9.0.0');
    const game = join(tmp, 'game');
    mkdirSync(game);
    writeFileSync(join(game, 'main.lua'), 'x');
    git(game, 'init', '-q');
    git(game, 'add', '.');
    git(game, 'commit', '-q', '-m', 'game');
    git(game, 'tag', 'v1.3.0');
    const wasm = join(sdk, 'cart.wasm');
    assert.equal(packVersion(tmp, ['--wasm', wasm]), '9.0.0', 'without it, the wasm\'s checkout');
    assert.equal(packVersion(tmp, ['--wasm', wasm, '--version-from', game]), '1.3.0', 'the game\'s checkout');
    assert.equal(packVersion(tmp, ['--wasm', wasm, '--version-from', tmp]), '0.1.0', 'not a checkout: the default, never the wasm\'s');
    assert.equal(packVersion(tmp, ['--wasm', wasm, '--version-from', game, '--version', '2.0.0']), '2.0.0', '--version still wins');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no --version outside git: 0.1.0, not the 1.0.0 every cart used to claim', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-ver-'));
  try {
    const wasm = join(tmp, 'cart.wasm');
    writeFileSync(wasm, Buffer.from(unzipSync(new Uint8Array(readFileSync(HELLO_WASC)))['cart.wasm']));
    assert.equal(packVersion(tmp, ['--wasm', wasm]), '0.1.0');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--source: --version wins over the manifest, and git over a placeholder', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-ver-'));
  try {
    const repo = cartRepo(tmp);
    const src = join(repo, 'src');
    git(repo, 'tag', 'v2.3.4');
    // The tree's manifest says 1.0.0; that was copied verbatim, so every
    // build of the tree, release or not, called itself 1.0.0.
    assert.equal(packVersion(tmp, ['--source', src]), '2.3.4', 'git over the manifest');
    assert.equal(packVersion(tmp, ['--source', src, '--version', '5.0.0']), '5.0.0', '--version over both');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a version that is not semver stops the pack', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wc-ver-'));
  try {
    const wasm = join(tmp, 'cart.wasm');
    writeFileSync(wasm, Buffer.from(unzipSync(new Uint8Array(readFileSync(HELLO_WASC)))['cart.wasm']));
    for (const v of ['1.0', 'v1.0.0', '1.0.0-01', 'latest', '']) {
      assert.match(packFails(tmp, ['--wasm', wasm, '--version', v]), /is not semver/, `--version "${v}"`);
    }
    // a --source manifest's own version is checked too (outside git it is the one used)
    const dir = join(tmp, 'game');
    mkdirSync(dir);
    writeFileSync(join(dir, 'cart.wasm'), readFileSync(wasm));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'g', version: '1.0', abi: 4 }));
    assert.match(packFails(tmp, ['--source', dir]), /"1\.0" \(fallback\) is not semver/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
