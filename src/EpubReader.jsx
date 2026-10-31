// In-browser EPUB reader. Loaded on demand, only when someone opens an EPUB.
// The file comes through the relay (api/file.js), is unzipped here (src/epub.js) and every
// chapter is sanitized before it is shown. Continuous scrolling, text size / font / width,
// paper-sepia-night, search, contents, remembers where you stopped.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './reader.css';
import './epub.css';
import { THEMES, store, driveUrl, downloadUrl, relayUrl, RelayError, Progress, Outline, Fallback } from './readerShared.jsx';
import { parseEpub } from './epub.js';

const FAMILIES = {
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
};
const WIDTHS = { narrow: 560, medium: 700, wide: 900 };
const LINES = { tight: 1.45, normal: 1.65, loose: 1.9 };
const SIZE_MIN = 70;
const SIZE_MAX = 220;
const DEFAULT_PREFS = { size: 100, family: 'serif', width: 'medium', line: 'normal' };
const MAX_HITS = 5000;

const nextTheme = (theme) => THEMES[(THEMES.findIndex((x) => x.key === theme) + 1) % THEMES.length].key;
const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

// Flat contents list (with depth) -> the nested shape <Outline> expects.
function nest(toc) {
  const root = [];
  const stack = [{ depth: -1, items: root }];
  for (const t of toc) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= t.depth) stack.pop();
    const node = { title: t.label, ch: t.ch, frag: t.frag, items: [] };
    stack[stack.length - 1].items.push(node);
    stack.push({ depth: t.depth, items: node.items });
  }
  return root;
}

