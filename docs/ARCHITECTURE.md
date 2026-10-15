# Architecture

## The daily flow

1. The watchface starts, creates an empty 8-bit bitmap matching its screen (only
   colour watches are supported: basalt, chalk, emery, gabbro) and sends a
   **Hello** with width, height, *row stride* (bytes per bitmap row, read from the
   bitmap itself), shape, the largest chunk it can receive, and its 12/24h setting.
2. The phone JS checks `localStorage`: if today's painting is already cached for
   this exact screen + framing + colour tuning, it sends it straight away.
   Otherwise it calls `GET /api/art/random?w=…&h=…&color=1&stride=…&round=…&fit=…&palette=…&frame=…`.
3. The server picks a random painting from its pool, renders it for that screen
   (or reuses a cached render) and replies with metadata plus a `rawUrl`.
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

## Picking a painting

- On startup the server crawls the Rijksmuseum **Search API** for paintings that
  have an image and stores the ids in `data/pool.json` (refreshed weekly).
- A random id is resolved as **Linked Art** JSON-LD. The image lives a few links
  away: object → `shows` (visual item) → `digitally_shown_by` (digital object)
  → `access_point` (a IIIF Image API URL).
- **Licence check** (`rijks.rs::judge_licence`): only licence statements on the
  *image* records count, because the object record may carry a CC0 statement
  about the metadata itself.
  - CC0 / Public Domain Mark / CC BY / CC BY-SA → allowed.
  - Any other statement (e.g. "In Copyright") → skipped.
  - No statement at all → allowed only if made no later than `PD_FALLBACK_YEAR`
    (1850 by default; set to 0 to require an explicit licence).
- Every resolved record is cached in `data/art/<key>/meta.json`, including
  rejected ones, so they're never fetched twice.

## Rendering for a screen

```
analysis image (≤1200 px, cached) ──▶ plan crop ──▶ IIIF: exact region + size ──▶ tone ──▶ dither ──▶ raw + preview
                                                        └─ fallback: crop/resize locally ─┘
```

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

**Exact dimensions from the source:** the planned crop is expressed as percentages,
so the server asks the IIIF server for
`{base}/pct:x,y,w,h/{W},{H}/0/default.jpg` — the museum delivers exactly the
pixels needed. If that fails, the same crop is done locally from the analysis
image.

**Tone and colour** (`imaging.rs::tone`, `palette.rs`): auto-levels (ignoring the
extreme 0.5 %), a shadow lift (gamma 0.8, because the reflective screen crushes
dark varnish into a single black), +10 % saturation, then Atkinson dithering to
the Pebble palette. With colour tuning other than *Accurate*, pixels are matched
against how each Pebble colour actually looks on the screen in that light, and the
true Pebble colour with the same index is written (pebble-color-optimizer's idea).

**Output layout:** colour bytes are `0b11RRGGBB`, rows padded to the stride the
watch reported. The server can also render 1-bit black-and-white (`color=0`: least-
significant bit = leftmost pixel, 1 = white), but the watchface doesn't target
black-and-white watches for now.

## Storage

```
data/
  pool.json
  art/<key>/meta.json
  art/<key>/source.jpg
  art/<key>/v1/<w>x<h>-<c|bw>-s<stride>-<rect|round>-<fill|whole>-<palette>.{raw,png,json}
```
Bump `RENDER_VERSION` in `store.rs` after changing the image pipeline.

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
| `GET /healthz` | `{ ok, paintings, poolComplete }` |
| `GET /api/art/random?<screen>` | painting metadata + render info + `rawUrl` + `previewUrl` |
| `GET /api/art/{key}?<screen>` | same, for a specific painting (used when framing changes) |
| `GET /api/art/{key}/raw?<screen>[&format=b64]` | watch bitmap bytes |
| `GET /api/art/{key}/preview.png?<screen>` | PNG of exactly those pixels |
| `GET /config/` | settings page |

`<screen>` = `w, h, color (0/1), stride, round (0/1), fit (fill/whole), palette (defined/sun/room/backlight)`.
