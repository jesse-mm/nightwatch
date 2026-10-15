//! Picture frames drawn around the painting, baked into the watch bitmap.
//!
//! A frame is a band `border` pixels wide along the screen edge (a ring on round
//! watches). Its look is a list of bands from the outer edge inwards, each with
//! a colour for the lit side (light comes from the top left), the side facing
//! away, and in between (only round frames have an "in between"). Colours are
//! exact Pebble palette colours, drawn without dithering so the mouldings stay
//! crisp next to the dithered painting.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Frame {
    #[default]
    None,
    /// Gilded moulding with a bright sight edge.
    Gold,
    /// Dark walnut with a thin gold slip.
    Wood,
    /// Slim black frame around a white mat (passe-partout).
    Gallery,
}

type Rgb = [u8; 3];

/// A colour, or two colours mixed in a fine checker. Pebble has no dark brown
/// or deep gold, but red-brown + olive (or gold + tan) side by side reads as one.
type Tone = [Rgb; 2];

const fn solid(c: Rgb) -> Tone {
    [c, c]
}

/// One band of a frame profile: (ends at this fraction of the border, lit, mid, shade).
type Band = (f32, Tone, Tone, Tone);

const BLACK: Rgb = [0, 0, 0];
const ROSE: Rgb = [85, 0, 0];
const OLIVE: Rgb = [85, 85, 0];
const TAN: Rgb = [170, 85, 0];
const GOLD_C: Rgb = [255, 170, 0];
const YELLOW: Rgb = [255, 255, 85];
const PALE: Rgb = [255, 255, 170];

const GOLD: &[Band] = &[
    (0.10, solid(OLIVE), [OLIVE, ROSE], solid(BLACK)),
    (0.25, solid(PALE), solid(GOLD_C), [GOLD_C, TAN]),
    (0.45, solid(YELLOW), solid(GOLD_C), [GOLD_C, TAN]),
    (0.55, solid(TAN), solid(TAN), [TAN, OLIVE]),
    (0.82, solid(GOLD_C), solid(GOLD_C), [GOLD_C, TAN]),
    (0.92, solid(PALE), solid(YELLOW), solid(GOLD_C)),
    (1.00, solid(OLIVE), solid(OLIVE), solid(BLACK)),
];

const WOOD: &[Band] = &[
    (0.12, solid(BLACK), solid(BLACK), solid(BLACK)),
    (0.32, [TAN, ROSE], [ROSE, OLIVE], [ROSE, BLACK]),
    (0.78, [ROSE, OLIVE], [ROSE, OLIVE], [ROSE, BLACK]),
    (0.90, solid(GOLD_C), solid(GOLD_C), solid(TAN)),
    (1.00, solid(BLACK), solid(BLACK), solid(BLACK)),
];

const GALLERY: &[Band] = &[
    (0.08, solid([85, 85, 85]), solid(BLACK), solid(BLACK)),
    (0.30, solid(BLACK), solid(BLACK), solid(BLACK)),
    (
        0.92,
        solid([255, 255, 255]),
        solid([255, 255, 255]),
        solid([255, 255, 255]),
    ),
    (
        1.00,
        solid([255, 255, 255]),
        solid([170, 170, 170]),
        solid([170, 170, 170]),
    ),
];

impl Frame {
    pub const ALL: [Frame; 4] = [Frame::None, Frame::Gold, Frame::Wood, Frame::Gallery];

    pub fn name(self) -> &'static str {
        match self {
            Frame::None => "none",
            Frame::Gold => "gold",
            Frame::Wood => "wood",
            Frame::Gallery => "gallery",
        }
    }

    /// Frame width in pixels for a screen of this size.
    pub fn border(self, w: u32, h: u32) -> u32 {
        let share = match self {
            Frame::None => return 0,
            Frame::Gold => 0.08,
            Frame::Wood => 0.065,
            Frame::Gallery => 0.10,
        };
        (w.min(h) as f32 * share).round() as u32
    }

    /// What shows around a letterboxed painting inside the frame.
    pub fn background(self) -> Rgb {
        match self {
            Frame::Gallery => [255, 255, 255],
            _ => [0, 0, 0],
        }
    }

    fn profile(self) -> &'static [Band] {
        match self {
            Frame::None => &[],
            Frame::Gold => GOLD,
            Frame::Wood => WOOD,
            Frame::Gallery => GALLERY,
        }
    }

    /// Colour of screen pixel (x, y), or None if it shows the painting.
    pub fn pixel(self, x: u32, y: u32, w: u32, h: u32, round: bool) -> Option<Rgb> {
        let border = self.border(w, h);
        if border == 0 {
            return None;
        }
        let border = border as f32;
        let (depth, light) = if round {
            let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let r = (dx * dx + dy * dy).sqrt().max(1e-3);
            // Facing the top left (dx, dy negative) is lit.
            (cx.min(cy) - r, -(dx + dy) / (r * std::f32::consts::SQRT_2))
        } else {
            let (left, top) = (x as f32, y as f32);
            let (right, bottom) = ((w - 1 - x) as f32, (h - 1 - y) as f32);
            let depth = left.min(top).min(right).min(bottom);
            // Corners are mitred: whichever edge is nearest decides the lighting.
            (
                depth,
                if depth == top || depth == left {
                    1.0
                } else {
                    -1.0
                },
            )
        };
        if depth >= border {
            return None;
        }
        let u = (depth.max(0.0) + 0.5) / border;
        let &(_, lit, mid, shade) = self
            .profile()
            .iter()
            .find(|b| u <= b.0)
            .unwrap_or(self.profile().last()?);
        let tone = if light > 0.35 {
            lit
        } else if light < -0.35 {
            shade
        } else {
            mid
        };
        Some(tone[((x + y) % 2) as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_frame_draws_nothing() {
        assert_eq!(Frame::None.border(144, 168), 0);
        assert_eq!(Frame::None.pixel(0, 0, 144, 168, false), None);
    }

    #[test]
    fn frame_covers_edges_and_leaves_the_middle() {
        let b = Frame::Gold.border(144, 168);
        assert!(b > 0);
        assert!(Frame::Gold.pixel(0, 80, 144, 168, false).is_some());
        assert!(Frame::Gold.pixel(b - 1, 80, 144, 168, false).is_some());
        assert_eq!(Frame::Gold.pixel(b, 80, 144, 168, false), None);
        assert_eq!(Frame::Gold.pixel(72, 84, 144, 168, false), None);
    }

    #[test]
    fn round_frame_is_a_ring() {
        assert!(Frame::Wood.pixel(90, 1, 180, 180, true).is_some());
        assert_eq!(Frame::Wood.pixel(90, 90, 180, 180, true), None);
    }

    #[test]
    fn colours_are_palette_colours() {
        for f in [Frame::Gold, Frame::Wood, Frame::Gallery] {
            for &(_, a, b, c) in f.profile() {
                for v in [a, b, c].iter().flatten().flatten() {
                    assert_eq!(v % 85, 0);
                }
            }
        }
    }
}
