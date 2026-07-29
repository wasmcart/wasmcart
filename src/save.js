// Save-file handling shared by the players.
//
// Both the windowed and terminal players have to agree on where a cart's save
// lives, or the same cart saves to two different files depending on how it was
// launched. That is the whole reason this is not inlined in either of them.

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';

/**
 * Where a cart's save file lives: alongside the cart, with `.sav` appended.
 * A directory-mode cart (unpacked assets) gets the trailing slash trimmed
 * first so `game/` and `game` do not produce different files.
 */
export function savPathFor(cartPath) {
  try {
    return statSync(cartPath).isDirectory()
      ? cartPath.replace(/\/+$/, '') + '.sav'
      : cartPath + '.sav';
  } catch {
    return cartPath + '.sav';
  }
}

/** Read an existing save, or undefined on first run. */
export function loadSave(savPath) {
  try {
    return new Uint8Array(readFileSync(savPath));
  } catch {
    return undefined; // first run, or unreadable — the cart starts fresh
  }
}

/**
 * Create a save-writer bound to one host and path.
 *
 * The returned function is safe to call from any exit path, including twice.
 *
 * The all-zero check is deliberately only a FIRST-write guard. A cart that has
 * never saved leaves its region zeroed, and writing that would litter a `.sav`
 * next to every cart merely for running it. But once a file exists we always
 * overwrite, because by then all-zero is a legitimate state (the player cleared
 * their data) and skipping it would silently resurrect the previous save.
 */
export function makeSaver(host, savPath) {
  let savedOnce = existsSync(savPath);
  return function persistSave() {
    try {
      const sav = host.getSaveData();
      if (!sav) return; // cart declares no save region
      if (!savedOnce && !sav.some((b) => b !== 0)) return;
      writeFileSync(savPath, sav);
      savedOnce = true;
    } catch { /* save is best-effort; never let it take the process down */ }
  };
}
