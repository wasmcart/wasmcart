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

// --enable-unsafe-webgpu: headless Chromium on Linux keeps WebGPU behind it.
// Headless, the adapter it then offers is SwiftShader (CPU), which is what the
// WebGPU checks below run on.
// WASMCART_BROWSER_ARGS adds Chromium flags: on Linux, WebGPU runs on
// SwiftShader (software) unless '--enable-features=Vulkan' is among them.
const browser = await chromium.launch({ headless: !process.argv.includes('--headed'),
  args: ['--enable-unsafe-webgpu', ...(process.env.WASMCART_BROWSER_ARGS || '').split(' ').filter(Boolean)] });
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

// ─── 8. direct present: draw straight into a matching canvas, no blit ─────
// gltri (256x192) paints a red top bar, a green left bar and a white
// top-left square over dark blue, so a flip or a wrong viewport shows. The
// same cart is run three ways: into a canvas that qualifies for direct
// present, into one that does not (wrong size, so the redirect + blit path),
// and into a qualifying canvas with { directPresent: false }. All three must
// read back the same picture.
const direct = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const run = async (w, h, opts) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const gl = canvas.getContext('webgl2', { antialias: false, depth: true, stencil: true, preserveDrawingBuffer: false });
    const host = new CartHostWeb();
    await host.load('/test/fixtures/gltri.wasc', { glBackend: gl, preferredWidth: 256, preferredHeight: 192, ...opts });
    for (let i = 0; i < 3; i++) host.runFrame([]);
    // read the cart-sized frame the way a page would: the default
    // framebuffer, in the same task as the frame (scaled to the canvas)
    const px = (x, y) => {
      const out = new Uint8Array(4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      // cart coords are y-down over 256x192; map into the canvas
      const cx = Math.floor((x + 0.5) * w / 256), cy = h - 1 - Math.floor((y + 0.5) * h / 192);
      gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return Array.from(out.slice(0, 3)).map((v) => (v > 128 ? 1 : 0)).join('');
    };
    const sample = { topBar: px(128, 2), leftBar: px(2, 96), corner: px(48, 48), middle: px(128, 96) };
    const isDirect = host._glFuncs._isDirectPresent();
    host.destroy();
    return { isDirect, sample };
  };
  return {
    match: await run(256, 192, {}),
    mismatch: await run(320, 240, {}),
    optOut: await run(256, 192, { directPresent: false }),
  };
});
check('direct present: a matching canvas draws direct', direct.match.isDirect, true);
check('direct present: a mismatched canvas keeps the redirect', direct.mismatch.isDirect, false);
check('direct present: { directPresent: false } keeps the redirect', direct.optOut.isDirect, false);
check('direct present: picture (red top, green left, white corner)', direct.match.sample,
      { topBar: '100', leftBar: '010', corner: '111', middle: direct.optOut.sample.middle });
check('direct present: same picture as the redirect path', direct.match.sample, direct.optOut.sample);
check('direct present: same picture as a scaled redirect', direct.match.sample, direct.mismatch.sample);

