#!/usr/bin/env node
// Crawls the public Google Drive folders listed in data/sources.json and
// writes a search index to public/index.json.
//
// It uses Drive's public "embedded folder view" page, so no API key or login
// is needed — but only folders shared as "Anyone with the link" can be read.
//
// Usage: node scripts/crawl.mjs [--only <folderId>] [--concurrency 4]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = resolve(ROOT, 'data/sources.json');
const OUT = resolve(ROOT, 'public/index.json');

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const ONLY = argVal('--only', null);
const CONCURRENCY = Number(argVal('--concurrency', 4));
const MAX_DEPTH = 12;

// File extensions we treat as "a fic". Everything else (images, zips…) is skipped.
const FIC_EXT = new Set(['pdf', 'epub', 'mobi', 'azw3', 'azw', 'docx', 'doc', 'txt', 'html', 'htm', 'rtf', 'odt', 'fb2']);
const GOOGLE_DOC = 'gdoc';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function folderIdFromUrl(url) {
  const m = url.match(/\/folders\/([\w-]+)/);
  return m ? m[1] : null;
}

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

async function fetchFolder(id) {
  const url = `https://drive.google.com/embeddedfolderview?id=${id}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (drive-of-our-own indexer)' } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.text();
    } catch (err) {
      const wait = 1000 * 2 ** attempt;
      console.warn(`  ! ${id}: ${err.message}, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  return null;
}

