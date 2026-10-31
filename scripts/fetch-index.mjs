#!/usr/bin/env node
// Runs during the Vercel build (see vercel.json). The search index is too big and
// changes too often to live in git, so the GitHub Actions workflow publishes it as
// a release asset; this downloads it into public/ before `vite build`.
//
// Env: INDEX_URL overrides the download URL. The download is retried a few times
// (the asset is briefly missing while a workflow replaces it). If it still fails the
// build fails, so Vercel keeps serving the previous deployment instead of an empty
// site. Set ALLOW_EMPTY_INDEX=1 to build without data anyway (first deploy, before
// any workflow has published an index).

import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      last = err;
      console.warn(`  attempt ${attempt}/5 failed: ${err.message}`);
      if (attempt < 5) await sleep(attempt * 5000);
    }
  }
  throw last;
}

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, 'data/config.json'), 'utf8'));
  const url = process.env.INDEX_URL || `https://github.com/${config.repo}/releases/download/index-data/index-bundle.tgz`;
  console.log(`Fetching the search index from ${url}`);
  const buf = await download(url);
  const dir = await mkdtemp(join(tmpdir(), 'index-'));
  try {
    const file = join(dir, 'bundle.tgz');
    await writeFile(file, buf);
    await mkdir(join(ROOT, 'public'), { recursive: true });
    await run('tar', ['-xzf', file, '-C', join(ROOT, 'public')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (!existsSync(join(ROOT, 'public/index.json'))) throw new Error('bundle has no index.json');
  console.log(`Index installed (${(buf.length / 1048576).toFixed(1)} MB download).`);
}

main().catch((err) => {
  if (process.env.ALLOW_EMPTY_INDEX === '1') {
    console.warn(`! Could not fetch the search index (${err.message}). Building without it (ALLOW_EMPTY_INDEX=1).`);
    return;
  }
  console.error(`✗ Could not fetch the search index (${err.message}). Failing the build so the previous deployment stays live.`);
  process.exit(1);
});
