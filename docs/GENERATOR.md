# The generator

`treasure-trove-generator` (in `generator/`) builds `catalog/catalog.json`: the
painting catalog that is bundled into the watchface and loaded by the settings
page. It keeps metadata and a master image per painting in `data/`, plans a
Cover crop of each painting for every supported screen, and writes the plans
into the catalog. It never stores pictures for the watch: the phone and the
settings page ask the Rijksmuseum's IIIF server for exactly the planned crop.
Tone, color tuning and frames are applied on the phone and in the settings
page (`site/render.js`). See [ARCHITECTURE.md](ARCHITECTURE.md).

## Running it

```sh
cp .env.example .env                         # set CONTACT
docker compose run --rm generator            # full run, also writes catalog/paintings.jsonl
docker compose run --rm generator treasure-trove-generator --help
docker compose run --rm generator treasure-trove-generator --limit 20   # test run
node scripts/bundle-catalog.mjs              # copy catalog.json into the app and site/
```

Options replace the service's default command, so name the binary when you
pass any. Without Docker, from the repository root:

```sh
cargo run --release --manifest-path generator/Cargo.toml -- --export catalog/paintings.jsonl
```

| Option | Use |
|---|---|
| `--data DIR` | Working directory: `catalog.sqlite` + `art/` (`DATA_DIR`, default `./data`) |
| `--bundle FILE` | Where to write `catalog.json` (`BUNDLE_PATH`, default `./catalog/catalog.json`) |
| `--export FILE` | Also write `paintings.jsonl`, for diffs (`EXPORT_PATH`) |
| `--rps 0.5` | Requests per second to outside services; 0.5 = one every 2 seconds (`REQUESTS_PER_SECOND`, default 1) |
| `--contact TEXT` | Your email or a URL, sent in the User-Agent (`CONTACT`) |
| `--refresh-days 0` | Re-check every painting's metadata now (`REFRESH_DAYS`, default 25) |
| `--featured FILE` | The Featured list (`FEATURED_PATH`, default `./catalog/featured.json`) |
| `--refresh-featured` | Rebuild the Featured list (e.g. once a year) |
| `--limit 20` | Test run: fetch and plan only 20 paintings |
| `--only 200107928` | One painting (repeatable) |
| `--skip-fetch` | Plan from what's on disk (no network at all) |
| `--skip-plan` | Fetch only |

It's safe to stop at any time (Ctrl-C, reboot): everything written so far is
recorded with its hash, and the next run continues where it left off.

## What it does

1. **Pools**: crawls the Search API for paintings with an image, and again per
   century for the "Paintings from" filter (~90 requests).
2. **Metadata**: resolves each painting (3–5 requests). Rejected paintings are
   stored too, so they aren't re-checked until `REFRESH_DAYS` have passed.
3. **Master image**: downloads a 1200 px image (`SOURCE_SIZE`) of each eligible
   painting once, kept in `data/art/<key>/source.jpg` for planning. It's only
   fetched again if the painting's IIIF URL changes (IIIF images are
   immutable).
4. **Featured** (only when `catalog/featured.json` is missing, or with
   `--refresh-featured`): one SPARQL query lists the Wikipedia articles about
   Rijksmuseum paintings (~415 paintings, ~1,200 articles, all languages), then
   one Wikimedia pageviews request per article for the last 12 full months
   (~20 minutes). The top 365 eligible paintings, topped up with others when
   fewer have an article, are saved to `catalog/featured.json` in rank order.
   Otherwise the file is just read.
5. **Plan** (local, all CPU cores): one Cover crop per screen (4 per painting:
   144×168, 180×180 round, 200×228, 260×260 round) with the smart crop, stored
   with the image's width and height in `data/catalog.sqlite` (table
   `crop_plans`); only plans whose inputs changed are redone.
6. **Write**: `catalog/catalog.json` (`--bundle`) and, with `--export`,
   `paintings.jsonl`.

Then run `node scripts/bundle-catalog.mjs` to copy `catalog.json` to
`watchface/src/pkjs/catalog-data.js` and `site/catalog.json`.

## Being polite

