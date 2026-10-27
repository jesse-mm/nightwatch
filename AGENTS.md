# Notes for agents

Start with [README.md](README.md); the details are in [docs/](docs/).

## Running the watchface in the emulator

The emulator needs both local servers, or the face stays **black** (only the
time shows, because no painting arrives):

```sh
npm run dev    # site on :8090 (catalog, settings page) + emulator image helper on :8092
```

- `watchface/src/pkjs/config.dev.js` (not in git) points `SETTINGS_URL` and
  `DEV_BASE64_URL` at those servers; see
  [docs/DEPLOY.md](docs/DEPLOY.md#testing-locally). Rebuild after changing it.
- The phone side can't download binary data in the emulator, so a log line
  `Binary download not supported here; trying text` is expected: it falls back to
  the :8092 helper ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#known-limits)).
- `Ignoring unreadable nw-art` / `nw-rows` in the logs means the emulator's
  stored phone data is damaged; the phone ignores it and fetches again.
- The emulator keeps the settings saved by earlier runs. Before judging "Auto
  hide" or other settings, check what the watch actually has (e.g. a temporary
  `APP_LOG` in `init()`), not the defaults.

```sh
cd watchface
pebble build && pebble install --emulator basalt --logs   # or chalk, emery, gabbro
pebble screenshot --emulator basalt shot.png --no-open
pebble emu-button --emulator basalt click select          # opens the menu; `click back` returns
pebble emu-tap --emulator basalt                          # a wrist flick
```

Opening the menu closes a watchface; coming back launches it again (`init()`).
