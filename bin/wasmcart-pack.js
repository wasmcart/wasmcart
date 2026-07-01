#!/usr/bin/env node

/**
 * wasmcart-pack - Package a .wasm cart + assets into a .wasc archive
 *
 * Usage:
 *   wasmcart-pack --wasm build/cart.wasm --assets assets/ --output game.wasc
 *   wasmcart-pack --wasm build/cart.wasm --output game.wasc  (no assets)
 *   wasmcart-pack --wasm build/cart.wasm --assets assets/ --name "My Game" --version "1.0.0" --output game.wasc
 */

import { createWriteStream, readFileSync, statSync, readdirSync } from 'fs';
import { resolve, relative, join, basename, extname } from 'path';
import { ZipFile } from 'yazl';

// Parse arguments
const args = process.argv.slice(2);
let wasmPath = null;
let assetsDir = null;
let outputPath = null;
let gameName = null;
let gameVersion = '1.0.0';
let players = null;
let netWebsocket = null;  // array of domain strings
let netDataChannel = false;
let usePointer = false;
let useKeyboard = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--wasm':
      wasmPath = resolve(args[++i]);
      break;
    case '--assets':
      assetsDir = resolve(args[++i]);
      break;
    case '--output':
    case '-o':
      outputPath = resolve(args[++i]);
      break;
    case '--name':
      gameName = args[++i];
      break;
    case '--version':
      gameVersion = args[++i];
      break;
    case '--players':
      players = parseInt(args[++i], 10);
      break;
    case '--ws':
    case '--websocket':
      if (!netWebsocket) netWebsocket = [];
      netWebsocket.push(args[++i]);
      break;
    case '--data-channel':
      netDataChannel = true;
      break;
    case '--pointer':
      usePointer = true;
      break;
    case '--keyboard':
      useKeyboard = true;
      break;
    case '--help':
    case '-h':
      printUsage();
      process.exit(0);
      break;
    default:
      if (!args[i].startsWith('-')) {
        // Positional: treat as wasm path if not set, else output
        if (!wasmPath) wasmPath = resolve(args[i]);
        else if (!outputPath) outputPath = resolve(args[i]);
      }
      break;
  }
}

if (!wasmPath) {
  console.error('Error: --wasm <path> is required');
  printUsage();
  process.exit(1);
}

if (!outputPath) {
  // Default: same name as wasm but with .wasc extension
  outputPath = resolve(basename(wasmPath, extname(wasmPath)) + '.wasc');
}

if (!gameName) {
  gameName = basename(wasmPath, extname(wasmPath));
}

// Validate wasm file exists
try {
  statSync(wasmPath);
} catch {
  console.error(`Error: WASM file not found: ${wasmPath}`);
  process.exit(1);
}

// Validate new fields
if (players !== null) {
  if (!Number.isInteger(players) || players < 1 || players > 4) {
    console.error('Error: --players must be an integer between 1 and 4');
    process.exit(1);
  }
}

if (netWebsocket) {
  for (const domain of netWebsocket) {
    if (!domain || domain.includes('/') || domain.includes(':') || domain.startsWith('.')) {
      console.error(`Error: invalid WebSocket domain: "${domain}" (must be a bare domain name)`);
      process.exit(1);
    }
  }
}

// Build manifest
const manifest = {
  name: gameName,
  version: gameVersion,
  abi: 3,
  entry: 'cart.wasm',
};

if (players !== null && players > 1) {
  manifest.players = players;
}

if (usePointer) {
  manifest.pointer = true;
}

if (useKeyboard) {
  manifest.keyboard = true;
}

if (netWebsocket || netDataChannel) {
  manifest.net = {};
  if (netWebsocket) manifest.net.websocket = netWebsocket;
  if (netDataChannel) manifest.net['data-channel'] = true;
}

if (assetsDir) {
  manifest.assets = 'assets/';
}

// Collect asset files
function walkDir(dir, base) {
  const files = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = join(dir, entry);
    const relPath = join(base, entry);

    try {
      const s = statSync(fullPath);
      if (s.isDirectory()) {
        files.push(...walkDir(fullPath, relPath));
      } else if (s.isFile()) {
        files.push({ fullPath, relPath: relPath.replace(/\\/g, '/') });
      }
    } catch {
      // Skip inaccessible files
    }
  }

  return files;
}

// Create ZIP
const zipfile = new ZipFile();

// Add manifest.json
const manifestJson = JSON.stringify(manifest, null, 2);
zipfile.addBuffer(Buffer.from(manifestJson), 'manifest.json');

// Add cart.wasm (store without compression - wasm is already compact)
zipfile.addFile(wasmPath, 'cart.wasm', { compress: false });

// Add asset files
let assetCount = 0;
let assetBytes = 0;

if (assetsDir) {
  try {
    statSync(assetsDir);
  } catch {
    console.error(`Error: Assets directory not found: ${assetsDir}`);
    process.exit(1);
  }

  const assetFiles = walkDir(assetsDir, '');
  for (const { fullPath, relPath } of assetFiles) {
    const zipPath = 'assets/' + relPath;
    zipfile.addFile(fullPath, zipPath);
    const s = statSync(fullPath);
    assetCount++;
    assetBytes += s.size;
  }
}

// Write output
const outputStream = createWriteStream(outputPath);
zipfile.outputStream.pipe(outputStream);

outputStream.on('close', () => {
  const outSize = statSync(outputPath).size;
  const wasmSize = statSync(wasmPath).size;

  console.log(`Created: ${outputPath}`);
  console.log(`  WASM:   ${formatSize(wasmSize)}`);
  if (assetCount > 0) {
    console.log(`  Assets: ${assetCount} files, ${formatSize(assetBytes)} (uncompressed)`);
  }
  console.log(`  Total:  ${formatSize(outSize)}`);
});

zipfile.end();

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function printUsage() {
  console.log(`wasmcart-pack - Package a .wasm cart + assets into a .wasc archive`);
  console.log(``);
  console.log(`Usage: wasmcart-pack --wasm <cart.wasm> [--assets <dir>] --output <game.wasc>`);
  console.log(``);
  console.log(`Options:`);
  console.log(`  --wasm <path>      Path to the compiled cart.wasm file (required)`);
  console.log(`  --assets <dir>     Directory of assets to include`);
  console.log(`  --output, -o       Output .wasc file path (default: <name>.wasc)`);
  console.log(`  --name <name>      Game name for manifest (default: wasm filename)`);
  console.log(`  --version <ver>    Game version for manifest (default: 1.0.0)`);
  console.log(`  --players <n>      Number of local players (1-4, default: 1)`);
  console.log(`  --ws <domain>      Allow WebSocket to domain (repeatable)`);
  console.log(`  --data-channel     Enable data channel (peer-to-peer)`);
  console.log(`  --pointer          Enable pointer input (mouse/touch)`);
  console.log(`  --keyboard         Enable raw keyboard input`);
  console.log(`  -h, --help         Show this help`);
  console.log(``);
  console.log(`The .wasc file is a ZIP archive containing:`);
  console.log(`  manifest.json    Metadata (name, version, ABI, entry point)`);
  console.log(`  cart.wasm        The compiled cart (code only)`);
  console.log(`  assets/          Game assets (textures, levels, audio, etc.)`);
  console.log(``);
  console.log(`Examples:`);
  console.log(`  wasmcart-pack --wasm build/cart.wasm --assets assets/ -o game.wasc`);
  console.log(`  wasmcart-pack --wasm hello.wasm -o hello.wasc`);
}
