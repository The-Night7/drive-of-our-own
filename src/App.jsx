import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import config from '../data/config.json';
import {
  prepare,
  search,
  sortIds,
  facets as computeFacets,
  suggestTags,
  loadDetails,
  fileUrl,
  tagKey,
  TAG_TYPES,
  FORMAT_BITS,
  LENGTHS,
} from './search.js';

const BASE = import.meta.env.BASE_URL;
const PAGE = 30;
const FMT_LABEL = { gdoc: 'Google Doc', htm: 'HTML' };
const fmtLabel = (f) => FMT_LABEL[f] || f.toUpperCase();
const DONE = { complete: 1, wip: 2 };

// ---------- URL state (searches are shareable links) ----------
function readParams() {
  const p = new URLSearchParams(window.location.search);
  const list = (k) => (p.get(k) ? p.get(k).split(',').filter(Boolean) : []);
  return {
    q: p.get('q') || '',
    src: list('src').map(Number),
    fmt: list('fmt'),
    folder: p.get('folder') || '',
    inc: p.getAll('tag'),
    exc: p.getAll('xtag'),
    done: p.get('done') || '',
    len: p.get('len') || '',
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
  s.inc.forEach((t) => p.append('tag', t));
  s.exc.forEach((t) => p.append('xtag', t));
  if (s.done) p.set('done', s.done);
  if (s.len) p.set('len', s.len);
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
  const [inc, setInc] = useState(initial.inc);
  const [exc, setExc] = useState(initial.exc);
  const [done, setDone] = useState(initial.done);
  const [len, setLen] = useState(initial.len);
  const [sort, setSort] = useState(initial.sort);
  const [view, setView] = useState(initial.view);
  const [shown, setShown] = useState(PAGE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const inputRef = useRef(null);
  const dq = useDeferredValue(q);

  useEffect(() => {
    fetch(`${BASE}index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((idx) => setDb(prepare(idx)))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(
    () => writeParams({ q, src, fmt, folder, inc, exc, done, len, sort, view }),
    [q, src, fmt, folder, inc, exc, done, len, sort, view]
  );
  useEffect(() => setShown(PAGE), [dq, src, fmt, folder, inc, exc, done, len, sort]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        setView('search');
        setTimeout(() => inputRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filters = useMemo(() => {
    if (!db) return null;
    const ids = (keys) => keys.map((k) => db.tagIdByKey.get(k)).filter((x) => x !== undefined);
    return {
      src: new Set(src),
      fmtMask: FORMAT_BITS.filter((b) => fmt.includes(b.key)).reduce((m, b) => m | b.bit, 0),
      folder,
      inc: ids(inc),
      exc: ids(exc),
      done: DONE[done] || 0,
      len,
    };
  }, [db, src, fmt, folder, inc, exc, done, len]);

  const { results, facetData } = useMemo(() => {
    if (!db || !filters) return { results: [], facetData: null };
    const { ids, scores } = search(db, dq, filters);
    return { results: sortIds(db, ids, scores, sort, !!dq.trim()), facetData: computeFacets(db, ids) };
  }, [db, dq, filters, sort]);

  const toggle = (list, setList, v) => setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const includeTag = (key) => {
    setExc((e) => e.filter((x) => x !== key));
    setInc((i) => (i.includes(key) ? i : [...i, key]));
    setView('search');
  };
  const excludeTag = (key) => {
    setInc((i) => i.filter((x) => x !== key));
    setExc((e) => (e.includes(key) ? e : [...e, key]));
  };
  const activeCount = src.length + fmt.length + (folder ? 1 : 0) + inc.length + exc.length + (done ? 1 : 0) + (len ? 1 : 0);
  const clearFilters = () => {
    setSrc([]);
    setFmt([]);
    setFolder('');
    setInc([]);
    setExc([]);
    setDone('');
    setLen('');
  };

  const surprise = () => {
    const pool = results.length ? results : [];
    if (pool.length) setHighlight(pool[Math.floor(Math.random() * pool.length)]);
  };

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-inner">
          <button className="brand" onClick={() => setView('search')} aria-label="Drive of Our Own: home">
            <Logo />
            <span>
              <span className="brand-name">Drive of Our Own</span>
              <span className="brand-tag">fic search across community drives</span>
            </span>
          </button>
          <nav className="tabs" aria-label="Sections">
            {[
              ['search', 'Search'],
              ['drives', 'Drives'],
              ['add', 'Add a drive'],
              ['about', 'About'],
            ].map(([k, label]) => (
              <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {error && (
        <div className="notice">
          Couldn't load the fic index ({error}). It's rebuilt automatically by GitHub Actions; locally, run{' '}
          <code>npm run index</code>.
        </div>
      )}

      {view === 'search' && (
        <main>
          <section className="hero">
            <form className="searchbar" onSubmit={(e) => e.preventDefault()} role="search">
              <SearchIcon />
              <input
                ref={inputRef}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Title, author, fandom, ship, tag…  (-word to exclude)"
                aria-label="Search fics"
                autoFocus
              />
              {q && (
                <button type="button" className="clear" onClick={() => setQ('')} aria-label="Clear search">
                  ×
                </button>
              )}
            </form>
            <div className="hero-meta">
              {db ? (
                <>
                  <span>
                    <strong>{db.n.toLocaleString('en')}</strong> fics in{' '}
                    <strong>{db.sources.filter((s) => s.count).length}</strong> drives
                  </span>
                  <span className="dot">·</span>
                  <span>
                    <strong>{db.tagged.toLocaleString('en')}</strong> with tags
                  </span>
                  <span className="dot">·</span>
                  <span>updated {timeAgo(db.built)}</span>
                  <span className="dot">·</span>
                  <button className="linklike" onClick={surprise}>
                    🎲 surprise me
                  </button>
                </>
              ) : (
                !error && <span className="loading">Loading the index… (it's big, give it a few seconds)</span>
              )}
            </div>
          </section>

          {highlight !== null && db && (
            <div className="highlight" role="region" aria-label="Random fic">
              <div className="highlight-label">Tonight's read</div>
              <ol className="cards">
                <FicCard db={db} i={highlight} onTag={includeTag} onFolder={() => {}} />
              </ol>
              <div className="highlight-actions">
                <button className="linklike" onClick={surprise}>
                  🎲 another one
                </button>
                <button className="linklike" onClick={() => setHighlight(null)}>
                  close
                </button>
              </div>
            </div>
          )}

          {db && activeCount > 0 && (
            <div className="chips-row">
              {inc.map((k) => (
                <Chip key={`i${k}`} kind="inc" label={tagLabel(k)} onRemove={() => setInc(inc.filter((x) => x !== k))} />
              ))}
              {exc.map((k) => (
                <Chip key={`x${k}`} kind="exc" label={`not ${tagLabel(k)}`} onRemove={() => setExc(exc.filter((x) => x !== k))} />
              ))}
              {src.map((s) => (
                <Chip key={`s${s}`} label={db.sources[s]?.name || 'drive'} onRemove={() => toggle(src, setSrc, s)} />
              ))}
              {folder && <Chip label={`folder: ${folder}`} onRemove={() => setFolder('')} />}
              {fmt.map((f) => (
                <Chip key={`f${f}`} label={FORMAT_BITS.find((b) => b.key === f)?.label || f} onRemove={() => toggle(fmt, setFmt, f)} />
              ))}
              {done && <Chip label={done === 'complete' ? 'Complete' : 'Work in progress'} onRemove={() => setDone('')} />}
              {len && <Chip label={LENGTHS.find((l) => l.key === len)?.label} onRemove={() => setLen('')} />}
              <button className="linklike" onClick={clearFilters}>
                Clear all
              </button>
            </div>
          )}

          <div className="layout">
            <aside className={`filters ${filtersOpen ? 'open' : ''}`}>
              <button className="filters-toggle" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen}>
                Filters{activeCount ? ` (${activeCount})` : ''} <span aria-hidden>{filtersOpen ? '▴' : '▾'}</span>
              </button>
              {db && facetData && (
                <div className="filters-body">
                  <TagFinder db={db} onInclude={includeTag} onExclude={excludeTag} />
                  {TAG_TYPES.map((ty) => (
                    <TagFacet
                      key={ty.code}
                      db={db}
                      title={ty.plural}
                      items={facetData.tags[ty.code]}
                      inc={inc}
                      exc={exc}
                      onInclude={includeTag}
                      onExclude={excludeTag}
                      onClear={(k) => {
                        setInc(inc.filter((x) => x !== k));
                        setExc(exc.filter((x) => x !== k));
                      }}
                      initial={ty.code === 'r' || ty.code === 'w' || ty.code === 'c' ? 8 : 6}
                    />
                  ))}
                  <Facet title="Status">
                    {[
                      ['complete', 'Complete', facetData.done[1]],
                      ['wip', 'Work in progress', facetData.done[2]],
                    ].map(([k, label, n]) => (
                      <Check key={k} radio on={done === k} onChange={() => setDone(done === k ? '' : k)} label={label} n={n} />
                    ))}
                  </Facet>
                  <Facet title="Length">
                    {LENGTHS.map((l) => (
                      <Check key={l.key} radio on={len === l.key} onChange={() => setLen(len === l.key ? '' : l.key)} label={l.label} n={facetData.len[l.key]} />
                    ))}
                  </Facet>
                  <Facet title="Drive" initial={8}>
                    {facetData.src.map(([id, n]) => (
                      <Check key={id} on={src.includes(id)} onChange={() => toggle(src, setSrc, id)} label={db.sources[id].name} sub={db.sources[id].credit} n={n} />
                    ))}
                  </Facet>
                  <Facet title="Format">
                    {facetData.fmt.map(([bit, n]) => {
                      const b = FORMAT_BITS.find((x) => x.bit === bit);
                      return <Check key={b.key} on={fmt.includes(b.key)} onChange={() => toggle(fmt, setFmt, b.key)} label={b.label} n={n} />;
                    })}
                  </Facet>
                  <Facet title="Folder" initial={8}>
                    {facetData.folder.map(([f, n]) => (
                      <Check key={f} radio on={folder === f} onChange={() => setFolder(folder === f ? '' : f)} label={f} n={n} />
                    ))}
                  </Facet>
                </div>
              )}
            </aside>

            <section className="results" aria-live="polite">
              {db && (
                <div className="results-head">
                  <span>
                    {results.length.toLocaleString('en')} {results.length === 1 ? 'fic' : 'fics'}
                    {dq && <> for “{dq}”</>}
                  </span>
                  <label className="sort">
                    Sort
                    <select value={sort} onChange={(e) => setSort(e.target.value)}>
                      <option value="relevance">{dq ? 'Best match' : 'Tagged first'}</option>
                      <option value="title">Title A–Z</option>
                      <option value="words-desc">Longest first</option>
                      <option value="words-asc">Shortest first</option>
                    </select>
                  </label>
                </div>
              )}

              {db && !results.length && (
                <div className="empty">
                  <p>No fics found. 🫠</p>
                  <p>
                    Try fewer words, a ship or fandom name, or{' '}
                    {activeCount ? (
                      <button className="linklike" onClick={clearFilters}>
                        clearing the filters
                      </button>
                    ) : (
                      'another spelling'
                    )}
                    .
                  </p>
                </div>
              )}

              <ol className="cards">
                {db &&
                  results.slice(0, shown).map((i) => (
                    <FicCard
                      key={i}
                      db={db}
                      i={i}
                      onTag={includeTag}
                      onFolder={(p, s) => {
                        setFolder(p);
                        setSrc([s]);
                      }}
                    />
                  ))}
              </ol>

              {shown < results.length && (
                <button className="more" onClick={() => setShown(shown + PAGE)}>
                  Show more ({(results.length - shown).toLocaleString('en')} left)
                </button>
              )}
            </section>
          </div>
        </main>
      )}

      {view === 'drives' && db && (
        <Drives
          db={db}
          onBrowse={(id) => {
            clearFilters();
            setQ('');
            setSrc([id]);
            setView('search');
          }}
        />
      )}
      {view === 'add' && <AddDrive />}
      {view === 'about' && <About />}

      <footer className="foot">
        Every fic belongs to its author and stays in the drive it was shared in. This site only links to it.
        Leave kudos and comments when the archive is back. 💛
      </footer>
    </div>
  );
}

const TYPE_LABEL = Object.fromEntries(TAG_TYPES.map((t) => [t.code, t.label]));
function tagLabel(key) {
  const [code, ...rest] = key.split(':');
  return `${rest.join(':')}`.trim() + (TYPE_LABEL[code] ? ` (${TYPE_LABEL[code].toLowerCase()})` : '');
}

// ---------- fic card ----------

function FicCard({ db, i, onTag, onFolder }) {
  const details = useDetailsFor(db, i);
  const [open, setOpen] = useState(false);
  const folder = db.folders[db.d[i]];
  const source = db.sources[folder[0]];
  const tags = db.ficTags[i];
  const byType = {};
  for (const t of tags) (byType[db.tags[t][0]] ||= []).push(t);
  const primary = details?.files?.[0];
  const author = db.a[i] >= 0 ? db.authors[db.a[i]] : null;
  const other = [...(byType.h || []), ...(byType.t || [])];
  const visibleOther = open ? other : other.slice(0, 10);
  const tagBtn = (t, cls = '') => (
    <button key={t} className={`tag ${cls}`} onClick={() => onTag(tagKey(db, t))} title="Show fics with this tag">
      {db.tags[t][1]}
    </button>
  );

  return (
    <li className="card">
      <div className="card-head">
        <div className="card-main">
          <h3 className="card-title">
            {primary ? (
              <a href={fileUrl(primary[0], primary[1])} target="_blank" rel="noreferrer">
                {db.t[i] || 'Untitled'}
              </a>
            ) : (
              <span>{db.t[i] || 'Untitled'}</span>
            )}
            {author && <span className="byline"> by {author}</span>}
          </h3>
          {byType.f && <div className="fandoms">{byType.f.map((t) => tagBtn(t, 'tag-fandom'))}</div>}
        </div>
        {(byType.r || byType.w || byType.c) && (
          <div className="badges">
            {(byType.r || []).map((t) => (
              <button key={t} className={`badge rating-${ratingClass(db.tags[t][1])}`} onClick={() => onTag(tagKey(db, t))} title={db.tags[t][1]}>
                {ratingShort(db.tags[t][1])}
              </button>
            ))}
            {(byType.c || []).map((t) => (
              <button key={t} className="badge badge-cat" onClick={() => onTag(tagKey(db, t))} title={`Category: ${db.tags[t][1]}`}>
                {db.tags[t][1]}
              </button>
            ))}
          </div>
        )}
      </div>

      {(byType.w || byType.p || other.length > 0) && (
        <div className="tags">
          {(byType.w || []).map((t) => tagBtn(t, 'tag-warning'))}
          {(byType.p || []).map((t) => tagBtn(t, 'tag-rel'))}
          {visibleOther.map((t) => tagBtn(t))}
          {other.length > 10 && (
            <button className="linklike tag-more" onClick={() => setOpen(!open)}>
              {open ? 'fewer' : `+${other.length - 10} more`}
            </button>
          )}
        </div>
      )}

      {details?.summary ? <Summary text={details.summary} /> : null}

      <div className="card-foot">
        <div className="card-meta">
          <span className="crumbs">
            <span className="crumb-src" title={source.credit}>
              {source.name}
            </span>
            {folder[2].map((p, k) => (
              <span key={k}>
                <span className="sep" aria-hidden>
                  ›
                </span>
                {k === 0 ? (
                  <button className="linklike" onClick={() => onFolder(p, folder[0])} title="Only this folder">
                    {p}
                  </button>
                ) : (
                  p
                )}
              </span>
            ))}
          </span>
          <span className="stats">
            {source.credit && <span>via {source.credit}</span>}
            {db.w[i] > 0 && <span>{db.w[i].toLocaleString('en')} words</span>}
            {details?.chapters ? <span>{details.chapters} ch.</span> : null}
            {db.c[i] === 1 && <span className="ok">complete</span>}
            {db.c[i] === 2 && <span className="wip">WIP</span>}
            {details?.language ? <span>{details.language}</span> : null}
            {details?.published ? <span>{details.published.slice(0, 4)}</span> : null}
            {details?.ao3Id ? (
              <a href={`https://web.archive.org/web/2026/https://archiveofourown.org/works/${details.ao3Id}`} target="_blank" rel="noreferrer" title="Archived copy of the original work page">
                work #{details.ao3Id}
              </a>
            ) : null}
          </span>
        </div>
        <div className="card-actions">
          {details?.files?.map(([f, id]) => (
            <a key={id} className="fmt" href={fileUrl(f, id)} target="_blank" rel="noreferrer">
              {fmtLabel(f)}
            </a>
          ))}
          <a className="fmt fmt-folder" href={`https://drive.google.com/drive/folders/${folder[1]}`} target="_blank" rel="noreferrer" title="Open the folder in its original drive">
            Folder ↗
          </a>
        </div>
      </div>
    </li>
  );
}

function useDetailsFor(db, i) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    setD(null);
    loadDetails(BASE, db.chunk, i).then((x) => alive && setD(x));
    return () => {
      alive = false;
    };
  }, [db, i]);
  return d;
}

