//! The crops the generator plans, their names, and the input hashes that
//! decide whether a plan is still up to date.
//!
//! Per painting: one Cover crop plan per screen (4). Contain needs no plan: it
//! is the whole painting, sized from its aspect ratio on the phone.
//!
//! Plans come from the painting's local master image, so a planning change
//! never touches the network.

use sha2::{Digest, Sha256};

use crate::imaging::{Fit, Target};

/// Bump when the planning code changes output: every plan whose hash includes
/// it is then redone from the local master images.
pub const PIPELINE_VERSION: &str = "2026-10-17.4-plans";

/// The color screens we support: (width, height, round). See docs/DEVICES.md.
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

/// Every crop a painting gets a plan for: Cover on each screen.
pub fn cover() -> Vec<Target> {
    SCREENS.iter().map(|&s| target(s, Fit::Fill)).collect()
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
    fn cover_is_one_distinct_plan_per_screen() {
        let mut names: Vec<String> = cover().iter().map(crop_name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), SCREENS.len());
        assert!(names.iter().all(|n| n.ends_with("-fill")));
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
