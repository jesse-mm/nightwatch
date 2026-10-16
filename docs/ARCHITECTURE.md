# Architecture

Two programs share one Rust library (`server/src/lib.rs`):

- **Generator** (`treasure-trove-generator`): fetches paintings from the
  Rijksmuseum politely, cuts and tones a crop of each painting for every
  supported screen, and
  records it all in `data/catalog.sqlite`. Run it monthly; it only redoes what
  changed. See [GENERATOR.md](GENERATOR.md).
- **Server** (`treasure-trove-server`): reads the published snapshot
  (`serve.sqlite`) into plain in-memory maps and serves the files the generator
  made; it reloads when a new snapshot appears. It never calls an outside service and never
  renders; an unknown painting is a 404. Color tuning and frames are applied
  on the phone and in the settings page (`render.js`).

## The daily flow

1. The watchface starts, creates an empty 8-bit bitmap matching its screen (only
   color watches are supported: basalt, chalk, emery, gabbro) and sends a
   **Hello** with width, height, *row stride* (bytes per bitmap row, read from the
   bitmap itself), shape, the largest chunk it can receive, and its 12/24h setting.
2. The phone JS checks `localStorage`: if today's painting is already cached for
   this exact screen + framing + color tuning, it sends it straight away.
   Otherwise it calls `GET /api/art/random?w=…&h=…&color=1&stride=…&round=…&fit=…&palette=…&frame=…`.
3. The server picks a painting (Featured for the day, random, optionally from
   one era, or a pinned one) and replies with metadata plus an `rgbUrl`.
4. The phone downloads the crop (raw RGB as base64, gzipped), caches it, renders
   it with the color tuning and frame (`render.js`), and streams the bytes to
   the watch in chunks (`ImgBegin`, `ImgOffset`+`ImgChunk` × n, `ImgEnd`).
   Changing tuning or frame later just re-renders the cached crop.
5. The watch `memcpy`s each chunk into the bitmap and redraws, so the painting
   appears row by row.
6. At midnight the watch's tick handler sends Hello again with reason 2, and the
   date check on the phone fetches a new painting.

### Rotation, Featured and pinning (phone, `rotation.js`)

Each cached painting remembers its **period**: `daily:2026-10-16`,
`weekly:2026-10-12` (the Monday), `monthly:2026-10-01`, or `off`. On every
Hello the phone compares it with the current period and only fetches when it
changed, so the midnight Hello does nothing on most days for weekly/monthly.

- **Featured** asks for `/api/art/featured?day=N`, where *N* is the day of the
  year of the period's first day: weekly shows that Monday's Featured
  painting, monthly the 1st's, so all rotations walk the same year.
- **Surprise me** asks for `/api/art/random`, optionally with an era.
- **Pinned** (a key set via Advanced in the settings) always asks for that
  painting; rotation doesn't apply until it's unpinned.

### Why raw bitmap bytes instead of PNG?

Pebble apps have little RAM (64 KB on basalt). Decoding a PNG
needs the compressed file *and* the decoded bitmap in memory at once, plus decoder
work space. Sending bytes already in the watch's own layout means the only large
allocation is the bitmap itself, and there's no decoding on the watch at all.
The trade-off is transfer size (24 KB for basalt, 46 KB for emery), which takes a
few seconds over Bluetooth once per launch.

The watch can't keep the image between launches: persistent storage is limited
to 4 KB per app. That's why the phone caches it.

## Picking a painting (generator)

- The generator crawls the Rijksmuseum **Search API** for paintings that have an
  image (the pool), and the same search per century with `creationDate`
  wildcards (`16*` …) for the "Paintings from" filter.
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
- Wikidata is only used to pick the Featured paintings (`popularity.rs`); the
  catalog stores no per-painting Wikidata or Wikipedia links.

## Rendering: crops on the server, pixels on the phone

```
generator:  master image (1200 px, local) ──▶ plan crop ──▶ cut + resize (Lanczos3) ──▶ tone ──▶ crop.png
phone/page: crop ──▶ fit into the frame opening ──▶ dither (color tuning) ──▶ frame ──▶ watch bytes
```

The generator makes **8 crops** per painting: 4 screens × Fill/Whole, full
color, toned, lossless PNG. Color tuning and frames are applied by
`server/static/config/render.js`, which the phone (PebbleKit JS) and the
settings page both run, so one crop covers all 16 tuning × frame combinations,
changing them never downloads anything, and the settings preview is exactly
what the phone sends to the watch.

