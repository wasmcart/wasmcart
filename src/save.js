// Save-file handling shared by the players.
//
// Both the windowed and terminal players have to agree on where a cart's save
// lives, or the same cart saves to two different files depending on how it was
// launched. That is the whole reason this is not inlined in either of them.

import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Local carts store saves alongside the cart, with `.sav` appended. A
 * directory-mode cart gets the trailing slash trimmed first so `game/` and
 * `game` do not produce different files. Remote carts use a stable URL hash
 * below the user's data directory.
 */
export function savPathFor(cartPath) {
  try {
    const url = new URL(cartPath);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const stem = basename(url.pathname).replace(/\.wasc$/i, '') || 'cart';
      const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'cart';
      const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 16);
      const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
      return join(dataHome, 'wasmcart', 'saves', `${safeStem}-${hash}.sav`);
    }
  } catch { /* local path */ }
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
      mkdirSync(dirname(savPath), { recursive: true });
      writeFileSync(savPath, sav);
      savedOnce = true;
    } catch { /* save is best-effort; never let it take the process down */ }
  };
}
