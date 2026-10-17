# Architecture

There is no server. The watchface and the settings page get paintings straight
from the Rijksmuseum's IIIF image server, so nothing of ours runs anywhere. The
slow, polite work happens once, ahead of time:

- **Generator** (`generator/`, Rust, binary `treasure-trove-generator`):
  fetches paintings from the Rijksmuseum, checks licenses, sorts paintings into
  eras, ranks the Featured 365 and plans a smart crop of each painting for
  every supported screen. It writes all of that to a folder of small JSON
  files, `catalog/web/`. Run it monthly; it only redoes what changed. See
  [GENERATOR.md](GENERATOR.md).
- **Phone** (`watchface/src/pkjs/`, PebbleKit JS): loads the catalog from the
  settings page's host, one file at a time. It picks the painting, asks IIIF
  for the planned crop, tones, dithers and frames it, and streams the bytes to
  the watch.
- **Settings page** (`site/`): static files plus a copy of the catalog folder
  (`site/catalog/`), hosted anywhere (e.g. GitHub Pages). See
  [DEPLOY.md](DEPLOY.md).

```
generator ──▶ catalog/web/ ──▶ site/catalog/ ─┬─▶ phone    ──▶ IIIF crop (PNG)  ──▶ tone, dither, frame ──▶ watch
                                               └─▶ settings ──▶ IIIF image (PNG) ──▶ preview
```

`node scripts/bundle-catalog.mjs` copies `catalog/web/` to `site/catalog/`
(generated, not in git). Nothing is bundled into the watch app, so a new
catalog needs no new `.pbw`: publish `site/` again and the phone picks it up
the next time it fetches a new painting.

The phone and the page share their logic: `catalog.js`, `render.js`,
`settings.js` and `looks.js` live in `site/` and are symlinked into
`watchface/src/pkjs/`. They are ES5 (UMD), so they run in PebbleKit JS and in
the browser.

## The daily flow

1. The watchface starts, creates an empty 8-bit bitmap matching its screen (only
   color watches are supported: basalt, chalk, emery, gabbro) and sends a
   **Hello** with width, height, *row stride* (bytes per bitmap row, read from the
   bitmap itself), shape, the largest chunk it can receive, its 12/24h setting
   and the id of the painting it already shows (`ArtId`).
2. The phone sends its cached painting straight away if the watch is empty,
   then checks whether a new one is due (see rotation below) or the cached crop
   no longer matches the screen, fit, zoom or position.
