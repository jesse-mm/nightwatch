# Treasure Trove

*Art first, time second.* A Pebble watchface that hangs a different public-domain
painting from the Rijksmuseum on your wrist every day, with a small LECO time and
date that stay out of its way.

```
┌──────────────┐  once a day   ┌──────────────────┐  crop (PNG)   ┌──────────────────┐
│ Pebble       │ ◀── bitmap ── │ Phone (PebbleKit │ ◀──────────── │ Rijksmuseum IIIF │
│ watchface C  │ ─ screen info▶│ JS)              │               │ image server     │
└──────────────┘               └──────────────────┘  ┌─ picture ─ │ (iiif.micr.io)   │
                                         ▲           ▼            └──────────────────┘
                                         │    settings page (static files in site/)
                                         │           ▲
                       catalog/web/ ─────┴───────────┘  (copied into site/catalog/)
                                ▲
                   ┌────────────┴─────┐  monthly, ~1 request/s
                   │ generator (Rust) │ ◀── data.rijksmuseum.nl, iiif.micr.io, wikidata.org
                   └──────────────────┘
```

## What's in here

| Path | What it is |
|---|---|
| `watchface/` | The Pebble project: C watchface (`src/c/main.c`) and phone-side JS (`src/pkjs/`). |
| `generator/` | Rust: the **generator** (fetches paintings politely, checks licenses, ranks Featured, plans a smart crop per screen, writes the catalog folder `catalog/web/`). |
| `site/` | The custom settings page (plain HTML/CSS/JS, no Clay), static files. Also holds the JS shared with the phone (`catalog.js`, `render.js`, `settings.js`, `looks.js`). |
| `catalog/` | Generated: the catalog folder `web/` (a manifest, Featured and one file per era), metadata and the Featured list. Not in git: `featured.json` and `paintings.jsonl` are published as a `catalog.tar.gz` release asset (see `scripts/catalog.sh`). |
| `scripts/` | `bundle-catalog.mjs` (copies `catalog/web/` to `site/catalog/`), `catalog.sh`, `device-mockups.py`. |
| `docker-compose.yml` | Runs the generator. |
| `docs/` | [Supported watches](docs/DEVICES.md), [architecture](docs/ARCHITECTURE.md), [generator](docs/GENERATOR.md), [publishing](docs/DEPLOY.md), [Rust for TypeScript developers](docs/RUST_FOR_TS_DEVS.md). |

## Features

- A random painting each day (public domain / CC only), rendered for *your* watch's
  exact screen: 144×168, 180×180 round, 200×228 or 260×260 round. Color watches
  only for now (Pebble Time, Time Steel, Time Round, Time 2, Round 2; see
  [Supported watches](docs/DEVICES.md)).
- No server: the catalog is a few static JSON files next to the settings page
  (the phone only loads the one it needs), and the phone asks the Rijksmuseum's
  IIIF image server for the crop at the screen's exact size, so no stretching.
  Color tuning and frames are applied on the phone, so changing them is instant
  and needs no download.
- Paintings that almost fit (≤ 20 px off) get a simple center crop; very wide or tall
  ones get a smart crop that finds faces, detail and color, and keeps the head of
  a portrait. Or choose Contain to see the whole painting.
- **Zoom and position:** zoom a Cover view in up to 200 % and move it anywhere
  (drag the preview, arrow buttons, Reset), saved per painting.
- Colors are dithered to Pebble's 64-color palette with optional tuning for
  daylight, indoor or backlit viewing (based on pebble-color-optimizer).
- **Date & time:** time on/off, 12/24h (follows the phone by default), hide AM/PM,
  date on/off as DD, DD-MM or MM-DD with a `-`, `/` or `.` separator, all in LECO.
- **Auto hide:** the painting stays clean; flick your wrist to see the time for
  1 to 60 minutes (default 1).
- **Frames:** none (default), gold, wood or a gallery mat, drawn into the bitmap in
  exact Pebble colors. The painting is cropped to fit the opening.
- **Live preview:** crop, frame, color settings and "Hang a different painting"
  update the watch preview on the settings page straight away; nothing reaches
  the watch until you save. The preview shows how the painting looks on a Pebble
  Time 2 screen indoors or in daylight (from measured palettes, with the screen's
  pixel grid), and a small copy stays pinned at the top while you scroll.
- **Advanced color settings:** dithering (Atkinson, 50:50 checkerboard or off),
  brightness and contrast (-100 to 100), with a reset. Applied on the phone.
- **Featured:** the 365 Rijksmuseum paintings most read about on Wikipedia (page
  views over the last year, all languages), one for each day of the year in a
  fixed order. Topped up with other paintings when fewer have an article. The
  list lives in `catalog/featured.json`, shared as a release artifact, and is only
  rebuilt on request.
- **Rotation:** a new painting daily, weekly or monthly, or Off to keep the current
  one. Show Featured or "Surprise me" (random, optionally from one century:
  before 1600, or the 1600s, 1700s, 1800s or 1900s; there's no 2000s option,
  the few 21st-century paintings are still in copyright).
- **Pin a painting** (Advanced): enter an object number (`SK-C-5`), Rijksmuseum id
  or a link to the painting. Pinning turns rotation off until you unpin.
- **Explore:** zoom into the full-resolution painting in the settings page, with a
  minimap, streamed from the museum's IIIF image server.
- **Support the Rijksmuseum:** the settings page links to the museum's donation page
  (Dutch for Dutch-language phones).
