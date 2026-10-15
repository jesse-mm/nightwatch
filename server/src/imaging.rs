//! Turning a painting into exactly the pixels a Pebble screen wants.
//!
//! Pipeline:  plan crop  →  get pixels at the exact target size  →  tone
//! adjustments  →  dither to the Pebble palette  →  pack into the watch's raw
//! bitmap layout (so the watch can `memcpy` it without decoding anything).

use image::{imageops::FilterType, Rgb, RgbImage};
use serde::{Deserialize, Serialize};

use crate::palette::{defined_rgb, dither_color, dither_mono, gcolor8, MatchPalette, Reference};
use crate::saliency::best_window;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// Fill the whole screen; crop smartly if the shapes differ.
    Fill,
    /// Show the whole painting, with black bars if needed.
    Whole,
}

/// What the watch told us about its screen.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub w: u32,
    pub h: u32,
    pub color: bool,
    /// Bytes per bitmap row on the watch (1-bit rows are padded).
    pub stride: u32,
    pub round: bool,
    pub fit: Fit,
    /// Which light the colours are tuned for (see palette.rs).
    pub reference: Reference,
}

impl Target {
    pub fn cache_name(&self) -> String {
        format!(
            "{}x{}-{}-s{}-{}-{}-{}",
            self.w,
            self.h,
            if self.color { "c" } else { "bw" },
            self.stride,
            if self.round { "round" } else { "rect" },
            match self.fit {
                Fit::Fill => "fill",
                Fit::Whole => "whole",
            },
            self.reference.name()
        )
    }

