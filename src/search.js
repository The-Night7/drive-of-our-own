// Client-side search over the column-oriented index built by scripts/build-index.mjs.

// Lowercase + strip accents/punctuation so "Café_au_lait" matches "cafe au lait".
export const norm = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-–—.,:;!?'"’“”()[\]{}+&/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const TAG_TYPES = [
  { code: 'r', label: 'Rating', plural: 'Ratings' },
  { code: 'w', label: 'Archive warning', plural: 'Warnings' },
  { code: 'c', label: 'Category', plural: 'Categories' },
  { code: 'f', label: 'Fandom', plural: 'Fandoms' },
  { code: 'p', label: 'Relationship', plural: 'Relationships' },
  { code: 'h', label: 'Character', plural: 'Characters' },
  { code: 't', label: 'Additional tag', plural: 'Additional tags' },
];

export const FORMAT_BITS = [
  { bit: 1, key: 'pdf', label: 'PDF' },
  { bit: 2, key: 'epub', label: 'EPUB' },
  { bit: 4, key: 'gdoc', label: 'Google Doc' },
  { bit: 8, key: 'kindle', label: 'Kindle (MOBI/AZW3)' },
  { bit: 16, key: 'other', label: 'Other (DOCX, HTML…)' },
];

export const LENGTHS = [
  { key: 'short', label: 'Under 5k words', min: 1, max: 5000 },
  { key: 'medium', label: '5k – 20k', min: 5000, max: 20000 },
  { key: 'long', label: '20k – 80k', min: 20000, max: 80000 },
  { key: 'epic', label: 'Over 80k', min: 80000, max: Infinity },
];

export const tagKey = (db, id) => `${db.tags[id][0]}:${db.tags[id][1]}`;

export function prepare(index) {
  // v2 (no groups of copies) is still readable; anything else is refused.
  if (index.v !== 3 && index.v !== 2) throw new Error('This index was built by another version of the site and will be replaced shortly.');
  index = { ...index, groups: index.groups || [], unchecked: index.unchecked || [] };
  const n = index.count;
  // Copies of the same fic: groups[g] = versions (best first), each a list of places holding
  // that exact document. rank = position of a copy inside its group, best first.
  const gOf = new Int32Array(n).fill(-1);
  const rank = new Int32Array(n);
  index.groups.forEach((versions, g) => {
    let r = 0;
    for (const places of versions) for (const e of places) { gOf[e] = g; rank[e] = r++; }
  });
  const tagIdByKey = new Map(index.tags.map(([code, name], i) => [`${code}:${name}`, i]));
  const ficTags = new Array(n);
  for (let i = 0; i < n; i++) ficTags[i] = index.g[i] ? index.g[i].split('.').map((x) => parseInt(x, 36)) : [];
  return {
    ...index,
    n,
    uniqueCount: gOf.reduce((total, group) => total + (group < 0 ? 1 : 0), 0) + index.groups.length,
    gOf,
    rank,
    unchecked: new Set(index.unchecked),
    ficTags,
    tagIdByKey,
    nTitle: index.t.map(norm),
    tagNorm: index.tags.map(([, name]) => norm(name)),
    authorNorm: index.authors.map(norm),
    folderNorm: index.folders.map(([, , path]) => norm(path.join(' '))),
    sourceNorm: index.sources.map((s) => norm(`${s.name} ${s.credit}`)),
  };
}

