#!/usr/bin/env node
// Step 1 of the index build: find the drives and list every fic in them.
//
// Drives come from three places, merged and de-duplicated:
//   1. the "master" Drive folder in data/config.json: every folder shortcut in it,
//      plus every Drive-folder link written in a Google Doc inside it;
//   2. data/sources.json (manual entries and drives added through the site's form).
// Then every drive (and all of its subfolders) is read through Drive's public
// folder view (no API key, no login) and written to data/listing.json
// (scripts/build-index.mjs then adds tags and writes what the site loads).
//
// Usage: node scripts/crawl.mjs [--max-minutes 150] [--concurrency 8] [--only <folderId>] [--dry-run]
//                              [--if-older-than-hours 20]   (skip if the listing is fresher than that)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFolder, folderIdFromUrl, fileIdFromUrl } from './lib/drive.mjs';
import { discover, mergeSources } from './lib/discover.mjs';
import { compact, expand } from './lib/index-format.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(ROOT, 'data/config.json');
const SOURCES = resolve(ROOT, 'data/sources.json');
const OUT = resolve(ROOT, 'data/listing.json');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const FIC_EXT = new Set(['pdf', 'epub', 'mobi', 'azw3', 'azw', 'docx', 'doc', 'txt', 'html', 'htm', 'rtf', 'odt', 'fb2']);
const MAX_DEPTH = 15;

// ---------- crawl ----------

function cleanName(name) {
  let base = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  let ao3Id = null;
  const idMatch = base.match(/[_\s-](\d{5,9})$/);
  if (idMatch) {
    ao3Id = idMatch[1];
    base = base.slice(0, -idMatch[0].length);
  }
  return { title: base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim(), ao3Id };
}