3. If so, it picks a painting from the catalog (Featured for the day, random,
   optionally from one era, pinned, or one hung from the settings page; see
   [loading the catalog](#loading-the-catalog-on-the-phone-and-the-page)) and
   builds the IIIF URL for its crop with `catalog.js` (`cropRequest`).
4. The phone downloads the PNG (binary XHR, with an `x-user-defined` text
   fallback; it checks the PNG signature), decodes it (`png.js` with the
   vendored `vendor/tiny-inflate.js`), tones it (`render.js` `tone`), caches
   the toned crop in `localStorage`, renders it with the color tuning and frame
   (`render.js` `compose`), and streams the bytes to the watch in chunks
   (`ImgBegin`, `ImgOffset`+`ImgChunk` × n, `ImgEnd`). Changing tuning or frame
   later just re-renders the cached crop.
5. The watch `memcpy`s each chunk into the bitmap and redraws, so the painting
   appears row by row. Each painting carries an id (a hash of its bytes).
   Where an app may store enough (1 MB on Pebble Time 2, Round 2 and 2 Duo;
   older watches have 4 KB), the watch saves the painting on exit (`ArtMeta`
   plus 256-byte pieces) and shows it straight away on the next launch, e.g.
   after the menu. The phone skips sending a painting the watch already shows.
6. At midnight the watch's tick handler sends Hello again with reason 2, and the
   date check on the phone picks a new painting when one is due.

**Requests to the Rijksmuseum** stay low: the phone downloads one crop per new
painting (daily at most) and one when a saved look changes its crop, zoom or
position (the cache key, `cropKey`, includes them). It only ever asks for
screen size (at most 260×260, about 140 KB as PNG).

### Rotation, Featured and pinning (phone, `rotation.js`)

Each cached painting remembers its **period**: `daily:2026-10-16`,
`weekly:2026-10-12` (the Monday), `monthly:2026-10-01`, or `off`. On every
Hello the phone compares it with the current period and only fetches when it
changed, so the midnight Hello does nothing on most days for weekly/monthly.

- **Featured** takes `catalog.featured(N)`, where *N* is the day of the year
  of the period's first day: weekly shows that Monday's Featured painting,
  monthly the 1st's, so all rotations walk the same year.
- **Surprise me** takes `catalog.random(catalog.poolFor(era))`.
- **Pinned** (a key set via Advanced in the settings, found with
  `catalog.resolve`) always shows that painting; rotation doesn't apply until
  it's unpinned. The settings page hands the phone the pinned painting's row,
  so the phone needs no catalog file for it.

### Settings and looks on the phone (`settings.js`, `looks.js`)

The phone keeps two things in `localStorage`, both versioned JSON described by
a JSON Schema in [`docs/schema/`](schema/):

| Key | What | Schema | Code |
|---|---|---|---|
| `tt-settings` | The watchface settings plus `version` | [`settings.schema.json`](schema/settings.schema.json) | `settings.js`: `DEFAULTS`, `VERSION`, `MIGRATIONS` |
| `tt-looks` | `{version, looks}`: a look per painting | [`looks.schema.json`](schema/looks.schema.json) | `looks.js`: `FIELDS`, `VERSION`, `MIGRATIONS` |

Reading runs every migration from the stored version up, keeps only known
fields and fills the rest from the defaults. To change what a stored value
means: bump `VERSION`, add a step to `MIGRATIONS`, and update the schema
(`npm test` checks the schemas against the code). The page and the phone also
tell each other their settings version, so a newer settings page works with an
older phone app and the other way round. Version 1 is the first, so there are
no migrations yet.

**Backup.** Both live only on the phone (removing the watchface wipes them),
so the settings page has a Backup section. *Copy backup* puts this on the
clipboard ([`backup.schema.json`](schema/backup.schema.json)):

```json
{"backup": 1, "settings": {"version": 1, ...}, "looks": {"version": 1, "looks": {...}}}
```

The reader keeps it somewhere (a note, an email to themselves). *Restore*
takes the pasted text, applies it to the page for a check, and *Save to
watch* stores it: the settings as usual, and the phone replaces every saved
look with the backup's. Older backups go through the same migrations.

**Looks per painting.** When the reader changes the crop, zoom or position,
frame, color tuning or time placement and saves, the phone remembers that look
for the painting on the watch:

```json
{"version": 1, "looks": {"200108369": {"fit": "fill", "zoom": 140,
  "focusX": 420, "focusY": 310, "frame": "gold", "palette": "defined",
  "dither": "atkinson", "brightness": 10, "contrast": -5,
  "textRow": "bottom", "textCol": "end", "timeSize": "s"}}}
```

| Field | Setting | Values |
|---|---|---|
| `fit` | Crop | `fill` (Cover), `whole` (Contain) |
| `zoom` | Cover zoom | 100…200 (%) |
| `focusX`, `focusY` | Cover view center | 0…10000 across / down the painting; empty = smart crop |
| `frame` | Frame | `none`, `gold`, `wood`, `gallery` |
| `palette` | Color tuning | `defined` (Accurate), `sun` (Daylight), `room` (Indoors), `backlight` |
| `dither` | Dithering | `atkinson`, `checker` (50:50), `none` (Off) |
| `brightness` | Brightness | −100…100 |
| `contrast` | Contrast | −100…100 |
| `textRow` | Time row | `top`, `center`, `bottom` |
| `textCol` | Time column | `auto`, `start` (left), `center`, `end` (right) |
| `timeSize` | Time size | `s`, `m`, `l` |

A look is about 160 bytes, so even one for every painting (~0.8 MB) fits the
~5 MB storage. A painting with a saved look gets it back whenever it is hung
again, by rotation, a swap or a pin. A new painting without one starts with the
default color adjustments (tuning, dithering, brightness, contrast) at its
planned view (zoom and position): `looks.FRESH`. Crop, frame and time
placement carry over from the previous painting. The settings page gets the saved looks too (in its URL, so
only up to ~100 KB of them), so a swapped-in painting previews with its own
look.

### Why raw bitmap bytes on the watch?

Pebble apps have little RAM (64 KB on basalt). Decoding a PNG on the watch
needs the compressed file *and* the decoded bitmap in memory at once, plus
decoder work space. So the phone decodes the PNG and sends bytes already in the
watch's own layout: the only large allocation on the watch is the bitmap
itself. The trade-off is transfer size (24 KB for basalt, 46 KB for emery),
which takes a few seconds over Bluetooth. Watches with 4 KB of app storage
can't keep the painting between launches, so the phone caches it and sends it
again on each launch.

## The catalog (`catalog/web/`)

A folder of small JSON files, so the phone and the page only download and
parse what they need. The generator writes it (`generator/src/bundle.rs`);
[`docs/schema/catalog.schema.json`](schema/catalog.schema.json) describes the
manifest and the other files.

| File | Paintings | What |
|---|---|---|
| `manifest.json` | – | Shared fields and the list of files (~800 bytes) |
| `featured.json` | 365 | The Featured paintings, in day-of-year order |
| `pre1600.json` | 505 | Paintings made before 1600 |
| `1600s.json` | 2,184 | The 1600s (the largest file, ~480 KB) |
| `1700s.json` | 871 | The 1700s |
| `1800s.json` | 1,215 | The 1800s |
| `1900s.json` | 92 | The 1900s |
| `undated.json` | 1 | Paintings without a usable date |

Every painting is in exactly one era file (or `undated.json`); Featured ones
are also in `featured.json`. A painting's era comes from the Rijksmuseum's
search pools, or else from the first year in its own date text
(`Era::from_date` in `era.rs`), because the search API's `creationDate`
wildcards miss approximate dates like "c. 1650". "Any era" includes undated
paintings, so they need no setting of their own.

`manifest.json`:

| Field | What |
|---|---|
| `version` | 2 |
| `id` | A hash of all the files; a new id means new files |
| `iiifPrefix`, `webPrefix` | Base URLs for images (`https://iiif.micr.io/`) and object pages |
| `eras` | `pre1600`, `1600s`, `1700s`, `1800s`, `1900s` |
| `licenses` | `[label, url]` pairs, referenced by index |
| `screens` | `[w, h, round]` for the four screens, in crop order |
| `slack` | Cover slack in screen pixels (20) |
| `files` | `[{pool, file, count}]`: each file, the pool it holds (`featured`, an era or `undated`) and its number of paintings |

Every other file is `{version, id, pool, paintings}`, with `id` the
manifest's. `paintings` has one array (a *row*) per painting:
`[key, iiif, title, artist, date, objectNumber, eraBits, license, aspect, crops]`.

`eraBits` has bit *i* set for `eras[i]`; `aspect` is width / height of the
image. `crops` has one entry per screen: the Cover crop as fractions of the
image (`x, y, w, h`, slack included) and `window`, where the planned view
starts in that crop in screen pixels along its free axis.

`catalog.js` reads it: `create(manifest)` starts an empty catalog,
`add(part)` adds a file (and refuses one with another `id`), `addRow(row)`
adds a single painting. It also offers `files`, `id`, `has(pool)`,
`fileFor(pool)`, `poolFor(era)` (see below), `row(key)`, `get(key)`,
`featured(day)`, `random(pool)`, `resolve(query)` (object number, key or link)
and:

- `coverView(key, screen, {zoom, focusX, focusY})`: the visible part of the
  painting, as fractions. Without a focus it is the planned view; zoom shrinks
  it around its center.
- `cropRequest(key, screen, fit, view)`: the IIIF URL, exactly at screen size.
  Cover: `<iiifPrefix><id>/pct:x,y,w,h/<w>,<h>/0/default.png` for the
  `coverView` region. Contain: `/full/<w>,<h>/0/default.png`, the whole
  painting fitted inside the screen.
- `workImage(key, screen, maxZoom)`: the whole painting at twice the Cover size
  (enough to zoom to 200 % at full resolution), at most 1280 px on its long
  side, for the settings page.

### Loading the catalog on the phone and the page

**Phone** (`index.js`). Only when a new painting is due, the phone fetches
`SETTINGS_URL/catalog/manifest.json` and caches it in `localStorage`
(`tt-catalog`); a new `id` drops the files it cached before. Then it loads only
the file it needs, cached as `tt-catalog-<pool>`:

- Featured: `featured.json`.
- Surprise me: `poolFor(era)`, the era's file, or for "any era" a file chosen
  in proportion to its painting count, so every painting is equally likely.

Offline it uses the cached manifest and files. The cached painting keeps its
own catalog row, and paintings the settings page hands over (pinned or hung)
are kept as rows in `tt-rows`, so fetching another crop of the current
painting or a pinned one needs no catalog file. Showing the cached painting
needs no network at all.

**Settings page** (`app.js`). It loads `catalog/manifest.json` and adds the
rows the phone sends along (`state.rows`: the painting on the watch, the
pinned one). It loads an era file only for "Hang a different painting", and
all files only when pinning by object number a painting that isn't among the
loaded ones (rare). On save it sends back the `rows` of the hung or pinned
painting.

### Translations (settings page)

The page is in English (`en-US`) and Dutch (`nl-NL`).

- **Files.** `site/translations/<lang>.json`: flat objects of keys
  (`"pin.done"`, `"backup.copied"`) to ICU MessageFormat messages:
  `{title}` placeholders, `{count, plural, one {# look} other {# looks}}` and
  `select`. Every language has the same keys. Messages contain no HTML; a
  sentence around a link or a `<strong>` is split into separate keys. Use
  typographic apostrophes (’): a plain `'` is an escape character in ICU.
- **Library.** `site/vendor/intl-messageformat-11.2.0.iife.js` (FormatJS,
  BSD-3-Clause, unmodified; see NOTICE.md), formatting with the active locale so
  plural rules fit the language. Compiled messages are cached per key. Without
  it, `i18n.js` falls back to plain `{name}` substitution with simple
  plural/select.
- **Language.** `?lang=` wins (`nl`, `nl-NL`, `en-US`, …); otherwise the
  browser's first preferred language. Anything starting with `nl` is Dutch,
  everything else English. `document.documentElement.lang` is set to it.
- **Fallback.** `en-US.json` is always loaded, plus the reader's file if
  different. A key is looked up in the reader's language, then English, then
  the key itself is shown.
- **Loading.** `index.html` loads `i18n.js` instead of `app.js`. `i18n.js`
  fetches the translation files, fills the static markup (`data-i18n="key"`
  sets the text; `data-i18n-attr="aria-label:key;placeholder:key"` sets
  attributes), and only then appends `app.js`, which uses
  `TreasureI18n.t(key, vars)` from its first line. If loading fails, it still
  loads `app.js`; the English text in the HTML stays as it is.
- **Adding a key.** Put it in every `translations/*.json`; in HTML add
  `data-i18n`/`data-i18n-attr` and keep the English text as the default
  content; in `app.js` use `t('key', { vars })`.
- **Adding a language.** Copy `en-US.json` to `<lang>.json`, translate it,
  and teach `supported()` in `i18n.js` which tags map to it.


**Search.** `search.json` (~570 KB, ~160 KB gzipped) lists every painting as
`[key, title, artist, date, objectNumber, pool, iiif]`, with the same `id`;
suggestions show a 128 px square thumbnail cut by the IIIF server (`…/square/128,128/0/default.jpg`). The
settings page loads it only when someone types in the pin field, matches every
typed word against title, artist, object number and date (ignoring case and
accents, titles that start with the first word first) and suggests up to 8.
Picking one loads just that painting's file (`pool`) and pins it.

## Picking a painting (generator)

- The generator crawls the Rijksmuseum **Search API** for paintings that have an
  image (the pool), and the same search per century with `creationDate`
  wildcards (`16*` …) for the "Paintings from" filter. Paintings the
  wildcards miss (approximate dates like "c. 1650") get their era from their
  own date.
- Each id is resolved as **Linked Art** JSON-LD. The image lives a few links
  away: object → `shows` (visual item) → `digitally_shown_by` (digital object)
  → `access_point` (a IIIF Image API URL).
- **License check** (`rijks.rs::judge_license`): the image's rights are in
  `subject_to` on the visual item (or digital object). The CC0 under
  `subject_of` covers the metadata text, not the artwork.
  - CC0 / Public Domain Mark / CC BY / CC BY-SA → allowed.
  - Any other statement (e.g. "In Copyright") → skipped.
  - No statement at all → allowed only if made no later than `PD_FALLBACK_YEAR`
    (1850 by default; set to 0 to require an explicit license).
- Every resolved record is stored, including rejected ones, so a painting is
  only re-checked after `REFRESH_DAYS`.
- Only paintings on the IIIF server at `iiif.micr.io` make it into the
  catalog, since the phone cuts its crops there.
- Wikidata is only used to pick the Featured paintings (`popularity.rs`); the
  catalog stores no per-painting Wikidata or Wikipedia links.

## Crops: planned by the generator, cut by IIIF, rendered on the phone

```
generator:  master image (1200 px, local) ──▶ plan crop ──▶ catalog/web/
phone:      IIIF crop at screen size (PNG) ──▶ tone ──▶ fit into the frame opening ──▶ dither ──▶ frame ──▶ watch bytes
page:       IIIF work image (≤ 1280 px) ──▶ pan/zoom locally ──▶ same steps ──▶ preview
```

The generator plans one **Cover** crop per screen (4 per painting) from a
1200 px master image it keeps locally, and stores the plans in
`data/catalog.sqlite` (table `crop_plans`). Contain needs no plan: it is the
whole painting, sized from its aspect ratio. Tone, color tuning and frames are
applied by `site/render.js`, which the phone and the settings page both run,
so changing them never downloads anything and the settings preview is exactly
what the phone sends to the watch.

**Crop planning** (`imaging.rs::plan_crop`), measured in *screen* pixels:

| Situation | Result |
|---|---|
| Shapes match | No crop |
| Filling the screen would trim ≤ `SAFE_CROP_PX` (20) | Center crop ("safe crop") |
| Trims more | **Smart crop** |

**Smart crop** (`saliency.rs`): there is no public points-of-interest dataset for
this collection (some Wikimedia Commons files have "depicts" regions, but coverage
is too sparse to rely on), so we estimate interest from the pixels, like
smartcrop.js: edges (detail), saturation (color) and a skin-tone detector (faces).
Because Cover always fits one axis exactly, only one direction is free, so we
slide a window along a 1-D energy profile. The window weights its center a little
more (strongly on round screens, whose corners are hidden), and there's a gentle
pull toward the painting's center and, for tall works, toward the top.
**Portraits keep the top:** when the window slides up and down and the title
says it's a portrait ("Portrait", "Portret", "Self-portrait", "Zelfportret"), or
at least 60% of the painting's skin tones sit in its top third, the crop keeps
the top and cuts the bottom, so busy armor, lace or hands lower down can't pull
the head out of view.

**Cover slack.** Cover crops keep up to `COVER_SLACK_PX` (20) screen pixels of
extra painting on each side of the free axis, as far as the painting goes. The
plan records where the planned view sits in it (`window` in the catalog row), so
`coverView` can find the planned view's center.

**Zoom and position.** On the settings page a Cover view can be zoomed in
(100–200 %) and moved anywhere: by dragging the preview, with the arrow buttons,
or back to the plan with Reset. At 100 % it only moves along the axis the
painting overflows; zoomed in, both ways. The view is saved per painting in its
look as `zoom`, `focusX`, `focusY` (view center, 0–10000; empty = the planned
view), and `coverView` turns it into the region to ask IIIF for. The page
downloads one work image per painting (`workImage`, typically 400–1000 px) and
pans and zooms it locally, with no requests while dragging.

**Tone** (`render.js` `tone`, ported from the generator's former Rust code):
auto-levels (ignoring the extreme 0.5 %, gain at most 2.5×), a shadow lift
(gamma 0.8, because the reflective screen crushes dark varnish into a single
black) and +10 % saturation. The phone tones the crop once and caches the
result.

**Rendering** (`render.js` `compose`):

1. *Fit:* with a frame, the opening is smaller than the screen. A Cover crop is
   scaled (bilinear) to cover the opening and trimmed evenly; a Contain crop is
   scaled to fit inside it.
2. *Dither:* Atkinson error diffusion to the Pebble palette. With color tuning
   other than *Accurate*, pixels are matched against how each Pebble color
   actually looks on the screen in that light, and the true Pebble color with
   the same index is written (pebble-color-optimizer's idea).
3. *Frame:* drawn in exact palette colors (no dithering) around the opening,
   or as a ring on round watches.
4. *Bytes:* `0b11RRGGBB` per pixel, rows padded to the stride the watch reported.

**Preview on the settings page:** the page shows the watch's bytes either
exactly or as they look on a Pebble Time 2 screen (`toScreenRGBA`): each of the
64 colors is replaced by its measured appearance indoors, in daylight or with
the backlight (the pebble-color-optimizer palettes), scaled to a paper-like
18–232 range so the phone's brightness doesn't decide, with a faint pixel grid.

`render.js` was ported from the generator's former Rust implementation and is
tested against its exact output (`watchface/test/`, `npm test`): dithering is
byte-identical for all four tunings, frames pixel-identical on all four screens.

## Storage

```
data/                                   generator's working directory (not in git)
  catalog.sqlite                        paintings, eras, image sizes, crop plans + input hashes
  art/<key>/source.jpg                  master image, longest side 1200 px (for planning)
catalog/                                (not in git; release artifact: scripts/catalog.sh)
  web/                                  the catalog for the phone and the settings page
    manifest.json, featured.json        shared fields and file list; Featured, day-of-year order
    pre1600.json … 1900s.json           one file per era
    undated.json                        paintings without a usable date
  featured.json                         the Featured list, rank order
  paintings.jsonl                       one painting per line: metadata, eras, hashes (for diffs)
site/catalog/                           copy of catalog/web/, published with the page (generated)
```

Bump `PIPELINE_VERSION` in `variants.rs` after changing the planning code: the
next generator run re-plans from the master images without fetching. Rendered
crops from the server era (`data/art/<key>/c/`, ~3 GB) are no longer used and
can be deleted by hand.

## Message keys

| Key | Direction | Meaning |
|---|---|---|
| `Hello` | watch → phone | 1 = launch, 2 = new day |
| `ScreenW`, `ScreenH`, `RowStride`, `IsRound`, `ChunkSize`, `Is24h` | watch → phone | screen description |
| `ArtId` | both | with Hello: the painting the watch shows; with `ImgBegin`: the id of the painting being sent |
| `PhoneReady` | phone → watch | JS started; watch replies with Hello |
| `ShowTime`, `ClockMode`, `HideAmPm`, `ShowDate`, `DateFormat`, `DateSep`, `HideUntilShake`, `RevealMinutes`, `BoxMode`, `TextPos`, `TimeSize`, `TextInset` | phone → watch | settings (ints; `TextPos` = row × 3 + column (row 0 top, 1 bottom, 2 center), round screens always centered horizontally; `TimeSize` 0–2 = S/M/L, default S; `TextInset` = frame width in pixels, so the text sits on the painting) |
| `ImgBegin`, `ImgOffset`, `ImgChunk`, `ImgEnd` | phone → watch | image transfer |

## Known limits

- **Binary downloads in the emulator.** The emulator's PebbleKit JS (pypkjs)
  can't download binary data (its ArrayBuffer is empty, text is UTF-8
  mangled). Real phones run PebbleKit JS on the phone's own JavaScript
  engine; the app tries an ArrayBuffer first, then the `x-user-defined` text
  trick, and checks for a real PNG. For the emulator only, a development
  helper (`scripts/emulator-images.mjs`, `DEV_BASE64_URL` in config.js) sends
  the images as base64.
- **A pinned painting that disappears.** If the catalog no longer has it or
  the Rijksmuseum answers 404/410 for its image, the phone doesn't retry: it
  notes it (`tt-unavailable`) and the settings page shows a notice. Once a
  pinned painting has been downloaded, the phone also keeps its own copy of
  the whole painting (`tt-pinned-source`: the settings page's 2× image, PNG,
  typically 300-700 KB), so color, crop and zoom keep working from that copy.
  Unpinning drops the copy and the notice.
- **The phone needs the static site.** It loads the catalog from
  `SETTINGS_URL`, so it can only pick a new painting while the site is
  reachable (or from catalog files it cached before). Showing the current
  painting needs neither the site nor the network.
- **App size.** The `.pbw` is ~240 KB; the catalog isn't in it.
