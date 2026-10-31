// Small helpers for reading public Google Drive folders and Docs without an API key.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const UA = 'Mozilla/5.0 (compatible; drive-of-our-own indexer; +https://github.com/The-Night7/drive-of-our-own)';

export function folderIdFromUrl(url) {
  const m = String(url).match(/\/folders\/([\w-]{10,})/) || String(url).match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : null;
}

export function fileIdFromUrl(url) {
  const m = String(url).match(/\/(?:file|document|spreadsheets|presentation)\/d\/([\w-]{10,})/);
  return m ? m[1] : null;
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', eacute: 'é',
  egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', aacute: 'á', auml: 'ä', ccedil: 'ç', icirc: 'î',
  iuml: 'ï', iacute: 'í', ocirc: 'ô', oacute: 'ó', ouml: 'ö', ucirc: 'û', ugrave: 'ù', uacute: 'ú', uuml: 'ü',
  ntilde: 'ñ', oelig: 'œ', aelig: 'æ', szlig: 'ß', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç',
};

// Every Latin-1 named entity (codepoints 160-255), so accented letters never stay encoded.
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
LATIN1.forEach((n, i) => {
  NAMED[n] ??= String.fromCharCode(160 + i);
});

const decodeOnce = (s) =>
  s
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => (parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(n, 16)) : m))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => (Object.hasOwn(NAMED, name) ? NAMED[name] : m));

// Some exporters escape twice ("&amp;amp;"), so decode until nothing changes (3 passes at most).
export const decode = (s) => {
  let out = String(s);
  for (let k = 0; k < 3; k++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
};

// GET with retries on network errors / 429 / 5xx. Returns the Response, or null on 4xx.
export async function getWithRetry(url, { tries = 5, timeoutMs = 60000 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt === tries - 1) throw err;
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Lists one folder through Drive's public "embedded folder view".
// Returns { status, title, entries } — status 200 means readable, 401/403/404 means not public.
export async function listFolder(id) {
  const res = await getWithRetry(`https://drive.google.com/embeddedfolderview?id=${id}`);
  if (!res.ok) return { status: res.status, title: null, entries: [] };
  const html = await res.text();
  return { status: 200, ...parseFolder(html) };
}

export function parseFolder(html) {
  const title = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim();
  const entries = [];
  // Parse each entry on its own so one odd entry can't swallow its neighbours.
  for (const chunk of html.split('<div class="flip-entry" id="entry-').slice(1)) {
    const id = (chunk.match(/^([\w-]+)"/) || [])[1];
    const href = (chunk.match(/<a href="([^"]+)"/) || [])[1];
    const rawTitle = (chunk.match(/<div class="flip-entry-title">([^<]*)<\/div>/) || [])[1];
    if (!id || !href || rawTitle == null) continue;
    const listIcon = chunk.match(/<div class="flip-entry-list-icon">([\s\S]*?)<\/div>/)?.[1] || '';
    const icon = (listIcon.match(/src="([^"]*)"/) || [])[1] || listIcon;
    const modified = (chunk.match(/<div class="flip-entry-last-modified"><div>([^<]*)<\/div>/) || [])[1] || '';
    const url = decode(href);
    const isFolder = /\/folders\//.test(url) || /aria-label="Folder"|folder-(grid|list)/.test(chunk);
    entries.push({ id, href: url, icon, name: decode(rawTitle).trim(), modified: decode(modified).trim(), isFolder });
  }
  return { title, entries };
}

// Reads a public Google Doc as HTML and returns its blocks (list items / paragraphs)
// as { text, links } with Google's redirect wrappers removed.
export async function readDocBlocks(docId) {
  const res = await getWithRetry(`https://docs.google.com/document/d/${docId}/export?format=html`);
  if (!res.ok) return null;
  const html = await res.text();
  const blocks = [];
  const re = /<(li|p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const inner = m[2];
    const text = decode(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const links = [...inner.matchAll(/href="([^"]+)"/g)].map((x) => unwrapGoogleUrl(decode(x[1])));
    blocks.push({ tag: m[1], text, links });
  }
  return blocks;
}

export function unwrapGoogleUrl(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?google\.com\/url\?q=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : url;
}