function fileKind(entry) {
  const ext = (entry.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase();
  if (ext && FIC_EXT.has(ext)) return ext;
  if (/docs\.google\.com\/document/.test(entry.href)) return 'gdoc';
  return null;
}

const groupKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

async function crawlAll(sources, { concurrency, deadline }) {
  const seen = new Set();
  const state = sources.map(() => ({ fics: [], folders: 0, pending: 0, rootTitle: null, status: null }));
  const queue = [];
  sources.forEach((s, i) => {
    const id = folderIdFromUrl(s.url);
    if (id && s.kind !== 'external' && !s.skip) {
      queue.push({ id, path: [], depth: 0, s: i });
      state[i].pending++;
    }
  });

  let active = 0;
  let done = 0;
  let timedOut = false;
  const started = Date.now();

  await new Promise((finish) => {
    const tick = () => {
      if (Date.now() > deadline && !timedOut) {
        timedOut = true;
        console.warn('\n! time budget reached — unfinished drives keep their previous data');
      }
      while (!timedOut && active < concurrency && queue.length) {
        const job = queue.shift();
        const st = state[job.s];
        if (seen.has(job.id)) {
          st.pending--;
          continue;
        }
        seen.add(job.id);
        active++;
        listFolder(job.id)
          .then(({ status, title, entries }) => {
            if (job.depth === 0) {
              st.status = status;
              st.rootTitle = title;
            }
            if (status !== 200) return;
            st.folders++;
            const groups = new Map();
            for (const e of entries) {
              if (e.isFolder) {
                if (job.depth < MAX_DEPTH) {
                  queue.push({ id: folderIdFromUrl(e.href) || e.id, path: [...job.path, e.name], depth: job.depth + 1, s: job.s });
                  st.pending++;
                }
                continue;
              }
              const kind = fileKind(e);
              if (!kind) continue;
              const fileId = fileIdFromUrl(e.href) || e.id;
              const { title, ao3Id } = cleanName(e.name);
              const key = groupKey(title) || fileId;
              if (!groups.has(key)) groups.set(key, { title, ao3Id, files: [], modified: e.modified });
              const g = groups.get(key);
              g.ao3Id ||= ao3Id;
              if (!g.files.some((f) => f[1] === fileId)) g.files.push([kind, fileId]);
            }
            for (const g of groups.values()) {
              st.fics.push({ t: g.title, s: job.s, p: job.path, fo: job.id, fl: g.files, ...(g.ao3Id ? { a: g.ao3Id } : {}), m: g.modified });
            }
          })
          .catch((err) => {
            st.error = true;
            console.warn(`\n! folder ${job.id}: ${err.message}`);
          })
          .finally(() => {
            active--;
            st.pending--;
            done++;
            if (done % 50 === 0) {
              const fics = state.reduce((n, x) => n + x.fics.length, 0);
              process.stdout.write(`\r  ${done} folders read, ${queue.length} queued, ${fics} fics, ${Math.round((Date.now() - started) / 1000)}s   `);
            }
            tick();
          });
      }
      if (active === 0 && (timedOut || !queue.length)) finish();
    };
    tick();
  });
  process.stdout.write('\n');
  return state;
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const manual = JSON.parse(await readFile(SOURCES, 'utf8')).map((s) => ({ ...s, origin: s.origin || 'sources.json' }));
  const maxMinutes = Number(arg('--max-minutes', config.maxMinutes || 300));
  const concurrency = Number(arg('--concurrency', config.concurrency || 8));
  const deadline = Date.now() + maxMinutes * 60000;

  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {}
  const prevFics = previous ? expand(previous) : [];
  const discovered = await discover(config);
  const sources = mergeSources([manual, discovered]);
  console.log(`${sources.length} sources (${manual.length} in sources.json, ${discovered.length} found in the master folder)`);
  if (args.includes('--dry-run')) {
    for (const s of sources) console.log(`${s.kind === 'external' ? 'EXT  ' : 'DRIVE'} ${s.credit || '-'} | ${s.name || s.notes || ''} | ${s.url} [${s.origin}]`);
    return;
  }

  // Which drives to (re)crawl: all of them, one (--only), or — when the listing is
  // still fresh — just the drives that were added since the last crawl.
  let only = arg('--only', null) ? new Set([arg('--only')]) : null;
  const fresh = Number(arg('--if-older-than-hours', 0));
  if (!only && fresh && previous && Date.now() - new Date(previous.generated).getTime() < fresh * 3600000) {
    const known = new Set(previous.sources.map((s) => s.url));
    const added = sources.filter((s) => !known.has(s.url) && folderIdFromUrl(s.url) && s.kind !== 'external');
    if (!added.length && sources.length === previous.sources.length) {
      console.log(`Listing is from ${previous.generated} (< ${fresh} h) and no drive was added — nothing to crawl.`);
      return;
    }
    only = new Set(added.map((s) => folderIdFromUrl(s.url)));
    console.log(`Listing is fresh; crawling only the ${only.size} new drive(s).`);
  }
  if (only) sources.forEach((s) => (s.skip = !only.has(folderIdFromUrl(s.url))));
  const state = await crawlAll(sources, { concurrency, deadline });

  const outSources = [];
  const outFics = [];
  sources.forEach((s, i) => {
    const st = state[i];
    const isDrive = !!folderIdFromUrl(s.url) && s.kind !== 'external';
    const prevSrc = previous?.sources.find((p) => p.url === s.url);
    const prevList = prevSrc ? prevFics.filter((f) => f.s === prevSrc.id) : [];
    const incomplete = s.skip || st.pending > 0 || st.error;
    // Keep the old listing when this run couldn't finish the drive and the old one was bigger.
    const usePrev = isDrive && incomplete && prevList.length > st.fics.length;
    const fics = usePrev ? prevList : st.fics;
    outSources.push({
      id: i,
      url: s.url,
      name: s.name || st.rootTitle || prevSrc?.name || s.notes || s.credit || 'Drive',
      credit: s.credit || '',
      notes: s.notes || '',
      kind: isDrive ? 'drive' : 'external',
      count: fics.length,
      ...(isDrive ? { status: st.status ?? prevSrc?.status ?? null } : {}),
      ...(incomplete && isDrive && !s.skip ? { partial: true } : {}),
      origin: s.origin,
    });
    for (const f of fics) outFics.push({ ...f, s: i });
  });

  await mkdir(dirname(OUT), { recursive: true });
  const partialRun = sources.some((s) => s.skip);
  const index = { generated: partialRun && previous ? previous.generated : new Date().toISOString(), sources: outSources, ...compact(outFics) };
  await writeFile(OUT, JSON.stringify(index));
  const blocked = outSources.filter((s) => s.kind === 'drive' && s.status && s.status !== 200).length;
  console.log(`Wrote ${outFics.length} fics from ${outSources.length} sources (${blocked} not public) to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
