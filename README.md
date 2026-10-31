# Drive of Our Own

A little search engine for the fanfics people have been saving to Google Drive
since AO3 went down. It indexes the community drives I know about, then lets you
search every fic by title, fandom, ship or folder, and links **straight to the
file in its original drive**. Nothing is copied or re-hosted.

Built with React and Vite. The search runs entirely in the browser.

## How it works

1. `data/sources.json` lists the drives, with credit to whoever shared them.
2. `npm run crawl` (`scripts/crawl.mjs`) goes through each public folder and its
   subfolders through Drive's public folder view (no API key or login needed). It
   writes `public/index.json` with every fic's title, folder path and file links.
   An `.epub` and a `.pdf` with the same name count as one fic with two formats.
3. The React app loads `index.json` and searches it on the client.

Drives that aren't shared as "Anyone with the link" can't be crawled. They still
show up on the **Drives** page, marked *Not public*.

## Run it locally

```bash
npm install
```

```bash
npm run crawl
```

```bash
npm run dev
```

`npm run crawl -- --only <folderId>` re-crawls a single drive and keeps the
others from the existing index.

## Add a drive

Add an entry to `data/sources.json`:

```json
{ "url": "https://drive.google.com/drive/folders/<id>", "credit": "@whoever", "notes": "what's in it" }
```

Then run `npm run crawl`. Links that aren't Drive folders, such as a Google Sheet,
are listed on the Drives page but aren't crawled.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and deploys the site on every push to
`main`, and re-crawls all drives once a day. To turn it on, go to
**Settings → Pages → Build and deployment → Source: GitHub Actions**. To refresh
the index by hand, run the workflow from the **Actions** tab.

## Credit

Every fic belongs to its author, and every drive belongs to the person who made
it. This site only points to them. When the archive is back, go leave kudos. 💛
