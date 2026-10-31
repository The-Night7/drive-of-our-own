// In-browser PDF reader (pdf.js). Loaded on demand, only when someone opens a PDF.
//
// The file is read straight from Google Drive: its download endpoint answers with
// `access-control-allow-origin: *`, so no server in between and nothing is re-hosted.
// Files Google won't serve (private, or over their download quota) get Drive's own viewer.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import './reader.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const THEMES = [
  { key: 'paper', label: 'Paper' },
  { key: 'sepia', label: 'Sepia' },
  { key: 'night', label: 'Night' },
];
const MAX_PAGE_WIDTH = 980; // "fit width" never goes wider than this on big screens
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;

const driveUrl = (id) => `https://drive.google.com/file/d/${id}/view`;
const downloadUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
const previewUrl = (id) => `https://drive.google.com/file/d/${id}/preview`;

// localStorage can throw (private mode, blocked): the reader must work without it.
const store = {
  get(key, fallback) {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// Occurrences of `q` in a page's text items. Items are joined with a space, so a phrase split over
// two lines still matches. Returns, for each occurrence, the first and last item it touches.
export function findMatches(strs, q) {
  const needle = q.toLowerCase();
  if (!needle) return [];
  const starts = [];
  let text = '';
  strs.forEach((s, i) => {
    starts.push(text.length);
    text += s + (i < strs.length - 1 ? ' ' : '');
  });
  const hay = text.toLowerCase();
  const out = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0 || out.length > 5000) break;
    const end = at + needle.length;
    let first = starts.length - 1;
    while (first > 0 && starts[first] > at) first--;
    let last = first;
    while (last < starts.length - 1 && starts[last + 1] < end) last++;
    out.push([first, last]);
    from = at + Math.max(1, needle.length);
  }
  return out;
}

