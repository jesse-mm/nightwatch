# Architecture

Two programs share one Rust library (`server/src/lib.rs`):

- **Generator** (`treasure-trove-generator`): fetches paintings from the
  Rijksmuseum politely, renders every variant for every supported watch, and
  records it all in `data/catalog.sqlite`. Run it monthly; it only redoes what
  changed. See [GENERATOR.md](GENERATOR.md).
- **Server** (`treasure-trove-server`): reads the published snapshot
  (`serve.sqlite`) into plain in-memory maps and serves the files the generator
  made; it reloads when a new snapshot appears. It never calls an outside service and never
  renders; an unknown painting or variant is a 404.

## The daily flow

1. The watchface starts, creates an empty 8-bit bitmap matching its screen (only
   colour watches are supported: basalt, chalk, emery, gabbro) and sends a
   **Hello** with width, height, *row stride* (bytes per bitmap row, read from the
   bitmap itself), shape, the largest chunk it can receive, and its 12/24h setting.
2. The phone JS checks `localStorage`: if today's painting is already cached for
   this exact screen + framing + colour tuning, it sends it straight away.
   Otherwise it calls `GET /api/art/random?w=…&h=…&color=1&stride=…&round=…&fit=…&palette=…&frame=…`.
3. The server picks a random painting that has that exact variant (optionally
   from one era) and replies with metadata plus a `rawUrl`.
4. The phone downloads the raw bytes (base64), caches them, and streams them to
   the watch in chunks (`ImgBegin`, `ImgOffset`+`ImgChunk` × n, `ImgEnd`).
5. The watch `memcpy`s each chunk into the bitmap and redraws, so the painting
   appears row by row.
6. At midnight the watch's tick handler sends Hello again with reason 2, and the
   date check on the phone fetches a new painting.

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
- **Licence check** (`rijks.rs::judge_licence`): the image's rights are in
  `subject_to` on the visual item (or digital object). The CC0 under
  `subject_of` covers the metadata text, not the artwork.
  - CC0 / Public Domain Mark / CC BY / CC BY-SA → allowed.
  - Any other statement (e.g. "In Copyright") → skipped.
  - No statement at all → allowed only if made no later than `PD_FALLBACK_YEAR`
    (1850 by default; set to 0 to require an explicit licence).
- Every resolved record is stored, including rejected ones, so a painting is
  only re-checked after `REFRESH_DAYS`.
- Wikidata/Wikipedia links come from one SPARQL query (`wiki.rs`) matching
  Rijksmuseum inventory numbers.

## Rendering (generator)

```
master image (1200 px, local) ──▶ plan crop ──▶ cut + resize to the frame opening ──▶ crop.webp
                                                     └──▶ tone ──▶ dither (× 4 tunings) ──▶ frame ──▶ variant.png
```

Per painting: 4 screens × 2 framings × 4 frames = **32 crops**, each × 4 colour
tunings = **128 variants**. Only outdated ones are rebuilt (`variants.rs` hashes).

**Crop planning** (`imaging.rs::plan_crop`), measured in *screen* pixels:

| Situation | Result |
|---|---|
| Shapes match | No crop |
| Filling the screen would trim ≤ `SAFE_CROP_PX` (20) | Centre crop ("safe crop") |
| Trims more, framing = Fill | **Smart crop** |
| Trims more, framing = Whole painting | Letterbox with black bars |

**Smart crop** (`saliency.rs`): there is no public points-of-interest dataset for
this collection (some Wikimedia Commons files have "depicts" regions, but coverage
is too sparse to rely on), so we estimate interest from the pixels, like
smartcrop.js: edges (detail), saturation (colour) and a skin-tone detector (faces).
Because "fill" always fits one axis exactly, only one direction is free, so we
slide a window along a 1-D energy profile. The window weights its centre a little
more (strongly on round screens, whose corners are hidden), and there's a gentle
pull toward the painting's centre and, for tall works, toward the top.

**From the local master:** the planned crop is cut from the 1200 px master and
resized (Lanczos3) to the frame's opening. Because nothing is fetched per
variant, a new frame, tuning or pipeline change only costs CPU time.

**Tone and colour** (`imaging.rs::tone`, `palette.rs`): auto-levels (ignoring the
extreme 0.5 %), a shadow lift (gamma 0.8, because the reflective screen crushes
dark varnish into a single black), +10 % saturation, then Atkinson dithering to
the Pebble palette. With colour tuning other than *Accurate*, pixels are matched
against how each Pebble colour actually looks on the screen in that light, and the
true Pebble colour with the same index is written (pebble-color-optimizer's idea).

**Output layout:** the watch gets `0b11RRGGBB` bytes, rows padded to the stride
it reported; the server unpacks them from the stored indexed PNG. (`imaging.rs`
can also render 1-bit black-and-white, but no black-and-white variants are
generated: only colour watches are supported for now.)

## Storage

```
data/                                   (not in git)
  catalog.sqlite                        paintings, eras, wiki links, crops, variants + input hashes
  art/<key>/source.jpg                  master image, longest side 1200 px
  art/<key>/crops/<crop>.webp           32: <w>x<h>-<rect|round>-<fill|whole>-<frame>
  art/<key>/v/<variant>.png             128: <w>x<h>-c-s<w>-<rect|round>-<fill|whole>-<palette>[-<frame>]
catalog/paintings.jsonl                 (in git) one painting per line: metadata, eras, links, hashes
```

Variants are **indexed PNGs** (palettized, as Pebble recommends for colour
watches): lossless for 64-colour images and about a third of the raw bytes. The
server turns one into the watch's raw `GColor8` bytes with a table lookup per
pixel. Crops are lossy WebP (q90); they're for viewing only, since variants are
always rendered from the master image.

Bump `PIPELINE_VERSION` in `variants.rs` after changing crop or render output:
the next generator run re-renders from the master images without fetching.

## Message keys

| Key | Direction | Meaning |
|---|---|---|
| `Hello` | watch → phone | 1 = launch, 2 = new day |
| `ScreenW`, `ScreenH`, `RowStride`, `IsRound`, `ChunkSize`, `Is24h` | watch → phone | screen description |
| `PhoneReady` | phone → watch | JS started; watch replies with Hello |
| `ShowTime`, `ClockMode`, `HideAmPm`, `ShowDate`, `DateFormat`, `HideUntilShake`, `RevealMinutes`, `BoxMode` | phone → watch | settings (ints) |
| `ImgBegin`, `ImgOffset`, `ImgChunk`, `ImgEnd` | phone → watch | image transfer |

## HTTP API

| Endpoint | Returns |
|---|---|
| `GET /healthz` | `{ ok, paintings, stats }` (catalog counts) |
| `GET /api/art/random?<screen>[&era=…]` | painting metadata + render info + `wiki` + `rawUrl`, `previewUrl`, `cropUrl` |
| `GET /api/art/{key}?<screen>` | same, for a specific painting (used when framing changes) |
| `GET /api/art/{key}/raw?<screen>[&format=b64]` | watch bitmap bytes |
| `GET /api/art/{key}/preview.png?<screen>` | the stored indexed PNG (exactly those pixels) |
| `GET /api/art/{key}/crop.webp?<screen>` | the full-colour crop before dithering |
| `GET /config/` | settings page |

`<screen>` = `w, h, color=1, stride, round (0/1), fit (fill/whole), palette (defined/sun/room/backlight), frame (none/gold/wood/gallery)`.
`era` = `any, pre1600, 1600s, 1700s, 1800s, 1900s`. Supported screens: 144×168, 180×180 round, 200×228, 260×260 round.
