//! The full set of renders the generator produces, their names, and the input
//! hashes that decide whether a file is still up to date.
//!
//! Per painting:
//! - 4 screens × 2 fits × 4 frames = 32 **crops**: the painting cut to the frame's
//!   opening, full colour, before dithering (WebP). Colour tuning doesn't change them.
//! - each crop × 4 colour tunings = 128 **variants**: the dithered 64-colour image
//!   the watch shows, stored as an indexed PNG (lossless, ≈ ⅓ of the raw bytes).
//!
//! Everything is rendered from the painting's local source image, so adding a
//! frame or tuning, or changing the pipeline, never touches the network.

use sha2::{Digest, Sha256};

use crate::{
    frame::Frame,
    imaging::{Fit, Target},
    palette::Reference,
};

/// Bump when the crop or render code changes output: every crop and variant
/// whose hash includes it is then rebuilt from the local sources.
pub const PIPELINE_VERSION: &str = "2026-10-16.1";

/// The colour screens we support: (width, height, round).
pub const SCREENS: [(u32, u32, bool); 4] = [
    (144, 168, false), // basalt: Pebble Time, Time Steel
    (180, 180, true),  // chalk: Pebble Time Round
    (200, 228, false), // emery: Pebble Time 2
    (260, 260, true),  // gabbro: Pebble Round 2
];

pub fn target(screen: (u32, u32, bool), fit: Fit, frame: Frame, reference: Reference) -> Target {
    let (w, h, round) = screen;
    Target {
        w,
        h,
        color: true,
        stride: w,
        round,
        fit,
        reference,
        frame,
    }
}

/// One crop and the four variants rendered from it.
pub struct CropSet {
    pub crop: Target,
    pub variants: Vec<Target>,
}

pub fn all() -> Vec<CropSet> {
    let mut out = Vec::new();
    for screen in SCREENS {
        for fit in Fit::ALL {
            for frame in Frame::ALL {
                out.push(CropSet {
                    crop: target(screen, fit, frame, Reference::Defined),
                    variants: Reference::ALL
                        .iter()
                        .map(|&r| target(screen, fit, frame, r))
                        .collect(),
                });
            }
        }
    }
    out
}

/// Name of the crop a variant is rendered from (everything but the colour tuning).
pub fn crop_name(t: &Target) -> String {
    format!(
        "{}x{}-{}-{}-{}",
        t.w,
        t.h,
        if t.round { "round" } else { "rect" },
        t.fit.name(),
        t.frame.name()
    )
}

/// Variant names reuse `Target::cache_name`, which the HTTP API also derives
/// from the request, e.g. `200x228-c-s200-rect-fill-sun-gold`.
pub fn variant_name(t: &Target) -> String {
    t.cache_name()
}

/// SHA-256 over the parts, separated so ("ab","c") ≠ ("a","bc").
pub fn hash(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0]);
    }
    hex(&h.finalize())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            // Writing to a String can't fail.
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// A crop is up to date when the source image, the pipeline and the crop
/// settings (including the safe-crop threshold) are unchanged.
pub fn crop_hash(source_sha: &str, crop: &Target, safe_crop_px: u32) -> String {
    hash(&[
        PIPELINE_VERSION,
        source_sha,
        &crop_name(crop),
        &safe_crop_px.to_string(),
    ])
}

pub fn variant_hash(crop_hash: &str, variant: &Target) -> String {
    hash(&[PIPELINE_VERSION, crop_hash, variant.reference.name()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_is_32_crops_and_128_variants() {
        let all = all();
        assert_eq!(all.len(), 32);
        assert_eq!(all.iter().map(|c| c.variants.len()).sum::<usize>(), 128);
        let mut names: Vec<String> = all
            .iter()
            .flat_map(|c| c.variants.iter().map(variant_name))
            .collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 128);
    }

    #[test]
    fn variant_names_match_the_api() {
        let t = target((200, 228, false), Fit::Fill, Frame::Gold, Reference::Sun);
        assert_eq!(variant_name(&t), "200x228-c-s200-rect-fill-sun-gold");
        assert_eq!(crop_name(&t), "200x228-rect-fill-gold");
        let plain = target(
            (144, 168, false),
            Fit::Fill,
            Frame::None,
            Reference::Defined,
        );
        assert_eq!(variant_name(&plain), "144x168-c-s144-rect-fill-defined");
    }

    fn plain() -> Target {
        target(
            (144, 168, false),
            Fit::Fill,
            Frame::None,
            Reference::Defined,
        )
    }

    #[test]
    fn crop_hash_is_stable_for_the_same_inputs() {
        assert_eq!(
            crop_hash("abc", &plain(), 20),
            crop_hash("abc", &plain(), 20)
        );
    }

    #[test]
    fn crop_hash_changes_when_the_source_image_changes() {
        assert_ne!(
            crop_hash("abc", &plain(), 20),
            crop_hash("abd", &plain(), 20)
        );
    }

    #[test]
    fn crop_hash_changes_when_the_safe_crop_setting_changes() {
        assert_ne!(
            crop_hash("abc", &plain(), 20),
            crop_hash("abc", &plain(), 21)
        );
    }

    #[test]
    fn variant_hash_changes_with_the_colour_tuning() {
        let crop = crop_hash("abc", &plain(), 20);
        let sun = target((144, 168, false), Fit::Fill, Frame::None, Reference::Sun);
        assert_ne!(variant_hash(&crop, &plain()), variant_hash(&crop, &sun));
    }

    #[test]
    fn hash_separates_parts_so_boundaries_matter() {
        assert_ne!(hash(&["ab", "c"]), hash(&["a", "bc"]));
    }

    #[test]
    fn hash_is_64_hex_characters() {
        assert_eq!(hash(&["x"]).len(), 64);
    }
}