export default function PdfReader({ fileId, title, author, onClose }) {
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const pageEls = useRef([]);
  const anchor = useRef(null);
  const textCache = useRef(new Map());
  const docRef = useRef(null);

  const saved = useMemo(() => store.get(`reader:pos:${fileId}`, {}), [fileId]);
  // First visit: follow the phone's dark mode; after that, the last choice.
  const [theme, setTheme] = useState(() => store.get('reader:theme', window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'paper'));
  const [zoom, setZoom] = useState(saved.zoom || 1);
  const [load, setLoad] = useState({ status: 'loading', loaded: 0, total: 0, error: null });
  const [doc, setDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [base, setBase] = useState(null); // size of page 1 at scale 1
  const [sizes, setSizes] = useState({}); // page -> [w, h] at scale 1, when it differs from `base`
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(saved.page || 1);
  const [outline, setOutline] = useState(null);
  const [sidebar, setSidebar] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ running: false, hits: [], idx: -1, done: false });
  const [pageInput, setPageInput] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const restored = useRef(false);

  // ---------- load the document ----------
  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url: downloadUrl(fileId), disableRange: true, isEvalSupported: false });
    task.onProgress = ({ loaded, total }) => !cancelled && setLoad((s) => ({ ...s, loaded, total: total || 0 }));
    task.promise
      .then(async (d) => {
        if (cancelled) return;
        const p1 = await d.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        docRef.current = d;
        setBase([vp.width, vp.height]);
        setNumPages(d.numPages);
        setDoc(d);
        setLoad((s) => ({ ...s, status: 'ready' }));
        d.getOutline().then((o) => !cancelled && o?.length && setOutline(o)).catch(() => {});
      })
      .catch((error) => !cancelled && setLoad((s) => ({ ...s, status: 'error', error })));
    return () => {
      cancelled = true;
      task.destroy().catch?.(() => {});
    };
  }, [fileId]);

  // ---------- geometry ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  const pad = width < 600 ? 8 : 24;
  const fit = base && width ? Math.min(width - pad * 2, MAX_PAGE_WIDTH) / base[0] : 1;
  const scale = fit * zoom;
  const sizeOf = (n) => sizes[n] || base || [612, 792];

  const goTo = useCallback((n, smooth = false) => {
    const el = pageEls.current[n];
    const box = scrollRef.current;
    if (el && box) box.scrollTo({ top: el.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Keep the reading position when the zoom or the window size changes.
  const keepPosition = () => {
    const box = scrollRef.current;
    const el = pageEls.current[page];
    if (box && el) anchor.current = { page, frac: Math.max(0, (box.scrollTop - el.offsetTop) / Math.max(1, el.offsetHeight)) };
  };
  useLayoutEffect(() => {
    if (!anchor.current) return;
    const { page: p, frac } = anchor.current;
    anchor.current = null;
    const el = pageEls.current[p];
    if (el && scrollRef.current) scrollRef.current.scrollTop = el.offsetTop + frac * el.offsetHeight;
  }, [scale]);

  // Restore the last page once the layout exists.
  useLayoutEffect(() => {
    if (!doc || restored.current || !width) return;
    restored.current = true;
    if (page > 1) goTo(Math.min(page, numPages));
  }, [doc, width, page, numPages, goTo]);

  // Current page = the one under the upper third of the screen.
  const onScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box || !restored.current) return;
    const y = box.scrollTop + box.clientHeight * 0.33;
    let lo = 1;
    let hi = pageEls.current.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pageEls.current[mid] && pageEls.current[mid].offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    setPage((p) => (p === lo ? p : lo));
  }, []);

  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => store.set(`reader:pos:${fileId}`, { page, zoom }), 400);
    return () => clearTimeout(t);
  }, [doc, fileId, page, zoom]);
  useEffect(() => store.set('reader:theme', theme), [theme]);

  const changeZoom = (next) => {
    keepPosition();
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100)));
  };

  const onSize = useCallback((n, w, h) => {
    setSizes((s) => {
      const cur = s[n];
      if (cur && Math.abs(cur[0] - w) < 0.5 && Math.abs(cur[1] - h) < 0.5) return s;
      return { ...s, [n]: [w, h] };
    });
  }, []);

  // ---------- search ----------
  const pageStrings = useCallback(async (n) => {
    if (!textCache.current.has(n)) {
      const pg = await docRef.current.getPage(n);
      const tc = await pg.getTextContent();
      textCache.current.set(n, tc.items.map((it) => it.str));
    }
    return textCache.current.get(n);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!doc || !q) {
      setSearch({ running: false, hits: [], idx: -1, done: false });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearch({ running: true, hits: [], idx: -1, done: false });
      const hits = [];
      for (let n = 1; n <= numPages && !cancelled; n++) {
        const m = findMatches(await pageStrings(n), q);
        m.forEach((_, k) => hits.push({ page: n, k }));
        if (n % 10 === 0 || n === numPages) setSearch((s) => ({ ...s, hits: hits.slice() }));
      }
      if (cancelled) return;
      // start from the first hit at or after the page being read
      const first = Math.max(0, hits.findIndex((h) => h.page >= page));
      setSearch({ running: false, hits, idx: hits.length ? first : -1, done: true });
      if (hits.length) goTo(hits[first].page);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, doc]);

  const stepHit = (dir) => {
    setSearch((s) => {
      if (!s.hits.length) return s;
      const idx = (s.idx + dir + s.hits.length) % s.hits.length;
      goTo(s.hits[idx].page);
      return { ...s, idx };
    });
  };
  const current = search.idx >= 0 ? search.hits[search.idx] : null;

  // ---------- outline ----------
  const openOutlineItem = async (item) => {
    try {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
      if (!dest) return;
      const idx = await doc.getPageIndex(dest[0]);
      goTo(idx + 1);
      if (window.innerWidth < 760) setSidebar(false);
    } catch {}
  };

  // ---------- chrome: keyboard, focus, fullscreen ----------
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

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  const onKeyDown = (e) => {
    const typing = e.target.tagName === 'INPUT';
    if (e.key === 'Escape') {
      e.preventDefault();
      if (searchOpen) setSearchOpen(false);
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
    if (k === '/' || k === 'f') {
      e.preventDefault();
      setSearchOpen(true);
    } else if (k === 'ArrowRight' || k === 'n') goTo(Math.min(numPages, page + 1));
    else if (k === 'ArrowLeft' || k === 'p') goTo(Math.max(1, page - 1));
    else if (k === 'Home') goTo(1);
    else if (k === 'End') goTo(numPages);
    else if (k === '+' || k === '=') changeZoom(zoom * 1.2);
    else if (k === '-') changeZoom(zoom / 1.2);
    else if (k === '0') changeZoom(1);
    else if (k === 't') setTheme(THEMES[(THEMES.findIndex((x) => x.key === theme) + 1) % THEMES.length].key);
    else if (k === 'o' && outline) setSidebar((s) => !s);
    else return;
    e.preventDefault();
  };

  const submitPage = (e) => {
    e.preventDefault();
    const n = parseInt(pageInput, 10);
    if (n >= 1 && n <= numPages) goTo(n);
    setPageInput(null);
  };

  useEffect(() => {
    if (searchOpen) document.getElementById('reader-search')?.focus();
  }, [searchOpen]);

  const themeLabel = THEMES.find((x) => x.key === theme)?.label;

  return (
    <div className="reader" data-theme={theme} role="dialog" aria-modal="true" aria-label={`Reading: ${title}`} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="reader-bar">
        <div className="reader-row reader-row-top">
          <button className="rb" onClick={onClose} aria-label="Close the reader" title="Close (Esc)">
            ✕
          </button>
          <div className="reader-title">
            <strong>{title || 'Untitled'}</strong>
            {author && <span> by {author}</span>}
          </div>
          <div className="reader-tools">
            <button className={`rb ${searchOpen ? 'on' : ''}`} onClick={() => setSearchOpen((s) => !s)} aria-label="Search in the text" title="Search (/)" disabled={!doc}>
              ⌕
            </button>
            {outline && (
              <button className={`rb ${sidebar ? 'on' : ''}`} onClick={() => setSidebar((s) => !s)} aria-label="Contents" title="Contents (o)">
                ☰
              </button>
            )}
            <button className="rb rb-wide" onClick={() => setTheme(THEMES[(THEMES.findIndex((x) => x.key === theme) + 1) % THEMES.length].key)} title="Reading mode (t)" aria-label={`Reading mode: ${themeLabel}`}>
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

        {doc && (
          <div className="reader-row reader-row-nav">
            <div className="rgroup">
              <button className="rb" onClick={() => goTo(Math.max(1, page - 1))} disabled={page <= 1} aria-label="Previous page" title="Previous page (←)">
                ‹
              </button>
              <form onSubmit={submitPage} className="pageform">
                <input
                  aria-label="Page number"
                  inputMode="numeric"
                  value={pageInput ?? page}
                  onFocus={(e) => {
                    setPageInput('');
                    e.target.select?.();
                  }}
                  onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
                  onBlur={() => setPageInput(null)}
                />
                <span>/ {numPages}</span>
              </form>
              <button className="rb" onClick={() => goTo(Math.min(numPages, page + 1))} disabled={page >= numPages} aria-label="Next page" title="Next page (→)">
                ›
              </button>
            </div>
            <div className="rgroup">
              <button className="rb" onClick={() => changeZoom(zoom / 1.2)} aria-label="Zoom out" title="Zoom out (-)">
                −
              </button>
              <button className="rb rb-zoom" onClick={() => changeZoom(1)} aria-label="Reset zoom" title="Fit width (0)">
                {Math.round(zoom * 100)}%
              </button>
              <button className="rb" onClick={() => changeZoom(zoom * 1.2)} aria-label="Zoom in" title="Zoom in (+)">
                +
              </button>
            </div>
          </div>
        )}

        {searchOpen && doc && (
          <div className="reader-row reader-row-search">
            <input
              id="reader-search"
              data-role="search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search in this fic…"
              aria-label="Search in this fic"
            />
            <span className="search-count" aria-live="polite">
              {!query.trim() ? '' : search.running ? `${search.hits.length}…` : search.hits.length ? `${search.idx + 1} / ${search.hits.length}` : 'No match'}
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
        {sidebar && outline && (
          <nav className="reader-outline" aria-label="Contents">
            <Outline items={outline} onOpen={openOutlineItem} />
          </nav>
        )}

        {load.status === 'error' ? (
          <Fallback fileId={fileId} error={load.error} />
        ) : (
          <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
            {doc && base && (
              <div className="reader-pages" style={{ '--pad': `${pad}px` }}>
                {Array.from({ length: numPages }, (_, k) => k + 1).map((n) => (
                  <PdfPage
                    key={n}
                    doc={doc}
                    n={n}
                    scale={scale}
                    size={sizeOf(n)}
                    root={scrollRef.current}
                    refCb={(el) => (pageEls.current[n] = el)}
                    onSize={onSize}
                    query={query.trim()}
                    current={current}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({ loaded, total }) {
  const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : null;
  return (
    <div className="reader-progress" role="progressbar" aria-valuenow={pct ?? undefined} aria-label="Loading">
      <div className="reader-progress-bar" style={pct === null ? { width: '35%', animation: 'rp 1.1s ease-in-out infinite' } : { width: `${pct}%` }} />
      <span>{pct === null ? `Loading… ${(loaded / 1048576).toFixed(1)} MB` : `Loading… ${pct}% of ${(total / 1048576).toFixed(1)} MB`}</span>
    </div>
  );
}

function Outline({ items, onOpen, depth = 0 }) {
  return (
    <ul className={`outline outline-${Math.min(depth, 3)}`}>
      {items.map((it, i) => (
        <li key={i}>
          <button onClick={() => onOpen(it)}>{it.title}</button>
          {it.items?.length ? <Outline items={it.items} onOpen={onOpen} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

function Fallback({ fileId, error }) {
  const name = error?.name || '';
  const why =
    name === 'MissingPDFException' || name === 'InvalidPDFException'
      ? "This file isn't a readable PDF."
      : "Google didn't let the reader open this file directly. It may be private, or over Google's download limit for now.";
  return (
    <div className="reader-fallback">
      <div className="reader-fallback-msg">
        <strong>Can't use the built-in reader for this one.</strong>
        <span>{why} Google's own viewer is shown below instead.</span>
        <span className="reader-fallback-links">
          <a href={driveUrl(fileId)} target="_blank" rel="noreferrer">
            Open in Google Drive ↗
          </a>
          <a href={downloadUrl(fileId)}>Download</a>
        </span>
      </div>
      <iframe title="Google Drive viewer" src={previewUrl(fileId)} allow="fullscreen" />
    </div>
  );
}

// One page: a placeholder with the right size, drawn only while it is near the screen.
function PdfPage({ doc, n, scale, size, root, refCb, onSize, query, current }) {
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const layerRef = useRef(null);
  const [visible, setVisible] = useState(n <= 2);
  const [ready, setReady] = useState(0); // bumps each time the text layer is (re)built
  const jumped = useRef(null);

  useEffect(() => {
    if (!root) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root, rootMargin: '150% 0px' });
    io.observe(canvasRef.current.parentElement);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const text = textRef.current;
    if (!visible) {
      canvas.width = 0;
      canvas.height = 0;
      text.replaceChildren();
      layerRef.current = null;
      return;
    }
    let cancelled = false;
    let task = null;
    let layer = null;
    (async () => {
      const pg = await doc.getPage(n);
      if (cancelled) return;
      const vp = pg.getViewport({ scale });
      onSize(n, vp.width / scale, vp.height / scale);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      task = pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      await task.promise;
      if (cancelled) return;
      text.replaceChildren();
      text.style.setProperty('--scale-factor', String(scale));
      text.style.setProperty('--total-scale-factor', String(scale));
      layer = new pdfjs.TextLayer({ textContentSource: pg.streamTextContent(), container: text, viewport: vp });
      await layer.render();
      if (cancelled) return;
      layerRef.current = layer;
      setReady((r) => r + 1);
    })().catch((err) => {
      if (!cancelled && err?.name !== 'RenderingCancelledException' && err?.name !== 'AbortException') console.warn(`page ${n}:`, err);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [visible, scale, doc, n, onSize]);

  // Highlight the search matches on this page, and scroll to the current one.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const divs = layer.textDivs;
    for (const d of divs) d.classList.remove('hl', 'hl-current');
    if (!query) return;
    const matches = findMatches(layer.textContentItemsStr, query);
    let target = null;
    matches.forEach(([a, b], k) => {
      const isCurrent = current && current.page === n && current.k === k;
      for (let i = a; i <= b; i++) {
        divs[i]?.classList.add(isCurrent ? 'hl-current' : 'hl');
        if (isCurrent && !target) target = divs[a];
      }
    });
    const key = current ? `${current.page}:${current.k}:${query}` : null;
    if (target && key !== jumped.current) {
      jumped.current = key;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, [query, current, ready, n]);

  const [w, h] = size;
  return (
    <div className="pdf-page" ref={refCb} style={{ width: w * scale, height: h * scale }} data-page={n}>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
    </div>
  );
}
