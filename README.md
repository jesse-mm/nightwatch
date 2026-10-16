# Treasure Trove

*Art first, time second.* A Pebble watchface that hangs a different public-domain
painting from the Rijksmuseum on your wrist every day, with a small LECO time and
date that stay out of its way.

```
                                                                     monthly, ~1 request/s
┌──────────────┐  once a day   ┌──────────────────┐   JSON + bytes   ┌─────────┐  reads   ┌───────────┐ ◀── data.rijksmuseum.nl
│ Pebble       │ ◀── bitmap ── │ Phone (PebbleKit │ ◀─────────────── │ server  │ ◀─────── │ generator │ ◀── iiif.micr.io
│ watchface C  │ ─ screen info▶│ JS, caches today)│ ── screen info ─▶│ (Rust)  │  data/   │ (Rust)    │ ◀── wikidata.org
└──────────────┘               └──────────────────┘                  └─────────┘          └───────────┘
                                        ▲ settings page served by the server
```

## What's in here

| Path | What it is |
|---|---|
| `watchface/` | The Pebble project: C watchface (`src/c/main.c`) and phone-side JS (`src/pkjs/`). |
| `server/` | Rust: the **generator** (fetches paintings politely, smart-crops and tones a crop per screen) and the **server** (serves the pre-rendered files + settings page). |
| `catalog/` | Generated metadata and the Featured list. Not in git: published as a `catalog.tar.gz` release asset (see `scripts/catalog.sh`). |
| `server/static/config/` | The custom settings page (plain HTML/CSS/JS, no Clay). |
| `docker-compose.yml` | Runs the server, optionally with a Tailscale Funnel sidecar for a public HTTPS URL. |
| `docs/` | [Supported watches](docs/DEVICES.md), [architecture](docs/ARCHITECTURE.md), [generator](docs/GENERATOR.md), [deployment](docs/DEPLOY.md), [Rust for TypeScript developers](docs/RUST_FOR_TS_DEVS.md). |

## Features

- A random painting each day (public domain / CC only), rendered for *your* watch's
  exact screen: 144×168, 180×180 round, 200×228 or 260×260 round. Color watches
  only for now (Pebble Time, Time Steel, Time Round, Time 2, Round 2; see
  [Supported watches](docs/DEVICES.md)).
- Every crop is cut from a local master image at the screen's exact size, so no
  stretching. Color tuning and frames are applied on the phone, so changing them
  is instant and needs no download.
- Paintings that almost fit (≤ 20 px off) get a simple center crop; very wide or tall
  ones get a smart crop that finds faces, detail and color. Or choose "Whole painting".
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

## Quick start

1. **Generate the paintings** (see [docs/GENERATOR.md](docs/GENERATOR.md); the
   first full run takes most of a day at one request per second):
   ```sh
   cp .env.example .env
   docker compose run --rm generator --limit 20    # quick test run
   docker compose run --rm generator               # everything
   ```
2. **Run the server** (see [docs/DEPLOY.md](docs/DEPLOY.md) for Proxmox + Tailscale):
   ```sh
   docker compose up -d --build
   curl http://localhost:8080/healthz   # "paintings" = how many are ready
   ```
3. **Point the watchface at it:** edit `watchface/src/pkjs/config.js` →
   `SERVER_URL` (use the HTTPS Funnel URL so it works away from home).
4. **Build and install the watchface** with the Pebble SDK
   ([developer.repebble.com](https://developer.repebble.com)):
   ```sh
   cd watchface
   pebble build
   pebble install --phone <phone-ip>      # or --emulator basalt
   ```
5. Open the watchface settings in the Pebble app.

## Gestures

Watchfaces don't receive button presses on Pebble, so gestures use the accelerometer
"tap" event (a flick of the wrist):

| Gesture | Effect |
|---|---|
| One flick | Shows the time for the chosen number of minutes (when *Hide until I flick my wrist* is on) |

## Development

```sh
npm install && npm run lint              # ESLint 10 (flat config) for all JS
cd server && cargo test                  # unit tests for crop, palette, license rules
cd server && cargo run                   # server on :8080, data in ./data
```

## Verify on first run

Checked against the live services and the SDK 4.17 emulators (basalt, chalk, emery):

- **Rijksmuseum API.** The search URL works as is. Object records must be requested
  with plain `Accept: application/ld+json`; adding `profile=` gets a 400. The image
  license is read from `subject_to` on the VisualItem (the CC0 under `subject_of` is
  the metadata license, not the artwork's).
- **LECO glyphs.** `LECO_20_BOLD_NUMBERS` includes `-`, so the date renders as `15-10`.
- **Text box insets.** `TIME_TOP_INSET 7` / `DATE_TOP_INSET 6` give the "Always" box
  3 px of padding above and below the digits.

Still to check on a real watch:

- **Color tuning.** "Daylight / Indoors / Backlight" stretch the simulated palettes;
  compare them on a real screen and pick a default (`palette` in the phone's
  defaults, `watchface/src/pkjs/index.js`).

## Credits

Artwork and data: Rijksmuseum, Amsterdam, via the
[Rijksmuseum data services](https://data.rijksmuseum.nl/about/). Not affiliated with
the Rijksmuseum. Color approach: czmanix/pebble-color-optimizer (MIT). See
[NOTICE.md](NOTICE.md).
