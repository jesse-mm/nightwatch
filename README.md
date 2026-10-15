# Treasure Trove

*Art first, time second.* A Pebble watchface that hangs a different public-domain
painting from the Rijksmuseum on your wrist every day, with a small LECO time and
date that stay out of its way.

```
┌──────────────┐   once a day    ┌────────────────────┐   Linked Art + IIIF   ┌──────────────┐
│  Pebble      │ ◀── bitmap ──── │  Phone (PebbleKit  │ ◀──── JSON / PNG ──── │  Treasure    │ ◀── data.rijksmuseum.nl
│  watchface C │ ── screen info ▶│  JS, caches today) │ ──── screen info ───▶ │  Trove server│     iiif.micr.io
└──────────────┘                 └────────────────────┘                       │  (Rust)      │
                                         ▲ settings page served by the server └──────────────┘
```

## What's in here

| Path | What it is |
|---|---|
| `watchface/` | The Pebble project: C watchface (`src/c/main.c`) and phone-side JS (`src/pkjs/`). |
| `server/` | Rust HTTP server: picks paintings, smart-crops, dithers to Pebble colours, caches results, serves the settings page. |
| `server/static/config/` | The custom settings page (plain HTML/CSS/JS, no Clay). |
| `docker-compose.yml` | Runs the server, optionally with a Tailscale Funnel sidecar for a public HTTPS URL. |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [deployment](docs/DEPLOY.md), [Rust for TypeScript developers](docs/RUST_FOR_TS_DEVS.md). |

## Features

- A random painting each day (public domain / CC only), rendered for *your* watch's
  exact screen: 144×168, 180×180 round, 200×228, colour or black-and-white.
- Images arrive already sized from the museum's IIIF server, so no stretching.
- Paintings that almost fit (≤ 20 px off) get a simple centre crop; very wide or tall
  ones get a smart crop that finds faces, detail and colour. Or choose "Whole painting".
- Colours are dithered to Pebble's 64-colour palette with optional tuning for
  daylight, indoor or backlit viewing (based on pebble-color-optimizer).
- Time on/off, 12/24h (follows the phone by default), hide AM/PM, date on/off,
  DD-MM or MM-DD, all in LECO.
- **Hide until flick:** the painting stays clean; flick your wrist to see the time
  for a minute.
- **Readability box:** off, always, or toggled with a double flick. Without the box
  the digits get a thin black outline.
- The settings page shows today's painting, its artist, a link to the object on
  rijksmuseum.nl and to the full image, plus attribution.

## Quick start

1. **Run the server** (see [docs/DEPLOY.md](docs/DEPLOY.md) for Proxmox + Tailscale):
   ```sh
   cp .env.example .env
   docker compose up -d --build
   curl http://localhost:8080/healthz   # wait until "paintings" > 0
   ```
2. **Point the watchface at it:** edit `watchface/src/pkjs/config.js` →
   `SERVER_URL` (use the HTTPS Funnel URL so it works away from home).
3. **Build and install the watchface** with the Pebble SDK
   ([developer.repebble.com](https://developer.repebble.com)):
   ```sh
   cd watchface
   pebble build
   pebble install --phone <phone-ip>      # or --emulator basalt
   ```
4. Open the watchface settings in the Pebble app.

## Gestures

Watchfaces don't receive button presses on Pebble, so gestures use the accelerometer
"tap" event (a flick of the wrist):

| Gesture | Effect |
|---|---|
| One flick | Shows the time for 60 s (when *Hide until I flick my wrist* is on) |
| Two flicks within 1.5 s | Turns the readability box on/off (when set to *Double flick*) |

## Development

```sh
npm install && npm run lint              # ESLint 10 (flat config) for all JS
cd server && cargo test                  # unit tests for crop, palette, licence rules
cd server && cargo run                   # server on :8080, data in ./data
```

## Verify on first run

These parts were written against the documentation but could not be exercised
against the live services or a physical watch while building:

- **Rijksmuseum API shapes.** The search URL and the Linked Art path
  (`shows → digitally_shown_by → access_point`) are read defensively, but check the
  server log on first start. If `/healthz` stays at 0 paintings, adjust
  `RIJKS_SEARCH_URL`.
- **LECO glyphs.** `LECO_20_BOLD_NUMBERS` is a numbers-only font; confirm the `-`
  separator renders in the emulator. If not, change the `strftime` formats in
  `update_strings()`.
- **Text box insets.** `TIME_TOP_INSET` / `DATE_TOP_INSET` in `main.c` trim the
  font's built-in top padding; tweak them in the emulator so the box hugs the digits.
- **Colour tuning.** "Daylight / Indoors / Backlight" stretch the simulated palettes;
  compare them on a real screen and pick a default with `PALETTE_REFERENCE`.

## Credits

Artwork and data: Rijksmuseum, Amsterdam (data.rijksmuseum.nl). Not affiliated with
the Rijksmuseum. Colour approach: czmanix/pebble-color-optimizer (MIT). See
[NOTICE.md](NOTICE.md).