export default function EpubReader({ fileId, title, author, onClose }) {
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const chapterEls = useRef([]);
  const texts = useRef([]); // plain text of each chapter, for search
  const anchor = useRef(null);
  const restored = useRef(false);
  const bookRef = useRef(null);

  const saved = useMemo(() => store.get(`reader:pos:epub:${fileId}`, {}), [fileId]);
  const [theme, setTheme] = useState(() => store.get('reader:theme', window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'paper'));
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_PREFS, ...store.get('reader:epub:prefs', {}) }));
  const [load, setLoad] = useState({ status: 'loading', loaded: 0, total: 0, error: null });
  const [book, setBook] = useState(null);
  const [pos, setPos] = useState({ ch: saved.ch || 0, frac: saved.frac || 0 });
  const [overall, setOverall] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [menu, setMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ hits: [], idx: -1, done: false });
  const [fullscreen, setFullscreen] = useState(false);

  // ---------- load ----------
  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    (async () => {
      const res = await fetch(relayUrl(fileId, 'epub'), { signal: abort.signal });
      if (!res.ok) throw new RelayError(res.status);
      const total = Number(res.headers.get('content-length') || 0);
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (!cancelled) setLoad((s) => ({ ...s, loaded, total }));
      }
      const buf = new Uint8Array(loaded);
      let at = 0;
      for (const c of chunks) {
        buf.set(c, at);
        at += c.length;
      }
      // let the progress bar paint before the (synchronous) unzip + sanitize
      await new Promise((r) => setTimeout(r, 0));
      const parsed = parseEpub(buf);
      if (cancelled) return parsed.dispose();
      bookRef.current = parsed;
      setBook(parsed);
      setLoad((s) => ({ ...s, status: 'ready' }));
    })().catch((error) => !cancelled && error.name !== 'AbortError' && setLoad((s) => ({ ...s, status: 'error', error })));
    return () => {
      cancelled = true;
      abort.abort();
      bookRef.current?.dispose();
    };
  }, [fileId]);

  const totalLength = useMemo(() => (book ? book.chapters.reduce((n, c) => n + c.textLength, 0) || 1 : 1), [book]);
  const before = useMemo(() => {
    let sum = 0;
    return book ? book.chapters.map((c) => ((sum += c.textLength), sum - c.textLength)) : [];
  }, [book]);

  // ---------- positions ----------
  const scrollToChapter = useCallback((i, frac = 0, frag = '') => {
    const box = scrollRef.current;
    const el = chapterEls.current[i];
    if (!box || !el) return;
    let top = el.offsetTop + frac * el.offsetHeight;
    if (frag) {
      const wanted = `c${i}-${frag}`;
      const target = [...el.querySelectorAll('[id]')].find((n) => n.id === wanted);
      if (target) top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
    }
    box.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }, []);

  const currentPosition = useCallback(() => {
    const box = scrollRef.current;
    if (!box || !chapterEls.current.length) return null;
    const y = box.scrollTop + 8;
    let lo = 0;
    let hi = chapterEls.current.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chapterEls.current[mid] && chapterEls.current[mid].offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    const el = chapterEls.current[lo];
    return { ch: lo, frac: Math.min(1, Math.max(0, (y - el.offsetTop) / Math.max(1, el.offsetHeight))) };
  }, []);

  const onScroll = useCallback(() => {
    if (!restored.current || !book) return;
    const p = currentPosition();
    if (!p) return;
    setPos((old) => (old.ch === p.ch && Math.abs(old.frac - p.frac) < 0.002 ? old : p));
    setOverall((before[p.ch] + p.frac * book.chapters[p.ch].textLength) / totalLength);
  }, [book, before, totalLength, currentPosition]);

  // Restore the saved place once the chapters are laid out.
  useLayoutEffect(() => {
    if (!book || restored.current) return;
    restored.current = true;
    texts.current = chapterEls.current.map((el) => el?.textContent || '');
    if (saved.ch || saved.frac) scrollToChapter(Math.min(saved.ch || 0, book.chapters.length - 1), saved.frac || 0);
    setOverall(((before[saved.ch || 0] || 0) + (saved.frac || 0) * (book.chapters[saved.ch || 0]?.textLength || 0)) / totalLength);
  }, [book, saved, before, totalLength, scrollToChapter]);

  useEffect(() => {
    if (!book) return;
    const t = setTimeout(() => store.set(`reader:pos:epub:${fileId}`, pos), 400);
    return () => clearTimeout(t);
  }, [book, fileId, pos]);
  useEffect(() => store.set('reader:theme', theme), [theme]);
  useEffect(() => store.set('reader:epub:prefs', prefs), [prefs]);

  // Changing the text size/width/spacing reflows everything: keep the reader on the same line.
  const changePrefs = (patch) => {
    anchor.current = currentPosition();
    setPrefs((p) => ({ ...p, ...patch }));
  };
  useLayoutEffect(() => {
    if (!anchor.current) return;
    const { ch, frac } = anchor.current;
    anchor.current = null;
    scrollToChapter(ch, frac);
  }, [prefs, scrollToChapter]);

  const jumpToOverall = (f) => {
    if (!book) return;
    const target = f * totalLength;
    let ch = 0;
    while (ch < book.chapters.length - 1 && before[ch + 1] <= target) ch++;
    scrollToChapter(ch, (target - before[ch]) / Math.max(1, book.chapters[ch].textLength));
  };

  const goChapter = (i) => book && scrollToChapter(Math.min(book.chapters.length - 1, Math.max(0, i)));

  // Links inside the book go through the reader instead of leaving the page.
  const onContentClick = (e) => {
    const a = e.target.closest?.('a');
    if (!a) return;
    const goto = a.getAttribute('data-goto');
    if (goto) {
      e.preventDefault();
      const [ch, ...frag] = goto.split('|');
      scrollToChapter(Number(ch), 0, frag.join('|'));
    } else if (!a.getAttribute('target')) e.preventDefault();
  };

  // ---------- search (plain text of every chapter; matches can span elements) ----------
  const rangeIndex = useRef(new Map());
  const nodesOf = (ch) => {
    if (!rangeIndex.current.has(ch)) {
      const list = [];
      const walker = document.createTreeWalker(chapterEls.current[ch], NodeFilter.SHOW_TEXT);
      let offset = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        list.push({ node: n, start: offset });
        offset += n.nodeValue.length;
      }
      rangeIndex.current.set(ch, list);
    }
    return rangeIndex.current.get(ch);
  };
  const rangeFor = (ch, start, end) => {
    const nodes = nodesOf(ch);
    const find = (pos) => {
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].start <= pos) lo = mid;
        else hi = mid - 1;
      }
      return nodes[lo];
    };
    const a = find(start);
    const b = find(Math.max(start, end - 1));
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a.node, Math.min(start - a.start, a.node.nodeValue.length));
    range.setEnd(b.node, Math.min(end - b.start, b.node.nodeValue.length));
    return range;
  };

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!book || !q) {
      setSearch({ hits: [], idx: -1, done: false });
      return;
    }
    const t = setTimeout(() => {
      const hits = [];
      for (let ch = 0; ch < texts.current.length && hits.length < MAX_HITS; ch++) {
        const hay = texts.current[ch].toLowerCase();
        for (let at = hay.indexOf(q); at >= 0 && hits.length < MAX_HITS; at = hay.indexOf(q, at + q.length)) hits.push({ ch, start: at, end: at + q.length });
      }
      const here = pos.ch;
      const first = Math.max(0, hits.findIndex((h) => h.ch >= here));
      setSearch({ hits, idx: hits.length ? first : -1, done: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, book]);

  // Paint the matches (CSS Custom Highlight API: no DOM changes) and scroll to the current one.
  useEffect(() => {
    if (supportsHighlights) {
      CSS.highlights.delete('epub-hit');
      CSS.highlights.delete('epub-cur');
    }
    if (!search.hits.length) return;
    const ranges = search.hits.map((h) => rangeFor(h.ch, h.start, h.end));
    const cur = ranges[search.idx];
    if (supportsHighlights) {
      CSS.highlights.set('epub-hit', new Highlight(...ranges.filter(Boolean)));
      if (cur) CSS.highlights.set('epub-cur', new Highlight(cur));
    } else if (cur) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(cur);
    }
    const box = scrollRef.current;
    if (cur && box) {
      const r = cur.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      box.scrollTo({ top: box.scrollTop + (r.top - b.top) - b.height * 0.35, behavior: 'auto' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(
    () => () => {
      if (supportsHighlights) {
        CSS.highlights.delete('epub-hit');
        CSS.highlights.delete('epub-cur');
      }
    },
    []
  );
  const stepHit = (dir) =>
    setSearch((s) => (s.hits.length ? { ...s, idx: (s.idx + dir + s.hits.length) % s.hits.length } : s));

  // ---------- chrome ----------
  useEffect(() => {
    rootRef.current?.focus();
    const prevFocus = document.activeElement;
    document.documentElement.classList.add('reader-open');
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.documentElement.classList.remove('reader-open');
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      prevFocus?.focus?.();
    };
  }, []);
  useEffect(() => {
    if (searchOpen) document.getElementById('reader-search')?.focus();
  }, [searchOpen]);

  // Closing a panel can remove the element that had the focus; without this the keyboard
  // shortcuts would stop working until the next click.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) rootRef.current?.focus();
  }, [sidebar, menu, searchOpen]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  const onKeyDown = (e) => {
    const typing = e.target.tagName === 'INPUT' && e.target.type !== 'range';
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc closes the top layer first: settings, then search, then contents, then the reader.
      if (menu) setMenu(false);
      else if (searchOpen) setSearchOpen(false);
      else if (sidebar) setSidebar(false);
      else onClose();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setSearchOpen(true);
      return;
    }
    if (typing) {
      if (e.key === 'Enter' && e.target.dataset.role === 'search') {
        e.preventDefault();
        stepHit(e.shiftKey ? -1 : 1);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === '/' || k === 'f') setSearchOpen(true);
    else if (k === ']' || k === 'n') goChapter(pos.ch + 1);
    else if (k === '[' || k === 'p') goChapter(pos.ch - 1);
    else if (k === '+' || k === '=') changePrefs({ size: Math.min(SIZE_MAX, prefs.size + 10) });
    else if (k === '-') changePrefs({ size: Math.max(SIZE_MIN, prefs.size - 10) });
    else if (k === '0') changePrefs({ size: 100 });
    else if (k === 't') setTheme(nextTheme(theme));
    else if (k === 'o' && book?.toc.length) setSidebar((s) => !s);
    else return;
    e.preventDefault();
  };

  const openContents = (item) => {
    if (item.ch >= 0) scrollToChapter(item.ch, 0, item.frag);
    if (window.innerWidth < 760) setSidebar(false);
  };
  const contents = useMemo(() => (book ? nest(book.toc) : []), [book]);
  const currentLabel = useMemo(() => {
    if (!book) return '';
    let label = '';
    for (const t of book.toc) if (t.ch >= 0 && t.ch <= pos.ch) label = t.label;
    return label;
  }, [book, pos.ch]);

  const vars = {
    '--epub-size': `${prefs.size}%`,
    '--epub-font': FAMILIES[prefs.family],
    '--epub-width': `${WIDTHS[prefs.width]}px`,
    '--epub-lh': LINES[prefs.line],
  };
  const themeLabel = THEMES.find((x) => x.key === theme)?.label;
  const shownTitle = title || book?.title || 'Untitled';
  const shownAuthor = author || book?.author;

  return (
    <div className="reader reader-epub" data-theme={theme} role="dialog" aria-modal="true" aria-label={`Reading: ${shownTitle}`} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="reader-bar">
        <div className="reader-row reader-row-top">
          <button className="rb" onClick={onClose} aria-label="Close the reader" title="Close (Esc)">
            ✕
          </button>
          <div className="reader-title">
            <strong>{shownTitle}</strong>
            {shownAuthor && <span> by {shownAuthor}</span>}
          </div>
          <div className="reader-tools">
            <button className={`rb ${searchOpen ? 'on' : ''}`} onClick={() => setSearchOpen((s) => !s)} aria-label="Search in the text" title="Search (/)" disabled={!book}>
              ⌕
            </button>
            {book?.toc.length > 0 && (
              <button className={`rb ${sidebar ? 'on' : ''}`} onClick={() => setSidebar((s) => !s)} aria-label="Contents" title="Contents (o)">
                ☰
              </button>
            )}
            <button className={`rb rb-aa ${menu ? 'on' : ''}`} onClick={() => setMenu((m) => !m)} aria-label="Text settings" aria-expanded={menu} title="Text settings" disabled={!book}>
              Aa
            </button>
            <button className="rb rb-wide" onClick={() => setTheme(nextTheme(theme))} title="Reading mode (t)" aria-label={`Reading mode: ${themeLabel}`}>
              ◐ <span className="rb-text">{themeLabel}</span>
            </button>
            {document.fullscreenEnabled && (
              <button className={`rb ${fullscreen ? 'on' : ''}`} onClick={toggleFullscreen} aria-label="Full screen" title="Full screen">
                ⛶
              </button>
            )}
            <a className="rb" href={downloadUrl(fileId)} aria-label="Download" title="Download">
              ⤓
            </a>
            <a className="rb" href={driveUrl(fileId)} target="_blank" rel="noreferrer" aria-label="Open in Google Drive" title="Open in Google Drive">
              ↗
            </a>
          </div>
        </div>

        {menu && book && (
          <div className="reader-menu" role="group" aria-label="Text settings">
            <div className="menu-row">
              <span className="menu-label">Size</span>
              <button className="rb" onClick={() => changePrefs({ size: Math.max(SIZE_MIN, prefs.size - 10) })} aria-label="Smaller text" title="Smaller (-)">
                A−
              </button>
              <button className="rb rb-zoom" onClick={() => changePrefs({ size: 100 })} title="Reset (0)">
                {prefs.size}%
              </button>
              <button className="rb" onClick={() => changePrefs({ size: Math.min(SIZE_MAX, prefs.size + 10) })} aria-label="Larger text" title="Larger (+)">
                A+
              </button>
            </div>
            <Choice label="Font" value={prefs.family} options={{ serif: 'Serif', sans: 'Sans' }} onChange={(family) => changePrefs({ family })} />
            <Choice label="Width" value={prefs.width} options={{ narrow: 'Narrow', medium: 'Medium', wide: 'Wide' }} onChange={(width) => changePrefs({ width })} />
            <Choice label="Spacing" value={prefs.line} options={{ tight: 'Tight', normal: 'Normal', loose: 'Loose' }} onChange={(line) => changePrefs({ line })} />
          </div>
        )}

        {searchOpen && book && (
          <div className="reader-row reader-row-search">
            <input id="reader-search" data-role="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search in this fic…" aria-label="Search in this fic" />
            <span className="search-count" aria-live="polite">
              {!query.trim() ? '' : !search.done ? '…' : search.hits.length ? `${search.idx + 1} / ${search.hits.length}${search.hits.length >= MAX_HITS ? '+' : ''}` : 'No match'}
            </span>
            <button className="rb" onClick={() => stepHit(-1)} disabled={!search.hits.length} aria-label="Previous match" title="Previous (Shift+Enter)">
              ↑
            </button>
            <button className="rb" onClick={() => stepHit(1)} disabled={!search.hits.length} aria-label="Next match" title="Next (Enter)">
              ↓
            </button>
          </div>
        )}
        {load.status === 'loading' && <Progress loaded={load.loaded} total={load.total} />}
      </header>

      <div className="reader-body">
        {sidebar && contents.length > 0 && (
          <nav className="reader-outline" aria-label="Contents">
            <Outline items={contents} onOpen={openContents} />
          </nav>
        )}
        {load.status === 'error' ? (
          <Fallback fileId={fileId} error={load.error} kind="epub" />
        ) : (
          <div className="reader-scroll epub-scroll" ref={scrollRef} onScroll={onScroll} onClick={onContentClick}>
            {book && (
              <article className="epub" style={vars} lang={book.language || undefined}>
                {book.chapters.map((c, i) => (
                  <section key={i} className="epub-ch" data-ch={i} ref={(el) => (chapterEls.current[i] = el)} dangerouslySetInnerHTML={{ __html: c.html }} />
                ))}
                <p className="epub-end">— End —</p>
              </article>
            )}
          </div>
        )}
      </div>

      {book && (
        <footer className="reader-foot">
          <button className="rb" onClick={() => goChapter(pos.ch - 1)} disabled={pos.ch <= 0} aria-label="Previous chapter" title="Previous chapter ([)">
            ‹
          </button>
          <div className="foot-mid">
            <input
              type="range"
              min="0"
              max="1000"
              value={Math.round(overall * 1000)}
              onChange={(e) => jumpToOverall(Number(e.target.value) / 1000)}
              aria-label="Reading progress"
              aria-valuetext={`${Math.round(overall * 100)}%`}
            />
            <span className="foot-label">
              {book.chapters.length > 1 ? `Part ${pos.ch + 1} of ${book.chapters.length}` : ''}
              {currentLabel && book.chapters.length > 1 ? ` · ${currentLabel}` : ''}
            </span>
          </div>
          <span className="foot-pct">{Math.round(overall * 100)}%</span>
          <button className="rb" onClick={() => goChapter(pos.ch + 1)} disabled={pos.ch >= book.chapters.length - 1} aria-label="Next chapter" title="Next chapter (])">
            ›
          </button>
        </footer>
      )}
    </div>
  );
}

function Choice({ label, value, options, onChange }) {
  return (
    <div className="menu-row">
      <span className="menu-label">{label}</span>
      <div className="seg">
        {Object.entries(options).map(([k, v]) => (
          <button key={k} className={k === value ? 'on' : ''} onClick={() => onChange(k)} aria-pressed={k === value}>
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}
