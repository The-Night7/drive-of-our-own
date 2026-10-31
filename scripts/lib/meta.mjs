// Pulls AO3-style metadata (rating, fandoms, relationships, tags, summary…) out of
// a downloaded EPUB or PDF. Works with AO3's own downloads and with the common
// "title page" style used by other exporters (FicHub, FanFicFare…).

import { unzipSync, strFromU8 } from 'fflate';
import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from './drive.mjs';

// label (lower-case, no colon) -> field
const LABELS = {
  rating: 'rating', ratings: 'rating',
  'archive warning': 'warnings', 'archive warnings': 'warnings', warning: 'warnings', warnings: 'warnings',
  category: 'categories', categories: 'categories',
  fandom: 'fandoms', fandoms: 'fandoms',
  relationship: 'relationships', relationships: 'relationships', pairing: 'relationships', pairings: 'relationships',
  character: 'characters', characters: 'characters',
  'additional tags': 'freeforms', 'additional tag': 'freeforms', freeform: 'freeforms', tags: 'freeforms',
  language: 'language',
  stats: 'stats',
  series: 'series',
  collections: 'collections',
  status: 'status',
  published: 'published',
  updated: 'updated',
  completed: 'completed',
  words: 'words',
  chapters: 'chapters',
  summary: 'summary',
  author: 'author', authors: 'author',
};
const LIST_FIELDS = new Set(['warnings', 'categories', 'fandoms', 'relationships', 'characters', 'freeforms']);
const LABEL_RE = new RegExp(
  `^\\s*(${Object.keys(LABELS).sort((a, b) => b.length - a.length).map((l) => l.replace(/ /g, '\\s+')).join('|')})\\s*:\\s*(.*)$`,
  'i'
);

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const splitList = (s) =>
  s
    .split(/,(?![^()]*\))/) // AO3 tags can't contain commas, but keep "(Formula 1 RPF)" disambiguators intact
    .map(clean)
    .filter((x) => x && x.length < 200);

