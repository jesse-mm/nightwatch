#!/usr/bin/env python3
"""Draw a simple mockup of each supported watch showing what it really displays.

Used for docs/DEVICES.md. Each screen shows a painting the way the phone makes
it: the planned Cover crop from the Rijksmuseum's IIIF server, toned and
rendered by site/render.js (run with Node; Accurate colors, no frame) at its
exact resolution, scaled 2x without smoothing so the dithered pixels stay
visible. Needs Pillow, Node 18+ and the catalog folder (catalog/web).

    python3 scripts/device-mockups.py catalog/web 200107756 docs/images/devices
"""

import base64
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# (platform, file name, width, height, round)
SCREENS = [
    ("basalt", "basalt-144x168", 144, 168, False),
    ("chalk", "chalk-180x180", 180, 180, True),
    ("emery", "emery-200x228", 200, 228, False),
    ("gabbro", "gabbro-260x260", 260, 260, True),
]
SCALE = 2
BODY = (58, 60, 64)
BEZEL = (24, 25, 27)
BAND = (40, 42, 46)
PAD = 18  # bezel around the screen, in mockup pixels

ROOT = Path(__file__).resolve().parent.parent

# Reads {catalog, key, w, h, round} on stdin, prints the watch bytes as base64:
# the same steps as the phone (watchface/src/pkjs/index.js).
NODE = """
const [catalogJs, renderJs, pngJs] = process.argv.slice(1);
const render = require(renderJs);
const png = require(pngJs);
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', async () => {
  const o = JSON.parse(input);
  const fs = require('fs');
  const path = require('path');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(o.catalog, f), 'utf8'));
  const catalog = require(catalogJs).create(read('manifest.json'));
  for (const f of catalog.files) catalog.add(read(f.file));
  const screen = { w: o.w, h: o.h, round: o.round };
  const req = catalog.cropRequest(o.key, screen, 'fill');
  const file = new Uint8Array(await (await fetch(req.url)).arrayBuffer());
  const image = png.decode(file);
  const bytes = render.compose(render.tone(image.data), image.width, image.height, {
    w: o.w, h: o.h, stride: o.w, round: o.round, fit: 'fill', frame: 'none', palette: 'defined',
  });
  process.stdout.write(Buffer.from(bytes).toString('base64'));
});
"""


def screen_image(catalog: Path, key: str, w: int, h: int, round_: bool) -> Image.Image:
    request = {"catalog": str(catalog.resolve()), "key": key, "w": w, "h": h, "round": round_}
    out = subprocess.run(
        ["node", "-e", NODE, str(ROOT / "site" / "catalog.js"), str(ROOT / "site" / "render.js"),
         str(ROOT / "watchface" / "src" / "pkjs" / "png.js")],
        input=json.dumps(request), capture_output=True, text=True, check=True,
    )
    # GColor8 bytes (0b11RRGGBB) to RGB.
    pixels = bytes(
        v for b in base64.b64decode(out.stdout) for v in (((b >> 4) & 3) * 85, ((b >> 2) & 3) * 85, (b & 3) * 85)
    )
    img = Image.frombytes("RGB", (w, h), pixels)
    return img.resize((w * SCALE, h * SCALE), Image.NEAREST)


def mockup(screen: Image.Image, round_: bool) -> Image.Image:
    sw, sh = screen.size
    bw, bh = sw + 2 * PAD, sh + 2 * PAD
    band_w = int(bw * 0.55)
    out = Image.new("RGBA", (bw + 2 * PAD, bh + 2 * PAD + 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(out)
    cx = out.width // 2
    # Strap above and below.
    d.rounded_rectangle((cx - band_w // 2, 0, cx + band_w // 2, out.height), radius=24, fill=BAND)
    top = 60
    box = (PAD, top, PAD + bw, top + bh)
    if round_:
        d.ellipse((box[0] - 6, box[1] - 6, box[2] + 6, box[3] + 6), fill=BODY)
        d.ellipse(box, fill=BEZEL)
        mask = Image.new("L", screen.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, sw - 1, sh - 1), fill=255)
        out.paste(screen, (PAD + PAD, top + PAD), mask)
    else:
        d.rounded_rectangle((box[0] - 8, box[1] - 8, box[2] + 8, box[3] + 8), radius=36, fill=BODY)
        d.rounded_rectangle(box, radius=22, fill=BEZEL)
        out.paste(screen, (PAD + PAD, top + PAD))
    # Buttons on the right edge (one left on rectangular models).
    for y in (0.3, 0.5, 0.7):
        by = top + int(bh * y)
        d.rounded_rectangle((box[2] + 6, by - 14, box[2] + 14, by + 14), radius=3, fill=BODY)
    if not round_:
        by = top + int(bh * 0.5)
        d.rounded_rectangle((box[0] - 14, by - 14, box[0] - 6, by + 14), radius=3, fill=BODY)
    return out


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    catalog, key, out_dir = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    for _, name, w, h, round_ in SCREENS:
        path = out_dir / f"{name}.png"
        mockup(screen_image(catalog, key, w, h, round_), round_).save(path, optimize=True)
        print(path)


if __name__ == "__main__":
    main()