    pub fn raw_len(&self) -> usize {
        (self.stride * self.h) as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CropMode {
    /// Shapes already match.
    None,
    /// Almost fits: a few pixels trimmed evenly from both sides.
    Safe,
    /// Shapes differ a lot: the most interesting part was chosen.
    Smart,
    /// Whole painting shown with bars.
    Letterbox,
}

/// A crop expressed as fractions (0..1) of the source image, so the same plan
/// works on the small analysis image and on the full-resolution IIIF image.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropPlan {
    pub mode: CropMode,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// For letterbox: size of the painting inside the screen.
    pub inner_w: u32,
    pub inner_h: u32,
}

pub fn plan_crop(src: &RgbImage, t: &Target, safe_px: u32) -> CropPlan {
    let (iw, ih) = src.dimensions();
    let (iwf, ihf) = (iw as f64, ih as f64);
    let (tw, th) = (t.w as f64, t.h as f64);

    // How many screen pixels would "fill" mode cut off?
    let cover = (tw / iwf).max(th / ihf);
    let overflow = ((iwf * cover - tw).max(ihf * cover - th)).round() as u32;

    if overflow == 0 {
        return CropPlan { mode: CropMode::None, x: 0.0, y: 0.0, w: 1.0, h: 1.0, inner_w: t.w, inner_h: t.h };
    }

    let wide = iwf / ihf > tw / th;
    let (cw, ch) = if wide {
        (((ihf * tw / th).round() as u32).clamp(1, iw), ih)
    } else {
        (iw, ((iwf * th / tw).round() as u32).clamp(1, ih))
    };

    if overflow <= safe_px {
        let (x, y) = ((iw - cw) / 2, (ih - ch) / 2);
        return frac(CropMode::Safe, x, y, cw, ch, iw, ih, t);
    }

    if t.fit == Fit::Whole {
        let contain = (tw / iwf).min(th / ihf);
        return CropPlan {
            mode: CropMode::Letterbox,
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            inner_w: ((iwf * contain).round() as u32).clamp(1, t.w),
            inner_h: ((ihf * contain).round() as u32).clamp(1, t.h),
        };
    }

    let (x, y) = best_window(src, cw, ch, t.round);
    frac(CropMode::Smart, x, y, cw, ch, iw, ih, t)
}

#[allow(clippy::too_many_arguments)]
fn frac(mode: CropMode, x: u32, y: u32, cw: u32, ch: u32, iw: u32, ih: u32, t: &Target) -> CropPlan {
    CropPlan {
        mode,
        x: x as f64 / iw as f64,
        y: y as f64 / ih as f64,
        w: cw as f64 / iw as f64,
        h: ch as f64 / ih as f64,
        inner_w: t.w,
        inner_h: t.h,
    }
}

/// IIIF Image API path (region/size/rotation/quality) that returns the planned
/// crop already resized to the size we need — "right dimensions from the get-go".
pub fn iiif_path(plan: &CropPlan) -> String {
    let region = if plan.mode == CropMode::None || plan.mode == CropMode::Letterbox {
        "full".to_string()
    } else {
        format!("pct:{:.4},{:.4},{:.4},{:.4}", plan.x * 100.0, plan.y * 100.0, plan.w * 100.0, plan.h * 100.0)
    };
    format!("{region}/{},{}/0/default.jpg", plan.inner_w, plan.inner_h)
}

/// Fallback when the IIIF server can't do the crop: do it locally from the
/// analysis image.
pub fn crop_locally(src: &RgbImage, plan: &CropPlan) -> RgbImage {
    let (iw, ih) = src.dimensions();
    let x = (plan.x * iw as f64).round() as u32;
    let y = (plan.y * ih as f64).round() as u32;
    let w = ((plan.w * iw as f64).round() as u32).clamp(1, iw - x.min(iw - 1));
    let h = ((plan.h * ih as f64).round() as u32).clamp(1, ih - y.min(ih - 1));
    let view = image::imageops::crop_imm(src, x, y, w, h).to_image();
    image::imageops::resize(&view, plan.inner_w, plan.inner_h, FilterType::Lanczos3)
}

/// Make sure what we got is exactly inner_w x inner_h (IIIF servers may round).
pub fn exact_size(img: RgbImage, plan: &CropPlan) -> RgbImage {
    if img.dimensions() == (plan.inner_w, plan.inner_h) {
        img
    } else {
        image::imageops::resize(&img, plan.inner_w, plan.inner_h, FilterType::Lanczos3)
    }
}

const SHADOW_GAMMA: f32 = 0.8;

/// Old master paintings are dark and brown under varnish, and the Pebble screen
/// is dim. Stretch the tones (ignoring the extreme 0.5%) and add a touch of colour.
fn tone(img: &RgbImage) -> Vec<[f32; 3]> {
    let mut hist = [0u32; 256];
    for p in img.pixels() {
        let [r, g, b] = p.0;
        let l = (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32) as usize;
        hist[l.min(255)] += 1;
    }
    let total: u32 = hist.iter().sum();
    let cut = (total as f32 * 0.005) as u32;
    let (mut lo, mut hi, mut acc) = (0usize, 255usize, 0u32);
    for (i, &c) in hist.iter().enumerate() {
        acc += c;
        if acc > cut {
            lo = i;
            break;
        }
    }
    acc = 0;
    for i in (0..256).rev() {
        acc += hist[i];
        if acc > cut {
            hi = i;
            break;
        }
    }
    let span = (hi.saturating_sub(lo)).max(1) as f32;
    let gain = (255.0 / span).min(2.5);
    let saturation = 1.1;
    // Lift shadows: the reflective screen crushes dark tones into one blob.
    let lift: [f32; 256] = std::array::from_fn(|i| 255.0 * (i as f32 / 255.0).powf(SHADOW_GAMMA));

    img.pixels()
        .map(|p| {
            let c = p.0.map(|v| lift[((v as f32 - lo as f32) * gain).clamp(0.0, 255.0) as usize]);
            let l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
            c.map(|v| (l + (v - l) * saturation).clamp(0.0, 255.0))
        })
        .collect()
}

pub struct Rendered {
    /// Bytes laid out exactly like the watch's GBitmap (rows of `stride` bytes).
    pub raw: Vec<u8>,
    /// What the watch will show, as a normal image (for the settings page).
    pub preview: RgbImage,
}

/// Dither `art` (inner size) and place it centred on a black screen of t.w x t.h.
pub fn render(art: &RgbImage, t: &Target) -> Rendered {
    let pal = &MatchPalette::new(t.reference);
    let (aw, ah) = (art.width() as usize, art.height() as usize);
    let ox = (t.w as usize - aw) / 2;
    let oy = (t.h as usize - ah) / 2;
    let toned = tone(art);

    let mut raw = vec![0u8; t.raw_len()];
    let mut preview = RgbImage::from_pixel(t.w, t.h, Rgb([0, 0, 0]));
    let stride = t.stride as usize;

    if t.color {
        // Black background bytes for any letterbox bars.
        for b in raw.iter_mut() {
            *b = gcolor8(0);
        }
        let mut buf: Vec<f32> = toned.iter().flatten().copied().collect();
        let idx = dither_color(&mut buf, aw, ah, pal);
        for y in 0..ah {
            for x in 0..aw {
                let i = idx[y * aw + x];
                let (sx, sy) = (x + ox, y + oy);
                raw[sy * stride + sx] = gcolor8(i);
                preview.put_pixel(sx as u32, sy as u32, Rgb(defined_rgb(i)));
            }
        }
    } else {
        let mut buf: Vec<f32> =
            toned.iter().map(|c| 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]).collect();
        let bits = dither_mono(&mut buf, aw, ah);
        for y in 0..ah {
            for x in 0..aw {
                if bits[y * aw + x] {
                    let (sx, sy) = (x + ox, y + oy);
                    // Pebble 1-bit bitmaps: least-significant bit is the leftmost
                    // pixel, 1 = white.
                    raw[sy * stride + sx / 8] |= 1 << (sx % 8);
                    preview.put_pixel(sx as u32, sy as u32, Rgb([255, 255, 255]));
                }
            }
        }
    }
    Rendered { raw, preview }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(w: u32, h: u32, color: bool) -> Target {
        let stride = if color { w } else { w.div_ceil(32) * 4 };
        Target { w, h, color, stride, round: false, fit: Fit::Fill, reference: Reference::Defined }
    }

    #[test]
    fn almost_fitting_image_gets_safe_crop() {
        // 144x168 screen; 150x168 image overflows by 6px → safe.
        let img = RgbImage::from_pixel(150, 168, Rgb([100, 50, 20]));
        let plan = plan_crop(&img, &target(144, 168, true), 20);
        assert_eq!(plan.mode, CropMode::Safe);
    }

    #[test]
    fn very_wide_image_gets_smart_crop() {
        let img = RgbImage::from_pixel(1200, 400, Rgb([100, 50, 20]));
        let plan = plan_crop(&img, &target(144, 168, true), 20);
        assert_eq!(plan.mode, CropMode::Smart);
        assert!((plan.h - 1.0).abs() < 1e-9);
    }

    #[test]
    fn raw_sizes_match_watch_layout() {
        let art = RgbImage::from_pixel(144, 168, Rgb([200, 200, 200]));
        let c = render(&art, &target(144, 168, true));
        assert_eq!(c.raw.len(), 144 * 168);
        let bw = render(&art, &target(144, 168, false));
        assert_eq!(bw.raw.len(), 20 * 168);
    }

    #[test]
    fn iiif_path_uses_pct_region() {
        let img = RgbImage::from_pixel(1200, 400, Rgb([1, 2, 3]));
        let plan = plan_crop(&img, &target(144, 168, true), 20);
        let p = iiif_path(&plan);
        assert!(p.starts_with("pct:") && p.ends_with("/144,168/0/default.jpg"), "{p}");
    }
}
