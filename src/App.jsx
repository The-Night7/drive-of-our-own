import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import { prepare, search } from './search.js';

const PAGE = 40;
const FORMAT_LABEL = { gdoc: 'Google Doc', htm: 'HTML' };
const fmtLabel = (f) => FORMAT_LABEL[f] || f.toUpperCase();

// ---- URL state (so searches can be shared as links) ----
function readParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    q: p.get('q') || '',
    src: p.get('src') ? p.get('src').split(',').map(Number) : [],
    fmt: p.get('fmt') ? p.get('fmt').split(',') : [],
    folder: p.get('folder') || '',
    sort: p.get('sort') || 'relevance',
    view: p.get('view') || 'search',
  };
}
function writeParams(s) {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.src.length) p.set('src', s.src.join(','));
  if (s.fmt.length) p.set('fmt', s.fmt.join(','));
  if (s.folder) p.set('folder', s.folder);
  if (s.sort !== 'relevance') p.set('sort', s.sort);
  if (s.view !== 'search') p.set('view', s.view);
  const qs = p.toString();
  window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
}

export default function App() {
  const [db, setDb] = useState(null);
  const [error, setError] = useState(null);
  const initial = useMemo(readParams, []);
  const [q, setQ] = useState(initial.q);
  const [src, setSrc] = useState(initial.src);
  const [fmt, setFmt] = useState(initial.fmt);
  const [folder, setFolder] = useState(initial.folder);
  const [sort, setSort] = useState(initial.sort);
  const [view, setView] = useState(initial.view);
  const [shown, setShown] = useState(PAGE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const inputRef = useRef(null);
  const dq = useDeferredValue(q);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((idx) => setDb(prepare(idx)))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => writeParams({ q, src, fmt, folder, sort, view }), [q, src, fmt, folder, sort, view]);
  useEffect(() => setShown(PAGE), [dq, src, fmt, folder, sort]);

  // "/" focuses the search box, like most search UIs.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        setView('search');
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { results: matched, fuzzy } = useMemo(() => (db ? search(db, dq) : { results: [], fuzzy: false }), [db, dq]);

  // Facet counts are computed from the query matches, before facet filters,
  // so you can see how many results each choice would give.
  const facets = useMemo(() => {
    const bySrc = new Map();
    const byFmt = new Map();
    const byFolder = new Map();
    for (const f of matched) {
      bySrc.set(f.sourceId, (bySrc.get(f.sourceId) || 0) + 1);
      if (!src.length || src.includes(f.sourceId)) {
        for (const x of new Set(f.formats)) byFmt.set(x, (byFmt.get(x) || 0) + 1);
        if (f.path[0]) byFolder.set(f.path[0], (byFolder.get(f.path[0]) || 0) + 1);
      }
    }
    return {
      src: [...bySrc.entries()].sort((a, b) => b[1] - a[1]),
      fmt: [...byFmt.entries()].sort((a, b) => b[1] - a[1]),
      folder: [...byFolder.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [matched, src]);

  const results = useMemo(() => {
    let r = matched.filter(
      (f) =>
        (!src.length || src.includes(f.sourceId)) &&
        (!fmt.length || f.formats.some((x) => fmt.includes(x))) &&
        (!folder || f.path[0] === folder)
    );
    if (sort === 'title') r = [...r].sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
    else if (sort === 'drive') r = [...r].sort((a, b) => a.sourceId - b.sourceId || a.title.localeCompare(b.title));
    return r;
  }, [matched, src, fmt, folder, sort]);

  const toggle = (list, setList, v) => setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const activeFilters = src.length + fmt.length + (folder ? 1 : 0);
  const clearFilters = () => {
    setSrc([]);
    setFmt([]);
    setFolder('');
  };

  const surprise = () => {
    const pool = results.length ? results : db?.fics || [];
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setHighlight(pick);
  };

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-inner">
          <button className="brand" onClick={() => setView('search')} aria-label="Drive of Our Own home">
            <Logo />
            <span>
              <span className="brand-name">Drive of Our Own</span>
              <span className="brand-tag">fic search across community drives</span>
            </span>
          </button>
          <nav className="tabs" aria-label="Sections">
            <button className={view === 'search' ? 'on' : ''} onClick={() => setView('search')}>Search</button>
            <button className={view === 'drives' ? 'on' : ''} onClick={() => setView('drives')}>Drives</button>
            <button className={view === 'about' ? 'on' : ''} onClick={() => setView('about')}>About</button>
          </nav>
        </div>
      </header>

      {error && (
        <div className="notice">
          Couldn't load the fic index ({error}). Run <code>npm run crawl</code> to build <code>public/index.json</code>.
        </div>
      )}

      {view === 'search' && (
        <main className="search-view">
          <section className="hero">
            <form className="searchbar" onSubmit={(e) => e.preventDefault()} role="search">
              <SearchIcon />
              <input
                ref={inputRef}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Title, fandom, ship, folder… (try “lestappen” or “teen wolf”)"
                aria-label="Search fics"
                autoFocus
              />
              {q && (
                <button type="button" className="clear" onClick={() => setQ('')} aria-label="Clear search">×</button>
              )}
            </form>
            <div className="hero-meta">
              {db ? (
                <>
                  <span>
                    <strong>{db.fics.length.toLocaleString()}</strong> fics from{' '}
                    <strong>{db.sources.filter((s) => s.count).length}</strong> drives
                  </span>
                  <span className="dot">·</span>
                  <span>indexed {timeAgo(db.generated)}</span>
                  <span className="dot">·</span>
                  <button className="linklike" onClick={surprise}>🎲 surprise me</button>
                </>
              ) : (
                !error && <span>Loading the index…</span>
              )}
            </div>
          </section>

          {highlight && <Highlight fic={highlight} onClose={() => setHighlight(null)} onReroll={surprise} />}

          <div className="layout">
            <aside className={`filters ${filtersOpen ? 'open' : ''}`}>
              <button className="filters-toggle" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen}>
                Filters{activeFilters ? ` (${activeFilters})` : ''} <span aria-hidden>{filtersOpen ? '▴' : '▾'}</span>
              </button>
              <div className="filters-body">
                {activeFilters > 0 && (
                  <button className="linklike clear-all" onClick={clearFilters}>Clear all filters</button>
                )}
                <Facet title="Drive">
                  {facets.src.map(([id, n]) => (
                    <Check key={id} on={src.includes(id)} onChange={() => toggle(src, setSrc, id)} label={db.sources[id].name} sub={db.sources[id].credit} n={n} />
                  ))}
                </Facet>
                <Facet title="Format">
                  {facets.fmt.map(([f, n]) => (
                    <Check key={f} on={fmt.includes(f)} onChange={() => toggle(fmt, setFmt, f)} label={fmtLabel(f)} n={n} />
                  ))}
                </Facet>
                {facets.folder.length > 0 && (
                  <Facet title="Folder" collapsible={facets.folder.length > 12}>
                    {folder && !facets.folder.some(([f]) => f === folder) && (
                      <Check on onChange={() => setFolder('')} label={folder} n={0} />
                    )}
                    {facets.folder.map(([f, n]) => (
                      <Check key={f} radio on={folder === f} onChange={() => setFolder(folder === f ? '' : f)} label={f} n={n} />
                    ))}
                  </Facet>
                )}
              </div>
            </aside>

            <section className="results" aria-live="polite">
              {db && (
                <div className="results-head">
                  <span>
                    {results.length.toLocaleString()} {results.length === 1 ? 'fic' : 'fics'}
                    {dq && <> for “{dq}”</>}
                    {fuzzy && results.length > 0 && <em> — no exact match, showing close ones</em>}
                  </span>
                  <label className="sort">
                    Sort
                    <select value={sort} onChange={(e) => setSort(e.target.value)}>
                      <option value="relevance">{dq ? 'Best match' : 'Drive order'}</option>
                      <option value="title">Title A–Z</option>
                      <option value="drive">By drive</option>
                    </select>
                  </label>
                </div>
              )}

              {db && !results.length && (
                <div className="empty">
                  <p>No fics found. 🫠</p>
                  <p>Try fewer words, a ship name, or {activeFilters ? <button className="linklike" onClick={clearFilters}>clearing the filters</button> : 'a fandom name'}.</p>
                </div>
              )}

              <ol className="cards">
                {results.slice(0, shown).map((f) => (
                  <FicCard key={f.id} fic={f} onFolder={(p) => { setFolder(p); setSrc([f.sourceId]); }} />
                ))}
              </ol>

              {shown < results.length && (
                <button className="more" onClick={() => setShown(shown + PAGE)}>
                  Show more ({(results.length - shown).toLocaleString()} left)
                </button>
              )}
            </section>
          </div>
        </main>
      )}

      {view === 'drives' && db && <Drives db={db} onBrowse={(id) => { clearFilters(); setQ(''); setSrc([id]); setView('search'); }} />}
      {view === 'about' && <About />}

      <footer className="foot">
        Every fic belongs to its author and lives in the drive it was shared in — this site only links to them.
        Comment, kudos and rec the authors when the archive is back. 💛
      </footer>
    </div>
  );
}

function FicCard({ fic, onFolder }) {
  const primary = fic.files[0];
  return (
    <li className="card">
      <div className="card-main">
        <h3 className="card-title">
          <a href={primary.u} target="_blank" rel="noreferrer">{fic.title || 'Untitled'}</a>
        </h3>
        <div className="crumbs">
          <span className="crumb-src" title={fic.source.credit}>{fic.source.name}</span>
          {fic.path.map((p, i) => (
            <span key={i} className="crumb">
              <span className="sep" aria-hidden>›</span>
              {i === 0 ? (
                <button className="linklike" onClick={() => onFolder(p)} title="Filter by this folder">{p}</button>
              ) : (
                p
              )}
            </span>
          ))}
        </div>
        <div className="card-meta">
          <span>via {fic.source.credit}</span>
          {fic.modified && <span>· added {fic.modified}</span>}
          {fic.ao3Id && (
            <span>
              · <a href={`https://web.archive.org/web/2026/https://archiveofourown.org/works/${fic.ao3Id}`} target="_blank" rel="noreferrer" title="Look for an archived copy of the original work page">work #{fic.ao3Id}</a>
            </span>
          )}
        </div>
      </div>
      <div className="card-actions">
        {fic.files.map((x) => (
          <a key={x.u} className={`fmt fmt-${x.f}`} href={x.u} target="_blank" rel="noreferrer">{fmtLabel(x.f)}</a>
        ))}
        <a className="fmt fmt-folder" href={fic.folderUrl} target="_blank" rel="noreferrer" title="Open the folder in its original drive">Folder ↗</a>
      </div>
    </li>
  );
}

function Highlight({ fic, onClose, onReroll }) {
  return (
    <div className="highlight" role="dialog" aria-label="Random fic">
      <div className="highlight-label">Tonight's read</div>
      <ol className="cards"><FicCard fic={fic} onFolder={() => {}} /></ol>
      <div className="highlight-actions">
        <button className="linklike" onClick={onReroll}>🎲 another one</button>
        <button className="linklike" onClick={onClose}>close</button>
      </div>
    </div>
  );
}

function Facet({ title, children, collapsible }) {
  const [open, setOpen] = useState(false);
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : [children];
  const visible = collapsible && !open ? items.slice(0, 12) : items;
  if (!items.length) return null;
  return (
    <fieldset className="facet">
      <legend>{title}</legend>
      {visible}
      {collapsible && (
        <button className="linklike facet-more" onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </fieldset>
  );
}

function Check({ on, onChange, label, sub, n, radio }) {
  return (
    <label className={`check ${on ? 'on' : ''}`}>
      <input type={radio ? 'radio' : 'checkbox'} checked={!!on} onChange={onChange} onClick={radio && on ? onChange : undefined} />
      <span className="check-label">
        {label}
        {sub && <span className="check-sub">{sub}</span>}
      </span>
      <span className="count">{n.toLocaleString()}</span>
    </label>
  );
}

function Drives({ db, onBrowse }) {
  const sorted = [...db.sources].sort((a, b) => b.count - a.count);
  return (
    <main className="page">
      <h2>The drives</h2>
      <p className="lede">
        Every drive in the index, with credit to the people who put them together. Drives that aren't shared publicly
        (or aren't Drive folders) can't be searched, but they're still linked here.
      </p>
      <ul className="drives">
        {sorted.map((s) => (
          <li key={s.id} className="drive">
            <div>
              <div className="drive-name">{s.name}</div>
              <div className="drive-credit">{s.credit}{s.notes && s.notes !== s.name ? ` — ${s.notes}` : ''}</div>
            </div>
            <div className="drive-side">
              {s.kind === 'external' ? (
                <span className="pill pill-muted">External list</span>
              ) : s.ok === false ? (
                <span className="pill pill-warn" title="Drive answered 'not authorised' — it isn't shared as 'anyone with the link'">Not public</span>
              ) : s.count ? (
                <button className="pill pill-ok" onClick={() => onBrowse(s.id)}>{s.count.toLocaleString()} fics →</button>
              ) : (
                <span className="pill pill-muted">No files found</span>
              )}
              <a href={s.url} target="_blank" rel="noreferrer" className="linklike">Open ↗</a>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

function About() {
  return (
    <main className="page prose">
      <h2>About</h2>
      <p>
        When the archive went down, a lot of lovely people started sharing Google Drives full of downloaded fics.
        Drive of Our Own gathers the ones I know about into one searchable place, so you can find a fic and jump
        straight to it in the drive it came from.
      </p>
      <h3>How it works</h3>
      <ul>
        <li>A small script reads every public drive folder (and its subfolders) and writes an index of file names and folder paths.</li>
        <li>This page searches that index in your browser — nothing is uploaded or copied.</li>
        <li>Each result links to the original file and its folder, so the drive owners stay in charge of their files.</li>
      </ul>
      <h3>Search tips</h3>
      <ul>
        <li>All words must match somewhere: in the title, in a folder name (often the fandom or ship), or the drive name.</li>
        <li>Use <code>"quotes"</code> for an exact phrase. Typos fall back to a fuzzy match.</li>
        <li>Press <kbd>/</kbd> anywhere to jump to the search box. Searches are in the URL, so you can share them.</li>
      </ul>
      <h3>Know another drive?</h3>
      <p>Add it to <code>data/sources.json</code> and run <code>npm run crawl</code>.</p>
    </main>
  );
}

function timeAgo(iso) {
  if (!iso) return 'just now';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short' });
}

const Logo = () => (
  <svg className="logo" viewBox="0 0 40 40" aria-hidden>
    <rect width="40" height="40" rx="10" fill="var(--accent)" />
    <path d="M11 10h4v20h-4z" fill="var(--paper)" opacity=".55" />
    <path d="M17 10h6a10 10 0 0 1 0 20h-6z" fill="var(--paper)" />
    <circle cx="23" cy="20" r="3.2" fill="var(--accent)" />
  </svg>
);

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden className="search-icon">
    <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
