# Publishing

There is no server to run. Publishing a new catalog means four steps: run the
generator, copy its catalog into the app and the settings page, build the
`.pbw`, and host the settings page as static files.

## 1. Run the generator

```sh
cp .env.example .env              # set CONTACT
scripts/catalog.sh fetch          # optional: reuse the shared Featured list
docker compose run --rm generator
```

The first run takes hours (see [GENERATOR.md](GENERATOR.md)); later runs only
redo what changed. It writes `catalog/catalog.json`.

## 2. Bundle the catalog

```sh
node scripts/bundle-catalog.mjs   # [catalog/catalog.json]
```

This copies the catalog to `watchface/src/pkjs/catalog-data.js` (bundled into
the app, ~1 MB) and `site/catalog.json` (for the settings page). Both are
generated and not in git.

## 3. Build the watchface

Set `SETTINGS_URL` in `watchface/src/pkjs/config.js` to where the settings
page will live (no trailing slash; the phone opens `SETTINGS_URL + '/#<state>'`),
then build with the Pebble SDK
([developer.repebble.com](https://developer.repebble.com)):

```sh
cd watchface
pebble build                       # → build/watchface.pbw (~2.4 MB)
pebble install --phone <phone-ip>
```

The catalog is part of the app, so new paintings reach readers with a new
`.pbw`.

## 4. Host the settings page

`site/` is plain static files: `index.html`, `app.js`, `style.css`,
`render.js`, `looks.js`, `settings.js`, `catalog.js` and the generated
`catalog.json`. Any static host works; on GitHub Pages, publish `site/`
including the generated `catalog.json` (it's gitignored, so copy it in when
you publish). The page's copy of the catalog can be updated on its own,
without a new `.pbw`.

The page loads `catalog.json` from next to itself and pictures straight from
the Rijksmuseum's IIIF server, so it needs nothing else. Phone webviews may
block plain HTTP, so use HTTPS for the published page.

### Testing locally

```sh
cd site && python3 -m http.server 8090
```

Set `SETTINGS_URL` to `http://<your-mac>:8090`, rebuild and install. The
emulator can open the settings page but can't download paintings (see
[ARCHITECTURE.md](ARCHITECTURE.md#known-limits)); use a real phone to see new
paintings.

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
| `BUNDLE_PATH` | ./catalog/catalog.json | Where to write `catalog.json` (the Docker image uses `/catalog/catalog.json`) |
| `EXPORT_PATH` | (none) | Also write `paintings.jsonl` here |
| `SAFE_CROP_PX` | 20 | Max pixels trimmed by a plain center crop before smart crop takes over |
| `PD_FALLBACK_YEAR` | 1850 | Accept records without license info only if made by this year; 0 = never |
| `POOL_MAX_PAGES` | 80 | Search pages crawled per pool |
| `RIJKS_SEARCH_URL` | paintings with images | Change to widen/narrow the collection |
| `SOURCE_SIZE` | 1200 | Longest side of the master image |
| `RUST_LOG` | info | Log level (`debug` for more) |
