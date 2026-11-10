#!/usr/bin/env node
/*
 * wasmcart-art - copy carts' launcher art (SPEC: manifest `art`) to where a
 * frontend looks for it.
 *
 *   wasmcart art <cart.wasc | cart-dir | dir of .wasc> [...] --esde <media dir>
 *   wasmcart art <carts...> --libretro <thumbnails dir>
 *   wasmcart art <carts...> --out <dir>
 *
 * --esde writes ES-DE's media folders: covers/ screenshots/ titlescreens/
 *   marquees/ fanart/, each <cart name>.png|.jpg. Point it at the system's
 *   folder (e.g. .../ES-DE/downloaded_media/wasmcart).
 * --libretro writes RetroArch's thumbnail folders: Named_Boxarts/ Named_Snaps/
 *   Named_Titles/, each <cart name>.png. Point it at the playlist's folder
 *   (e.g. .../thumbnails/<playlist name>). Thumbnails must be PNG, and a JPEG
 *   picture is not converted: it is named in the cart's line and skipped.
 * --out writes every picture to <dir>/<cart name>/ (icon, cover, background,
 *   logo, title, screenshot-N) with an art.json carrying the screenshot labels,
 *   a folder `wasmcart-pack --art` packs back as it was.
 *
 * The cart name is the file name without .wasc, what both frontends match on.
 * An existing file is kept unless --force. One line per cart: what it wrote,
 * what it kept, or that it has no art (not an error).
 */

import { resolve } from 'path';
import { openCart, listCarts, cartName, exportArt } from '../src/artExport.js';

const args = process.argv.slice(2);
const targets = [];
const carts = [];
let force = false;
let bad = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--esde' || a === '--libretro' || a === '--out' || a === '-o') {
    const dir = args[++i];
    if (!dir) bad = `${a} needs a directory`;
    else targets.push({ target: a === '--esde' ? 'esde' : a === '--libretro' ? 'libretro' : 'out', dir: resolve(dir) });
  } else if (a === '--force' || a === '-f') force = true;
  else if (a === '-h' || a === '--help') bad = '';
  else if (a.startsWith('-')) bad = `unknown option ${a}`;
  else carts.push(a);
}
if (bad !== null || !carts.length || !targets.length) {
  if (bad) console.error(`wasmcart art: ${bad}`);
  console.log('Usage: wasmcart art <cart.wasc | cart-dir | dir of .wasc> [...] <target> [--force]');
  console.log('  Copies the art carts carry (manifest `art`) to where a frontend looks for it.');
  console.log('  --esde <media dir>        ES-DE: covers/ screenshots/ titlescreens/ marquees/ fanart/');
  console.log('  --libretro <thumb dir>    RetroArch: Named_Boxarts/ Named_Snaps/ Named_Titles/ (PNG only;');
  console.log('                            JPEG pictures are skipped, not converted)');
  console.log('  --out <dir>               every picture, to <dir>/<cart>/ with an art.json');
  console.log('  --force                   overwrite files already there (kept by default)');
  process.exit(bad === '' ? 0 : 1);
}

let failed = false;
const list = [];
for (const c of carts) {
  try {
    list.push(...listCarts(resolve(c)));
  } catch (e) {
    console.error(`${c}: ${e.code === 'ENOENT' ? 'not found' : e.message}`);
    failed = true;
  }
}

for (const path of list) {
  const name = cartName(path);
  let cart;
  try {
    cart = await openCart(path);
  } catch (e) {
    console.log(`${name}: error: cannot read the cart (${e.message})`);
    failed = true;
    continue;
  }
  try {
    const parts = [];
    let noArt = false;
    for (const { target, dir } of targets) {
      const r = await exportArt(cart, target, dir, name, { force });
      if (r.noArt) { noArt = true; break; }
      const bits = [];
      if (r.written.length) bits.push(`wrote ${r.written.length}`);
      if (r.skipped.length) bits.push(`kept ${r.skipped.length} already there`);
      if (!r.written.length && !r.skipped.length) bits.push('nothing to write');
      parts.push(`${target}: ${bits.join(', ')}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
    }
    console.log(noArt ? `${name}: no art` : `${name}: ${parts.join('; ')}`);
  } catch (e) {
    console.log(`${name}: error: ${e.message}`);
    failed = true;
  } finally {
    cart.close();
  }
}
process.exit(failed ? 1 : 0);
