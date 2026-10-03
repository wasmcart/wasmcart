// assetFiles.js - the file list of a cart's asset directory, shared by the node
// host (dev directories), `wasmcart index` and `wasmcart pack --files`, so all
// three agree on what "every asset" means.

import { readdirSync } from 'fs';
import { join } from 'path';

// Same bound as an archive's entry count (MAX_ARCHIVE_ENTRIES in the hosts).
export const MAX_LISTED_FILES = 100000;

/*
 * Every file under `dir`, as forward-slash paths relative to it, so a dev
 * directory produces the same _filelist.txt an archive does. Bounded for the
 * same reason the archive loaders are: a cart asking for the list should not
 * be able to make the host walk an unbounded tree. Symlinked directories are
 * not followed.
 */
export function listDirRelative(dir) {
  const out = [];
  const walk = (abs, rel) => {
    if (out.length >= MAX_LISTED_FILES) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;   // unreadable subtree: the asset calls report per-path anyway
    }
    for (const e of entries) {
      if (out.length >= MAX_LISTED_FILES) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  walk(dir, '');
  return out;
}

/*
 * A manifest's optional `files` list against the directory it describes.
 * `missing`: listed but not on disk. `unlisted`: on disk but not listed.
 */
export function diffFileList(declared, actual) {
  const want = new Set(declared);
  const have = new Set(actual);
  return {
    missing: declared.filter((p) => !have.has(p)),
    unlisted: actual.filter((p) => !want.has(p)),
  };
}
