// Copy a cart's launcher art (SPEC: manifest `art`) out to where a frontend
// looks for it: ES-DE's media folders, libretro's thumbnail folders, or a
// plain directory that `wasmcart-pack --art` can pack again. Reads only the
// manifest and the art entries of a .wasc, never the cart's code or assets,
// and never looks at which engine made the cart.
import { open as yauzlOpen } from 'yauzl';
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { imageInfo, ART_KEYS } from './cartArt.js';

/**
 * The manifest and a reader for one cart: a .wasc archive, or a cart
 * directory (manifest.json beside the wasm).
 * @param {string} path
 * @returns {Promise<{ manifest: object, read: (p: string) => Promise<Buffer | null>, close: () => void }>}
 */
export async function openCart(path) {
  if (statSync(path).isDirectory()) {
    const mp = join(path, 'manifest.json');
    const manifest = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : {};
    return {
      manifest,
      read: async (p) => {
        try {
          return readFileSync(join(path, p));
        } catch {
          return null;
        }
      },
      close: () => {},
    };
  }
  const zip = await new Promise((res, rej) => yauzlOpen(path, { lazyEntries: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z))));
  const entries = new Map();
  await new Promise((res, rej) => {
    zip.on('entry', (e) => {
      entries.set(e.fileName, e);
      zip.readEntry();
    });
    zip.on('end', res);
    zip.on('error', rej);
    zip.readEntry();
  });
  const read = (p) => {
    const e = entries.get(p);
    if (!e) return Promise.resolve(null);
    return new Promise((res, rej) =>
      zip.openReadStream(e, (err, s) => {
        if (err) return rej(err);
        const chunks = [];
        s.on('data', (c) => chunks.push(c));
        s.on('end', () => res(Buffer.concat(chunks)));
        s.on('error', rej);
      }),
    );
  };
  let manifest = {};
  const mb = await read('manifest.json');
  if (mb) manifest = JSON.parse(mb.toString('utf8'));
  return { manifest, read, close: () => zip.close() };
}

/** The cart files an art argument names: a .wasc, a cart directory, or a directory of .wasc files. */
export function listCarts(arg) {
  if (!statSync(arg).isDirectory()) return [arg];
  if (existsSync(join(arg, 'manifest.json'))) return [arg];
  return readdirSync(arg)
    .filter((n) => /\.wasc$/i.test(n))
    .sort()
    .map((n) => join(arg, n));
}

/** The name frontends look a cart up by: its file name without the extension. */
export const cartName = (path) => basename(path).replace(/\.wasc$/i, '');

// libretro thumbnails replace these characters of the playlist label with _
const libretroName = (name) => name.replace(/[&*/:`<>?\\|"]/g, '_');

const EXT = { png: '.png', jpeg: '.jpg' };

/**
 * Where each picture goes for one target, as { key, src, dest, png }:
 * src is the manifest path, dest is relative to the target directory, png
 * means the target takes only PNG.
 * @param {object} art the manifest's `art`
 * @param {'esde' | 'libretro' | 'out'} target
 * @param {string} name the cart's name
 */
export function artPlan(art, target, name) {
  const shots = Array.isArray(art.screenshots) ? art.screenshots.filter((s) => s && typeof s.path === 'string') : [];
  const str = (k) => (typeof art[k] === 'string' ? art[k] : null);
  const out = [];
  const add = (key, src, dir, file, png = false) => src && out.push({ key, src, dir, file, png });
  if (target === 'esde') {
    add('cover', str('cover'), 'covers', name);
    add('screenshot', shots[0]?.path, 'screenshots', name);
    add('title', str('title'), 'titlescreens', name);
    add('logo', str('logo'), 'marquees', name);
    add('background', str('background'), 'fanart', name);
  } else if (target === 'libretro') {
    const n = libretroName(name);
    add('cover', str('cover'), 'Named_Boxarts', n, true);
    add('screenshot', shots[0]?.path, 'Named_Snaps', n, true);
    add('title', str('title'), 'Named_Titles', n, true);
  } else {
    for (const k of ART_KEYS) add(k, str(k), name, k);
    shots.forEach((s, i) => add('screenshot', s.path, name, `screenshot-${i + 1}`));
  }
  return out;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];

/**
 * Export one cart's art to one target directory.
 * @param {{ manifest: object, read: (p: string) => Promise<Buffer | null> }} cart
 * @param {'esde' | 'libretro' | 'out'} target
 * @param {string} root the target directory
 * @param {string} name the cart's name
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ noArt?: true, written: string[], skipped: string[], notes: string[] }>}
 */
export async function exportArt(cart, target, root, name, { force = false } = {}) {
  const art = cart.manifest && cart.manifest.art;
  const res = { written: [], skipped: [], notes: [] };
  if (!art || typeof art !== 'object') return { ...res, noArt: true };
  const plan = artPlan(art, target, name);
  if (!plan.length) return { ...res, noArt: true };
  const manifestOut = {};
  const jpegs = [];
  for (const p of plan) {
    const b = await cart.read(p.src);
    const info = b && imageInfo(b);
    if (!b) { res.notes.push(`${p.key} ${p.src} is not in the cart`); continue; }
    if (!info) { res.notes.push(`${p.key} ${p.src} is not a PNG or JPEG`); continue; }
    if (p.png && info.type !== 'png') {
      jpegs.push(p.key);
      continue;
    }
    const dir = join(root, p.dir);
    const file = p.file + EXT[info.type];
    const dest = join(dir, file);
    // ES-DE finds a picture by name whatever its extension, so another
    // format already there is that game's picture too
    const others = target === 'esde' ? IMAGE_EXTS.filter((e) => e !== EXT[info.type]).map((e) => join(dir, p.file + e)).filter(existsSync) : [];
    const rel = join(p.dir, file);
    if (target === 'out') {
      if (p.key === 'screenshot') {
        const label = art.screenshots.find((s) => s && s.path === p.src)?.label;
        (manifestOut.screenshots ||= []).push(label ? { path: file, label: String(label) } : { path: file });
      } else manifestOut[p.key] = file;
    }
    if (!force && (existsSync(dest) || others.length)) {
      res.skipped.push(rel);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, b);
    for (const o of others) unlinkSync(o);
    res.written.push(rel);
  }
  if (jpegs.length) res.notes.push(`${jpegs.join(', ')} ${jpegs.length > 1 ? 'are' : 'is'} JPEG; libretro thumbnails must be PNG, not converted`);
  if (target === 'out' && Object.keys(manifestOut).length) {
    // art.json keeps the screenshot labels, so the folder packs back with --art
    const dest = join(root, name, 'art.json');
    if (!force && existsSync(dest)) res.skipped.push(join(name, 'art.json'));
    else {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(dest, JSON.stringify(manifestOut, null, 2) + '\n');
      res.written.push(join(name, 'art.json'));
    }
  }
  return res;
}
