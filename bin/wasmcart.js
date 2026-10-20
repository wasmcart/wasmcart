#!/usr/bin/env node
/*
 * wasmcart - the package's front door. `npx wasmcart game.wasc` just plays.
 *
 *   wasmcart <cart.wasc | cart-dir | URL> [options]    run it (default)
 *   wasmcart play <cart> [options]                     same, explicit
 *   wasmcart pack --wasm cart.wasm [options]           package a .wasc
 *   wasmcart index <cart-dir> [--check|--remove]       write manifest `files`
 *   wasmcart test [options]                            play the test cart (testcart/)
 *
 * Player options and keys: see `wasmcart play --help` (bin/wasmcart-play.js).
 */

const sub = process.argv[2];

if (sub === 'pack') {
  process.argv.splice(2, 1); // wasmcart-pack parses argv from index 2
  await import('./wasmcart-pack.js');
} else if (sub === 'index') {
  process.argv.splice(2, 1);
  await import('./wasmcart-index.js');
} else if (sub === 'test') {
  // the host test cart: pads, touch, keyboard, sound and saves on one screen
  const { fileURLToPath } = await import('node:url');
  process.argv[2] = fileURLToPath(new URL('../testcart/testcart.wasc', import.meta.url));
  await import('./wasmcart-play.js');
} else if (sub === 'play') {
  process.argv.splice(2, 1);
  await import('./wasmcart-play.js');
} else if (sub === '-h' || sub === '--help' || sub === undefined) {
  console.log('Usage: wasmcart <cart.wasc | cart-dir | https://.../cart.wasc> [options]');
  console.log('       wasmcart pack --wasm cart.wasm');
  console.log('       wasmcart index <cart-dir>   (list assets for web hosts)');
  console.log('       wasmcart test               (the test cart: pads, touch, sound, saves)');
  console.log('Player options: --term, --window, --gl, --zoom n, --width px, --height px,');
  console.log('  --no-resize, --stretch, --fullscreen (-f), --frames n, --shot out.png,');
  console.log('  --wav out.wav, --seed n, --scale cols, --fps n   (details: wasmcart play --help)');
} else {
  await import('./wasmcart-play.js'); // bare cart path → play
}
