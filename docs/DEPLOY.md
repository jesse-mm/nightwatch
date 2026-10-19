# Publishing

There is no server to run. The catalog lives next to the settings page, and
the phone loads it from there. Publishing a new catalog means three steps:
run the generator, copy its catalog into `site/`, and publish `site/` as
static files. Building the `.pbw` is only needed for the first install or
when the watchface itself changes.

## 1. Run the generator

```sh
cp .env.example .env              # set CONTACT
scripts/catalog.sh fetch          # optional: reuse the shared Featured list
docker compose run --rm generator
```

The first run takes hours (see [GENERATOR.md](GENERATOR.md)); later runs only
redo what changed. It writes the catalog folder `catalog/web/`.

## 2. Copy the catalog into the site

```sh
node scripts/bundle-catalog.mjs   # [catalog/web]
```

This copies the folder to `site/catalog/` (`manifest.json`, `featured.json`
and one file per era, ~1.1 MB together). It's generated and not in git.

## 3. Build the watchface

Set `SETTINGS_URL` in `watchface/src/pkjs/config.production.js` to where the
settings page will live (no trailing slash; the phone opens
`SETTINGS_URL + '/#<state>'`), then build with the Pebble SDK
([developer.repebble.com](https://developer.repebble.com)):

```sh
npm run build:watch                # → watchface/build/watchface.pbw (~240 KB)
cd watchface
pebble install --phone <phone-ip>
```

The build picks its settings file: `npm run build:watch` always uses
`config.production.js`. A plain `pebble build` uses `config.dev.js` when it
exists (it's not in git, see "Testing locally") and `config.production.js`
otherwise; `NIGHTWATCH_ENV=dev` or `production` forces one. The build writes
`config.js` to load the chosen file, so don't edit that one.

The catalog isn't part of the app, so a new catalog needs no new `.pbw`.

## 4. Host the settings page

`site/` is plain static files: `index.html`, `app.js`, `style.css`,
`render.js`, `looks.js`, `settings.js`, `catalog.js` and the generated
`catalog/` folder. Any static host works; on GitHub Pages, publish `site/`
including the generated `catalog/` folder (it's gitignored, so copy it in
when you publish).

### On Cloudflare Pages

Upload `site/` directly rather than connecting the repository: the catalog
isn't in git, and the generator takes far too long to run in a Pages build.

```sh
npm run deploy                         # bundles the catalog, then uploads site/
PAGES_PROJECT=<name> npm run deploy    # project name other than nightwatch
```

The first run asks you to log in to Cloudflare and creates the project, which
is then live at `https://<name>.pages.dev`. To serve it from a subdomain of
your own, add it under the project's **Custom domains**: if the domain's DNS
is on Cloudflare the record and certificate are set up for you; otherwise add
a `CNAME <subdomain> → <name>.pages.dev` record at your DNS provider. Then
set `SETTINGS_URL` to that address (step 3). The site is far within the free
plan's limits (25 MiB per file, 20,000 files).

The page loads `catalog/manifest.json` from next to itself (and other catalog
files only when it needs them) and pictures straight from the Rijksmuseum's
IIIF server, so it needs nothing else. The phone loads its catalog files from
the same place (`SETTINGS_URL/catalog/`), so keep the site up: without it the
phone keeps showing its current painting but can't pick a new one, apart
from catalog files it cached before.

### Updating the catalog

Run the generator, `node scripts/bundle-catalog.mjs`, and publish `site/`
again (on Cloudflare Pages, `npm run deploy` does both). The phone sees the
new manifest `id` the next time it fetches a new painting, drops the catalog
files it cached and loads the new ones. Phone webviews may block plain HTTP,
so use HTTPS for the published page.

### Testing locally

```sh
npm run dev                # both of these:
npm run site               #   serves site/ on :8090 (npx serve)
npm run emulator-images    #   only for the emulator, on :8092 (see below)
```

Copy `watchface/src/pkjs/config.production.js` to `config.dev.js` next to it
(not in git), set `SETTINGS_URL` to `http://<your-mac>:8090` there, then
`pebble build` and install. That's all a real phone needs.

The emulator's PebbleKit JS can't download binary data, so it can't fetch the
PNG crops itself. `scripts/emulator-images.mjs` fetches them from the IIIF
server and hands them over as base64 text; add
`DEV_BASE64_URL: 'http://<your-mac>:8092/base64?url='` to `config.dev.js`.
With `DEV_GONE=<iiif id>` it answers 404 for that image, to try what happens
when the Rijksmuseum drops a pinned painting.

**Debug pane.** With `DEBUG: true` in `config.dev.js`, the app opens the
settings page with `?debug=true` (you can also add it by hand in a browser).
The pane shows what the phone stores (and how big it is), the catalog version
on the phone and on the site, and the current painting, and has actions the
phone runs when the page closes: pin *The Milkmaid*, new painting now, re-send
the image to the watch, clear the catalog cache, reset the phone's storage, plus
clearing the page's own storage and copying the debug info.

## Settings reference (.env)

Read by the generator. `docker-compose.yml` passes on `RUST_LOG`,
`REQUESTS_PER_SECOND`, `CONTACT`, `REFRESH_DAYS`, `SAFE_CROP_PX`,
`PD_FALLBACK_YEAR`, `POOL_MAX_PAGES` and `SOURCE_SIZE`, and mounts `DATA_DIR`;
`CATALOG_URL` is for `scripts/catalog.sh`.

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | ./data | The generator's working directory (`catalog.sqlite` + master images) |
| `CATALOG_URL` | (empty) | Release asset for `scripts/catalog.sh fetch` |
| `REQUESTS_PER_SECOND` | 1 | Pace of all outside requests |
| `REFRESH_DAYS` | 25 | Re-check metadata/pools older than this |
| `CONTACT` | (empty) | Your email or URL for the User-Agent; needed for Wikipedia pageviews |
| `FEATURED_PATH` | ./catalog/featured.json | The Featured list (the Docker image uses `/catalog/featured.json`) |
| `BUNDLE_DIR` | ./catalog/web | Where to write the catalog folder (the Docker image uses `/catalog/web`) |
| `EXPORT_PATH` | (none) | Also write `paintings.jsonl` here |
| `SAFE_CROP_PX` | 20 | Max pixels trimmed by a plain center crop before smart crop takes over |
| `PD_FALLBACK_YEAR` | 1850 | Accept records without license info only if made by this year; 0 = never |
| `POOL_MAX_PAGES` | 80 | Search pages crawled per pool |
| `RIJKS_SEARCH_URL` | paintings with images | Change to widen/narrow the collection |
| `SOURCE_SIZE` | 1200 | Longest side of the master image |
| `RUST_LOG` | info | Log level (`debug` for more) |
