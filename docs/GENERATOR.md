# The generator

`treasure-trove-generator` builds everything the server serves: metadata for
every painting, a master image per painting, and a crop of each painting for
every supported screen. The server only reads its output; colour tuning and
frames are applied on the phone and in the settings page
(`server/static/config/render.js`).

## Running it

```sh
docker compose run --rm generator            # full run, then exports catalog/paintings.jsonl
docker compose run --rm generator --help     # all options
```

Useful options:

| Option | Use |
|---|---|
| `--limit 20` | Test run: fetch and render only 20 paintings |
| `--only 200107928` | One painting (repeatable) |
| `--skip-fetch` | Render only, from what's on disk (no network at all) |
| `--skip-render` | Fetch only |
| `--rps 0.5` | Slower: one request every 2 seconds |
| `--refresh-days 0` | Re-check every painting's metadata now |

It's safe to stop at any time (Ctrl-C, reboot): everything written so far is
recorded with its hash, and the next run continues where it left off.

## What it does

1. **Wikidata links**: one SPARQL query for all Rijksmuseum paintings.
2. **Pools**: crawls the Search API for paintings with an image, and again per
   century for the "Paintings from" filter (~90 requests).
3. **Metadata**: resolves each painting (3–5 requests). Rejected paintings are
   stored too, so they aren't re-checked until `REFRESH_DAYS` have passed.
4. **Master image**: downloads the 1200 px image once. It's only fetched again
   if the painting's IIIF URL changes (IIIF images are immutable).
5. **Featured** (only when `catalog/featured.json` is missing, or with
   `--refresh-featured`, e.g. once a year): one SPARQL query lists the
   Wikipedia articles about Rijksmuseum paintings (~415 paintings, ~1,200
   articles, all languages), then one Wikimedia pageviews request per article
   for the last 12 full months (~20 minutes). The top 365 eligible paintings,
   topped up with others when fewer have an article, are saved to
   `catalog/featured.json` in rank order. Otherwise the file is just read.
6. **Render** (local, all CPU cores): 8 crops per painting (4 screens ×
   Fill/Whole), toned, lossless PNG; only those whose inputs changed.
7. **Export**: `catalog/paintings.jsonl`.

## Being polite

**Set `CONTACT`** (in `.env`) to an email address or URL. It goes into the
User-Agent, as [Wikimedia's policy](https://meta.wikimedia.org/wiki/User-Agent_policy)
requires: without it the pageviews API answers 429 to every request, and the
generator falls back to ranking Featured by the number of Wikipedia articles.

All outside requests (Rijksmuseum, its IIIF image server, Wikidata) go through
one pacer: `REQUESTS_PER_SECOND` (default 1). A "429 Too Many Requests" or a
server error pauses *all* requests (honouring `Retry-After`, otherwise 30 s,
60 s, …) before retrying, up to five times. The Rijksmuseum sends no rate-limit
headers, so we stay well below anything that could matter.

## Only redo what changed

| What | Redone when |
|---|---|
| Pools, Wikidata | older than `REFRESH_DAYS` (25) |
| Featured list (`catalog/featured.json`) | only when missing or with `--refresh-featured` |
| Metadata | older than `REFRESH_DAYS`; marked *changed* only if its hash differs |
| Master image | its IIIF URL changed, or the file is missing |
| Crop | master image hash, crop settings or `PIPELINE_VERSION` changed |

Frames and colour tunings live in `render.js`, so adding or changing one needs
no generator run at all. Changing the crop or tone code (bump
`PIPELINE_VERSION` in `server/src/variants.rs`) makes the next run re-render
the crops **from the local master images**, with no network:

```sh
docker compose run --rm generator --skip-fetch
```

## Output

```
data/catalog.sqlite                 the catalog (server loads it into memory)
data/art/<key>/source.jpg           master image
data/art/<key>/c/*.png              8 crops: <w>x<h>-<rect|round>-<fill|whole>.png, toned RGB
catalog/paintings.jsonl             metadata: one painting per line, sorted
catalog/featured.json               the Featured list (see below)
```

### The Featured list

Wikipedia readership barely changes month to month, so `catalog/featured.json`
is built once and then reused (and shared as a release artifact, below); refresh it now and then with
`docker compose run --rm generator --refresh-featured`. It lists the 365
paintings in rank order with title, artist, number of articles and views, so
diffs are readable and you can swap paintings by hand (any eligible painting's
`key` works; ones that aren't rendered are skipped). The day of the year maps
to a fixed per-year shuffle of the list, so famous works are spread over the
year. Test runs (`--only`, `--limit`) never overwrite the file.

Neither is in git. `data/` stays on the machine (or is copied with rsync, see
DEPLOY.md); `catalog/` is shared as a release artifact.

### Sharing the catalog (release artifact)

`catalog/` is generated, so instead of committing it, publish it as a release
asset (e.g. on GitHub) and fetch it where it's needed:

```sh
scripts/catalog.sh pack     # -> catalog.tar.gz + catalog.tar.gz.sha256
# upload both to a release, keeping these names
scripts/catalog.sh fetch    # downloads $CATALOG_URL (+ .sha256), verifies, unpacks into catalog/
```

Set `CATALOG_URL` in `.env`. With fixed asset names, GitHub's
`https://github.com/<owner>/<repo>/releases/latest/download/catalog.tar.gz`
always points at the newest upload. The script only needs `tar`, `curl` or
`wget`, and `sha256sum` or `shasum`, so it also works on a bare Linux box
(tested with BusyBox on Alpine), and it refuses an archive whose checksum
doesn't match.

Fetch before a generator run on a new machine, so it reuses the Featured list
instead of rebuilding it.

## How the server picks up new output

The generator works in `catalog.sqlite`, which holds a row and hash for every
crop. The server doesn't read that. Instead the
generator **publishes** `serve.sqlite`: a copy of only what the server needs
(paintings, eras, Wikipedia links, crop plans, and a *ready* flag set once all
8 crops of a painting exist).

1. It writes the copy to `serve.sqlite.tmp`.
2. It renames the temp file to `serve.sqlite`. A rename is atomic: anyone
   opening the name gets either the old file or the new one, never a mix.
3. The server checks the file's timestamp every minute. When it changes, it
   reads the new file into plain in-memory maps (paintings by key, a key list
   per era) and swaps them in; requests in flight keep using the old copy
   until they finish. No SQL runs while answering a request.

SQLite stays the file format because the generator needs transactions and
resumable bookkeeping, and you can inspect it with the `sqlite3` CLI.

It publishes after fetching, every 800 paintings while rendering, and at the
end, so during a long first run the server offers paintings as they finish.
File paths aren't stored: they follow from the painting key and crop name.

## Expected size and time

Measured on test runs (Apple silicon, 12 cores, 1 request/s):

| | Per painting | ~4,900 paintings |
|---|---|---|
| Fetch (first run: metadata + master image) | 5–7 s (5–7 requests) | **7–10 hours** |
| Fetch (monthly: metadata only) | 3–5 s | 4–7 hours |
| Render (8 crops, 12 cores) | ~0.02 s | **~2 minutes** |
| Disk: 8 crops (lossless PNG) | 0.59 MB | ~2.8 GB |
| Disk: master image | 0.17 MB | ~0.8 GB |
| `catalog.sqlite` / `serve.sqlite` | | a few MB / ~25 MB |

`--rps 2` roughly halves the fetch time; the default stays gentle on purpose.