**Crop planning** (`imaging.rs::plan_crop`), measured in *screen* pixels:

| Situation | Result |
|---|---|
| Shapes match | No crop |
| Filling the screen would trim ≤ `SAFE_CROP_PX` (20) | Center crop ("safe crop") |
| Trims more, framing = Fill | **Smart crop** |
| Trims more, framing = Whole painting | Letterbox: the crop is the whole painting, smaller than the screen |

**Smart crop** (`saliency.rs`): there is no public points-of-interest dataset for
this collection (some Wikimedia Commons files have "depicts" regions, but coverage
is too sparse to rely on), so we estimate interest from the pixels, like
smartcrop.js: edges (detail), saturation (color) and a skin-tone detector (faces).
Because "fill" always fits one axis exactly, only one direction is free, so we
slide a window along a 1-D energy profile. The window weights its center a little
more (strongly on round screens, whose corners are hidden), and there's a gentle
pull toward the painting's center and, for tall works, toward the top.

**Tone** (`imaging.rs::tone`, in the generator): auto-levels (ignoring the
extreme 0.5 %), a shadow lift (gamma 0.8, because the reflective screen crushes
dark varnish into a single black) and +10 % saturation, baked into the crop.

**On the phone** (`render.js`, ES5 so it runs in PebbleKit JS):

1. *Fit:* with a frame, the opening is smaller than the screen. A Fill crop is
   scaled (bilinear) to cover the opening and trimmed evenly; a Whole crop is
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
data/                                   (not in git)
  catalog.sqlite                        paintings, eras, wiki links, crops + input hashes
  serve.sqlite                          the server's snapshot
  art/<key>/source.jpg                  master image, longest side 1200 px
  art/<key>/c/<crop>.png                8: <w>x<h>-<rect|round>-<fill|whole>, toned RGB
catalog/paintings.jsonl                 one painting per line: metadata, eras, links, hashes
catalog/featured.json                   the Featured list, rank order
                                        (catalog/ is a release artifact: scripts/catalog.sh)
```

About 0.6 MB of crops plus a 0.17 MB master per painting (~3.6 GB for the
collection). Bump `PIPELINE_VERSION` in `variants.rs` after changing crop or
tone output: the next generator run re-renders from the master images without
fetching (and removes folders from the older layout).

## Message keys

| Key | Direction | Meaning |
|---|---|---|
| `Hello` | watch → phone | 1 = launch, 2 = new day |
| `ScreenW`, `ScreenH`, `RowStride`, `IsRound`, `ChunkSize`, `Is24h` | watch → phone | screen description |
| `PhoneReady` | phone → watch | JS started; watch replies with Hello |
| `ShowTime`, `ClockMode`, `HideAmPm`, `ShowDate`, `DateFormat`, `DateSep`, `HideUntilShake`, `RevealMinutes`, `BoxMode`, `TextPos`, `TimeSize`, `TextInset` | phone → watch | settings (ints; `TextPos` = row × 3 + column, round screens always centered; `TimeSize` 0–2 = S/M/L, default S; `TextInset` = frame width in pixels, so the text sits on the painting) |
| `ImgBegin`, `ImgOffset`, `ImgChunk`, `ImgEnd` | phone → watch | image transfer |

## HTTP API

| Endpoint | Returns |
|---|---|
| `GET /healthz` | `{ ok, paintings, eligible, pool, featured }` |
| `GET /api/art/random?<screen>[&era=…]` | painting metadata + `render` (crop plan, width, height) + `wiki` + `cropUrl`, `rgbUrl` |
| `GET /api/art/featured?day=N&<screen>` | the Featured painting for day *N* of the year (0-based, wraps; all paintings in turn if there's no Featured list) |
| `GET /api/art/resolve?q=…` | `{ key }` for an object number, key or Rijksmuseum link (only servable paintings) |
| `GET /api/art/{key}?<screen>` | same as random, for a specific painting |
| `GET /api/art/{key}/crop.png?<screen>` | the crop, toned full-color PNG (settings page) |
| `GET /api/art/{key}/rgb?<screen>[&format=b64]` | the same pixels as raw RGB, width × height × 3 (phone) |
| `GET /config/` | settings page (incl. `render.js`) |

`<screen>` = `w, h, round (0/1), fit (fill/whole)`; other parameters are
ignored (tuning and frame are applied on the phone). `era` = `any, pre1600,
1600s, 1700s, 1800s, 1900s`. Supported screens: 144×168, 180×180 round,
200×228, 260×260 round. JSON and base64 responses are gzip-compressed.
