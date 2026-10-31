# Drive of Our Own

A search engine for the fanfics people have been saving to Google Drive since AO3
went down. It indexes the community drives, reads each fic's AO3 tags, and lets you
search by title, author, fandom, ship, character or any tag. Every result links
**straight to the file in its original drive**. Nothing is copied or re-hosted.

React + Vite, hosted on Vercel. Search runs entirely in the browser.

## Everything runs on its own

Two GitHub Actions workflows run in parallel (separate concurrency groups, so one
never waits behind the other). Nobody has to do anything:

- **[Index & deploy](.github/workflows/deploy.yml)** is the slow, thorough one. It runs
  every 6 hours (or by hand) for up to ~3 hours and does the steps below.
- **[Quick index](.github/workflows/quick-index.yml)** is the fast lane: a few minutes.
  It runs on every push and whenever a drive is added through the site. It lists the
  new drives, rebuilds the index from the tags already cached, and redeploys. Tags for
  a brand-new drive are filled in by the next slow run.

The steps:

1. **Finds the drives.** It reads the master Drive folder set in
   [`data/config.json`](data/config.json) (“AO3 - Drives”):
   - every **shortcut to a folder** in it;
   - every **Drive folder link written in a Google Doc** in it, plus Google Docs
     linked from those docs (one level, e.g. a community masterpost). The `@handle`
     and the text in brackets on the same line become the credit and the description;
   - plus anything in [`data/sources.json`](data/sources.json) (manual entries and
     drives added through the site).
2. **Lists every fic.** It goes through every drive and subfolder via Drive's
   public folder view (no API key). This happens once a day; in between, only newly
   added drives are listed.
