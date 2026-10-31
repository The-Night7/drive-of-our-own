# Drive of Our Own

A search engine for the fanfics people have been saving to Google Drive since AO3
went down. It indexes the community drives, reads each fic's AO3 tags, and lets you
search by title, author, fandom, ship, character or any tag. Every result links
**straight to the file in its original drive**. Nothing is copied or re-hosted.

React + Vite, hosted on Vercel. Search runs entirely in the browser.

## Everything runs on its own

A GitHub Actions workflow ([`deploy.yml`](.github/workflows/deploy.yml)) runs every
6 hours, on every push and whenever a drive is added. Nobody has to do anything:

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
   chapters. Results are cached per file, so each run only reads new files. The
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
