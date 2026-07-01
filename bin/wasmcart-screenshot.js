#!/usr/bin/env node

/**
 * wasmcart-screenshot - Run a cart for N frames and save a screenshot as PNG
 *
 * Usage:
 *   wasmcart-screenshot <cart.wasc> [--frames N] [--res WxH] [-o output.png]
 *
 * Requires: webgl-node, ImageMagick `convert`
 */

import { resolve, dirname } from 'path';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import CartHost from our own package
const { CartHost } = await import(resolve(__dirname, '..', 'index.js'));

// Parse args
const args = process.argv.slice(2);
let cartPath = null;
let frames = 120;  // ~2 seconds at 60fps - let menu animations settle
let outputPath = '/tmp/wasmcart_screenshot.png';
let prefW = 800, prefH = 600;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--frames':
    case '-n':
      frames = parseInt(args[++i], 10);
      break;
    case '-o':
    case '--output':
      outputPath = resolve(args[++i]);
      break;
    case '--res':
      const parts = args[++i].split('x');
      prefW = parseInt(parts[0], 10);
      prefH = parseInt(parts[1], 10);
      break;
    case '--webgl':
      // Accepted for backward compat but ignored (always WebGL now)
      break;
    case '--help':
    case '-h':
      console.log('Usage: wasmcart-screenshot <cart> [--frames N] [--res WxH] [-o output.png]');
      process.exit(0);
    default:
      if (!args[i].startsWith('-')) cartPath = resolve(args[i]);
      break;
  }
}

if (!cartPath) {
  console.error('Error: provide a cart path (.wasc)');
  process.exit(1);
}

// WebGL backend via webgl-node
let createWebGL2Context;
for (const p of [
  'webgl-node',
  resolve(__dirname, '../../webgl-node/index.mjs'),
]) {
  try {
    const mod = await import(p);
    createWebGL2Context = mod.createWebGL2Context;
    break;
  } catch (e) {}
}
if (!createWebGL2Context) {
  console.error('Error: webgl-node not found');
  process.exit(1);
}

const result = createWebGL2Context(prefW, prefH);
const glBackend = result.gl;

const cartHost = new CartHost();
await cartHost.load(cartPath, { glBackend, preferredWidth: prefW, preferredHeight: prefH });

const w = cartHost.info.width;
const h = cartHost.info.height;

console.log(`Running ${frames} frames at ${w}x${h}...`);

let lastFrame;
for (let i = 0; i < frames; i++) {
  lastFrame = cartHost.runFrame([]);
}

// Determine if this is a 2D framebuffer cart or GL cart
const is2D = cartHost.info.fbPtr !== 0;

const ppmPath = outputPath.replace(/\.png$/, '.ppm');
const header = `P6\n${w} ${h}\n255\n`;
const rgb = Buffer.alloc(w * h * 3);

if (is2D) {
  // 2D cart: read ARGB8888 framebuffer from WASM memory (top-down, no flip needed)
  const fb = lastFrame.framebuffer;
  for (let y = 0; y < h; y++) {
    const srcRow = y * w * 4;
    const dstRow = y * w * 3;
    for (let x = 0; x < w; x++) {
      // ARGB8888: byte order in little-endian memory is B, G, R, A
      rgb[dstRow + x * 3]     = fb[srcRow + x * 4 + 2]; // R
      rgb[dstRow + x * 3 + 1] = fb[srcRow + x * 4 + 1]; // G
      rgb[dstRow + x * 3 + 2] = fb[srcRow + x * 4];     // B
    }
  }
} else {
  // GL cart: read pixels from GPU (bottom-up, flip vertically)
  const GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401;
  const pixels = new Uint8Array(w * h * 4);

  glBackend.finish();
  glBackend.readPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);

  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = y * w * 3;
    for (let x = 0; x < w; x++) {
      rgb[dstRow + x * 3]     = pixels[srcRow + x * 4];     // R
      rgb[dstRow + x * 3 + 1] = pixels[srcRow + x * 4 + 1]; // G
      rgb[dstRow + x * 3 + 2] = pixels[srcRow + x * 4 + 2]; // B
    }
  }
}

writeFileSync(ppmPath, Buffer.concat([Buffer.from(header), rgb]));

// Convert to PNG with ImageMagick
try {
  execSync(`convert "${ppmPath}" "${outputPath}"`, { stdio: 'pipe' });
  execSync(`rm "${ppmPath}"`, { stdio: 'pipe' });
  console.log(`Screenshot saved: ${outputPath}`);
} catch (e) {
  console.log(`PPM saved: ${ppmPath} (install ImageMagick for PNG conversion)`);
}

process.exit(0);