// ─── WebGPU (SPEC.md, "WebGPU") on the browser's own navigator.gpu ────────
// Same fixtures and contract as test/wgpu.test.js on the Node host. Frames
// are read in the SAME task as runFrame: a browser canvas hands out a fresh
// texture once the page composites.
const wgpu = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const px = (f, x, y) => Array.from(f.data.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 4));
  const out = { adapter: !!(navigator.gpu && await navigator.gpu.requestAdapter()) };

  let host = new CartHostWeb();
  await host.load('/test/fixtures/wgpucart.wasc');
  const ex = host.instance.exports;
  out.usesWgpu = host.usesWgpu;
  out.flag = ex.wgpucart_host_flags() & 2;
  for (let i = 0; i < 40 && ex.wgpucart_result() < 0; i++) { host.runFrame([]); await tick(); }
  for (let i = 0; i < 4; i++) { host.runFrame([]); await tick(); }
  out.result = ex.wgpucart_result();
  out.mappedDuringRender = ex.wgpucart_mapped_during_render();
  for (let i = 0; i < 20 && ex.wgpucart_scope_error() < 0; i++) { host.runFrame([]); await tick(); }
  out.scopeError = ex.wgpucart_scope_error();
  out.allocs = { info: ex.t_allocs(1) > 0, mapped: ex.t_allocs(2) > 0, msg: ex.t_allocs(0) > 0, freed: ex.t_frees() >= 2 };
  host.runFrame([]);
  let f = await host.readGpuFrame();
  out.size = [f.width, f.height];
  out.triangle = px(f, 128, 110);
  out.background = px(f, 2, 2);
  host.destroy();

  host = new CartHostWeb();
  await host.load('/test/fixtures/dualgpu.wasc');
  host.runFrame([]);
  f = await host.readGpuFrame();
  out.dualOnWgpu = { uses: host.instance.exports.dualgpu_uses_wgpu(), px: px(f, 64, 48) };
  host.destroy();

  host = new CartHostWeb();
  await host.load('/test/fixtures/dualgpu.wasc', { wgpu: false });
  host.runFrame([]);
  out.dualOnGl = { uses: host.instance.exports.dualgpu_uses_wgpu(), usesGL: host.usesGL };
  host.destroy();

  host = new CartHostWeb();
  await host.load('/test/fixtures/dualgpu_bad.wasc');
  try { host.runFrame([]); out.badDual = 'ran'; } catch (e) { out.badDual = /called glClear, but this host selected WebGPU/.test(e.message); }
  host.destroy();

  // wasi-sdk producer: threads (Web Workers on shared memory) that never call
  // WebGPU, WebGPU on the main thread, and the error message on the cart stack.
  host = new CartHostWeb();
  await host.load('/test/fixtures/wasicart.wasc');
  {
    const w = host.instance.exports;
    for (let i = 0; i < 80 && !(w.wgpucart_result() >= 0 && w.wgpucart_scope_error() >= 0 && w.wasicart_workers_ok()); i++) { host.runFrame([]); await tick(); }
    host.runFrame([]);
    const wf = await host.readGpuFrame();
    out.wasi = { wgpu: host.usesWgpu, threaded: host.isThreaded, result: w.wgpucart_result(), scope: w.wgpucart_scope_error(),
                 msg: w.wasicart_scope_msg_ok(), workers: w.wasicart_workers_ok(), px: px(wf, 128, 110) };
  }
  host.destroy();

  const refusal = async (path, opts) => {
    try { await new CartHostWeb().load(path, opts); return 'loaded'; } catch (e) { return e.message; }
  };
  out.noWgpu = /cannot provide WebGPU: the page disabled it/.test(await refusal('/test/fixtures/wgpucart.wasc', { wgpu: false }));
  out.gpuApi2 = /imports no WebGPU functions/.test(await refusal('/test/fixtures/gpuapi2.wasc'));
  out.gpuApi3 = /gpu_api 3, which this host does not support/.test(await refusal('/test/fixtures/gpuapi3.wasc'));
  out.fake = /does not provide: wgpuDeviceDoesNotExistYet/.test(await refusal('/test/fixtures/wgpufake.wasc'));
  return out;
});
check('webgpu: the browser offers an adapter', wgpu.adapter, true);
check('webgpu: cart runs on WebGPU with the host flag set', [wgpu.usesWgpu, wgpu.flag], [true, 2]);
check('webgpu: compute result arrives between frames', [wgpu.result, wgpu.mappedDuringRender], [42, 0]);
check('webgpu: an error scope catches a validation error', wgpu.scopeError, 2);
check('webgpu: adapter info, the mapped range and the callback message go through wc_alloc/wc_free', wgpu.allocs,
      { info: true, mapped: true, msg: true, freed: true });