// Splits a query into terms, keeping "quoted phrases" together; "-word" excludes.
export function parseQuery(query) {
  const include = [];
  const exclude = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let m;
  while ((m = re.exec(query))) {
    const neg = m[1] || m[3];
    const t = norm(m[2] || m[4]);
    if (t) (neg ? exclude : include).push(t);
  }
  return { include, exclude };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns matching fic ids with scores.
//   Every word must match the title, a tag, the author, a folder name or the drive.
//   filters: { src: Set, fmtMask, folder, inc: [tagId], exc: [tagId], done: 0|1|2, len }
export function search(db, query, filters) {
  const { include, exclude } = parseQuery(query);
  const termTags = include.map((t) => tagSet(db, t));
  const exclTags = exclude.map((t) => tagSet(db, t));
  const wordRes = include.map((t) => new RegExp(`(^| )${escapeRe(t)}( |$)`));
  const len = LENGTHS.find((l) => l.key === filters.len);
  const inc = filters.inc || [];
  const exc = new Set(filters.exc || []);
  const ids = [];
  const scores = new Map();

  for (let i = 0; i < db.n; i++) {
    const d = db.d[i];
    const folder = db.folders[d];
    if (filters.src?.size && !filters.src.has(folder[0])) continue;
    if (filters.fmtMask && !(db.f[i] & filters.fmtMask)) continue;
    if (filters.folder && folder[2][0] !== filters.folder) continue;
    if (filters.done && db.c[i] !== filters.done) continue;
    if (len && !(db.w[i] >= len.min && db.w[i] < len.max)) continue;
    const tags = db.ficTags[i];
    if (inc.length && !inc.every((t) => tags.includes(t))) continue;
    if (exc.size && tags.some((t) => exc.has(t))) continue;

    let score = 0;
    let ok = true;
    const title = db.nTitle[i];
    for (let k = 0; k < include.length; k++) {
      const t = include[k];
      if (title.includes(t)) {
        score += 10;
        if (title.startsWith(t)) score += 4;
        if (wordRes[k].test(title)) score += 3;
      } else if (termTags[k].size && tags.some((x) => termTags[k].has(x))) score += 6;
      else if (db.a[i] >= 0 && db.authorNorm[db.a[i]].includes(t)) score += 6;
      else if (db.folderNorm[d].includes(t)) score += 4;
      else if (db.sourceNorm[folder[0]].includes(t)) score += 2;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let k = 0; k < exclude.length && ok; k++) {
      if (title.includes(exclude[k]) || (exclTags[k].size && tags.some((x) => exclTags[k].has(x)))) ok = false;
    }
    if (!ok) continue;
    if (include.length && title === include.join(' ')) score += 20;
    if (tags.length) score += 1; // tagged fics are richer results: surface them first on ties
    ids.push(i);
    scores.set(i, score);
  }
  return collapse(db, ids, scores);
}

// One result per fic: when several copies match, keep the best one (the group's best version
// first), with the best score of the copies. The others stay reachable from the card.
function collapse(db, ids, scores) {
  const single = [];
  const best = new Map();
  for (const i of ids) {
    const g = db.gOf[i];
    if (g < 0) {
      single.push(i);
      continue;
    }
    const cur = best.get(g);
    if (cur === undefined) best.set(g, i);
    else {
      const [keep, drop] = db.rank[i] < db.rank[cur] ? [i, cur] : [cur, i];
      scores.set(keep, Math.max(scores.get(keep), scores.get(drop)));
      best.set(g, keep);
    }
  }
  const out = single.concat([...best.values()]);
  return { ids: out, scores, hidden: ids.length - out.length };
}

const tagSetCache = new Map();
function tagSet(db, term) {
  if (tagSetCache.has(term)) return tagSetCache.get(term);
  const set = new Set();
  // Words of 1-2 letters only match as whole words inside a tag ("au", "f1"); longer ones match anywhere in it.
  const wordRe = term.length < 3 ? new RegExp("(^| )" + escapeRe(term) + "( |$)") : null;
  for (let i = 0; i < db.tagNorm.length; i++) {
    if (wordRe ? wordRe.test(db.tagNorm[i]) : db.tagNorm[i].includes(term)) set.add(i);
  }
  if (tagSetCache.size > 200) tagSetCache.clear();
  tagSetCache.set(term, set);
  return set;
}

export function sortIds(db, ids, scores, sort, hasQuery) {
  const arr = ids.slice();
  const byTitle = (a, b) => (db.nTitle[a] < db.nTitle[b] ? -1 : db.nTitle[a] > db.nTitle[b] ? 1 : 0);
  if (sort === 'title') arr.sort(byTitle);
  else if (sort === 'words-desc') arr.sort((a, b) => db.w[b] - db.w[a] || byTitle(a, b));
  else if (sort === 'words-asc') arr.sort((a, b) => (db.w[a] || Infinity) - (db.w[b] || Infinity) || byTitle(a, b));
  else if (hasQuery) arr.sort((a, b) => scores.get(b) - scores.get(a) || byTitle(a, b));
  else arr.sort((a, b) => (db.ficTags[b].length > 0) - (db.ficTags[a].length > 0) || a - b);
  return arr;
}

// Facet counts over the current results.
export function facets(db, ids) {
  const tagCounts = new Map();
  const src = new Map();
  const fmt = new Map();
  const folder = new Map();
  const done = [0, 0, 0];
  const len = Object.fromEntries(LENGTHS.map((l) => [l.key, 0]));
  for (const i of ids) {
    for (const t of db.ficTags[i]) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    const f = db.folders[db.d[i]];
    src.set(f[0], (src.get(f[0]) || 0) + 1);
    if (f[2][0]) folder.set(f[2][0], (folder.get(f[2][0]) || 0) + 1);
    for (const b of FORMAT_BITS) if (db.f[i] & b.bit) fmt.set(b.bit, (fmt.get(b.bit) || 0) + 1);
    done[db.c[i]]++;
    const w = db.w[i];
    if (w) for (const l of LENGTHS) if (w >= l.min && w < l.max) len[l.key]++;
  }
  const byType = {};
  for (const ty of TAG_TYPES) byType[ty.code] = [];
  for (const [t, n] of tagCounts) byType[db.tags[t][0]]?.push([t, n]);
  for (const k in byType) byType[k].sort((a, b) => b[1] - a[1]);
  const desc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { tags: byType, src: desc(src), fmt: desc(fmt), folder: desc(folder), done, len };
}

// Tag suggestions for the "find a tag" box. Every typed word must appear somewhere in the tag
// (any order, anywhere inside it). Tags starting with the text come first, then tags containing it as
// a phrase, then the rest; each group keeps popularity order (tags are already sorted that way).
export function suggestTags(db, text, limit = 40) {
  const t = norm(text);
  if (t.length < 2) return [];
  const words = t.split(" ");
  const starts = [];
  const phrase = [];
  const rest = [];
  for (let i = 0; i < db.tagNorm.length; i++) {
    const nm = db.tagNorm[i];
    if (!words.every((w) => nm.includes(w))) continue;
    if (nm.startsWith(t)) starts.push(i);
    else if (nm.includes(t)) phrase.push(i);
    else rest.push(i);
  }
  return [...starts, ...phrase, ...rest].slice(0, limit);
}

// Lazily loads file links / summaries for the fics on screen, 500 at a time.
const detailCache = new Map();
export function loadDetails(base, chunkSize, i) {
  const c = Math.floor(i / chunkSize);
  if (!detailCache.has(c)) {
    detailCache.set(
      c,
      fetch(`${base}details/${c}.json`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => {
          detailCache.delete(c);
          return [];
        })
    );
  }
  return detailCache.get(c).then((rows) => {
    const row = rows[i % chunkSize];
    if (!row) return null;
    const [files, ao3Id, summary, added, language, published, chapters, updated, fileWords] = row;
    return { files, ao3Id, summary, added, language, published, chapters, updated, fileWords };
  });
}

export function fileUrl(format, id) {
  if (format === 'gdoc') return `https://docs.google.com/document/d/${id}/edit`;
  return `https://drive.google.com/file/d/${id}/view`;
}
