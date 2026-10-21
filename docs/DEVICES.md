# Supported watches

NightWatch supports the **color** Pebbles. The generator plans a Cover
crop of every painting for each of their four screens (`screens` in the
catalog's `manifest.json`, in this order), and the phone asks the Rijksmuseum's IIIF
server for it at the screen's exact size:

| Screen    | Shape     | Platform | Watches                        |
| --------- | --------- | -------- | ------------------------------ |
| 144 × 168 | rectangle | `basalt` | Pebble Time, Pebble Time Steel |
| 180 × 180 | round     | `chalk`  | Pebble Time Round              |
| 200 × 228 | rectangle | `emery`  | Pebble Time 2                  |
| 260 × 260 | round     | `gabbro` | Pebble Round 2                 |

All four have 64-color e-paper displays. The black-and-white Pebbles (`aplite`:
Pebble and Pebble Steel; `diorite`: Pebble 2; `flint`: Pebble 2 Duo) aren't
supported for now. Platform names and resolutions come from the Pebble SDK
(`pebble_sdk_platform.py`) and the
[hardware overview](https://developer.repebble.com/guides/tools-and-resources/hardware-information/).

## What each screen shows

The same painting on each screen, made the way the phone makes it: the
planned Cover crop from IIIF, toned and rendered by `site/render.js`
(_Accurate_ colors, no frame), drawn at 2× with every watch pixel visible. The watches are drawn to scale with each other.

|               Pebble Time / Time Steel               |                     Pebble Time Round                     |                    Pebble Time 2                    |                       Pebble Round 2                       |
| :--------------------------------------------------: | :-------------------------------------------------------: | :-------------------------------------------------: | :--------------------------------------------------------: |
| ![144×168 screen](images/devices/basalt-144x168.png) | ![180×180 round screen](images/devices/chalk-180x180.png) | ![200×228 screen](images/devices/emery-200x228.png) | ![260×260 round screen](images/devices/gabbro-260x260.png) |
|                 144 × 168, `basalt`                  |                    180 × 180, `chalk`                     |                 200 × 228, `emery`                  |                    260 × 260, `gabbro`                     |

_The Meeting of Granida and Daifilo_, Jan Mijtens, c. 1655–1660,
[SK-A-1856](https://www.rijksmuseum.nl/en/collection/SK-A-1856), Rijksmuseum,
Amsterdam (public domain). The mockups are drawn by
[`scripts/device-mockups.py`](../scripts/device-mockups.py) (needs Pillow,
Node and the catalog folder `catalog/web/`; it downloads the crops); regenerate them with

```sh
python3 scripts/device-mockups.py catalog/web 200107756 docs/images/devices
```
