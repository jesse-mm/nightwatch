# Notices

## Artwork and data
Paintings, images and metadata come from the Rijksmuseum, Amsterdam, via the
Rijksmuseum data services (https://data.rijksmuseum.nl/about/). Only works the data marks as public domain (CC0 /
Public Domain Mark) or under CC BY / CC BY-SA are shown. See
https://data.rijksmuseum.nl/policy/ for the museum's terms.

Treasure Trove is an independent project and is not affiliated with or endorsed
by the Rijksmuseum.

## Device photos
`docs/images/devices/pebble-time.jpg`: "Pebble Time front" by Frmorrison,
https://commons.wikimedia.org/wiki/File:Pebble_Time_front.jpg, CC BY-SA 3.0
(https://creativecommons.org/licenses/by-sa/3.0/), resized.

`docs/images/devices/pebble-time-2.jpg`: "Pebble Time 2 + Quartz watchface
(close-up)" by Waldyrious,
https://commons.wikimedia.org/wiki/File:Pebble_Time_2_%2B_Quartz_watchface_(close-up).jpg,
CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), resized.

The device mockups (`docs/images/devices/*.png`) are drawn by
`scripts/device-mockups.py` and show a public-domain Rijksmuseum painting.

## Wikidata and Wikimedia
The Featured list is ranked using Wikidata (https://www.wikidata.org, CC0) and
Wikipedia pageview statistics from the Wikimedia REST API.

## pebble-color-optimizer (MIT)
`site/render.js` contains color tables extracted from the
palette swatches of https://github.com/czmanix/pebble-color-optimizer and ports
its matching + Atkinson dithering approach.

MIT License — Copyright (c) 2026 czmanix. Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files, to deal in the Software without restriction, subject to
including the copyright notice and permission notice in all copies or
substantial portions of the Software. The software is provided "as is", without
warranty of any kind.

## tiny-inflate (MIT)
`watchface/src/pkjs/vendor/tiny-inflate.js` is tiny-inflate 1.0.3
(https://github.com/foliojs/tiny-inflate), unchanged. Copyright (c) 2015-present
Devon Govett, MIT License. It inflates the PNG crops the phone downloads from the
Rijksmuseum's IIIF server.
