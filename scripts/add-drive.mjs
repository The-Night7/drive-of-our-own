#!/usr/bin/env node
// Used by .github/workflows/add-drive.yml: reads an "Add a drive" issue (from the
// site's form) and appends the drive to data/sources.json.
//
// Env: ISSUE_BODY, AUTHOR_ASSOCIATION, APPROVED ("true" when the "approved" label is on).
// Prints a result line for the workflow: status=<added|duplicate|invalid|not_public|needs_approval>

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderIdFromUrl, listFolder } from './lib/drive.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = resolve(ROOT, 'data/sources.json');
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Issue forms render as "### Label\n\nvalue".
function field(body, label) {
  const re = new RegExp(`###\\s*${label}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`, 'i');
  const v = (body.match(re) || [])[1]?.trim() || '';
  return v === '_No response_' ? '' : v;
}
const tidy = (s, max) => s.replace(/[\r\n\t]+/g, ' ').replace(/[<>`]/g, '').trim().slice(0, max);

async function out(status, message) {
  console.log(`${status}: ${message}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `status=${status}\nmessage<<EOF\n${message}\nEOF\n`);
  }
}

async function main() {
  const body = process.env.ISSUE_BODY || '';
  const url = field(body, 'Drive folder link');
  const id = /^https:\/\/drive\.google\.com\//.test(url) ? folderIdFromUrl(url) : null;
  if (!id) return out('invalid', "That doesn't look like a Google Drive folder link (https://drive.google.com/drive/folders/…).");

  const sources = JSON.parse(await readFile(SOURCES, 'utf8'));
  if (sources.some((s) => folderIdFromUrl(s.url) === id)) return out('duplicate', 'This drive is already in the list. 💛');

  const trusted = TRUSTED.has(process.env.AUTHOR_ASSOCIATION) || process.env.APPROVED === 'true';
  if (!trusted) return out('needs_approval', 'Thanks! A maintainer will have a quick look and add the `approved` label, then the bot takes it from there.');

  const check = await listFolder(id);
  if (check.status !== 200) {
    return out('not_public', `Google says this folder isn't public (HTTP ${check.status}). Share it as "Anyone with the link" and add the \`approved\` label to retry.`);
  }

  sources.push({
    url: `https://drive.google.com/drive/folders/${id}`,
    credit: tidy(field(body, 'Who shared it'), 80),
    notes: tidy(field(body, "What's in it"), 200),
    name: tidy(check.title || '', 120) || undefined,
  });
  await writeFile(SOURCES, JSON.stringify(sources, null, 2) + '\n');
  return out('added', `Added **${tidy(check.title || 'the drive', 120)}** (${check.entries.length} items at the top level). Its fics will be searchable after the indexing run that has just started.`);
}

main().catch(async (err) => {
  await out('error', `Something went wrong: ${err.message}`);
  process.exit(1);
});
