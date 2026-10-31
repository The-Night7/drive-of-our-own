// Opens an EPUB in the browser: unzip, read the package (spine + contents), and turn each
// chapter into SAFE html. An EPUB is untrusted third-party content shown inside our page, so
// every chapter goes through DOMPurify with a strict allow-list:
//   - no scripts, styles, frames, forms, objects, svg...; no event handlers; no classes;
//   - inline style reduced to a few typographic properties;
//   - images only if they come from inside the EPUB (turned into blob: URLs);
//   - links: inside the book -> in-reader navigation, http(s) -> new tab, anything else removed;
//   - ids are prefixed per chapter (no DOM clobbering, no clashes between chapters).

import { unzipSync, strFromU8 } from 'fflate';
import DOMPurify from 'dompurify';

export class EpubError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EpubError';
  }
}

const MAX_FILE = 40 * 1024 * 1024;
const MAX_TOTAL = 300 * 1024 * 1024; // uncompressed: protects against zip bombs

const ALLOWED_TAGS = [
  'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'id', 'style', 'dir', 'lang', 'align'];

const STYLE_OK = {
  'text-align': /^(left|right|center|justify|start|end)$/i,
  'font-style': /^(normal|italic|oblique)$/i,
  'font-weight': /^(normal|bold|bolder|lighter|[1-9]00)$/i,
  'text-decoration': /^(none|underline|line-through|overline)( (none|underline|line-through|overline))*$/i,
  'text-indent': /^-?[\d.]+(em|rem|px|%|ex)?$/i,
  'font-variant': /^(normal|small-caps)$/i,
  'white-space': /^(normal|pre|pre-wrap|pre-line|nowrap)$/i,
};
export function cleanStyle(style) {
  const out = [];
  for (const decl of String(style).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim().replace(/\s*!important$/i, '');
    if (STYLE_OK[prop]?.test(value)) out.push(`${prop}:${value}`);
  }
  return out.join(';');
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
// Resolves `href` (relative to the file at `from`) to a path inside the zip.
export function resolvePath(from, href) {
  let path = href.split('#')[0];
  try {
    path = decodeURIComponent(path);
  } catch {}
  const full = path.startsWith('/') ? path.slice(1) : dirOf(from) + path;
  const parts = [];
  for (const seg of full.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const fragmentOf = (href) => {
  const i = href.indexOf('#');
  if (i < 0) return '';
  try {
    return decodeURIComponent(href.slice(i + 1));
  } catch {
    return href.slice(i + 1);
  }
};

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}
const byLocal = (root, name) => [...root.getElementsByTagName('*')].filter((e) => e.localName === name);
const textOf = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

// The sanitizer hooks need to know which chapter they're working on.
let ctx = null;
let hooked = false;
function installHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!ctx || node.nodeType !== 1) return;
    if (node.hasAttribute('style')) {
      const s = cleanStyle(node.getAttribute('style'));
      if (s) node.setAttribute('style', s);
      else node.removeAttribute('style');
    }
    if (node.hasAttribute('id')) node.setAttribute('id', `c${ctx.index}-${node.getAttribute('id')}`);
    const tag = node.tagName;
    if (tag === 'A') {
      const href = node.getAttribute('href');
      node.removeAttribute('href');
      if (href === null) return;
      if (href.startsWith('#')) {
        node.setAttribute('href', '#');
        node.setAttribute('data-goto', `${ctx.index}|${fragmentOf(href)}`);
      } else if (/^https?:/i.test(href)) {
        node.setAttribute('href', href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        const target = ctx.spineIndex.get(resolvePath(ctx.path, href));
        if (target !== undefined) {
          node.setAttribute('href', '#');
          node.setAttribute('data-goto', `${target}|${fragmentOf(href)}`);
        }
      }
    } else if (tag === 'IMG') {
      const src = node.getAttribute('src') || '';
      const url = /^[a-z][a-z0-9+.-]*:/i.test(src) ? null : ctx.blobUrl(resolvePath(ctx.path, src));
      if (url) node.setAttribute('src', url);
      else node.remove(); // never load anything from outside the book
    }
  });
}

function sanitize(html, chapter) {
  installHooks();
  ctx = chapter;
  try {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
  } finally {
    ctx = null;
  }
}

// Chapter file -> inner html of its <body>. XHTML is parsed as XML first (so `<div/>` isn't
// misread as an open tag), with the lenient HTML parser as a fallback.
function bodyHtml(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (!xml.getElementsByTagName('parsererror').length) {
    const body = byLocal(xml, 'body')[0];
    if (body) return new XMLSerializer().serializeToString(body);
  }
  return new DOMParser().parseFromString(text, 'text/html').body.innerHTML;
}