3. **Reads the tags.** It downloads each new EPUB (or the PDF when there's no EPUB)
   once and reads the AO3 info page: rating, warnings, category, fandoms,
   relationships, characters, additional tags, summary, author, word count,
   chapters. Results are cached per file, so each run only reads new files. If the cache
   is ever lost, it is refilled from the last published index (`scripts/seed-cache.mjs`). The
   first pass over a big collection takes a few runs.
4. **Publishes the index and redeploys the site.** The index is uploaded as an asset
   of the `index-data` release, then a Vercel deploy hook is called. The Vercel build
   (`scripts/fetch-index.mjs`, see [`vercel.json`](vercel.json)) downloads that asset
   before building the app, so the index never has to live in git.

### Adding a drive

Any of these works, and the drive shows up after the next run:

- **Put a shortcut to it in the “AO3 - Drives” folder**, or paste its link into one
  of the Google Docs in that folder.
- **Use the site's “Add a drive” page.** It opens a pre-filled GitHub issue. The
  [`add-drive`](.github/workflows/add-drive.yml) workflow checks that the folder is
  public, adds it to `data/sources.json`, replies on the issue and starts an
  indexing run. Issues from the repo owner are added immediately; anyone else's
  wait until the owner adds the `approved` label.

Folders must be shared as “Anyone with the link”. The ones that aren't show up
as *Not public* on the Drives page.

## One-time setup

1. **Vercel:** import the repo (the framework and build command are picked up from
   `vercel.json`). Then, in **Project Settings → Git → Deploy Hooks**, create a hook
   for the `main` branch and copy its URL.
2. **GitHub:** in **Settings → Secrets and variables → Actions**, add a repository
   secret named `VERCEL_DEPLOY_HOOK` with that URL. Without it everything still
   works, but Vercel only shows the new index at its next deploy.
3. **Actions → Index & deploy → Run workflow** to start the first run now instead of
   waiting for the schedule.

## Run it locally

```bash
npm install
```

```bash
npm run index
```

```bash
npm run dev
```

`npm run index` lists the drives (`scripts/crawl.mjs`), then downloads the fics and
extracts their tags (`scripts/build-index.mjs`). The tag step needs `pdftotext`
(`poppler-utils`) for PDFs. Useful flags:

- `node scripts/crawl.mjs --dry-run` shows which drives were found and with what credit.
- `node scripts/crawl.mjs --only <folderId>` re-lists a single drive.
- `node scripts/build-index.mjs --limit 500` reads tags for at most 500 new files.

## Reading PDFs and EPUBs in the site

A click on a fic (its title, or the **Read PDF** / **Read EPUB** button) opens it in a built-in
reader, loaded only when needed. When a fic has both, the title opens the EPUB (it reflows to
the screen); the PDF has its own button.

Both readers: search in the text with highlights (`/`), contents, reading modes **paper /
sepia / night** (night follows the phone's dark mode the first time), full screen, download
and “open in Google Drive” buttons, they remember where you stopped, the phone's back button
closes them, `Esc` closes the top panel first.

- **PDF** ([`src/PdfReader.jsx`](src/PdfReader.jsx), pdf.js): continuous pages, zoom (fit width
  by default), jump to a page, the PDF's outline.
- **EPUB** ([`src/EpubReader.jsx`](src/EpubReader.jsx) + [`src/epub.js`](src/epub.js)): text you
  can resize (size, serif/sans, width, spacing), chapters with the book's own contents, a
  progress slider, links between chapters and notes. An EPUB is untrusted content, so every
  chapter is sanitized with DOMPurify and an allow-list (no scripts, frames, forms, svg, event
  handlers or classes; inline style cut down to a few typographic properties; images only from
  inside the book; ids prefixed per chapter) — `scripts/lib/epub.test.mjs` and the browser tests
  cover it.

Google refuses to serve a Drive file to a browser's own request (403), so files go through a
small relay, [`api/file.js`](api/file.js) (a Vercel Edge Function, `GET /api/file?id=…&kind=pdf|epub`).
It streams the file from Drive and stores nothing (`Cache-Control: private`); it only accepts
requests from the site's own pages, checks the first bytes match the kind, up to 80 MB. It does
use Vercel bandwidth: roughly the size of each file opened. If Google won't serve a file
(private, or over its download quota) the reader says why (and, for a PDF, shows Google's own
viewer). Other formats link to Drive.

## Copies of the same fic

The same fic is often in several drives. Each result is one fic; if there are other
copies, a bar on the card (“2 versions of this fic · 3 copies”) opens the list of them
so the reader can pick. The rules live in [`scripts/lib/group.mjs`](scripts/lib/group.mjs)
(tests: `npm test`):

- **Same fic** = identical text (a fingerprint of the whole document is stored when it
  is downloaded), or the same AO3 work id, or the same title **and** a common author.
- **Different authors are never grouped**, whatever the title (there are dozens of
  different “Home”). A copy whose author can't be read (no AO3 info page, not
  downloaded yet) is only grouped through identical text or AO3 id. Very generic titles
  (shared by more than 60 fics) are never grouped by title.
- **Identical files are merged** into one version with several places. **Any difference
  in the text keeps copies apart as separate versions** (never merged), best first:
  complete, then longest. The same work as an EPUB and as a PDF is one version only if
  its stats (words, chapters, last update) are identical.

Grouping gets more complete as tags and fingerprints are collected over the runs.

## Files

| Path | What it is |
| --- | --- |
| `data/config.json` | Master Drive folder and the repo name used by the “Add a drive” form |
| `data/sources.json` | Extra drives (manual and added via the site) |
| `scripts/crawl.mjs` | Finds the drives and lists the fics → `data/listing.json` |
| `scripts/build-index.mjs` | Reads the tags → `public/index.json` + `public/details/*.json` |
| `scripts/fetch-index.mjs` | Used by the Vercel build: downloads the published index |
| `scripts/lib/meta.mjs` | The AO3 EPUB/PDF metadata parser |
| `src/` | The React app |

`public/index.json` holds what search needs, in columns (titles, tags, authors,
word counts). File links and summaries are in small `public/details/<n>.json`
chunks, which are loaded only for the fics on screen.

## Credit

Every fic belongs to its author, and every drive belongs to the person who made
it. This site only points to them. When the archive is back, go leave kudos. 💛
