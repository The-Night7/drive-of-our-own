// public/index.json stores each folder path once in `folders` and fics point at
// it with `d` — much smaller than repeating the path on every fic.
// In the scripts we work with the flat shape: { t, s, p, fo, fl: [[format, fileId]], a?, m }.

import { fileIdFromUrl, folderIdFromUrl } from './drive.mjs';

export function compact(fics) {
  const folders = [];
  const byId = new Map();
  const out = fics.map((f) => {
    let k = byId.get(f.fo);
    if (k === undefined) {
      k = folders.length;
      byId.set(f.fo, k);
      folders.push([f.s, f.fo, f.p]);
    }
    const { fo, p, s, ...rest } = f;
    return { ...rest, d: k };
  });
  return { folders, fics: out };
}

export function expand(index) {
  return index.fics.map((raw) => {
    let f = raw;
    if (index.folders) {
      const { d, ...rest } = raw;
      const dir = index.folders[d];
      f = Array.isArray(dir) ? { ...rest, s: dir[0], fo: dir[1], p: dir[2] } : { ...rest, s: dir.s, fo: dir.id, p: dir.p };
    }
    // Older index files stored full URLs.
    if (typeof f.fo === 'string' && f.fo.includes('/')) f = { ...f, fo: folderIdFromUrl(f.fo) };
    if (f.fl?.length && !Array.isArray(f.fl[0])) f = { ...f, fl: f.fl.map((x) => [x.f, fileIdFromUrl(x.u) || x.u]) };
    return f;
  });
}
