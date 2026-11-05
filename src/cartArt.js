// The cart's pictures for launchers (SPEC: manifest `art`): reading a pack
// tool's art directory, and checking each picture's format, shape and size.
// Advisory throughout: only a file that is not a PNG or JPEG is an error.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/** The single-picture keys, in the order a manifest lists them. */
export const ART_KEYS = ['icon', 'cover', 'background', 'logo', 'title'];

// What each key should be (SPEC table): an aspect (width / height, 0 = any),
// and the smallest size that still looks sharp.
const SHAPES = {
  icon: { aspect: 1, minW: 256, minH: 256, what: 'square, at least 256 x 256' },
  cover: { aspect: 2 / 3, minW: 600, minH: 900, what: 'portrait 2:3, at least 600 x 900' },
  background: { aspect: 16 / 9, minW: 1920, minH: 1080, what: '16:9, at least 1920 x 1080' },
  logo: { aspect: 0, minW: 0, minH: 0, what: 'a transparent PNG, wider than tall' },
  title: { aspect: 0, minW: 0, minH: 0, what: '' },
  screenshot: { aspect: 0, minW: 0, minH: 0, what: '' },
};

/**
 * A PNG's or JPEG's format and size from its first bytes; null for anything else.
 * @param {Uint8Array} b
 * @returns {{ type: 'png' | 'jpeg', width: number, height: number, alpha: boolean } | null}
 */
export function imageInfo(b) {
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    // IHDR: width, height, bit depth, colour type (4, 6: alpha; 3 may carry tRNS)
    const colour = b[25];
    return { type: 'png', width: u32(16), height: u32(20), alpha: colour === 4 || colour === 6 || colour === 3 };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // walk the markers to the first start of frame (SOF0..SOF15 but DHT, JPG, DAC)
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null;
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = (b[o + 2] << 8) | b[o + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: 'jpeg', width: (b[o + 7] << 8) | b[o + 8], height: (b[o + 5] << 8) | b[o + 6], alpha: false };
      }
      o += 2 + len;
    }
    return null;
  }
  return null;
}

/** Warnings for one picture against what its key should be ([] when it fits). */
function shapeWarnings(key, path, info) {
  const s = SHAPES[key];
  const out = [];
  if (!s) return out;
  const { width: w, height: h } = info;
  if (s.aspect && Math.abs(w / h - s.aspect) / s.aspect > 0.03) out.push(`art ${key} ${path} is ${w} x ${h}; it should be ${s.what}`);
  else if (w < s.minW || h < s.minH) out.push(`art ${key} ${path} is ${w} x ${h}; it should be ${s.what}`);
  if (key === 'logo' && (info.type !== 'png' || !info.alpha)) out.push(`art logo ${path} has no transparency; a launcher draws it over other art`);
  if (key === 'logo' && w <= h) out.push(`art logo ${path} is ${w} x ${h}; a logo is wider than tall`);
  return out;
}

/** Every file a manifest `art` object names, as [key, path, label]. */
function artEntries(art) {
  const out = [];
  for (const k of ART_KEYS) if (typeof art[k] === 'string') out.push([k, art[k]]);
  if (Array.isArray(art.screenshots)) for (const s of art.screenshots) if (s && typeof s.path === 'string') out.push(['screenshot', s.path]);
  return out;
}

const safePath = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split(/[\\/]/).includes('..');

/**
 * Problems with a manifest's art, each file read through read(path) (null:
 * missing). For a cart that already carries its art (a --source tree, a host
 * checking a .wasc).
 * @param {object} art
 * @param {(path: string) => Uint8Array | null} read
 * @returns {string[]}
 */
export function describeArtProblems(art, read) {
  const out = [];
  if (!art || typeof art !== 'object') return ['art is not an object'];
  for (const [key, path] of artEntries(art)) {
    if (!safePath(path)) { out.push(`art ${key} path "${path}" is not a cart-relative path`); continue; }
    const b = read(path);
    if (!b) { out.push(`art ${key} ${path} is not in the cart`); continue; }
    const info = imageInfo(b);
    if (!info) { out.push(`art ${key} ${path} is not a PNG or JPEG`); continue; }
    out.push(...shapeWarnings(key, path, info));
  }
  return out;
}

const IMAGE = /\.(png|jpe?g)$/i;

/**
 * A pack tool's art directory: art.json naming the files (the manifest's own
 * shape, paths relative to the directory, screenshot labels), or else files
 * named for their key (icon.png, cover.jpg, ...) and screenshot*.png in name
 * order. Throws on a file that is missing or is not a PNG or JPEG.
 * @param {string} dir
 * @returns {{ manifest: object, files: { fullPath: string, zipPath: string }[], warnings: string[] }}
 */
export function readArtDir(dir) {
  if (!statSync(dir).isDirectory()) throw new Error('not a directory');
  const names = readdirSync(dir).filter((n) => !n.startsWith('.'));
  let spec;
  if (names.includes('art.json')) {
    try {
      spec = JSON.parse(readFileSync(join(dir, 'art.json'), 'utf8'));
    } catch (e) {
      throw new Error(`art.json is not valid JSON: ${e.message}`);
    }
  } else {
    spec = {};
    for (const k of ART_KEYS) {
      const f = names.find((n) => IMAGE.test(n) && n.replace(IMAGE, '').toLowerCase() === k);
      if (f) spec[k] = f;
    }
    const shots = names.filter((n) => IMAGE.test(n) && /^screenshot/i.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (shots.length) spec.screenshots = shots.map((path) => ({ path }));
  }
  const warnings = [];
  const known = new Set([...ART_KEYS, 'screenshots']);
  for (const k of Object.keys(spec)) if (!known.has(k)) warnings.push(`art key "${k}" is not one the SPEC defines (hosts will ignore it)`);
  const manifest = {};
  const files = [];
  const add = (key, rel) => {
    if (!safePath(rel)) throw new Error(`${key} path "${rel}" must be relative to the art directory`);
    const fullPath = join(dir, rel);
    let b;
    try {
      b = readFileSync(fullPath);
    } catch {
      throw new Error(`${key} ${rel} not found`);
    }
    const info = imageInfo(b);
    if (!info) throw new Error(`${key} ${rel} is not a PNG or JPEG`);
    warnings.push(...shapeWarnings(key, rel, info));
    const zipPath = 'art/' + rel.replace(/\\/g, '/');
    if (!files.some((f) => f.zipPath === zipPath)) files.push({ fullPath, zipPath });
    return zipPath;
  };
  for (const k of ART_KEYS) if (spec[k] !== undefined) manifest[k] = add(k, spec[k]);
  if (spec.screenshots !== undefined) {
    if (!Array.isArray(spec.screenshots)) throw new Error('screenshots must be an array');
    manifest.screenshots = spec.screenshots.map((s) => {
      const entry = typeof s === 'string' ? { path: s } : s;
      const out = { path: add('screenshot', entry.path) };
      if (entry.label) out.label = String(entry.label);
      return out;
    });
  }
  if (!files.length) warnings.push(`no art found in ${dir} (icon, cover, background, logo, title, screenshot*.png or art.json)`);
  return { manifest, files, warnings };
}
