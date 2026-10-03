/*
 * CartHostWeb in a REAL browser, via Playwright.
 *
 * The node suite covers CartHost.js. CartHostWeb.js was only ever exercised
 * under node, which is not the environment it ships into: its WebSocket, its
 * WebGL2 and its Gamepad API are the browser's implementations, not node's
 * lookalikes. That distinction is not academic -- node's WebSocket works
 * standalone and is inert inside libnode, so "same API name" has already
 * proven not to mean "same behaviour" once in this codebase.
 *
 * Runs against the same test/wsserver.mjs the node peer tests use, so a
 * difference between hosts is a real difference and not a difference of
 * fixture.
 *
 * Usage:
 *   node test/browser.test.mjs            # starts its own ws server
 *   node test/browser.test.mjs --headed   # watch it
 *
 * Skips cleanly (exit 0) if Playwright or Chromium is not installed, so it
 * never turns a machine without browsers into a red suite.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WS_PORT = 8794;
const HTTP_PORT = 8795;

// Skipping keeps a machine without browsers from going red, but in CI a skip
// is indistinguishable from a pass -- which is exactly how a suite rots. CI
// sets REQUIRE_BROWSER=1 so a missing browser is a failure there.
//
// Probe the BROWSER BINARY, not the playwright package: `playwright` is a
// devDependency, so after `npm ci` the import succeeds on a machine that has
// never run `npx playwright install` and cannot launch anything.
const required = process.env.REQUIRE_BROWSER === '1';
let chromium;
try {
  const pw = await import('playwright');
  const exe = pw.chromium.executablePath();
  if (!exe || !existsSync(exe)) {
    throw new Error(`no chromium binary at ${exe || '(unknown path)'} - run: npx playwright install chromium`);
  }
  chromium = pw.chromium;
} catch (e) {
  if (required) {
    console.error('browser test REQUIRED but no chromium binary is available:', e.message);
    process.exit(1);
  }
  console.log('browser test SKIPPED:', e.message);
  process.exit(0);
}

let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(ok ? `  ok    ${what}` : `*** FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
};

// ─── static server: the page needs real module URLs, not file:// ───────────
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.html': 'text/html', '.wasm': 'application/wasm',
               '.wasc': 'application/octet-stream', '.json': 'application/json' };

// Cart-directory tests (5-7) assert on WHAT was fetched and WHEN, so every
// request is logged, and asset responses are delayed so a lazy load really
// has to suspend instead of racing a cache.
const requests = [];
const DIRCART = '/test/fixtures/dircart/';
// The same directory served with a manifest that carries a `files` list.
const DIRCART_LISTED = '/test/fixtures/dircart-listed/';
const LISTED_MANIFEST = JSON.stringify({
  name: 'dircart-listed',
  files: ['hello.txt', 'data/key.txt', 'data/late.bin'],
});

const http = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  requests.push(path);
  if (path.startsWith(DIRCART_LISTED)) {
    if (path === DIRCART_LISTED + 'manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(LISTED_MANIFEST);
      return;
    }
    path = DIRCART + path.slice(DIRCART_LISTED.length);
  }
  if (path.startsWith(DIRCART + 'assets/')) await new Promise((r) => setTimeout(r, 40));
  const file = join(ROOT, path === '/' ? 'test/browser-fixture.html' : path);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    // CartHostWeb may use SharedArrayBuffer for threaded carts; these headers
    // are what a real deployment needs, so test with them present.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  res.end(readFileSync(file));
});
await new Promise((r) => http.listen(HTTP_PORT, '127.0.0.1', r));

const ws = spawn('node', [join(HERE, 'wsserver.mjs'), '--port', String(WS_PORT)],
                 { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
page.on('pageerror', (e) => { console.log('  [page throw]', e.message); failures++; });

await page.goto(`http://127.0.0.1:${HTTP_PORT}/`);

// ─── 1. a cart loads and renders in a real browser ────────────────────────
const basic = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const bytes = new Uint8Array(await (await fetch('/test/fixtures/hello.wasc')).arrayBuffer());
  const host = new CartHostWeb();
  await host.load(bytes, {});
  const f = host.runFrame([{ connected: true, buttons: 0 }]);
  const out = { w: f.width, h: f.height, bytes: f.framebuffer.length };
  host.destroy();
  return out;
});
check('cart loads and renders', basic, { w: 320, h: 240, bytes: 320 * 240 * 4 });

// ─── 2. standardized Wasm EH, through wasi-sdk's native SjLj ──────────────
const sjlj = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const bytes = new Uint8Array(await (await fetch('/test/fixtures/sjlj.wasc')).arrayBuffer());
  const host = new CartHostWeb();
  await host.load(bytes, {});
  const result = host.instance.exports.wc_sjlj_result();
  host.runFrame([]);
  host.destroy();
  return result;
});
check('native WebAssembly setjmp/longjmp', sjlj, 42);

// ─── 3. the BROWSER's WebSocket, through the peer ABI ─────────────────────
// This is the point of the whole file: node's WebSocket and the browser's are
// different implementations behind one name.
const peer = await page.evaluate(async (wsPort) => {
  const { CartHostWeb } = await import('/web.js');
  const bytes = new Uint8Array(await (await fetch('/test/fixtures/peernet_net.wasc')).arrayBuffer());
  const host = new CartHostWeb();
  await host.load(bytes, {});
  const ex = host.instance.exports;
  const enc = new TextEncoder();

  const scratch = ex.t_scratch();
  const addr = enc.encode(`ws://127.0.0.1:${wsPort}/echo`);
  host._u8.set(addr, scratch);
  const id = ex.t_open(scratch, addr.length);

  const pump = async (n, until) => {
    for (let i = 0; i < n; i++) {
      host.runFrame([{ connected: true, buttons: 0 }]);
      if (until && until()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await pump(80, () => ex.t_connects() > 0);

  const msg = enc.encode('hello-from-browser');
  host._u8.set(msg, scratch);
  ex.t_send(id, scratch, msg.length);
  await pump(80, () => ex.t_messages() > 0);

  const out = { id, connects: ex.t_connects(), messages: ex.t_messages(),
                echoed: ex.t_last_msg_len() };
  host.destroy();
  return out;
}, WS_PORT);
check('peer open returns an id', peer.id >= 0, true);
check('browser WebSocket connects', peer.connects, 1);
check('message round-trips', peer.messages, 1);
check('echoed byte count', peer.echoed, 'hello-from-browser'.length);

// ─── 4. the allowlist still refuses, against a REACHABLE server ───────────
// The server is provably up -- test 3 just used it -- so a refusal here is the
// gate doing its job rather than a dead port.
const denied = await page.evaluate(async (wsPort) => {
  const { CartHostWeb } = await import('/web.js');
  const bytes = new Uint8Array(await (await fetch('/test/fixtures/peernet.wasc')).arrayBuffer());
  const host = new CartHostWeb();
  await host.load(bytes, {});           // no net grant in this manifest
  const ex = host.instance.exports;
  const enc = new TextEncoder();
  const scratch = ex.t_scratch();
  const addr = enc.encode(`ws://127.0.0.1:${wsPort}/echo`);
  host._u8.set(addr, scratch);
  const id = ex.t_open(scratch, addr.length);
  host.destroy();
  return id;
}, WS_PORT);
check('ungranted cart refused (-1)', denied, -1);

// ─── 5. a cart DIRECTORY, assets fetched on demand through JSPI ───────────
// dircart has no manifest.json (optional) and no `files` list. Read back what
// the CART saw (its results struct) and which files the host fetched when.
const readResults = () => page.evaluate(() => {
  const h = window.__dirHost;
  const p = h.instance.exports.dc_results();
  const v = new Int32Array(h.memory.buffer, p, 10);
  const str = (ptr) => {
    const u8 = new Uint8Array(h.memory.buffer);
    let end = ptr; while (u8[end]) end++;
    return new TextDecoder().decode(u8.subarray(ptr, end));
  };
  return {
    init_size: v[0], init_loaded: v[1], missing_size: v[2], list_size: v[3],
    list_loaded: v[4], late_loaded: v[5], late_frame: v[6], key_loaded: v[7],
    frames: v[8], late_sum: v[9] >>> 0,
    hello: str(h.instance.exports.dc_hello()), key: str(h.instance.exports.dc_key()),
  };
});
const fetchedAssets = () => requests.filter((p) => p.includes('/assets/'))
  .map((p) => p.split('/assets/')[1]);

const jspi = await page.evaluate(() => typeof WebAssembly.Suspending === 'function');
check('this Chromium has JSPI', jspi, true);

requests.length = 0;
const loaded = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const host = new CartHostWeb();
  window.__dirHost = host;
  await host.load('/test/fixtures/dircart/', {});
  return { lazy: host._lazy, info: host.getInfo().width };
});
check('directory cart loads lazily', loaded, { lazy: true, info: 64 });
let r = await readResults();
check('wc_init: size of an asset fetched on demand', r.init_size, 22);
check('wc_init: asset bytes arrive', [r.init_loaded, r.hello], [22, 'hello from a directory']);
check('missing asset is -1', r.missing_size, -1);
check('no files list: _filelist.txt is missing', [r.list_size, r.list_loaded], [-1, -1]);
check('only what init asked for was fetched', fetchedAssets(), ['hello.txt', 'nope.txt']);

const frames = await page.evaluate(async () => {
  const h = window.__dirHost;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const f = await h.runFrame([]);
    out.push(f.framebuffer[1]);   // green channel of pixel 0 (XRGB bytes: B,G,R,X)
  }
  return out;
});
r = await readResults();
check('frame 3 suspended mid-render and finished it', [r.late_loaded, r.late_frame, r.late_sum], [3000, 3, 382428]);
check('pixels written after the fetch (red, red, green, green)', frames, [0, 0, 255, 255]);
check('late.bin fetched only when the frame needed it', fetchedAssets().slice(2), ['data/late.bin']);

// A keyboard callback that loads an asset is entered through JSPI too.
await page.evaluate(async () => {
  const h = window.__dirHost;
  h.keyDown(4, 0);
  await h.runFrame([]);
  h.keyUp(4, 0);
});
r = await readResults();
check('asset loaded inside wc_kb_on_down', [r.key_loaded, r.key], [9, 'key asset']);

// Overlapping runFrame calls share one frame instead of re-entering the cart.
const overlap = await page.evaluate(async () => {
  const h = window.__dirHost;
  const before = h.instance.exports.dc_results();
  const v = () => new Int32Array(h.memory.buffer, before, 10)[8];
  const n0 = v();
  const a = h.runFrame([]);
  const b = h.runFrame([]);
  await Promise.all([a, b]);
  return { same: a === b, ran: v() - n0 };
});
check('a second runFrame during a frame does not re-enter', overlap, { same: true, ran: 1 });
await page.evaluate(() => { window.__dirHost.destroy(); window.__dirHost = null; });

// ─── 6. the optional manifest `files` list feeds _filelist.txt ────────────
requests.length = 0;
await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const host = new CartHostWeb();
  window.__dirHost = host;
  await host.load('/test/fixtures/dircart-listed/', {});
});
r = await readResults();
const list = await page.evaluate(() => {
  const h = window.__dirHost;
  const u8 = new Uint8Array(h.memory.buffer);
  let p = h.instance.exports.dc_list(), e = p; while (u8[e]) e++;
  return new TextDecoder().decode(u8.subarray(p, e));
});
check('files list served as _filelist.txt', [r.list_size, list],
      [list.length, 'hello.txt\ndata/key.txt\ndata/late.bin']);
check('missing asset still -1', r.missing_size, -1);
check('with a list, an unlisted path is answered locally (no request)', fetchedAssets(), ['hello.txt']);
await page.evaluate(() => { window.__dirHost.destroy(); window.__dirHost = null; });

// ─── 7. without JSPI: prefetch the files list, or refuse with a reason ────
requests.length = 0;
const noJspi = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const saved = WebAssembly.Suspending;
  delete WebAssembly.Suspending;
  try {
    const listed = new CartHostWeb();
    await listed.load('/test/fixtures/dircart-listed/', {});
    window.__dirHost = listed;
    const f1 = listed.runFrame([]);    // synchronous again: no promise
    const sync = !(f1 instanceof Promise);
    listed.runFrame([]); listed.runFrame([]);
    let refused = null;
    try {
      await new CartHostWeb().load('/test/fixtures/dircart/', {});
    } catch (e) { refused = e.message; }
    return { lazy: listed._lazy, sync, refused };
  } finally {
    WebAssembly.Suspending = saved;
  }
});
r = await readResults();
check('no JSPI + files: prefetched, runs synchronously', [noJspi.lazy, noJspi.sync], [false, true]);
check('no JSPI + files: every listed file fetched before start',
      fetchedAssets().sort(), ['data/key.txt', 'data/late.bin', 'hello.txt']);
check('no JSPI + files: assets load from the prefetch', [r.init_loaded, r.late_loaded, r.late_sum], [22, 3000, 382428]);
check('no JSPI, no files: refused with the reason', /no WebAssembly JSPI/.test(noJspi.refused ?? ''), true);
await page.evaluate(() => { window.__dirHost.destroy(); window.__dirHost = null; });

await browser.close();
ws.kill();
http.close();

console.log(failures ? `\nFAILED (${failures})` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
