//! Turning a painting into the crop a Pebble screen shows.
//!
//! Pipeline (generator):  plan crop  →  cut it from the local master at the
//! screen's exact size  →  tone adjustments  →  lossless PNG. Colour tuning,
//! dithering and frames happen on the phone and in the settings page
//! (`server/static/config/render.js`), so one crop serves every combination.

use image::{imageops::FilterType, Rgb, RgbImage};
use serde::{Deserialize, Serialize};

use crate::saliency::best_window;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// Fill the whole screen; crop smartly if the shapes differ.
    #[default]
    Fill,
    /// Show the whole painting, with bars if needed.
    Whole,
}

impl Fit {
    pub const ALL: [Fit; 2] = [Fit::Fill, Fit::Whole];

    pub fn name(self) -> &'static str {
        match self {
            Fit::Fill => "fill",
            Fit::Whole => "whole",
        }
    }
}

/// A screen and how the painting fills it: what one crop is made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub w: u32,
    pub h: u32,
    pub round: bool,
    pub fit: Fit,
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
        return CropPlan {
            mode: CropMode::None,
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            inner_w: t.w,
            inner_h: t.h,
        };
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

#[expect(
    clippy::too_many_arguments,
    reason = "plain numbers from one call site; a struct would only rename them"
)]
fn frac(
    mode: CropMode,
    x: u32,
    y: u32,
    cw: u32,
    ch: u32,
    iw: u32,
    ih: u32,
    t: &Target,
) -> CropPlan {
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

/// Cut the planned crop out of the master image and resize it to the opening
/// (Lanczos3). Everything is rendered from the local master, never re-fetched.
pub fn crop_locally(src: &RgbImage, plan: &CropPlan) -> RgbImage {
    let (iw, ih) = src.dimensions();
    let x = (plan.x * iw as f64).round() as u32;
    let y = (plan.y * ih as f64).round() as u32;
    let w = ((plan.w * iw as f64).round() as u32).clamp(1, iw - x.min(iw - 1));
    let h = ((plan.h * ih as f64).round() as u32).clamp(1, ih - y.min(ih - 1));
    let view = image::imageops::crop_imm(src, x, y, w, h).to_image();
    image::imageops::resize(&view, plan.inner_w, plan.inner_h, FilterType::Lanczos3)
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
            let c =
                p.0.map(|v| lift[((v as f32 - lo as f32) * gain).clamp(0.0, 255.0) as usize]);
            let l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
            c.map(|v| (l + (v - l) * saturation).clamp(0.0, 255.0))
        })
        .collect()
}

/// Tone a crop for the screen (see `tone`), rounded back to 8-bit RGB.
pub fn tone_image(img: &RgbImage) -> RgbImage {
    let toned = tone(img);
    let mut out = RgbImage::new(img.width(), img.height());
    for (px, c) in out.pixels_mut().zip(toned) {
        *px = Rgb(c.map(|v| v.round().clamp(0.0, 255.0) as u8));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(w: u32, h: u32) -> Target {
        Target {
            w,
            h,
            round: false,
            fit: Fit::Fill,
        }
    }

    #[test]
    fn plan_crop_trims_an_almost_fitting_image_evenly() {
        // 144x168 screen; 150x168 image overflows by 6px → safe crop.
        let img = RgbImage::from_pixel(150, 168, Rgb([100, 50, 20]));
        assert_eq!(plan_crop(&img, &target(144, 168), 20).mode, CropMode::Safe);
    }

    #[test]
    fn plan_crop_picks_a_region_of_a_very_wide_image() {
        let img = RgbImage::from_pixel(1200, 400, Rgb([100, 50, 20]));
        assert_eq!(plan_crop(&img, &target(144, 168), 20).mode, CropMode::Smart);
    }

    #[test]
    fn plan_crop_letterboxes_when_showing_the_whole_painting() {
        let img = RgbImage::from_pixel(1200, 400, Rgb([100, 50, 20]));
        let t = Target {
            fit: Fit::Whole,
            ..target(144, 168)
        };
        assert_eq!(plan_crop(&img, &t, 20).mode, CropMode::Letterbox);
    }

    #[test]
    fn crop_locally_makes_the_planned_size() {
        let img = RgbImage::from_pixel(1200, 400, Rgb([100, 50, 20]));
        let plan = plan_crop(&img, &target(144, 168), 20);
        assert_eq!(crop_locally(&img, &plan).dimensions(), (144, 168));
    }

    #[test]
    fn tone_image_keeps_the_size() {
        let img = RgbImage::from_fn(30, 20, |x, y| Rgb([(x * 8) as u8, (y * 12) as u8, 90]));
        assert_eq!(tone_image(&img).dimensions(), (30, 20));
    }

    #[test]
    fn tone_image_stretches_a_dull_image_to_full_range() {
        let img = RgbImage::from_fn(64, 1, |x, _| {
            // 60..186: a span the 2.5x gain cap can stretch to the full range.
            let v = 60 + 2 * x as u8;
            Rgb([v, v, v])
        });
        let toned = tone_image(&img);
        let lo = toned.pixels().map(|p| p.0[0]).min().unwrap();
        let hi = toned.pixels().map(|p| p.0[0]).max().unwrap();
        assert!(lo < 20 && hi > 235, "range {lo}..{hi}");
    }
}