function readToc(files, manifest, spineIndex, opfPath, tocId, readText) {
  const entries = [];
  const add = (label, href, from, depth) => {
    const path = resolvePath(from, href);
    const ch = spineIndex.get(path);
    if (ch !== undefined && label) entries.push({ label, ch, frag: fragmentOf(href), depth });
  };
  // EPUB 3 navigation document
  const nav = [...manifest.values()].find((m) => /(^|\s)nav(\s|$)/.test(m.props));
  if (nav && files[nav.path]) {
    const doc = new DOMParser().parseFromString(readText(nav.path), 'text/html');
    const navEl = [...doc.querySelectorAll('nav')].find((n) => /(^|\s)toc(\s|$)/.test(n.getAttribute('epub:type') || '')) || doc.querySelector('nav');
    const walk = (list, depth) => {
      for (const li of list.children) {
        if (li.tagName !== 'LI') continue;
        const a = li.querySelector(':scope > a, :scope > span > a');
        if (a?.getAttribute('href')) add(textOf(a), a.getAttribute('href'), nav.path, depth);
        else if (li.querySelector(':scope > span')) entries.push({ label: textOf(li.querySelector(':scope > span')), ch: -1, frag: '', depth });
        const sub = li.querySelector(':scope > ol');
        if (sub) walk(sub, depth + 1);
      }
    };
    const ol = navEl?.querySelector('ol');
    if (ol) walk(ol, 0);
  }
  if (entries.length) return entries;
  // EPUB 2 NCX
  const ncx = (tocId && manifest.get(tocId)) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
  if (ncx && files[ncx.path]) {
    const doc = parseXml(readText(ncx.path));
    const map = doc && byLocal(doc, 'navMap')[0];
    const walk = (parent, depth) => {
      for (const p of parent.children) {
        if (p.localName !== 'navPoint') continue;
        const label = textOf(byLocal(p, 'text')[0]);
        const src = byLocal(p, 'content')[0]?.getAttribute('src');
        if (src) add(label, src, ncx.path, depth);
        walk(p, depth + 1);
      }
    };
    if (map) walk(map, 0);
  }
  return entries;
}

// buf: Uint8Array of the .epub file. Returns the book; call book.dispose() when done (frees images).
export function parseEpub(buf) {
  let total = 0;
  let files;
  try {
    files = unzipSync(buf, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        if (f.originalSize > MAX_FILE) return false;
        total += f.originalSize;
        if (total > MAX_TOTAL) throw new EpubError('This EPUB is too large to open here.');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof EpubError) throw err;
    throw new EpubError('Not a valid EPUB (zip).');
  }
  const readText = (path) => (files[path] ? strFromU8(files[path]) : '');

  const container = parseXml(readText('META-INF/container.xml'));
  let opfPath = container && byLocal(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !files[opfPath]) opfPath = Object.keys(files).find((n) => n.toLowerCase().endsWith('.opf'));
  if (!opfPath) throw new EpubError('No package file in this EPUB.');
  const opf = parseXml(readText(opfPath));
  if (!opf) throw new EpubError('Unreadable package file.');

  const manifest = new Map();
  for (const it of byLocal(opf, 'item')) {
    const href = it.getAttribute('href');
    if (href) manifest.set(it.getAttribute('id'), { path: resolvePath(opfPath, href), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  }
  const isHtml = (m) => /x?html/.test(m.type) || /\.x?html?$/i.test(m.path);
  const spineItems = byLocal(opf, 'itemref')
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((m) => m && isHtml(m) && files[m.path]);
  if (!spineItems.length) throw new EpubError('This EPUB has no readable chapters.');
  const spineIndex = new Map(spineItems.map((m, i) => [m.path, i]));

  const blobs = new Map();
  const blobUrl = (path) => {
    if (!files[path]) return null;
    if (!blobs.has(path)) {
      const mime = MIME[path.split('.').pop().toLowerCase()];
      if (!mime) return null;
      blobs.set(path, URL.createObjectURL(new Blob([files[path]], { type: mime })));
    }
    return blobs.get(path);
  };

  const chapters = spineItems.map((m, index) => {
    const html = sanitize(bodyHtml(readText(m.path)), { index, path: m.path, spineIndex, blobUrl });
    // An inert document: measuring the text must not start loading the images.
    const probe = new DOMParser().parseFromString(html, 'text/html');
    return { path: m.path, html, textLength: (probe.body.textContent || '').length, heading: textOf(probe.querySelector('h1,h2,h3,h4')) };
  });

  const tocId = byLocal(opf, 'spine')[0]?.getAttribute('toc');
  let toc = readToc(files, manifest, spineIndex, opfPath, tocId, readText);
  if (!toc.length) toc = chapters.map((c, i) => ({ label: c.heading || `Chapter ${i + 1}`, ch: i, frag: '', depth: 0 })).filter((t) => chapters.length > 1);

  const meta = (name) => textOf(byLocal(opf, name)[0]);
  return {
    title: meta('title'),
    author: byLocal(opf, 'creator').map(textOf).filter(Boolean).join(', '),
    language: meta('language'),
    chapters,
    toc,
    dispose: () => blobs.forEach((u) => URL.revokeObjectURL(u)),
  };
}
