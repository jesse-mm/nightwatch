# Settings and defaults

Everything the reader can change lives on the settings page (`site/`), opened
from the watchface's settings in the Pebble app. Changes show in the watch
preview straight away; nothing reaches the watch until *Save to watch*.

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
| | Paintings from (Selection only) | Any |
| Date & time | Show time | On |
| | Clock format | Auto (follows the watch), AM/PM shown in 12-hour |
| | Show date | On |
| | Date format | Day only (17) |
| | Separator | Slash (/), for day-month formats |
| | Position & size | Bottom right (round watches: bottom center), size S |
| | Auto hide | On: a flick shows the time for 1 minute |
| | Improve readability | Off |

Before the watch has a painting, the settings page previews Vermeer's *Woman
Reading a Letter* (SK-C-251); saving hangs it (not pinned), so the watch shows
what the preview showed. `FIRST_PAINTING` in `site/app.js`.

The defaults live in `site/settings.js` (shared by the phone and the settings
page), with the watch's own copy in `default_settings()` in
`watchface/src/c/main.c` (used before the phone has sent anything) and the
schema in [`schema/settings.schema.json`](schema/settings.schema.json);
`npm test` checks the schema against `settings.js`. How settings and the looks
saved per painting are stored is in
[ARCHITECTURE.md](ARCHITECTURE.md#settings-and-looks-on-the-phone-settingsjs-looksjs).

## Gestures

Watchfaces don't receive button presses on Pebble, so gestures use the
accelerometer "tap" event (a flick of the wrist):

| Gesture | Effect |
|---|---|
| One flick | Shows the time for the chosen number of minutes (when *Auto hide* is on) |

The watch only listens to the accelerometer while a setting needs it, to save
battery.

**Touch (later).** The Pebble Time 2 and Round 2 have a touchscreen, but touch is
[not available to watchfaces yet](https://developer.repebble.com/guides/events-and-services/touch.md)
(SDK 4.33, watchapps only). Once it is, ideas: tap to show the time, swipe to show the
painting's title and artist, long-press to cycle the color tuning. Keep an eye on the
[SDK changelogs](https://developer.repebble.com/sdk/changelogs/).
