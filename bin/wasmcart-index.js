#!/usr/bin/env node
/*
 * wasmcart-index - write a cart directory's optional manifest `files` list.
 *
 *   wasmcart index <cart-dir>            write/refresh manifest.json `files`
 *   wasmcart index <cart-dir> --check    exit 1 if `files` is missing or stale
 *   wasmcart index <cart-dir> --remove   drop `files` from the manifest
 *
 * A web host serving a cart DIRECTORY fetches each asset by name, so sizes and
 * loads need no list. The one thing HTTP cannot do is list a directory, and a
 * few carts enumerate their assets through _filelist.txt (a ROM picker, a mod
 * scanner). `files` is that list. It is optional: without it the cart still
 * runs, and only _filelist.txt is missing on the web.
 *
 * The list is every file under the manifest's asset prefix (default assets/),
 * relative to it -- the same walk the node host uses for _filelist.txt, so the
 * two agree.
 */

import { readFileSync, writeFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { listDirRelative, diffFileList } from '../src/assetFiles.js';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help') || !args.some((a) => !a.startsWith('-'))) {
  console.log('Usage: wasmcart index <cart-dir> [--check | --remove]');
  console.log('  Writes the optional manifest.json `files` list a web host serves as');
  console.log('  _filelist.txt for a cart directory (HTTP cannot list directories).');
  console.log('  --check   exit 1 if the list is missing or out of date, change nothing');
  console.log('  --remove  delete the list from the manifest');
  process.exit(args.length ? 0 : 1);
}
const dir = resolve(args.find((a) => !a.startsWith('-')));
const check = args.includes('--check');
const remove = args.includes('--remove');

try {
  if (!statSync(dir).isDirectory()) throw new Error('not a directory');
} catch (e) {
  console.error(`Error: ${dir}: ${e.message}`);
  process.exit(1);
}

// The manifest is optional in a cart, so a directory without one gets a
// minimal one holding just the list (every other field keeps its default).
const manifestPath = join(dir, 'manifest.json');
let manifest = {};
let hadManifest = false;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  hadManifest = true;
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`Error: ${manifestPath} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

if (remove) {
  if (!('files' in manifest)) {
    console.log(`${manifestPath}: no files list`);
    process.exit(0);
  }
  delete manifest.files;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${manifestPath}: removed files list`);
  process.exit(0);
}

const raw = manifest.assets;
const prefix = raw === undefined || raw === null || raw === '' ? 'assets/' : String(raw);
const assetsDir = join(dir, prefix);
const files = listDirRelative(assetsDir).sort();

if (check) {
  if (!Array.isArray(manifest.files)) {
    console.error(`${manifestPath}: no files list (run: wasmcart index ${dir})`);
    process.exit(1);
  }
  const { missing, unlisted } = diffFileList(manifest.files, files);
  if (missing.length || unlisted.length) {
    for (const p of unlisted) console.error(`  not listed: ${p}`);
    for (const p of missing) console.error(`  listed but missing: ${p}`);
    console.error(`${manifestPath}: files list is out of date (run: wasmcart index ${dir})`);
    process.exit(1);
  }
  console.log(`${manifestPath}: files list matches (${files.length} files)`);
  process.exit(0);
}

manifest.files = files;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${hadManifest ? 'Updated' : 'Created'} ${manifestPath}: ${files.length} files under ${prefix}`);