function htmlToText(html) {
  return decode(
    html
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<\/dt>\s*<dd[^>]*>/gi, ' ') // AO3 preface: <dt>Rating:</dt><dd>…</dd>
      .replace(/<(br|\/p|\/div|\/h\d|\/li|\/dd|\/dt|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').replace(/\s+$/, ''))
    .join('\n');
}

// Reads "Label: value" lines. Indented lines right after a list field continue it
// (that's how pdftotext -layout wraps long tag lists).
const STOP = /^\s*(notes?\s*:?|chapter\s+\d+|chapter text|see the end|author'?s?\s+notes?|work text|chapter\s+one)\s*:?\s*$/i;

export function parseFields(text) {
  const out = {};
  const lines = text.split('\n');
  let current = null;
  let summaryLines = null;
  let seen = 0;
  for (let i = 0; i < lines.length && i < 400; i++) {
    const line = lines[i];
    // Once the info block is behind us, author notes ("Warnings: …") must not count as tags.
    if (seen && !summaryLines && STOP.test(line)) break;
    if (summaryLines) {
      // A form feed is a PDF page break: AO3 PDFs start the work on a new page.
      if (line.includes('\f')) {
        summaryLines = null;
        current = null;
        continue;
      }
      if (/^\s*(notes?|chapter\s+\d+|chapter text|see the end|work text)\b/i.test(line) || (LABEL_RE.test(line) && !/^\s*summary/i.test(line))) {
        summaryLines = null;
      } else {
        summaryLines.push(line.trim());
        if (summaryLines.join(' ').length > 1200) summaryLines = null;
        continue;
      }
    }
    const m = line.match(LABEL_RE);
    if (m) {
      const field = LABELS[m[1].toLowerCase().replace(/\s+/g, ' ')];
      const value = m[2];
      if (field === 'summary') {
        summaryLines = value ? [value] : [];
        out.summaryLines = summaryLines;
        current = null;
        continue;
      }
      seen++;
      if (out[field] !== undefined) {
        current = null; // first occurrence wins
        continue;
      }
      out[field] = value;
      current = LIST_FIELDS.has(field) || field === 'stats' ? field : null;
      continue;
    }
    if (current && /^\s{2,}\S/.test(line) && line.trim()) {
      // "Rape/Non-" + "Con" → "Rape/Non-Con" (pdftotext wraps at hyphens)
      out[current] = /[-/]$/.test(out[current]) ? out[current] + line.trim() : out[current] + ' ' + line.trim();
      continue;
    }
    // A bare "Summary" heading (AO3 PDFs) starts the summary on the next lines.
    if (/^\s*summary\s*$/i.test(line) && !out.summaryLines) {
      summaryLines = [];
      out.summaryLines = summaryLines;
    }
    current = null;
  }
  return out;
}

// AO3's fixed vocabularies. Anything else in these fields is an author's note, not a tag.
const squash = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const CANON = {
  rating: ['General Audiences', 'Teen And Up Audiences', 'Mature', 'Explicit', 'Not Rated'],
  warnings: ['Creator Chose Not To Use Archive Warnings', 'Graphic Depictions Of Violence', 'Major Character Death', 'No Archive Warnings Apply', 'Rape/Non-Con', 'Underage Sex'],
  categories: ['F/F', 'F/M', 'Gen', 'M/M', 'Multi', 'Other'],
};
const ALIASES = { choosenottousearchivewarnings: 'Creator Chose Not To Use Archive Warnings', underage: 'Underage Sex', teenandupaudience: 'Teen And Up Audiences', general: 'General Audiences', teen: 'Teen And Up Audiences', notrated: 'Not Rated' };
const canonMap = Object.fromEntries(Object.values(CANON).flat().map((v) => [squash(v), v]));
const canon = (v) => canonMap[squash(v)] || ALIASES[squash(v)] || null;
const CAT_SQUASH = { ff: 'F/F', fm: 'F/M', mm: 'M/M', gen: 'Gen', multi: 'Multi', other: 'Other' };

function normalize(raw, extra = {}) {
  const text = raw._text || '';
  const meta = {};
  const lists = {};
  for (const f of LIST_FIELDS) if (raw[f]) lists[f] = splitList(raw[f]);
  if (lists.warnings) lists.warnings = [...new Set(lists.warnings.map(canon).filter(Boolean))];
  if (lists.categories) lists.categories = [...new Set(lists.categories.map((c) => CAT_SQUASH[squash(c)]).filter(Boolean))];
  Object.assign(meta, lists);
  if (raw.rating) {
    const r = canon(clean(raw.rating.split(',')[0]));
    if (r && CANON.rating.includes(r)) meta.rating = r;
  }
  if (raw.language) meta.language = clean(raw.language);

  const stats = [raw.stats, raw.words && `Words: ${raw.words}`, raw.chapters && `Chapters: ${raw.chapters}`, raw.published && `Published: ${raw.published}`, raw.completed && `Completed: ${raw.completed}`, raw.status && `Status: ${raw.status}`, raw.updated && `Updated: ${raw.updated}`]
    .filter(Boolean)
    .join(' ');
  const words = stats.match(/Words:\s*([\d][\d,.\s]*)/i);
  if (words) meta.words = Number(words[1].replace(/[^\d]/g, '')) || undefined;
  const ch = stats.match(/Chapters:\s*(\d+)\s*\/\s*(\d+|\?)/i);
  if (ch) {
    meta.chapters = `${ch[1]}/${ch[2]}`;
    meta.complete = ch[2] !== '?' && ch[1] === ch[2];
  }
  if (/Status:\s*(Completed?|Complete)/i.test(stats) || /Completed:\s*\d/i.test(stats)) meta.complete = true;
  else if (/Status:\s*(In[- ]Progress|Ongoing|WIP)/i.test(stats)) meta.complete = false;
  const pub = stats.match(/Published:\s*(\d{4}-\d{2}-\d{2})/i);
  if (pub) meta.published = pub[1];

  const ao3 = text.match(/archiveofourown\.org\/works\/(\d+)/);
  if (ao3) meta.ao3Id = ao3[1];

  meta.author = clean(extra.author || raw.author || '') || undefined;
  meta.title = clean(extra.title || '') || undefined;
  // Wrapped lines join with a space; blank lines separate paragraphs.
  let summary = extra.summary || (raw.summaryLines || []).map((l) => l || '\n').join(' ');
  summary = summary.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
  if (summary) meta.summary = summary.length > 700 ? summary.slice(0, 680).replace(/\s+\S*$/, '') + '…' : summary;

  for (const k of Object.keys(meta)) if (meta[k] === undefined || (Array.isArray(meta[k]) && !meta[k].length)) delete meta[k];
  const useful = meta.fandoms || meta.relationships || meta.freeforms || meta.rating || meta.characters || meta.ao3Id;
  return useful ? meta : null;
}

// ---------- EPUB ----------

export function parseEpub(buf) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buf), {
      filter: (f) => /\.(opf|x?html?|ncx)$/i.test(f.name) || f.name === 'META-INF/container.xml',
    });
  } catch {
    return null;
  }
  const names = Object.keys(files);
  const read = (n) => (files[n] ? strFromU8(files[n]) : '');
  const opfName = names.find((n) => n.endsWith('.opf'));
  const opf = opfName ? read(opfName) : '';
  const tag = (t) => (opf.match(new RegExp(`<dc:${t}\\b[^>]*>([\\s\\S]*?)<\\/dc:${t}>`, 'i')) || [])[1];
  const extra = {
    title: tag('title') && decode(tag('title')),
    author: [...opf.matchAll(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => decode(m[1]).trim()).join(', '),
    summary: tag('description') ? htmlToText(decode(tag('description'))).trim() : '',
  };

  // Read documents in spine order; the metadata page is near the front.
  const base = opfName && opfName.includes('/') ? opfName.slice(0, opfName.lastIndexOf('/') + 1) : '';
  const manifest = Object.fromEntries([...opf.matchAll(/<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/gi)].map((m) => [m[1], m[2]]));
  for (const m of opf.matchAll(/<item\b[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"/gi)) manifest[m[2]] ||= m[1];
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/gi)].map((m) => manifest[m[1]]).filter(Boolean);
  let docs = spine.map((h) => base + decodeURIComponent(h.split('#')[0]));
  if (!docs.length) docs = names.filter((n) => /\.x?html?$/i.test(n)).sort();
  const front = docs.slice(0, 4).filter((n) => files[n]);
  // Use the first document that looks like an info page (AO3 preface / title page).
  const tagFields = (r) => ['rating', 'fandoms', 'relationships', 'characters', 'freeforms', 'warnings', 'categories'].filter((k) => r[k]).length;
  let raw = null;
  for (const n of front) {
    const r = parseFields(htmlToText(read(n)));
    if (tagFields(r) >= 2) {
      raw = r;
      break;
    }
  }
  const text = front.map((n) => htmlToText(read(n))).join('\n');
  raw ||= parseFields(text);
  raw._text = front.map(read).join('\n') + '\n' + opf; // raw HTML keeps the AO3 link
  // dc:subject often carries tags when there's no title page.
  if (!raw.freeforms) {
    const subjects = [...opf.matchAll(/<dc:subject\b[^>]*>([\s\S]*?)<\/dc:subject>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean);
    if (subjects.length) raw.freeforms = subjects.join(', ');
  }
  // FicHub/FFF title pages write "Title by Author" in the heading.
  if (!extra.author) {
    const by = text.match(/^\s*.+?\s+by\s+(.+)$/m);
    if (by) extra.author = by[1];
  }
  return normalize(raw, extra);
}

// ---------- PDF ----------

let hasPdftotext = null;
const run = (cmd, args) =>
  new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 30000 }, (e, out) => (e ? rej(e) : res(out))));

