// Finding the drives: the "master" Drive folder (data/config.json) holds shortcuts to
// folders and Google Docs full of drive links; this reads them. Shared by
// scripts/crawl.mjs (to list the drives) and scripts/add-drive.mjs (to tell whether a
// submitted drive is already known).

import { listFolder, readDocBlocks, folderIdFromUrl, fileIdFromUrl } from './drive.mjs';

// The identity of a source: the Drive folder id, the Google file id (sheets), or the URL.
export const sourceKey = (url) => folderIdFromUrl(url) || fileIdFromUrl(url) || String(url);

export const HANDLE = /@[A-Za-z0-9_.]{2,30}/;

export function sourceFromBlock(text, url, context) {
  // Typical lines: "@handle (fandoms…) : lien", "AO3 Library : <link>", "Russtappen : <link>"
  const before = text.split(/\s:\s|\s:$/)[0].replace(/https?:\/\/\S+/g, '').trim();
  const handles = before.match(new RegExp(HANDLE.source, 'g'));
  const credit = handles ? [...new Set(handles)].join(' & ') : context.handle;
  const paren = before.match(/\(([^)]+)\)/);
  const notes = (paren ? paren[1] : before.replace(new RegExp(HANDLE.source, 'g'), ''))
    .replace(/^[\s,;:&()-]+|[\s,;:&()-]+$/g, '')
    .replace(/\(?\s*drive link\s*\)?/gi, '')
    .replace(/\bby\s*:?\s*$/i, '')
    .replace(/^(et|and)\s+/i, '')
    .replace(/[\s,;:&(-]+$/g, '')
    .trim();
  return { url, credit, notes: notes === before && handles ? '' : notes };
}

// Collects Drive-folder (and Google Sheet) links from a Google Doc. With depth > 0 it
// also follows Google Docs linked from it (e.g. a community masterpost).
export async function readDoc(docId, name, found, depth, seenDocs) {
  if (!docId || seenDocs.has(docId)) return;
  seenDocs.add(docId);
  const blocks = await readDocBlocks(docId);
  if (!blocks) {
    console.warn(`! could not read doc "${name}" (not public?)`);
    return;
  }
  let n = 0;
  const ctx = { handle: '' };
  const linkedDocs = [];
  for (const b of blocks) {
    if (/^h/.test(b.tag)) {
      // A heading like "@LukeTraveler (200 first fics)" gives credit to the links under it.
      ctx.handle = (b.text.match(HANDLE) || [''])[0];
      continue;
    }
    for (const link of b.links) {
      const folderId = /drive\.google\.com/.test(link) ? folderIdFromUrl(link) : null;
      if (folderId) {
        found.push({ ...sourceFromBlock(b.text, `https://drive.google.com/drive/folders/${folderId}`, ctx), origin: `doc:${name}` });
        n++;
      } else if (/docs\.google\.com\/spreadsheets\/d\//.test(link)) {
        found.push({ ...sourceFromBlock(b.text, link.split('#')[0], ctx), kind: 'external', origin: `doc:${name}` });
        n++;
      } else if (/docs\.google\.com\/document\/d\//.test(link)) {
        linkedDocs.push({ id: fileIdFromUrl(link), name: b.text.slice(0, 60) });
      }
    }
  }
  console.log(`  doc "${name}": ${n} drive links`);
  if (depth > 0) for (const d of linkedDocs) await readDoc(d.id, d.name, found, depth - 1, seenDocs);
}

export async function discover(config) {
  const found = [];
  const masterId = folderIdFromUrl(config.masterFolder || '');
  if (!masterId) return found;
  const master = await listFolder(masterId);
  if (master.status !== 200) {
    console.warn(`! master folder not readable (HTTP ${master.status}) — is it shared as "anyone with the link"?`);
    return found;
  }
  console.log(`Master folder "${master.title}": ${master.entries.length} entries`);
  const seenDocs = new Set();
  for (const e of master.entries) {
    if (e.isFolder) {
      found.push({ url: `https://drive.google.com/drive/folders/${folderIdFromUrl(e.href) || e.id}`, name: e.name, credit: '', notes: '', origin: 'shortcut' });
    } else if (/docs\.google\.com\/document\//.test(e.href)) {
      await readDoc(fileIdFromUrl(e.href), e.name, found, config.followLinkedDocs !== false ? 1 : 0, seenDocs);
    }
  }
  return found;
}

export function mergeSources(lists) {
  const byKey = new Map();
  for (const s of lists.flat()) {
    const key = sourceKey(s.url);
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...s });
    else {
      // Earlier lists win, later ones only fill the gaps.
      for (const k of ['name', 'credit', 'notes', 'kind']) if (!prev[k] && s[k]) prev[k] = s[k];
    }
  }
  return [...byKey.values()];
}
