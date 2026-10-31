#!/usr/bin/env node
// Step 2 of the index build: download each fic (EPUB preferred, else PDF), read its
// AO3 metadata (rating, warnings, fandoms, relationships, characters, tags, summary,
// author, words…), then write what the site loads:
//   public/index.json       — compact, column-oriented search index
//   public/details/<n>.json — file links + summaries, fetched only for fics on screen
//
// Downloads are cached per Drive file in data/meta-cache/*.ndjson (kept between
// GitHub Actions runs), so each run only downloads files it has never seen.
//
// Usage: node scripts/build-index.mjs [--max-minutes 200] [--concurrency 6] [--limit N]

import { readFile, writeFile, appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWithRetry, sleep, decode } from './lib/drive.mjs';
import { parseEpub, parsePdf, pdfAvailable } from './lib/meta.mjs';
import { expand } from './lib/index-format.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LISTING = resolve(ROOT, 'data/listing.json');
const INDEX = resolve(ROOT, 'public/index.json');
const DETAILS_DIR = resolve(ROOT, 'public/details');
const CACHE_DIR = resolve(ROOT, 'data/meta-cache');
const CHUNK = 500;
const MAX_BYTES = 40 << 20;
// Bump when the metadata parser improves: older cache entries are then re-read
// (a few thousand per run, so it never blocks new fics).
const PARSER_VERSION = 2;
const REPARSE_PER_RUN = 3000;

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const maxMinutes = Number(arg('--max-minutes', 200));
const concurrency = Number(arg('--concurrency', 6));
const limit = Number(arg('--limit', Infinity));
const deadline = Date.now() + maxMinutes * 60000;

// ---------- cache ----------

const SHARDS = 32;
const shardOf = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return String(h % SHARDS).padStart(2, '0');
};

async function loadCache() {
  const cache = new Map();
  await mkdir(CACHE_DIR, { recursive: true });
  for (const f of await readdir(CACHE_DIR)) {
    if (!f.endsWith('.ndjson')) continue;
    for (const line of (await readFile(join(CACHE_DIR, f), 'utf8')).split('\n')) {
      if (!line) continue;
      try {
        const { i, ...rest } = JSON.parse(line);
        cache.set(i, rest);
      } catch {}
    }
  }
  return cache;
}

const pending = new Map();
function remember(cache, id, value) {
  cache.set(id, value);
  const shard = shardOf(id);
  if (!pending.has(shard)) pending.set(shard, []);
  pending.get(shard).push(JSON.stringify({ i: id, ...value }));
}
async function flush() {
  for (const [shard, lines] of pending) {
    await appendFile(join(CACHE_DIR, `${shard}.ndjson`), lines.join('\n') + '\n');
  }
  pending.clear();
}

// ---------- download + parse ----------

class Transient extends Error {}

async function fetchMeta(format, id) {
  const res = await getWithRetry(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, { tries: 3, timeoutMs: 90000 });
  if (res.status === 404 || res.status === 403 || res.status === 401) return { x: `http${res.status}` };
  if (!res.ok) throw new Transient(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  const size = Number(res.headers.get('content-length') || 0);
  if (size > MAX_BYTES) {
    res.body?.cancel();
    return { x: 'big' };
  }
  if (type.includes('text/html')) {
    const html = await res.text();
    // Quota / rate-limit pages are temporary; "can't download" (not shared, removed) is not.
    if (/quota|too many|unusual traffic|try again later/i.test(html)) throw new Transient('rate limited');
    return { x: 'html' };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = format === 'epub' ? parseEpub(buf) : await parsePdf(buf);
  if (meta === undefined) return undefined; // pdftotext missing: try again on a machine that has it
  return meta || { x: 'none' };
}

// ---------- index ----------

const TAG_TYPES = [
  ['rating', 'r'],
  ['warnings', 'w'],
  ['categories', 'c'],
  ['fandoms', 'f'],
  ['relationships', 'p'],
  ['characters', 'h'],
  ['freeforms', 't'],
];
const FORMAT_BITS = { pdf: 1, epub: 2, gdoc: 4, mobi: 8, azw3: 8, azw: 8 }; // anything else: 16
const FORMAT_RANK = ['pdf', 'epub', 'gdoc', 'docx', 'doc', 'html', 'htm', 'txt', 'rtf', 'odt', 'mobi', 'azw3', 'azw', 'fb2'];

// Older cache entries (and Drive file names) may still hold HTML entities like "&amp;amp;": clean them
// here so the index is always correct, without re-downloading anything.
const dec = (s) => (typeof s === "string" && s.includes("&") ? decode(s) : s);
const fixMeta = (m) => {
  if (!m) return m;
  const o = { ...m };
  for (const k of ["title", "author", "summary", "rating"]) if (o[k]) o[k] = dec(o[k]);
  for (const [field] of TAG_TYPES) if (Array.isArray(o[field])) o[field] = [...new Set(o[field].map(dec))];
  return o;
};

function buildIndex(listing, fics, cache) {
  const metas = fics.map((f) => fixMeta(f.fl.map(([, id]) => cache.get(id)).find((m) => m && !m.x) || null));

  const tagCount = new Map();
  const ficKeys = metas.map((m) => {
    if (!m) return [];
    const keys = [];
    for (const [field, code] of TAG_TYPES) {
      const vals = field === 'rating' ? (m.rating ? [m.rating] : []) : m[field] || [];
      for (const v of vals) {
        const key = `${code}\u0000${v}`;
        if (keys.includes(key)) continue;
        keys.push(key);
        tagCount.set(key, (tagCount.get(key) || 0) + 1);
      }
    }
    return keys;
  });
  // Most-used tags get the smallest ids (shorter JSON).
  const tagIds = new Map();
  const tags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n], i) => {
      tagIds.set(key, i);
      const [code, name] = key.split('\u0000');
      return [code, name, n];
    });

  const authorIds = new Map();
  const authors = [];
  const folders = [];
  const folderIds = new Map();
  const cols = { t: [], d: [], g: [], a: [], w: [], c: [], f: [] };
  const details = [];

  fics.forEach((f, i) => {
    const m = metas[i];
    let k = folderIds.get(f.fo);
    if (k === undefined) {
      k = folders.length;
      folderIds.set(f.fo, k);
      folders.push([f.s, f.fo, f.p]);
    }
    let au = -1;
    if (m?.author) {
      au = authorIds.get(m.author);
      if (au === undefined) {
        au = authors.length;
        authorIds.set(m.author, au);
        authors.push(m.author);
      }
    }
    const files = [...f.fl].sort((x, y) => FORMAT_RANK.indexOf(x[0]) - FORMAT_RANK.indexOf(y[0]));
    cols.t.push(dec(m?.title || f.t));
    cols.d.push(k);
    cols.g.push(ficKeys[i].map((key) => tagIds.get(key).toString(36)).join('.'));
    cols.a.push(au);
    cols.w.push(m?.words || 0);
    cols.c.push(m?.complete === true ? 1 : m?.complete === false ? 2 : 0);
    cols.f.push(files.reduce((bits, [fmt]) => bits | (FORMAT_BITS[fmt] || 16), 0));
    // details: [files, ao3 id, summary, date added, language, published, chapters]
    details.push([
      files,
      m?.ao3Id || f.a || 0,
      m?.summary || 0,
      f.m || 0,
      m?.language && m.language !== 'English' ? m.language : 0,
      m?.published || 0,
      m?.chapters || 0,
    ]);
  });

  const index = {
    v: 2,
    generated: listing.generated,
    built: new Date().toISOString(),
    count: fics.length,
    tagged: metas.filter(Boolean).length,
    chunk: CHUNK,
    sources: listing.sources,
    folders,
    tags,
    authors,
    ...cols,
  };
  const chunks = [];
  for (let i = 0; i < details.length; i += CHUNK) chunks.push(details.slice(i, i + CHUNK));
  return { index, chunks };
}

