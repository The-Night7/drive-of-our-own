#!/usr/bin/env node
// Runs during the Vercel build (see vercel.json). The search index is too big and
// changes too often to live in git, so the GitHub Actions workflow publishes it as
// a release asset; this downloads it into public/ before `vite build`.
//
// Env: INDEX_URL overrides the download URL. If the download fails, the build goes
// on without data (the site then says the index isn't ready yet).

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, 'data/config.json'), 'utf8'));
  const url = process.env.INDEX_URL || `https://github.com/${config.repo}/releases/download/index-data/index-bundle.tgz`;
  console.log(`Fetching the search index from ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), 'index-'));
  try {
    const file = join(dir, 'bundle.tgz');
    await writeFile(file, buf);
    await run('tar', ['-xzf', file, '-C', join(ROOT, 'public')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (!existsSync(join(ROOT, 'public/index.json'))) throw new Error('bundle has no index.json');
  console.log(`Index installed (${(buf.length / 1048576).toFixed(1)} MB download).`);
}

main().catch((err) => {
  console.warn(`! Could not fetch the search index (${err.message}). Building without it — the first "Index & deploy" run on GitHub will publish one.`);
});
