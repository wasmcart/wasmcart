#!/usr/bin/env node
/*
 * wasmcart - the package's front door. `npx wasmcart game.wasc` just plays.
 *
 *   wasmcart <cart.wasc | cart-dir> [player options]   run it (default)
 *   wasmcart play <cart> [options]                     same, explicit
 *   wasmcart pack --wasm cart.wasm [options]           package a .wasc
 *
 * Player options and keys: see `wasmcart play --help` (bin/wasmcart-play.js).
 */

const sub = process.argv[2];

if (sub === 'pack') {
  process.argv.splice(2, 1); // wasmcart-pack parses argv from index 2
  await import('./wasmcart-pack.js');
} else if (sub === 'play') {
  process.argv.splice(2, 1);
  await import('./wasmcart-play.js');
} else if (sub === '-h' || sub === '--help' || sub === undefined) {
  console.log('Usage: wasmcart <cart.wasc | cart-dir> [options]   (or: wasmcart pack --wasm cart.wasm)');
  console.log('Player options: --term, --window, --gl, --zoom n, --width px, --height px,');
  console.log('  --no-resize, --stretch, --fullscreen (-f), --frames n, --shot out.png,');
  console.log('  --wav out.wav, --seed n, --scale cols, --fps n   (details: wasmcart play --help)');
} else {
  await import('./wasmcart-play.js'); // bare cart path → play
}
