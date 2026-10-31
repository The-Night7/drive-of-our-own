#!/usr/bin/env node
// Refills the per-file metadata cache from a previously PUBLISHED index, so that tags are
// never lost when the Actions cache is missing, evicted, or failed to save: any fic that the
// published index has tags for, and the cache doesn't know, is imported (it is re-read later
// by the normal "stale entry" pass to get its text fingerprint).
//
// Usage: node scripts/seed-cache.mjs [assetName ...]     (default: the current format, then the previous one)
// Env: INDEX_BASE_URL (folder holding the assets), CACHE_DIR, SEED_DIR (read an already extracted bundle: tests)

import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, cacheWriter } from './lib/cache.mjs';
import { bundleName } from './lib/index-format.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.CACHE_DIR || resolve(ROOT, 'data/meta-cache');
const run = promisify(execFile);
const TYPE_FIELD = { r: 'rating', w: 'warnings', c: 'categories', f: 'fandoms', p: 'relationships', h: 'characters', t: 'freeforms' };

async function download(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

// Metadata of fic i, rebuilt from the published index (null if it had none).
export function metaOf(index, details, i) {
  const tagIds = index.g[i] ? index.g[i].split('.').map((x) => parseInt(x, 36)) : [];
  const meta = {};
  for (const id of tagIds) {
    const [code, name] = index.tags[id];
    const field = TYPE_FIELD[code];
    if (field === 'rating') meta.rating = name;
    else if (field) (meta[field] ||= []).push(name);
  }
  const [, ao3Id, summary, , language, published, chapters, updated] = details;
  if (index.a[i] >= 0) meta.author = index.authors[index.a[i]];
  if (index.w[i] > 0) meta.words = index.w[i];
  if (index.c[i] === 1) meta.complete = true;
  else if (index.c[i] === 2) meta.complete = false;
  if (ao3Id) meta.ao3Id = String(ao3Id);
  if (summary) meta.summary = summary;
  if (language) meta.language = language;
  if (published) meta.published = published;
  if (chapters) meta.chapters = chapters;
  if (updated) meta.updated = updated;
  if (!tagIds.length && !meta.author && !meta.words && !meta.summary && !meta.ao3Id && !meta.published) return null;
  meta.title = index.t[i];
  return meta;
}

// The file that was downloaded for a fic: its EPUB if it has one, otherwise its PDF.
const sourceFile = (files) => files.find(([f]) => f === 'epub') || files.find(([f]) => f === 'pdf');

async function seedFrom(dir, cache, writer) {
  const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
  if (index.v !== 2 && index.v !== 3) return { seeded: 0, skipped: 'unknown format' };
  const rows = [];
  for (let c = 0; c * index.chunk < index.count; c++) rows.push(...JSON.parse(await readFile(join(dir, 'details', `${c}.json`), 'utf8')));
  let seeded = 0;
  for (let i = 0; i < index.count; i++) {
    const file = sourceFile(rows[i][0]);
    if (!file) continue;
    const have = cache.get(file[1]);
    if (have && !have.x) continue; // the cache already knows this file
    const meta = metaOf(index, rows[i], i);
    if (!meta) continue;
    writer.remember(cache, file[1], { ...meta, v: 2, seeded: 1 });
    seeded++;
  }
  await writer.flush();
  return { seeded, total: index.count };
}

async function main() {
  const cache = await loadCache(CACHE_DIR);
  const writer = cacheWriter(CACHE_DIR);
  console.log(`${cache.size} files in the cache`);
  if (process.env.SEED_DIR) {
    console.log(await seedFrom(process.env.SEED_DIR, cache, writer));
    return;
  }
  const config = JSON.parse(await readFile(join(ROOT, 'data/config.json'), 'utf8'));
  const base = process.env.INDEX_BASE_URL || `https://github.com/${config.repo}/releases/download/index-data`;
  const names = process.argv.slice(2).length ? process.argv.slice(2) : [bundleName(), 'index-bundle.tgz'];
  for (const name of names) {
    let buf;
    try {
      buf = await download(`${base}/${name}`);
    } catch (err) {
      console.warn(`! ${name}: ${err.message}`);
      continue;
    }
    if (!buf) {
      console.log(`${name}: not published, skipped`);
      continue;
    }
    const tmp = await mkdtemp(join(tmpdir(), 'seed-'));
    try {
      await writeFile(join(tmp, 'bundle.tgz'), buf);
      await mkdir(join(tmp, 'x'));
      await run('tar', ['-xzf', join(tmp, 'bundle.tgz'), '-C', join(tmp, 'x')]);
      const r = await seedFrom(join(tmp, 'x'), cache, writer);
      console.log(`${name}: ${r.seeded} files imported (index had ${r.total ?? '?'} fics)`);
    } catch (err) {
      console.warn(`! ${name}: ${err.message}`); // a broken old asset must never block a build
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