check('webgpu: frame size', wgpu.size, [256, 192]);
check('webgpu: triangle pixel', wgpu.triangle, [255, 128, 64, 255]);
check('webgpu: background carries the compute result', wgpu.background, [42, 0, 255, 255]);
check('webgpu: dual cart picks WebGPU', wgpu.dualOnWgpu, { uses: 1, px: [0, 255, 0, 255] });
check('webgpu: dual cart falls back to GL', wgpu.dualOnGl, { uses: 0, usesGL: true });
check('webgpu: dual cart calling the unselected API throws', wgpu.badDual, true);
check('webgpu: WebGPU-only cart refused without WebGPU', wgpu.noWgpu, true);
check('webgpu: gpu_api 2 without WebGPU imports refused', wgpu.gpuApi2, true);
check('webgpu: gpu_api 3 refused', wgpu.gpuApi3, true);
check('webgpu: unknown WebGPU function refused by name', wgpu.fake, true);
check('webgpu: a wasi-sdk threaded cart runs (workers never call WebGPU)', wgpu.wasi,
      { wgpu: true, threaded: true, result: 42, scope: 2, msg: 1, workers: 1, px: [255, 128, 64, 255] });

// ─── Cart memory the host writes (SPEC.md): wc_alloc in CartHostWeb ────────
// Same fixtures as test/cartmem.test.js on the Node host.
const cartmem = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const GL_VERSION = 0x1F02;
  const load = async (name) => { const h = new CartHostWeb(); await h.load(`/test/fixtures/${name}.wasc`); return h; };
  const str = (h, p) => { const u8 = new Uint8Array(h.memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const out = {};
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    let h = await load('alloc_count');
    let ex = h.instance.exports;
    out.glString = /^OpenGL ES/.test(str(h, ex.t_gl_string(GL_VERSION))) && ex.t_allocs(1) === 1;
    const frees = ex.t_frees();
    out.map = ex.t_map(512, 9) % 16 === 0 && ex.t_allocs(2) === 1 && ex.t_frees() === frees + 1;
    ex.t_alloc_mode(1);
    try { ex.t_gl_stringi(0x1F03, 1); out.bounds = 'accepted'; } catch (e) { out.bounds = e.code === 'bounds' && /outside its \d+-byte memory/.test(e.message); }
    h.destroy();

    h = await load('alloc_none');
    ex = h.instance.exports;
    try { for (let i = 0; i < 3; i++) h.runFrame([]); out.noneRuns = true; } catch (e) { out.noneRuns = e.message; }
    try { ex.t_gl_string(GL_VERSION); out.noneError = 'no error'; } catch (e) { out.noneError = e.code === 'missing' && /glGetString must write into the cart's memory/.test(e.message); }
    h.destroy();

    h = await load('alloc_malloc');
    ex = h.instance.exports;
    try { ex.t_gl_string(GL_VERSION); out.malloc = 'no error'; } catch (e) { out.malloc = e.code === 'missing' && /does not export wc_alloc\/wc_free/.test(e.message); }
    h.destroy();
  } finally {
    console.warn = warn;
  }
  out.warnings = warnings.length;
  return out;
});
check('cart memory: GL strings and mappings through wc_alloc, mapping freed at unmap', [cartmem.glString, cartmem.map], [true, true]);
check('cart memory: a bad pointer from wc_alloc is refused', cartmem.bounds, true);
check('cart memory: a cart with no allocator runs while it needs none', cartmem.noneRuns, true);
check('cart memory: ...and gets the clear error when it calls glGetString', cartmem.noneError, true);
check('cart memory: a malloc-only cart gets the same clear error, no fallback, no warning', [cartmem.malloc, cartmem.warnings], [true, 0]);

