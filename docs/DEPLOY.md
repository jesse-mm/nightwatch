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

Set `SETTINGS_URL` in `watchface/src/pkjs/config.js` to where the settings
page will live (no trailing slash; the phone opens `SETTINGS_URL + '/#<state>'`),
then build with the Pebble SDK
([developer.repebble.com](https://developer.repebble.com)):

```sh
cd watchface
pebble build                       # → build/watchface.pbw (~240 KB)
pebble install --phone <phone-ip>
```

The catalog isn't part of the app, so a new catalog needs no new `.pbw`.

## 4. Host the settings page

`site/` is plain static files: `index.html`, `app.js`, `style.css`,
`render.js`, `looks.js`, `settings.js`, `catalog.js` and the generated
`catalog/` folder. Any static host works; on GitHub Pages, publish `site/`
including the generated `catalog/` folder (it's gitignored, so copy it in
when you publish).

The page loads `catalog/manifest.json` from next to itself (and other catalog
files only when it needs them) and pictures straight from the Rijksmuseum's
IIIF server, so it needs nothing else. The phone loads its catalog files from
the same place (`SETTINGS_URL/catalog/`), so keep the site up: without it the
phone keeps showing its current painting but can't pick a new one, apart
from catalog files it cached before.

### Updating the catalog

Run the generator, `node scripts/bundle-catalog.mjs`, and publish `site/`
again. The phone sees the new manifest `id` the next time it fetches a new
painting, drops the catalog files it cached and loads the new ones. Phone webviews may
block plain HTTP, so use HTTPS for the published page.

### Testing locally

```sh
npm run dev                # both of these:
npm run site               #   serves site/ on :8090 (npx serve)
npm run emulator-images    #   only for the emulator, on :8092 (see below)
```

Set `SETTINGS_URL` to `http://<your-mac>:8090` in `watchface/src/pkjs/config.js`,
rebuild and install. That's all a real phone needs.

The emulator's PebbleKit JS can't download binary data, so it can't fetch the
PNG crops itself. `scripts/emulator-images.mjs` fetches them from the IIIF
server and hands them over as base64 text; add
`DEV_BASE64_URL: 'http://<your-mac>:8092/base64?url='` to your local
`config.js` (leave it out for real use). With `DEV_GONE=<iiif id>` it answers
404 for that image, to try what happens when the Rijksmuseum drops a pinned
painting.

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
