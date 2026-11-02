#!/usr/bin/env node
// Used by .github/workflows/add-drive.yml: reads an "Add a drive" issue (from the
// site's form) and appends the drive to data/sources.json.
//
// A drive that's already known is turned down ("duplicate"), whether it's in
// data/sources.json or was found in the master Drive folder (shortcuts and the links
// in its Google Docs), so the same drive is never added twice.
//
// Env: ISSUE_TITLE, ISSUE_BODY, AUTHOR_ASSOCIATION, APPROVED ("true" when the "approved" label is on).
// Prints a result line for the workflow:
//   status=<added|duplicate|missing|invalid|not_public|needs_approval>
// `missing` = no Drive link anywhere in the issue (the issue stays open: edit it and it runs again).

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderIdFromUrl, listFolder } from './lib/drive.mjs';
import { field, tidy, findDriveUrl, plainField } from './lib/issue.mjs';
import { discover, sourceKey } from './lib/discover.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = resolve(ROOT, 'data/sources.json');
const CONFIG = resolve(ROOT, 'data/config.json');
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

async function out(status, message) {
  console.log(`${status}: ${message}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `status=${status}\nmessage<<EOF\n${message}\nEOF\n`);
  }
}

// "Add drive: @handle" -> "@handle" (when the title is all that says who shared it).
const titleCredit = (title) => ((title || '').match(/^\s*add drive\s*:\s*(@\S+)/i) || [])[1] || '';

// Where an already-known drive came from, in words for the reply on the issue.
function where(origin) {
  if (!origin || origin === 'sources.json') return 'it was added to the list earlier';
  if (origin === 'shortcut') return 'it is a shortcut in the "AO3 - Drives" folder';
  if (origin.startsWith('doc:')) return `it is linked in the doc "${origin.slice(4)}" in the "AO3 - Drives" folder`;
  return 'it is already known';
}

async function findKnown(key, sources) {
  const manual = sources.find((s) => sourceKey(s.url) === key);
  if (manual) return { ...manual, origin: 'sources.json' };
  try {
    const config = JSON.parse(await readFile(CONFIG, 'utf8'));
    return (await discover(config)).find((s) => sourceKey(s.url) === key) || null;
  } catch (err) {
    // No network / master folder unreadable: don't block the request, the crawler
    // de-duplicates by id anyway.
    console.warn(`! could not check the master folder (${err.message}); only data/sources.json was checked`);
    return null;
  }
}

async function main() {
  const body = process.env.ISSUE_BODY || '';
  const url = findDriveUrl(process.env.ISSUE_TITLE, body);
  if (!url) {
    return out(
      'missing',
      "I couldn't find a Google Drive folder link in this issue. **Edit the issue and paste the link in the description** (it looks like `https://drive.google.com/drive/folders/…`, and the folder must be shared as “Anyone with the link”). I'll pick it up as soon as you save, or when you reopen it."
    );
  }
  const id = /^https:\/\/drive\.google\.com\//.test(url) ? folderIdFromUrl(url) : null;
  if (!id) return out('invalid', "That doesn't look like a Google Drive folder link (https://drive.google.com/drive/folders/…).");

  const sources = JSON.parse(await readFile(SOURCES, 'utf8'));
  const known = await findKnown(id, sources);
  if (known) {
    const label = [tidy(known.credit || '', 40), tidy(known.name || known.notes || '', 70)].filter(Boolean).join(' · ');
    return out('duplicate', `This drive is already in the list${label ? ` (${label})` : ''}: ${where(known.origin)}. Nothing to do, thanks! 💛`);
  }

  const trusted = TRUSTED.has(process.env.AUTHOR_ASSOCIATION) || process.env.APPROVED === 'true';
  if (!trusted) return out('needs_approval', 'Thanks! A maintainer will have a quick look and add the `approved` label, then the bot takes it from there.');

  const check = await listFolder(id);
  if (check.status !== 200) {
    return out('not_public', `Google says this folder isn't public (HTTP ${check.status}). Share it as "Anyone with the link" and add the \`approved\` label to retry.`);
  }

  sources.push({
    url: `https://drive.google.com/drive/folders/${id}`,
    credit: tidy(field(body, 'Who shared it') || plainField(body, 'Who shared it') || titleCredit(process.env.ISSUE_TITLE), 80),
    notes: tidy(field(body, "What's in it") || plainField(body, "What's in it"), 200),
    name: tidy(check.title || '', 120) || undefined,
  });
  await writeFile(SOURCES, JSON.stringify(sources, null, 2) + '\n');
  return out('added', `Added **${tidy(check.title || 'the drive', 120)}** (${check.entries.length} items at the top level). Its fics will be searchable after the indexing run that has just started.`);
}

main().catch(async (err) => {
  await out('error', `Something went wrong: ${err.message}`);
  process.exit(1);
});
