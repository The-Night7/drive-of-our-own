// The per-file metadata cache (data/meta-cache/NN.ndjson): one JSON line per Drive file,
// {i: fileId, ...metadata}. Later lines win. Shared by build-index and seed-cache.

import { readFile, readdir, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const SHARDS = 32;
export const shardOf = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return String(h % SHARDS).padStart(2, '0');
};

export async function loadCache(dir) {
  const cache = new Map();
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.ndjson')) continue;
    for (const line of (await readFile(join(dir, f), 'utf8')).split('\n')) {
      if (!line) continue;
      try {
        const { i, ...rest } = JSON.parse(line);
        cache.set(i, rest);
      } catch {}
    }
  }
  return cache;
}

export function cacheWriter(dir) {
  const pending = new Map();
  return {
    remember(cache, id, value) {
      cache.set(id, value);
      const shard = shardOf(id);
      if (!pending.has(shard)) pending.set(shard, []);
      pending.get(shard).push(JSON.stringify({ i: id, ...value }));
    },
    async flush() {
      for (const [shard, lines] of pending) await appendFile(join(dir, `${shard}.ndjson`), lines.join('\n') + '\n');
      pending.clear();
    },
  };
}