- **Improve readability:** a dark box behind the time and date (off by default;
  without it the digits get a thin black outline).
- The settings page shows today's painting, its artist, a link to the object on
  rijksmuseum.nl and to the full image, plus attribution.

## Defaults

What a new install starts with. A painting without a saved look gets the
painting defaults again (colors, zoom and position); crop, frame and time
placement carry over from the previous painting.

| Group | Setting | Default |
|---|---|---|
| Painting | Crop | Cover |
| | Zoom | 100 % (the smart crop's view) |
| | Frame | Wood |
| | Color tuning | Accurate |
| | Dithering | Atkinson |
| | Brightness, contrast | 0 |
| Swap painting | How often | Daily |
| | Collection | Featured |
| | Paintings from (Selection only) | Any era |
| Date & time | Show time | On |
| | Clock format | Auto (follows the watch), AM/PM shown in 12-hour |
| | Show date | On |
| | Date format | Day only (17) |
| | Separator | Slash (/), for day-month formats |
| | Position & size | Bottom right (round watches: bottom center), size S |
| | Auto hide | On: a flick shows the time for 1 minute |
| | Improve readability | Off |

The defaults live in `site/settings.js` (shared by the phone and the settings
page), with the watch's own copy in `default_settings()` in
`watchface/src/c/main.c` (used before the phone has sent anything) and the
schema in `docs/schema/settings.schema.json`; `npm test` checks the schema
against `settings.js`.

## Quick start

1. **Generate the catalog** (see [docs/GENERATOR.md](docs/GENERATOR.md); a full
   first run takes hours):
   ```sh
   cp .env.example .env                      # set CONTACT
   docker compose run --rm generator treasure-trove-generator --limit 20   # quick test run
   docker compose run --rm generator         # everything
   node scripts/bundle-catalog.mjs           # copy catalog/web/ to site/catalog/
   ```
2. **Host the settings page** (see [docs/DEPLOY.md](docs/DEPLOY.md)): publish
   `site/` (with its generated `catalog/` folder) on any static host, e.g.
   GitHub Pages. The phone loads the catalog from there too. To test locally:
   `npm run dev` (serves `site/` on port 8090, plus the emulator's image
   helper on 8092).
3. **Point the watchface at it:** edit `watchface/src/pkjs/config.js` →
   `SETTINGS_URL` (e.g. `http://<your-mac>:8090` for testing).
4. **Build and install the watchface** with the Pebble SDK
   ([developer.repebble.com](https://developer.repebble.com)):
   ```sh
   cd watchface
   pebble build
   pebble install --phone <phone-ip>      # or --emulator basalt
   ```
   The emulator can't download binary data, so for the emulator also run
   `npm run emulator-images` and set `DEV_BASE64_URL` (see
   [docs/DEPLOY.md](docs/DEPLOY.md#testing-locally)).
5. Open the watchface settings in the Pebble app.

## Gestures

Watchfaces don't receive button presses on Pebble, so gestures use the accelerometer
"tap" event (a flick of the wrist):

| Gesture | Effect |
|---|---|
| One flick | Shows the time for the chosen number of minutes (when *Auto hide* is on) |

**Touch (later).** The Pebble Time 2 and Round 2 have a touchscreen, but touch is
[not available to watchfaces yet](https://developer.repebble.com/guides/events-and-services/touch.md)
(SDK 4.33, watchapps only). Once it is, ideas: tap to show the time, swipe to show the
painting's title and artist, long-press to cycle the color tuning. Keep an eye on the
[SDK changelogs](https://developer.repebble.com/sdk/changelogs/).

## Development

```sh
npm install && npm run lint              # ESLint 10 (flat config) for all JS
npm test                                 # render.js, catalog.js, settings and looks (watchface/test/)
cd generator && cargo test               # unit tests for crop planning, license rules, catalog
```

## Verify on first run

Built with Pebble SDK 4.33.1 (`pebble sdk install latest`). Checked against the live
services and the SDK emulators (basalt, chalk, emery, gabbro):

- **Rijksmuseum API.** The search URL works as is. Object records must be requested
  with plain `Accept: application/ld+json`; adding `profile=` gets a 400. The image
  license is read from `subject_to` on the VisualItem (the CC0 under `subject_of` is
  the metadata license, not the artwork's).
- **LECO glyphs.** `LECO_20_BOLD_NUMBERS` includes `-`, so the date renders as `15-10`.
- **Text box insets.** The per-size font insets in `TEXT_SIZES` (`main.c`) give the
  readability box 3 px of padding above and below the digits.

Still to check on a real watch:

- **Binary downloads.** The phone downloads the PNG crop with an ArrayBuffer
  XHR, falling back to the `x-user-defined` text trick. The emulator can't do
  either (it uses a development helper instead), so check on a real iPhone and
  Android phone that new paintings arrive. (Checked on one phone so far.)

- **Color tuning.** "Daylight / Indoors / Backlight" stretch the simulated palettes;
  compare them on a real screen and pick a default (`palette` in the phone's
  defaults, `watchface/src/pkjs/index.js`).

## Credits

Artwork and data: Rijksmuseum, Amsterdam, via the
[Rijksmuseum data services](https://data.rijksmuseum.nl/about/). Not affiliated with
the Rijksmuseum. Color approach: czmanix/pebble-color-optimizer (MIT). See
[NOTICE.md](NOTICE.md).
