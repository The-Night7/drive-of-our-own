// Groups the copies of the same fic found in different drives/folders.
//
// Rules:
//   - Two fics are the same work if they share a content fingerprint (identical text),
//     or the same AO3 work id, or the same title AND at least one author in common.
//   - If both authors are known and have nothing in common, they are NEVER grouped,
//     whatever the title (there are dozens of different "Home" and "Stay").
//   - Inside a group, copies are the same *version* only if they are identical (same
//     fingerprint), or the same work saved in two different formats with identical
//     stats (words, chapters, last update). Any difference makes it another version.
//     Versions are listed, never merged: the reader picks one.
//   - Copies that can't be checked (no metadata, or not downloaded yet) are only
//     grouped when their fingerprint or AO3 id says so.

export const MAX_BUCKET = 60; // a title shared by more fics than this is too generic to trust

const accents = /[̀-ͯ]/g;
const squash = (s) => String(s || '').normalize('NFD').replace(accents, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export const normTitle = (s) => String(s || '').normalize('NFD').replace(accents, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const UNKNOWN_AUTHORS = new Set(['anonymous', 'orphanaccount', 'unknown', 'anon']);

// "name (pseud), other & third" -> {name, pseud, other, third}; anonymous = no information.
export function authorTokens(author) {
  const out = new Set();
  for (const part of String(author || '').split(/,|&|\band\b|;/i)) {
    const m = part.match(/^\s*([^()]*?)\s*(?:\(([^)]*)\))?\s*$/);
    for (const name of [m?.[1], m?.[2]]) {
      const t = squash(name);
      if (t.length >= 2 && !UNKNOWN_AUTHORS.has(t)) out.add(t);
    }
  }
  return out;
}

const intersects = (a, b) => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

// item: { title, ao3Id?, author?, h?, hf? (format hashed), sig?, words?, complete?, tagged? }
export function groupFics(items) {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const authors = items.map((it) => authorTokens(it.author));
  const compAuthors = authors.map((a) => new Set(a)); // by component root

  // Never join two components whose known authors have nothing in common.
  const compatible = (ra, rb) => !compAuthors[ra].size || !compAuthors[rb].size || intersects(compAuthors[ra], compAuthors[rb]);
  const union = (a, b, force = false) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (!force && !compatible(ra, rb)) return;
    parent[rb] = ra;
    for (const x of compAuthors[rb]) compAuthors[ra].add(x);
  };

  const buckets = (keyOf) => {
    const m = new Map();
    items.forEach((it, i) => {
      const k = keyOf(it, i);
      if (k) (m.get(k) || m.set(k, []).get(k)).push(i);
    });
    return [...m.values()].filter((v) => v.length > 1);
  };

  // 1. Identical text: the same document, wherever it is.
  for (const b of buckets((it) => it.h)) for (let k = 1; k < b.length; k++) union(b[0], b[k], true);

  // 2. Same AO3 work id, unless the authors clearly differ.
  // 3. Same title and a common author (both authors must be known).
  const pairwise = (bucket) => {
    for (let k = 1; k < bucket.length; k++) for (let j = 0; j < k; j++) union(bucket[j], bucket[k]);
  };
  for (const b of buckets((it) => it.ao3Id)) pairwise(b.slice(0, 200));
  for (const b of buckets((it, i) => (authors[i].size && normTitle(it.title).length >= 3 ? normTitle(it.title) : null))) {
    if (b.length <= MAX_BUCKET) pairwise(b);
  }

  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (comps.get(r) || comps.set(r, []).get(r)).push(i);
  }
  const groups = [];
  for (const members of comps.values()) if (members.length > 1) groups.push(splitVersions(members, items));
  return groups;
}

const sameVersion = (a, b) => {
  if (a.h && a.h === b.h) return true; // identical text
  // Same work saved in two formats: the text differs (layout) but the stats must be identical.
  return !!(a.sig && a.sig === b.sig && a.hf && b.hf && a.hf !== b.hf);
};

const quality = (it) => [it.complete ? 1 : 0, it.words || 0, it.tagged ? 1 : 0];
const better = (a, b) => {
  const qa = quality(a);
  const qb = quality(b);
  for (let k = 0; k < qa.length; k++) if (qa[k] !== qb[k]) return qb[k] - qa[k];
  return 0;
};

// -> array of versions, best first; each version is an array of item indexes (its locations).
function splitVersions(members, items) {
  const versions = [];
  for (const i of members) {
    const v = versions.find((vs) => vs.some((j) => sameVersion(items[i], items[j])));
    if (v) v.push(i);
    else versions.push([i]);
  }
  for (const v of versions) v.sort((a, b) => (items[b].tagged ? 1 : 0) - (items[a].tagged ? 1 : 0) || a - b);
  versions.sort((a, b) => better(items[a[0]], items[b[0]]) || a[0] - b[0]);
  return versions;
}