function parseFolder(html) {
  const title = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim();
  const entries = [];
  // Parse each entry on its own so one odd entry can't swallow its neighbours.
  const chunks = html.split('<div class="flip-entry" id="entry-').slice(1);
  for (const chunk of chunks) {
    const id = (chunk.match(/^([\w-]+)"/) || [])[1];
    const href = (chunk.match(/<a href="([^"]+)"/) || [])[1];
    const rawTitle = (chunk.match(/<div class="flip-entry-title">([^<]*)<\/div>/) || [])[1];
    if (!id || !href || rawTitle == null) continue;
    const listIcon = chunk.match(/<div class="flip-entry-list-icon">([\s\S]*?)<\/div>/)?.[1] || '';
    const icon = (listIcon.match(/src="([^"]*)"/) || [])[1] || listIcon;
    const modified = (chunk.match(/<div class="flip-entry-last-modified"><div>([^<]*)<\/div>/) || [])[1] || '';
    const isFolder = /\/folders\//.test(href) || /aria-label="Folder"|folder-(grid|list)/.test(chunk);
    entries.push({ id, href: decode(href), icon, name: decode(rawTitle).trim(), modified: decode(modified).trim(), isFolder });
  }
  return { title, entries };
}

function fileKind(entry) {
  const ext = (entry.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase();
  if (ext && FIC_EXT.has(ext)) return ext;
  if (/document/.test(entry.icon) && /docs\.google\.com\/document/.test(entry.href)) return GOOGLE_DOC;
  return null;
}

// "Bask_in_the_glory_of_all.epub" -> "Bask in the glory of all"
// "acrodite - futile devices_84760991.epub" -> title "acrodite - futile devices", ao3 id 84760991
function cleanName(name) {
  let base = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  let ao3Id = null;
  const idMatch = base.match(/[_\s-](\d{5,9})$/);
  if (idMatch) {
    ao3Id = idMatch[1];
    base = base.slice(0, -idMatch[0].length);
  }
  const title = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, ao3Id };
}

const groupKey = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function fileUrl(entry) {
  return entry.href.replace(/[?&]usp=drive_web$/, '');
}

async function crawlSource(source, seenFolders) {
  const rootId = folderIdFromUrl(source.url);
  const fics = [];
  let folderCount = 0;
  let rootTitle = null;
  const queue = [{ id: rootId, path: [], depth: 0 }];
  let active = 0;

  await new Promise((done) => {
    const pump = () => {
      if (!queue.length && !active) return done();
      while (active < CONCURRENCY && queue.length) {
        const job = queue.shift();
        if (seenFolders.has(job.id)) continue;
        seenFolders.add(job.id);
        active++;
        fetchFolder(job.id)
          .then((html) => {
            if (!html) return;
            folderCount++;
            const { title, entries } = parseFolder(html);
            if (job.depth === 0) rootTitle = title;
            const groups = new Map();
            for (const e of entries) {
              if (e.isFolder) {
                const sub = folderIdFromUrl(e.href) || e.id;
                if (job.depth < MAX_DEPTH) queue.push({ id: sub, path: [...job.path, e.name], depth: job.depth + 1 });
                continue;
              }
              const kind = fileKind(e);
              if (!kind) continue;
              const { title: t, ao3Id } = cleanName(e.name);
              const key = groupKey(t) || e.id;
              if (!groups.has(key)) groups.set(key, { title: t, ao3Id, files: [], modified: e.modified });
              const g = groups.get(key);
              g.ao3Id ||= ao3Id;
              g.files.push({ f: kind, u: fileUrl(e) });
            }
            for (const g of groups.values()) {
              fics.push({
                t: g.title,
                p: job.path,
                fo: `https://drive.google.com/drive/folders/${job.id}`,
                fl: g.files,
                ...(g.ao3Id ? { a: g.ao3Id } : {}),
                m: g.modified,
              });
            }
            process.stdout.write(`\r  ${source.credit}: ${folderCount} folders, ${fics.length} fics   `);
          })
          .catch((err) => console.warn(`\n  ! ${job.id}: ${err.message}`))
          .finally(() => {
            active--;
            pump();
          });
      }
      if (!queue.length && !active) done();
    };
    pump();
  });
  process.stdout.write('\n');
  return { rootTitle, fics, folderCount };
}

// On disk, folder paths are stored once in a table and fics point at them
// (index.json is much smaller that way). In memory we use the flat shape.
function compact(fics) {
  const folders = [];
  const byUrl = new Map();
  const out = fics.map((f) => {
    let k = byUrl.get(f.fo);
    if (k === undefined) {
      k = folders.length;
      byUrl.set(f.fo, k);
      folders.push({ s: f.s, id: f.fo.split('/').pop(), p: f.p });
    }
    const { fo, p, s, ...rest } = f;
    return { ...rest, d: k };
  });
  return { folders, fics: out };
}

function expand(index) {
  if (!index.folders) return index.fics;
  return index.fics.map(({ d, ...f }) => {
    const dir = index.folders[d];
    return { ...f, s: dir.s, p: dir.p, fo: `https://drive.google.com/drive/folders/${dir.id}` };
  });
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES, 'utf8'));
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {}

  const seenFolders = new Set();
  const outSources = [];
  const outFics = [];

  for (const [i, source] of sources.entries()) {
    const id = folderIdFromUrl(source.url);
    const base = { id: i, url: source.url, credit: source.credit, notes: source.notes || '' };
    if (!id) {
      // Not a Drive folder (e.g. a Google Sheet): list it as a source, nothing to crawl.
      outSources.push({ ...base, name: source.name || source.notes || 'External source', kind: 'external', count: 0 });
      continue;
    }
    if (ONLY && ONLY !== id) {
      // Keep previously crawled data for sources we're skipping this run.
      const prev = previous?.sources.find((s) => s.url === source.url);
      if (prev) {
        outSources.push({ ...prev, ...base });
        outFics.push(...expand(previous).filter((f) => f.s === prev.id).map((f) => ({ ...f, s: i })));
      } else outSources.push({ ...base, name: source.notes || source.credit, kind: 'drive', count: 0 });
      continue;
    }
    console.log(`→ ${source.credit} (${source.notes || id})`);
    const { rootTitle, fics, folderCount } = await crawlSource(source, seenFolders);
    outSources.push({
      ...base,
      name: source.name || rootTitle || source.notes || source.credit,
      kind: 'drive',
      count: fics.length,
      folders: folderCount,
      ok: folderCount > 0,
    });
    for (const f of fics) outFics.push({ ...f, s: i });
  }

  await mkdir(dirname(OUT), { recursive: true });
  const index = { generated: new Date().toISOString(), sources: outSources, ...compact(outFics) };
  await writeFile(OUT, JSON.stringify(index));
  console.log(`\nWrote ${outFics.length} fics from ${outSources.length} sources to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
