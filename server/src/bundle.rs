//! `catalog.json`: everything the phone and the settings page need to show
//! paintings without our server. Pictures come straight from the Rijksmuseum's
//! IIIF image server, cut to the planned crop (`region` + `size` in the URL).
//!
//! One row per painting, as arrays to keep it small (~1 MB, ~275 KB gzipped):
//!
//! ```text
//! [key, iiif, title, artist, date, objectNumber, eraBits, license, aspect, crops]
//! ```
//!
//! * `iiif` – image id on `iiifPrefix` (`https://iiif.micr.io/<id>`).
//! * `eraBits` – bit i set = in `eras[i]`.
//! * `license` – index into `licenses` (`[label, url]`).
//! * `aspect` – width / height of the full image.
//! * `crops` – per screen in `screens` order, the Cover crop as fractions of
//!   the image `x, y, w, h` (slack included) and `window`: where the planned
//!   view starts in the crop, in screen pixels along its free axis.
//!
//! The web page and image links follow from the object number and IIIF id.
//! `docs/schema/catalog.schema.json` describes the file.

use std::{collections::BTreeMap, path::Path};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::{
    era::Era,
    imaging::{Fit, Target},
    snapshot::Snapshot,
    variants,
};

pub const VERSION: u32 = 1;
const IIIF_PREFIX: &str = "https://iiif.micr.io/";

/// Fractions with 5 decimals: well below a pixel on a 1200 px master.
fn round5(v: f64) -> f64 {
    (v * 100_000.0).round() / 100_000.0
}

/// Write the bundle; returns the number of paintings.
pub fn write(snap: &Snapshot, data_dir: &Path, path: &Path) -> Result<usize> {
    let eras = Era::FILTERED;
    let screens: Vec<Target> = variants::SCREENS
        .iter()
        .map(|&(w, h, round)| Target {
            w,
            h,
            round,
            fit: Fit::Fill,
        })
        .collect();
    let mut licenses: Vec<(String, String)> = Vec::new();
    let mut rows: BTreeMap<String, Value> = BTreeMap::new();

    for p in snap.paintings() {
        let m = &p.meta;
        let Some(iiif) = m
            .iiif_base
            .as_deref()
            .and_then(|b| b.strip_prefix(IIIF_PREFIX))
        else {
            continue; // not on the IIIF server we can cut from
        };
        let source = data_dir.join("art").join(&m.key).join("source.jpg");
        let (sw, sh) = image::image_dimensions(&source)
            .with_context(|| format!("reading {}", source.display()))?;
        let mut era_bits = 0u32;
        for (i, era) in eras.iter().enumerate() {
            if snap.era_keys(*era).iter().any(|k| k == &m.key) {
                era_bits |= 1 << i;
            }
        }
        let license = (m.license.clone(), m.license_url.clone().unwrap_or_default());
        let license_idx = match licenses.iter().position(|l| *l == license) {
            Some(i) => i,
            None => {
                licenses.push(license);
                licenses.len() - 1
            }
        };
        let mut crops = Vec::new();
        for t in &screens {
            let plan = p
                .plans
                .get(&variants::crop_name(t))
                .with_context(|| format!("{} has no {} plan", m.key, variants::crop_name(t)))?;
            let window = plan.window_x.max(plan.window_y);
            crops.extend([
                json!(round5(plan.x)),
                json!(round5(plan.y)),
                json!(round5(plan.w)),
                json!(round5(plan.h)),
                json!(window),
            ]);
        }
        rows.insert(
            m.key.clone(),
            json!([
                m.key,
                iiif,
                m.title,
                m.artist,
                m.date,
                m.object_number,
                era_bits,
                license_idx,
                round5(sw as f64 / sh as f64),
                crops
            ]),
        );
    }

    let featured: Vec<&str> = snap
        .featured_keys()
        .iter()
        .map(String::as_str)
        .filter(|k| rows.contains_key(*k))
        .collect();
    let body = json!({
        "version": VERSION,
        "iiifPrefix": IIIF_PREFIX,
        "webPrefix": "https://www.rijksmuseum.nl/en/collection/",
        "eras": eras.iter().map(|e| serde_json::to_value(e).unwrap_or(Value::Null)).collect::<Vec<_>>(),
        "licenses": licenses.iter().map(|(l, u)| json!([l, u])).collect::<Vec<_>>(),
        "screens": variants::SCREENS.iter().map(|&(w, h, round)| json!([w, h, round])).collect::<Vec<_>>(),
        "slack": crate::imaging::COVER_SLACK_PX,
        "featured": featured,
        "paintings": rows.into_values().collect::<Vec<_>>(),
    });
    let n = body["paintings"].as_array().map_or(0, Vec::len);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&body)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(n)
}
