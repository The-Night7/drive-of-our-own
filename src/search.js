import Fuse from 'fuse.js';

// Lowercase + strip accents/punctuation so "Café_au_lait" matches "cafe au lait".
export const norm = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-–—.,:;!?'"’“”()[\]{}+&/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const FORMAT_RANK = ['pdf', 'gdoc', 'epub', 'docx', 'doc', 'html', 'htm', 'txt', 'rtf', 'odt', 'mobi', 'azw3', 'azw', 'fb2'];

export function prepare(index) {
  const sources = index.sources;
  const fics = index.fics.map((raw, i) => {
    // index.json stores folder paths once in `folders`; fics point at them with `d`.
    const dir = index.folders ? index.folders[raw.d] : null;
    const f = dir ? { ...raw, s: dir.s, p: dir.p, fo: `https://drive.google.com/drive/folders/${dir.id}` } : raw;
    const src = sources[f.s];
    const files = [...f.fl].sort((a, b) => FORMAT_RANK.indexOf(a.f) - FORMAT_RANK.indexOf(b.f));
    return {
      id: i,
      title: f.t,
      path: f.p,
      folderUrl: f.fo,
      files,
      formats: files.map((x) => x.f),
      ao3Id: f.a || null,
      modified: f.m || '',
      sourceId: f.s,
      source: src,
      nTitle: norm(f.t),
      nPath: norm(f.p.join(' ')),
      nSource: norm(`${src?.name || ''} ${src?.credit || ''}`),
    };
  });
  const fuse = new Fuse(fics, {
    keys: [
      { name: 'title', weight: 3 },
      { name: 'path', weight: 1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  return { sources, fics, fuse, generated: index.generated };
}

// Splits a query into terms, keeping "quoted phrases" together.
function terms(query) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(query))) {
    const t = norm(m[1] || m[2]);
    if (t) out.push(t);
  }
  return out;
}

// Every term must appear somewhere (title, folder path, or drive name);
// title hits rank highest. Falls back to fuzzy matching on typos.
export function search(db, query) {
  const ts = terms(query);
  if (!ts.length) return { results: db.fics, fuzzy: false };

  const words = ts.map((t) => new RegExp(`(^| )${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`));
  const scored = [];
  for (const f of db.fics) {
    let score = 0;
    let ok = true;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (f.nTitle.includes(t)) {
        score += 10;
        if (f.nTitle.startsWith(t)) score += 4;
        if (words[i].test(f.nTitle)) score += 3;
      } else if (f.nPath.includes(t)) score += 4;
      else if (f.nSource.includes(t)) score += 2;
      else {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (f.nTitle === ts.join(' ')) score += 20;
      scored.push({ f, score });
    }
  }
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score || a.f.title.localeCompare(b.f.title));
    return { results: scored.map((x) => x.f), fuzzy: false };
  }
  return { results: db.fuse.search(query, { limit: 300 }).map((r) => r.item), fuzzy: true };
}