**Set `CONTACT`** (in `.env`) to an email address or URL. It goes into the
User-Agent, as [Wikimedia's policy](https://meta.wikimedia.org/wiki/User-Agent_policy)
requires: without it the pageviews API answers 429 to every request, and the
generator falls back to ranking Featured by the number of Wikipedia articles.

All outside requests (Rijksmuseum, its IIIF image server, Wikidata) go through
one pacer: `REQUESTS_PER_SECOND` (default 1). A "429 Too Many Requests" or a
server error pauses *all* requests (honoring `Retry-After`, otherwise 30 s,
60 s, …) before retrying, up to five times. The Rijksmuseum sends no rate-limit
headers, so we stay well below anything that could matter.

## Only redo what changed

| What | Redone when |
|---|---|
| Pools | older than `REFRESH_DAYS` (25) |
| Featured list (`catalog/featured.json`) | only when missing or with `--refresh-featured` |
| Metadata | older than `REFRESH_DAYS`; marked *changed* only if its hash differs |
| Master image | its IIIF URL changed, or the file is missing |
| Crop plan | master image hash, `SAFE_CROP_PX` or `PIPELINE_VERSION` changed |
| `catalog.json` | every run |

Tone, frames and color tunings live in `render.js`, so changing them needs no
generator run at all. Changing the planning code (bump `PIPELINE_VERSION` in
`generator/src/variants.rs`) makes the next run re-plan **from the local master
images**, with no network:

```sh
docker compose run --rm generator treasure-trove-generator --skip-fetch
```

## Output

```
data/catalog.sqlite                 the working database: paintings, eras, crop plans + input hashes
data/art/<key>/source.jpg           master image, for planning
catalog/catalog.json                the catalog for the phone and the settings page
catalog/paintings.jsonl             metadata: one painting per line, sorted (--export)
catalog/featured.json               the Featured list (see below)
```

`catalog.json` is described in [ARCHITECTURE.md](ARCHITECTURE.md#the-catalog-catalogjson)
and [`docs/schema/catalog.schema.json`](schema/catalog.schema.json). Only
paintings with a crop plan and an image on the IIIF server make it in.

Rendered crops from before the generator stopped rendering
(`data/art/<key>/c/`, ~3 GB) are no longer used; delete them by hand.

### The Featured list

Wikipedia readership barely changes month to month, so `catalog/featured.json`
is built once and then reused (and shared as a release artifact, below);
refresh it now and then with `--refresh-featured`. It lists the 365 paintings
in rank order with title, artist, number of articles and views, so diffs are
readable and you can swap paintings by hand (any eligible painting's `key`
works; ones without a crop plan are skipped). `catalog.json` stores the list in
day-of-year order, a fixed per-year shuffle of the ranking, so famous works are
spread over the year. Test runs (`--only`, `--limit`) never overwrite the file.

Neither `data/` nor `catalog/` is in git. `data/` stays on the machine that
runs the generator; `catalog/` is shared as a release artifact.

### Sharing the catalog (release artifact)

`catalog/` is generated, so instead of committing it, publish it as a release
asset (e.g. on GitHub) and fetch it where it's needed:

```sh
scripts/catalog.sh pack     # -> catalog.tar.gz + catalog.tar.gz.sha256
# upload both to a release, keeping these names
scripts/catalog.sh fetch    # downloads $CATALOG_URL (+ .sha256), verifies, unpacks into catalog/
```

The archive holds `featured.json` and `paintings.jsonl`. Set `CATALOG_URL` in
`.env`. With fixed asset names, GitHub's
`https://github.com/<owner>/<repo>/releases/latest/download/catalog.tar.gz`
always points at the newest upload. The script only needs `tar`, `curl` or
`wget`, and `sha256sum` or `shasum`, so it also works on a bare Linux box
(tested with BusyBox on Alpine), and it refuses an archive whose checksum
doesn't match.

Fetch before a generator run on a new machine, so it reuses the Featured list
instead of rebuilding it.

## Expected size and time

For the ~4,900 paintings in the collection:

| | Time or size |
|---|---|
| First run (metadata + master image, 5–7 requests per painting), `--rps 4` | ~2.5 hours |
| First run at the default 1 request/s | 7–10 hours |
| Monthly run (metadata only, 3–5 requests per painting), 1 request/s | 4–7 hours |
| Planning all 4,868 paintings (all cores) | ~12 seconds |
| Master images (~0.17 MB each) | ~0.8 GB |
| `catalog.json` | ~1 MB (~275 KB gzipped) |

The default of 1 request per second stays gentle on purpose.
