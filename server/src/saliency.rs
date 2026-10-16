//! "Where is the interesting part of this painting?"
//!
//! There is no public points-of-interest dataset for the Rijksmuseum collection,
//! so we estimate one from the pixels, in the spirit of smartcrop.js:
//!
//! * **Detail** – local contrast (edges). Faces, hands, text and objects are
//!   busy; skies, walls and dark varnished backgrounds are calm.
//! * **Color** – saturated areas usually carry the subject in old paintings.
//! * **Skin** – a skin-tone detector, because portraits are a big part of the
//!   collection and a crop that cuts off a face is the worst outcome.
//!
//! Because the crop always fills the screen in one direction ("cover"), only one
//! axis is free. That turns the search into a 1-D sliding window over a column
//! (or row) energy profile, which is fast and stable.

use image::{imageops::FilterType, RgbImage};

/// Analysis resolution: plenty for finding a region, cheap to compute.
const ANALYSIS_LONG_SIDE: u32 = 192;

/// Per-pixel interest map at reduced resolution.
struct EnergyMap {
    w: usize,
    h: usize,
    e: Vec<f32>,
}

fn energy_map(img: &RgbImage) -> EnergyMap {
    let (iw, ih) = img.dimensions();
    let scale = ANALYSIS_LONG_SIDE as f32 / iw.max(ih) as f32;
    let (w, h) = if scale < 1.0 {
        (
            ((iw as f32 * scale).round() as u32).max(1),
            ((ih as f32 * scale).round() as u32).max(1),
        )
    } else {
        (iw, ih)
    };
    let small = image::imageops::resize(img, w, h, FilterType::Triangle);
    let (w, h) = (w as usize, h as usize);

    let mut lum = vec![0f32; w * h];
    for (i, p) in small.pixels().enumerate() {
        let [r, g, b] = p.0;
        lum[i] = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
    }

    let mut e = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let l = |xx: usize, yy: usize| lum[yy * w + xx];
            let gx = l((x + 1).min(w - 1), y) - l(x.saturating_sub(1), y);
            let gy = l(x, (y + 1).min(h - 1)) - l(x, y.saturating_sub(1));
            let edge = (gx.abs() + gy.abs()) / 255.0;

            let [r, g, b] = small.get_pixel(x as u32, y as u32).0;
            let (rf, gf, bf) = (r as f32, g as f32, b as f32);
            let max = rf.max(gf).max(bf);
            let min = rf.min(gf).min(bf);
            let light = lum[i] / 255.0;
            // Saturation only counts where there is light; noise in near-black
            // varnish is not "colourful".
            let sat = if max > 0.0 { (max - min) / max } else { 0.0 } * light.min(0.6) / 0.6;

            // smartcrop.js skin heuristic: distance to a reference skin color in
            // normalized RGB space, only for mid-tones.
            let mag = (rf * rf + gf * gf + bf * bf).sqrt().max(1.0);
            let (nr, ng, nb) = (rf / mag - 0.78, gf / mag - 0.57, bf / mag - 0.44);
            let skin_d = (nr * nr + ng * ng + nb * nb).sqrt();
            let skin = if (0.18..0.95).contains(&light) {
                (1.0 - skin_d * 6.0).max(0.0)
            } else {
                0.0
            };

            e[i] = edge * 1.0 + sat * 0.35 + skin * 1.2;
        }
    }
    EnergyMap { w, h, e }
}

/// Weight of a sample at relative position `t` (0..1) inside the window. A round
/// screen hides its corners, so the window's center matters more there.
/// Even on a rectangular screen a subject reads best away from the edges, so
/// the middle of the window counts a little more than its borders.
fn window_weight(t: f32, round: bool) -> f32 {
    let c = (t - 0.5) * 2.0; // -1..1
    if round {
        (1.0 - c * c).max(0.0) + 0.15
    } else {
        1.0 - 0.45 * c * c
    }
}

/// Find the best crop window of `crop_w` x `crop_h` (in `img` pixels).
/// Exactly one of the two must be smaller than the image; returns the top-left.
pub fn best_window(img: &RgbImage, crop_w: u32, crop_h: u32, round: bool) -> (u32, u32) {
    let (iw, ih) = img.dimensions();
    let map = energy_map(img);
    let horizontal = crop_w < iw; // slide left/right

    // Collapse the 2-D map into a 1-D profile along the free axis.
    let profile: Vec<f32> = if horizontal {
        (0..map.w)
            .map(|x| (0..map.h).map(|y| map.e[y * map.w + x]).sum())
            .collect()
    } else {
        (0..map.h)
            .map(|y| (0..map.w).map(|x| map.e[y * map.w + x]).sum())
            .collect()
    };
    let n = profile.len();
    let full = if horizontal { iw } else { ih } as f32;
    let win_full = if horizontal { crop_w } else { crop_h } as f32;
    let win = ((win_full / full) * n as f32).round().clamp(1.0, n as f32) as usize;
    let total: f32 = profile.iter().sum::<f32>().max(1e-6);

    let mut best_start = (n - win) / 2;
    let mut best_score = f32::MIN;
    for start in 0..=(n - win) {
        let mut s = 0.0;
        for k in 0..win {
            s += profile[start + k] * window_weight(k as f32 / win as f32, round);
        }
        let mut score = s / total;
        // Gentle pull toward the center: painters compose for the middle, and it
        // breaks ties between equally busy areas.
        let center_offset = ((start as f32 + win as f32 / 2.0) / n as f32 - 0.5).abs();
        score -= center_offset * 0.08;
        // Tall paintings: slight preference for the upper part (heads, faces).
        if !horizontal {
            score -= (start as f32 / n as f32) * 0.03;
        }
        if score > best_score {
            best_score = score;
            best_start = start;
        }
    }

    let offset = ((best_start as f32 / n as f32) * full).round() as u32;
    if horizontal {
        (offset.min(iw - crop_w), 0)
    } else {
        (0, offset.min(ih - crop_h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn finds_busy_region_in_wide_image() {
        // Flat gray wide image with a checkerboard on the right third.
        let mut img = RgbImage::from_pixel(900, 300, Rgb([90, 90, 90]));
        for y in 0..300 {
            for x in 650..850 {
                let v = if (x / 6 + y / 6) % 2 == 0 { 20 } else { 230 };
                img.put_pixel(x, y, Rgb([v, v, v]));
            }
        }
        let (x, y) = best_window(&img, 260, 300, false);
        assert_eq!(y, 0);
        assert!(
            x > 450,
            "window should move right toward the detail, got {x}"
        );
    }
}
