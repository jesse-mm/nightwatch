//! The crops the generator produces, their names, and the input hashes that
//! decide whether a file is still up to date.
//!
//! Per painting: 4 screens × 2 fits = 8 **crops**, the painting cut to the
//! screen's exact size and toned, stored as lossless PNG. Everything else, the
//! colour tuning (dithering) and the frame, is applied on the phone and in the
//! settings page (`server/static/config/render.js`), so one crop serves all
//! 16 combinations of frame and tuning.
//!
//! Everything is rendered from the painting's local master image, so a pipeline
//! change never touches the network.

use sha2::{Digest, Sha256};

use crate::imaging::{Fit, Target};

/// Bump when the crop or tone code changes output: every crop whose hash
/// includes it is then rebuilt from the local master images.
pub const PIPELINE_VERSION: &str = "2026-10-16.2-crops";

/// The colour screens we support: (width, height, round). See docs/DEVICES.md.
pub const SCREENS: [(u32, u32, bool); 4] = [
    (144, 168, false), // basalt: Pebble Time, Time Steel
    (180, 180, true),  // chalk: Pebble Time Round
    (200, 228, false), // emery: Pebble Time 2
    (260, 260, true),  // gabbro: Pebble Round 2
];

pub fn target(screen: (u32, u32, bool), fit: Fit) -> Target {
    let (w, h, round) = screen;
    Target { w, h, round, fit }
}

/// Every crop a painting gets.
pub fn all() -> Vec<Target> {
    SCREENS
        .iter()
        .flat_map(|&s| Fit::ALL.iter().map(move |&fit| target(s, fit)))
        .collect()
}

/// e.g. `200x228-rect-fill`; the file is `art/<key>/c/<name>.png`.
pub fn crop_name(t: &Target) -> String {
    format!(
        "{}x{}-{}-{}",
        t.w,
        t.h,
        if t.round { "round" } else { "rect" },
        t.fit.name()
    )
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

/// A crop is up to date when the master image, the pipeline and the crop
/// settings (including the safe-crop threshold) are unchanged.
pub fn crop_hash(source_sha: &str, crop: &Target, safe_crop_px: u32) -> String {
    hash(&[
        PIPELINE_VERSION,
        source_sha,
        &crop_name(crop),
        &safe_crop_px.to_string(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain() -> Target {
        target((144, 168, false), Fit::Fill)
    }

    #[test]
    fn all_is_8_distinct_crops() {
        let mut names: Vec<String> = all().iter().map(crop_name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 8);
    }

    #[test]
    fn crop_name_describes_screen_and_fit() {
        assert_eq!(
            crop_name(&target((260, 260, true), Fit::Whole)),
            "260x260-round-whole"
        );
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
    fn hash_separates_parts_so_boundaries_matter() {
        assert_ne!(hash(&["ab", "c"]), hash(&["a", "bc"]));
    }

    #[test]
    fn hash_is_64_hex_characters() {
        assert_eq!(hash(&["x"]).len(), 64);
    }
}
