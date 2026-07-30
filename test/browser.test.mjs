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
// sets REQUIRE_BROWSER=1 so a missing Playwright is a failure there.
const required = process.env.REQUIRE_BROWSER === '1';
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  if (required) {
    console.error('browser test REQUIRED but playwright is not installed:', e.message);
    process.exit(1);
  }
  console.log('browser test SKIPPED: playwright not installed');
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

const http = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
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

await browser.close();
ws.kill();
http.close();

console.log(failures ? `\nFAILED (${failures})` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