async function main() {
  const listing = JSON.parse(await readFile(LISTING, 'utf8'));
  const fics = expand(listing);
  const cache = await loadCache();
  const canPdf = await pdfAvailable();
  if (!canPdf) console.warn('! pdftotext not found (install poppler-utils) — PDFs are skipped this run');

  // One download per fic: EPUB if there is one, otherwise PDF.
  const todo = [];
  const stale = [];
  const fresh = (id) => cache.has(id) && (cache.get(id).v || 1) >= PARSER_VERSION;
  for (const f of fics) {
    if (f.fl.some(([, id]) => fresh(id) && !cache.get(id).x)) continue;
    const pick = f.fl.find(([fmt, id]) => fmt === 'epub' && !fresh(id)) || (canPdf && f.fl.find(([fmt, id]) => fmt === 'pdf' && !fresh(id)));
    if (!pick) continue;
    (cache.has(pick[1]) ? stale : todo).push(pick);
  }
  // New files first, then a slice of files read by an older parser version.
  const unique = [...new Map([...todo, ...stale.slice(0, REPARSE_PER_RUN)].map((t) => [t[1], t])).values()].slice(0, limit);
  console.log(`${cache.size} files cached, ${todo.length} new + ${stale.length} to re-read; ${unique.length} this run`);

  let done = 0;
  let found = 0;
  let failuresInARow = 0;
  let stopped = false;
  const started = Date.now();
  let next = 0;

  async function worker() {
    while (!stopped && next < unique.length) {
      if (Date.now() > deadline) {
        stopped = true;
        console.warn('\n! time budget reached — the rest will be done on the next run');
        break;
      }
      const [fmt, id] = unique[next++];
      try {
        const meta = await fetchMeta(fmt, id);
        failuresInARow = 0;
        if (meta) {
          remember(cache, id, { ...meta, v: PARSER_VERSION });
          if (!meta.x) found++;
        }
      } catch (err) {
        failuresInARow++;
        if (failuresInARow >= 40) {
          stopped = true;
          console.warn(`\n! ${failuresInARow} failures in a row (${err.message}) — Google is probably rate limiting, stopping for now`);
        } else await sleep(2000);
      }
      done++;
      if (done % 25 === 0) {
        await flush();
        const rate = done / ((Date.now() - started) / 1000);
        process.stdout.write(`\r  ${done}/${unique.length} downloaded, ${found} with tags, ${rate.toFixed(1)}/s   `);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await flush();
  process.stdout.write('\n');

  const { index, chunks } = buildIndex(listing, fics, cache);
  await mkdir(dirname(INDEX), { recursive: true });
  await writeFile(INDEX, JSON.stringify(index));
  await rm(DETAILS_DIR, { recursive: true, force: true });
  await mkdir(DETAILS_DIR, { recursive: true });
  for (let i = 0; i < chunks.length; i++) await writeFile(join(DETAILS_DIR, `${i}.json`), JSON.stringify(chunks[i]));
  console.log(`Tagged ${index.tagged}/${fics.length} fics with ${index.tags.length} distinct tags; ${chunks.length} detail chunks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
