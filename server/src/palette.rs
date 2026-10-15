//! Pebble colour handling and dithering.
//!
//! Approach ported from czmanix/pebble-color-optimizer (MIT): instead of matching
//! a pixel to the *ideal* Pebble colours, we match it to how those colours
//! *actually look* on the reflective screen (a "reference" palette measured in
//! sunlight / room light / backlight), then write the real Pebble colour with the
//! same index. Errors are spread with Atkinson dithering, which keeps more
//! contrast than Floyd–Steinberg on tiny screens.
//!
//! One deliberate change: the simulated palettes are much darker than the
//! source image (the "room" white is only ~90/255), so we stretch each reference
//! palette to the full 0–255 range first. Without that, every bright pixel would
//! collapse onto the few lightest swatches.

use std::str::FromStr;

use crate::palette_data::{BACKLIGHT, DEFINED, ROOM, SUN};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reference {
    Defined,
    Sun,
    Room,
    Backlight,
}

impl FromStr for Reference {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "defined" => Ok(Self::Defined),
            "sun" => Ok(Self::Sun),
            "room" => Ok(Self::Room),
            "backlight" => Ok(Self::Backlight),
            other => Err(format!("unknown palette reference '{other}'")),
        }
    }
}

impl Reference {
    pub fn name(self) -> &'static str {
        match self {
            Self::Defined => "defined",
            Self::Sun => "sun",
            Self::Room => "room",
            Self::Backlight => "backlight",
        }
    }
}

/// The 64 colours to *match against*, already stretched to 0–255.
pub struct MatchPalette {
    colors: [[f32; 3]; 64],
}

impl MatchPalette {
    pub fn new(reference: Reference) -> Self {
        let table = match reference {
            Reference::Defined => &DEFINED,
            Reference::Sun => &SUN,
            Reference::Room => &ROOM,
            Reference::Backlight => &BACKLIGHT,
        };
        let (mut lo, mut hi) = (255u8, 0u8);
        for c in table.iter() {
            for &v in c {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        let span = (hi.saturating_sub(lo)).max(1) as f32;
        let mut colors = [[0f32; 3]; 64];
        for (i, c) in table.iter().enumerate() {
            for ch in 0..3 {
                colors[i][ch] = (c[ch].saturating_sub(lo)) as f32 * 255.0 / span;
            }
        }
        Self { colors }
    }

    fn nearest(&self, px: [f32; 3]) -> usize {
        let mut best = 0;
        let mut best_d = f32::MAX;
        for (i, c) in self.colors.iter().enumerate() {
            // Weighted RGB distance: the eye is most sensitive to green.
            let dr = px[0] - c[0];
            let dg = px[1] - c[1];
            let db = px[2] - c[2];
            let d = 2.0 * dr * dr + 4.0 * dg * dg + 3.0 * db * db;
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        best
    }
}

/// Pebble's 8-bit colour byte: 0bAARRGGBB with alpha fully opaque.
pub fn gcolor8(index: usize) -> u8 {
    let [r, g, b] = DEFINED[index];
    0xC0 | ((r / 85) << 4) | ((g / 85) << 2) | (b / 85)
}

pub fn defined_rgb(index: usize) -> [u8; 3] {
    DEFINED[index]
}

/// Palette index of an exact Pebble colour (channels are multiples of 85).
pub fn defined_index(rgb: [u8; 3]) -> usize {
    DEFINED.iter().position(|c| *c == rgb).unwrap_or(0)
}

/// Atkinson error diffusion: 6 neighbours each get 1/8 of the error (3/4 total),
/// the rest is dropped, which keeps highlights and shadows crisp.
const ATKINSON: [(i32, i32); 6] = [(1, 0), (2, 0), (-1, 1), (0, 1), (1, 1), (0, 2)];

/// Dither an RGB float buffer (w*h*3) to palette indices (w*h).
pub fn dither_color(buf: &mut [f32], w: usize, h: usize, pal: &MatchPalette) -> Vec<usize> {
    let mut out = vec![0usize; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 3;
            let px = [
                buf[i].clamp(0.0, 255.0),
                buf[i + 1].clamp(0.0, 255.0),
                buf[i + 2].clamp(0.0, 255.0),
            ];
            let idx = pal.nearest(px);
            out[y * w + x] = idx;
            let c = pal.colors[idx];
            let err = [(px[0] - c[0]) / 8.0, (px[1] - c[1]) / 8.0, (px[2] - c[2]) / 8.0];
            for (dx, dy) in ATKINSON {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;
                if nx >= 0 && (nx as usize) < w && (ny as usize) < h {
                    let j = (ny as usize * w + nx as usize) * 3;
                    buf[j] += err[0];
                    buf[j + 1] += err[1];
                    buf[j + 2] += err[2];
                }
            }
        }
    }
    out
}

/// Dither a luminance float buffer (w*h) to black/white (true = white).
pub fn dither_mono(buf: &mut [f32], w: usize, h: usize) -> Vec<bool> {
    let mut out = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let v = buf[i].clamp(0.0, 255.0);
            let white = v >= 128.0;
            out[i] = white;
            let err = (v - if white { 255.0 } else { 0.0 }) / 8.0;
            for (dx, dy) in ATKINSON {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;
                if nx >= 0 && (nx as usize) < w && (ny as usize) < h {
                    buf[ny as usize * w + nx as usize] += err;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcolor8_extremes() {
        assert_eq!(gcolor8(0), 0xC0); // black
        let white = DEFINED.iter().position(|c| *c == [255, 255, 255]).unwrap();
        assert_eq!(gcolor8(white), 0xFF);
    }

    #[test]
    fn stretched_palette_spans_full_range() {
        let p = MatchPalette::new(Reference::Room);
        let max = p.colors.iter().flatten().cloned().fold(0.0, f32::max);
        let min = p.colors.iter().flatten().cloned().fold(255.0, f32::min);
        assert!(max > 254.0 && min < 1.0);
    }
}
