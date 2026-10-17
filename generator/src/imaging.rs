//! Planning the crop a Pebble screen shows.
//!
//! The generator plans each Cover crop from the local master image (smart crop,
//! see saliency.rs) and stores the plan in catalog.json. The phone and the
//! settings page ask the Rijksmuseum's IIIF server for exactly that region,
//! then tone, dither and frame it (`site/render.js`).

use image::RgbImage;
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

/// Extra painting kept on each side of a "fill" crop, in screen pixels, along
/// the axis the crop can move on. The reader can shift the picture by up to
/// this much in the settings; the phone cuts the screen-sized window.
pub const COVER_SLACK_PX: u32 = 20;

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
    /// Size of the crop image: the painting inside the screen for letterbox,
    /// the screen plus up to `COVER_SLACK_PX` per side (one axis) for fill.
    pub inner_w: u32,
    pub inner_h: u32,
    /// Where the planned screen-sized window sits in the crop image (fill).
    #[serde(default)]
    pub window_x: u32,
    #[serde(default)]
    pub window_y: u32,
}

/// What we know about a painting beyond its pixels, to steer the smart crop.
#[derive(Clone, Copy, Debug, Default)]
pub struct CropHints {
    /// The title says it's a portrait: keep the top (the head) when the crop
    /// slides up and down.
    pub portrait: bool,
}

/// "Portrait of …", "Self-portrait", "Portret van …", "Zelfportret", in any case.
pub fn is_portrait_title(title: &str) -> bool {
    let t = title.to_lowercase();
    t.contains("portrait") || t.contains("portret")
}

pub fn plan_crop(src: &RgbImage, t: &Target, safe_px: u32, hints: CropHints) -> CropPlan {
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
            window_x: 0,
            window_y: 0,
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
            window_x: 0,
            window_y: 0,
        };
    }

    let (x, y) = best_window(src, cw, ch, t.round, hints.portrait);
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
    // Widen the window along the free axis by up to COVER_SLACK_PX screen
    // pixels per side, as far as the painting goes ("fill" only: "whole"
    // shows the painting as is).
    let wide = cw < iw;
    let slack_px = if t.fit == Fit::Fill {
        COVER_SLACK_PX
    } else {
        0
    };
    let (pos, len, full, screen) = if wide {
        (x, cw, iw, t.w)
    } else {
        (y, ch, ih, t.h)
    };
    let slack = (slack_px as f64 * len as f64 / screen as f64).round() as u32;
    let before = slack.min(pos);
    let after = slack.min(full - pos - len);
    let (start, span) = (pos - before, len + before + after);
    let to_screen = |px: u32| (px as f64 * screen as f64 / len as f64).round() as u32;
    let (outer, window) = (to_screen(span).max(screen), to_screen(before));
    let window = window.min(outer - screen);
    let (cx, cy, cw2, ch2) = if wide {
        (start, y, span, ch)
    } else {
        (x, start, cw, span)
    };
    CropPlan {
        mode,
        x: cx as f64 / iw as f64,
        y: cy as f64 / ih as f64,
        w: cw2 as f64 / iw as f64,
        h: ch2 as f64 / ih as f64,
        inner_w: if wide { outer } else { t.w },
        inner_h: if wide { t.h } else { outer },
        window_x: if wide { window } else { 0 },
        window_y: if wide { 0 } else { window },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

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
        assert_eq!(
            plan_crop(&img, &target(144, 168), 20, CropHints::default()).mode,
            CropMode::Safe
        );
    }

    #[test]
    fn plan_crop_picks_a_region_of_a_very_wide_image() {
        let img = RgbImage::from_pixel(1200, 400, Rgb([100, 50, 20]));
        assert_eq!(
            plan_crop(&img, &target(144, 168), 20, CropHints::default()).mode,
            CropMode::Smart
        );
    }

    #[test]
    fn plan_crop_letterboxes_when_showing_the_whole_painting() {
        let img = RgbImage::from_pixel(1200, 400, Rgb([100, 50, 20]));
        let t = Target {
            fit: Fit::Whole,
            ..target(144, 168)
        };
        assert_eq!(
            plan_crop(&img, &t, 20, CropHints::default()).mode,
            CropMode::Letterbox
        );
    }

    #[test]
    fn fill_crops_keep_slack_on_the_free_axis() {
        // Uniform image: the smart window lands in the middle, so there's
        // room on both sides.
        let img = RgbImage::from_pixel(1200, 400, Rgb([100, 50, 20]));
        let plan = plan_crop(&img, &target(144, 168), 20, CropHints::default());
        assert_eq!(plan.inner_h, 168);
        assert_eq!(plan.inner_w, 144 + 2 * COVER_SLACK_PX);
        assert_eq!(plan.window_x, COVER_SLACK_PX);
        assert_eq!(plan.window_y, 0);
    }

    #[test]
    fn fill_slack_stops_at_the_painting_edge() {
        // Overflows by 6 px only: the slack is what the painting has.
        let img = RgbImage::from_pixel(150, 168, Rgb([100, 50, 20]));
        let plan = plan_crop(&img, &target(144, 168), 20, CropHints::default());
        assert_eq!(plan.inner_w, 150);
        assert_eq!(plan.window_x, 3);
        // A tall painting slides vertically.
        let tall = RgbImage::from_pixel(300, 1200, Rgb([100, 50, 20]));
        let plan = plan_crop(&tall, &target(144, 168), 20, CropHints::default());
        assert_eq!(
            (plan.inner_w, plan.inner_h),
            (144, 168 + 2 * COVER_SLACK_PX)
        );
        assert_eq!(plan.window_y, COVER_SLACK_PX);
    }

    #[test]
    fn whole_crops_get_no_slack() {
        // Almost fits, so "whole" trims it evenly like before, without slack.
        let img = RgbImage::from_pixel(150, 168, Rgb([100, 50, 20]));
        let t = Target {
            fit: Fit::Whole,
            ..target(144, 168)
        };
        let plan = plan_crop(&img, &t, 20, CropHints::default());
        assert_eq!((plan.inner_w, plan.inner_h, plan.window_x), (144, 168, 0));
    }
}