// ─── WebGPU textures and samplers, the documented example, the tier's edges ──
// (test/wgpu-claim.test.js and test/wgpu-example.test.js on the Node host)
const wgpu2 = await page.evaluate(async () => {
  const { CartHostWeb } = await import('/web.js');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const px = (f, x, y) => Array.from(f.data.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 3));
  // named debug fields (SPEC.md, "Debug state"), read from cart memory
  const field = (host, name) => {
    const ex = host.instance.exports;
    const dv = new DataView((host.memory || ex.memory).buffer);
    const str = (q) => { let s = ''; for (let b; (b = dv.getUint8(q)); q++) s += String.fromCharCode(b); return s; };
    for (let p = ex.wc_debug_state(); ; p += 16) {
      const n = dv.getUint32(p, true);
      if (!n) return undefined;
      if (str(n) !== name) continue;
      const vp = dv.getUint32(p + 4, true), len = dv.getUint32(p + 12, true);
      const vals = Array.from({ length: len }, (_, i) => dv.getUint32(vp + 4 * i, true));
      return len === 1 ? vals[0] : vals;
    }
  };
  const out = { adapter: (await navigator.gpu.requestAdapter())?.info?.description || '' };

  let host = new CartHostWeb();
  await host.load('/test/fixtures/wgputex.wasc');
  for (let i = 0; i < 40 && !field(host, 'tex.done'); i++) { host.runFrame([]); await tick(); }
  host.runFrame([]);
  let f = await host.readGpuFrame();
  out.tex = { done: field(host, 'tex.done'), pass: field(host, 'tex.pass'), errors: field(host, 'tex.errors'), size: [f.width, f.height],
              cells: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((c) => px(f, c * 32 + 16, 16)) };
  host.destroy();

  host = new CartHostWeb();
  await host.load('/examples/webgpu-hello/webgpu-hello.wasc');
  for (let i = 0; i < 10; i++) { host.runFrame([]); await tick(); }
  host.runFrame([]);
  f = await host.readGpuFrame();
  out.hello = { size: [f.width, f.height], px: [[2, 2], [155, 60], [140, 160], [180, 160]].map(([x, y]) => px(f, x, y)) };
  host.destroy();

  host = new CartHostWeb();
  await host.load('/test/fixtures/wgpuedges.wasc');
  for (let i = 0; i < 8; i++) { host.runFrame([]); await tick(); }
  host.runFrame([]); // frame 9, read in the task that drew it
  const g = await host.readGpuFrame();
  for (let i = 0; i < 5; i++) { host.runFrame([]); await tick(); }
  // the uncaptured-error event may take more turns to arrive in a browser
  for (let i = 0; i < 60 && !field(host, 'edge.uncaptured'); i++) { host.runFrame([]); await new Promise((r) => setTimeout(r, 10)); }
  host.runFrame([]);
  f = await host.readGpuFrame();
  out.edges = { adapter: field(host, 'edge.adapter'), device: field(host, 'edge.device'), separate: field(host, 'edge.separate'),
                uncaptured: field(host, 'edge.uncaptured'), lost: field(host, 'edge.lost'), info: [host.getInfo().width, host.getInfo().height],
                before: [g.width, g.height, ...px(g, 4, 4)], after: [f.width, f.height, ...px(f, 4, 4)] };
  host.destroy();

  host = new CartHostWeb();
  await host.load('/test/fixtures/wgpuvram.wasc');
  for (let i = 0; i < 600; i++) { host.runFrame([]); await tick(); }
  out.vram = { frames: field(host, 'vram.frames'), errors: field(host, 'vram.errors') };
  host.destroy();
  return out;
});
console.log(`  (WebGPU adapter: ${wgpu2.adapter || 'unnamed'})`);
check('webgpu textures: every sampler / mip / render-target case matches (the cart\'s own check)',
      [wgpu2.tex.done, wgpu2.tex.pass, wgpu2.tex.errors, wgpu2.tex.size], [1, 0x1ff, 0, [288, 32]]);
{
  const want = [[255, 0, 0], [128, 0, 255], [128, 128, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [20, 200, 40], [200, 20, 180], [51, 102, 204]];
  const tol = [1, 1, 3, 1, 1, 1, 1, 1, 1];
  const bad = wgpu2.tex.cells.map((c, i) => (c.every((v, k) => Math.abs(v - want[i][k]) <= tol[i]) ? null : `cell ${i}: ${c}`)).filter(Boolean);
  check('webgpu textures: the host reads back the same cells', bad, []);
}
check('webgpu example: examples/webgpu-hello draws its textured triangle', wgpu2.hello,
      { size: [320, 240], px: [[26, 26, 38], [255, 0, 0], [0, 0, 255], [255, 255, 255]] });
check('webgpu edges: second device, uncaptured error to its callback, device loss, resize',
      wgpu2.edges, { adapter: 1, device: 1, separate: 1, uncaptured: 1, lost: 2, info: [160, 120], before: [128, 96, 0, 255, 0], after: [160, 120, 0, 0, 255] });
check('webgpu: 600 frames of create / use / release, no errors', wgpu2.vram, { frames: 600, errors: 0 });

await browser.close();
ws.kill();
http.close();

console.log(failures ? `\nFAILED (${failures})` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