export async function pdfAvailable() {
  if (hasPdftotext === null) {
    try {
      await run('pdftotext', ['-v']);
      hasPdftotext = true;
    } catch (e) {
      hasPdftotext = e.code !== 'ENOENT';
    }
  }
  return hasPdftotext;
}

let tmp;
export async function parsePdf(buf) {
  if (!(await pdfAvailable())) return undefined; // undefined = "couldn't try", not "no metadata"
  tmp ||= await mkdtemp(join(tmpdir(), 'dooo-'));
  const file = join(tmp, `${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  await writeFile(file, buf);
  try {
    const text = await run('pdftotext', ['-layout', '-enc', 'UTF-8', '-l', '3', file, '-']);
    const raw = parseFields(text);
    raw._text = text;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const extra = {};
    // AO3 PDFs: the title, then "by author" right under it (after the tag block).
    const byIdx = lines.findIndex((l, i) => i < 80 && /^by\s+\S/i.test(l));
    if (byIdx > 0) {
      extra.author = lines[byIdx].replace(/^by\s+/i, '');
      extra.title = lines[byIdx - 1];
    } else if (lines[0] && lines[0].length < 200) extra.title = lines[0];
    return normalize(raw, extra);
  } catch {
    return null;
  } finally {
    unlink(file).catch(() => {});
  }
}
