# Experiment: no server (branch `feature/no-server`)

The watchface and the settings page get paintings straight from the
Rijksmuseum, so nothing of ours runs anywhere. The generator still does the
slow, polite work once (licenses, eras, Featured ranking, smart-crop plans) and
writes it to one file, `catalog.json`.

```
generator ──▶ catalog.json ──▶ bundled into the .pbw (phone)  ──▶ IIIF crop (PNG) ──▶ tone, dither ──▶ watch
                           └─▶ next to the settings page      ──▶ IIIF crop (PNG) ──▶ preview
```

- **Crops**: the Rijksmuseum's IIIF server (level 2) cuts the planned region
  and size: `…/<id>/pct:x,y,w,h/<w>,<h>/0/default.png`, about 140 KB, lossless.
  `catalog.js` builds the URL from the plan in `catalog.json`.
- **Phone**: downloads the PNG, decodes it (`png.js` with the vendored
  `tiny-inflate`), tones it (`render.js` `tone`, ported from the generator) and
  renders it as before. The catalog (~1 MB of JSON) is part of the app.
- **Zoom and position** (Cover): the view can be zoomed in (100–200 %) and
  moved anywhere; at 100 % only along the axis the painting overflows. Saved
  per painting in its look as `zoom`, `focusX`, `focusY` (view center,
  0–1000; empty = the generator's smart crop). `catalog.js` `coverView` turns
  that into the region to ask IIIF for.
- **Requests to the Rijksmuseum** stay low: the phone downloads one crop per
  new painting (daily) and one when a saved look changes its crop, zoom or
  position (the cache key includes them). The settings page downloads the
  whole painting once at twice the screen size (`workImage`) and pans and
  zooms locally, with no requests while dragging.
- **Settings page**: plain static files (`server/static`): the page, its
  scripts and `catalog.json`. Host them anywhere (GitHub Pages); set
  `SETTINGS_URL` in `watchface/src/pkjs/config.js`.

## Build and try it

```sh
docker compose --profile generate run --rm generator \
  treasure-trove-generator --skip-fetch --skip-render \
  --featured /catalog/featured.json --bundle /catalog/catalog.json
node scripts/bundle-catalog.mjs          # → pkjs/catalog-data.js + static/config/catalog.json
cd server/static && python3 -m http.server 8090   # the settings page, for testing
cd watchface && pebble build             # SETTINGS_URL = http://<your-mac>:8090
```

## Known limits

- **Binary downloads in PebbleKit JS.** The emulator's PebbleKit JS (pypkjs)
  can't download binary data (its ArrayBuffer is empty, text is UTF-8
  mangled), so the emulator can't show new paintings on this branch. Real
  phones run PebbleKit JS on the phone's own JavaScript engine; the app tries
  an ArrayBuffer first, then the `x-user-defined` text trick, and checks for a
  real PNG. This needs a test on a real phone.
- **New paintings need a new app.** The catalog is bundled; refreshing it
  (e.g. monthly) means a new `.pbw`. The settings page's copy is a separate
  file and can be updated on its own.
- **App size.** The `.pbw` is ~2.4 MB (the catalog plus the SDK's source map).