function Summary({ text }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 260;
  return (
    <div className={`summary ${open || !long ? 'open' : ''}`}>
      {text.split('\n').map((p, k) => (
        <p key={k}>{p}</p>
      ))}
      {long && (
        <button className="linklike" onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  );
}

const ratingShort = (r) =>
  ({ 'General Audiences': 'G', 'Teen And Up Audiences': 'T', Mature: 'M', Explicit: 'E', 'Not Rated': '–' })[r] || r.slice(0, 1);
const ratingClass = (r) => ({ 'General Audiences': 'g', 'Teen And Up Audiences': 't', Mature: 'm', Explicit: 'e' })[r] || 'n';

// ---------- filters ----------

function TagFinder({ db, onInclude, onExclude }) {
  const [text, setText] = useState('');
  const sugg = useMemo(() => suggestTags(db, text), [db, text]);
  return (
    <div className="tagfinder">
      <label className="facet-title" htmlFor="tagfinder">
        Find a tag
      </label>
      <input id="tagfinder" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. slow burn, hurt/comfort" autoComplete="off" />
      {sugg.length > 0 && (
        <ul className="suggestions">
          {sugg.map((t) => (
            <li key={t}>
              <button
                className="sugg-main"
                onClick={() => {
                  onInclude(tagKey(db, t));
                  setText('');
                }}
              >
                <span>{db.tags[t][1]}</span>
                <span className="count">
                  {TYPE_LABEL[db.tags[t][0]].toLowerCase()} · {db.tags[t][2].toLocaleString('en')}
                </span>
              </button>
              <button
                className="sugg-x"
                title="Exclude this tag"
                aria-label={`Exclude ${db.tags[t][1]}`}
                onClick={() => {
                  onExclude(tagKey(db, t));
                  setText('');
                }}
              >
                −
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TagFacet({ db, title, items, inc, exc, onInclude, onExclude, onClear, initial }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const visible = open ? items.slice(0, 60) : items.slice(0, initial);
  return (
    <fieldset className="facet">
      <legend className="facet-title">{title}</legend>
      {visible.map(([t, n]) => {
        const key = tagKey(db, t);
        const state = inc.includes(key) ? 'inc' : exc.includes(key) ? 'exc' : '';
        return (
          <div key={t} className={`tagrow ${state}`}>
            <button className="tagrow-main" onClick={() => (state ? onClear(key) : onInclude(key))} title={state ? 'Remove filter' : 'Only fics with this tag'}>
              <span className="check-label">{db.tags[t][1]}</span>
              <span className="count">{n.toLocaleString('en')}</span>
            </button>
            <button className="tagrow-x" onClick={() => (state === 'exc' ? onClear(key) : onExclude(key))} title="Exclude this tag" aria-label={`Exclude ${db.tags[t][1]}`}>
              −
            </button>
          </div>
        );
      })}
      {items.length > initial && (
        <button className="linklike facet-more" onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show more (${Math.min(items.length, 60) - initial})`}
        </button>
      )}
    </fieldset>
  );
}

function Facet({ title, children, initial = 50 }) {
  const [open, setOpen] = useState(false);
  const items = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  if (!items.length) return null;
  return (
    <fieldset className="facet">
      <legend className="facet-title">{title}</legend>
      {open ? items : items.slice(0, initial)}
      {items.length > initial && (
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
      <span className="count">{(n || 0).toLocaleString('en')}</span>
    </label>
  );
}

function Chip({ label, onRemove, kind = '' }) {
  return (
    <span className={`chip ${kind}`}>
      {label}
      <button onClick={onRemove} aria-label={`Remove ${label}`}>
        ×
      </button>
    </span>
  );
}

// ---------- pages ----------

function Drives({ db, onBrowse }) {
  const sorted = [...db.sources].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const indexed = sorted.filter((s) => s.count).length;
  return (
    <main className="page">
      <h2>The drives</h2>
      <p className="lede">
        {indexed} drives indexed out of {db.sources.length} known, with credit to the people who put them together.
        Drives that aren't shared publicly, and lists that aren't Drive folders, can't be searched, but they're still
        linked here.
      </p>
      <ul className="drives">
        {sorted.map((s) => (
          <li key={s.id} className="drive">
            <div className="drive-info">
              <div className="drive-name">{s.name}</div>
              <div className="drive-credit">
                {s.credit}
                {s.notes && s.notes !== s.name ? `${s.credit ? ' — ' : ''}${s.notes}` : ''}
              </div>
            </div>
            <div className="drive-side">
              {s.kind === 'external' ? (
                <span className="pill pill-muted">External list</span>
              ) : s.status && s.status !== 200 ? (
                <span className="pill pill-warn" title="Not shared as 'anyone with the link'">
                  Not public
                </span>
              ) : s.count ? (
                <button className="pill pill-ok" onClick={() => onBrowse(s.id)}>
                  {s.count.toLocaleString('en')} fics →
                </button>
              ) : (
                <span className="pill pill-muted" title="Empty, or already included inside another drive">
                  No new files
                </span>
              )}
              <a href={s.url} target="_blank" rel="noreferrer" className="linklike">
                Open ↗
              </a>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

function AddDrive() {
  const [url, setUrl] = useState('');
  const [credit, setCredit] = useState('');
  const [notes, setNotes] = useState('');
  const valid = /drive\.google\.com\/drive\/(u\/\d+\/)?folders\/[\w-]{10,}/.test(url) || /docs\.google\.com\/spreadsheets\/d\//.test(url);
  const issueUrl = () => {
    const p = new URLSearchParams({
      template: 'add-drive.yml',
      title: `Add drive: ${credit || url}`,
      drive_url: url.trim(),
      credit: credit.trim(),
      notes: notes.trim(),
    });
    return `https://github.com/${config.repo}/issues/new?${p}`;
  };
  return (
    <main className="page prose">
      <h2>Add a drive</h2>
      <p className="lede">
        Know a fic drive that isn't here yet? Send it in. It's added automatically, and its fics become searchable at
        the next index update (every few hours).
      </p>
      <form
        className="addform"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) window.open(issueUrl(), '_blank', 'noopener');
        }}
      >
        <label>
          Drive folder link <span className="req">required</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" required />
          {url && !valid && <span className="field-err">That doesn't look like a Google Drive folder link.</span>}
        </label>
        <label>
          Who shared it
          <input value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="@handle" />
        </label>
        <label>
          What's in it
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="fandoms, ships…" />
        </label>
        <button className="primary" type="submit" disabled={!valid}>
          Continue on GitHub →
        </button>
        <p className="hint">
          This opens a pre-filled form on GitHub (you need a free account). Submit it and a bot checks that the drive
          is public, adds it to the list, and starts indexing it. The folder has to be shared as “Anyone with the
          link”.
        </p>
      </form>
    </main>
  );
}

function About() {
  return (
    <main className="page prose">
      <h2>About</h2>
      <p>
        When the archive went down, lots of lovely people started sharing Google Drives full of downloaded fics. Drive
        of Our Own gathers them into one searchable place, so you can find a fic and jump straight to it in the drive
        it came from.
      </p>
      <h3>How it works</h3>
      <ul>
        <li>Every few hours a bot reads every public drive folder (and its subfolders) and lists the fics in it.</li>
        <li>
          It opens each new EPUB or PDF once and reads the AO3 info page at the start: rating, warnings, fandoms,
          relationships, characters, tags, summary, author and word count. That's what makes tag search work.
        </li>
        <li>This page searches that index in your browser. Every result links to the original file and its folder.</li>
      </ul>
      <h3>Search tips</h3>
      <ul>
        <li>Every word must match somewhere: title, author, any tag, a folder name or the drive name.</li>
        <li>
          <code>"slow burn"</code> matches an exact phrase. <code>-angst</code> leaves out fics with that word in the
          title or tags.
        </li>
        <li>Click any tag on a fic to filter by it. In the sidebar, use − to exclude a tag.</li>
        <li>
          Press <kbd>/</kbd> to jump to the search box. Searches live in the URL, so you can share them.
        </li>
        <li>Fics that weren't downloaded from AO3 (renamed files, Google Docs…) have no tags, but you can still find them by title and folder.</li>
      </ul>
    </main>
  );
}

function timeAgo(iso) {
  if (!iso) return 'recently';
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
