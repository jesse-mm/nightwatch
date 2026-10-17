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

use std::{collections::HashSet, path::Path};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::{
    catalog::Catalog,
    era::Era,
    imaging::{Fit, Target},
    variants,
};

pub const VERSION: u32 = 1;
const IIIF_PREFIX: &str = "https://iiif.micr.io/";

/// Fractions with 5 decimals: well below a pixel on a 1200 px master.
fn round5(v: f64) -> f64 {
    (v * 100_000.0).round() / 100_000.0
}

/// Write the bundle; returns the number of paintings.
/// `featured`: Featured keys in day-of-year order (see featured.rs).
pub fn write(catalog: &Catalog, featured: &[String], path: &Path) -> Result<usize> {
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
    let mut rows: Vec<Value> = Vec::new();
    let mut keys: HashSet<String> = HashSet::new();

    for p in catalog.bundle_rows()? {
        let m = &p.meta;
        let Some(iiif) = m
            .iiif_base
            .as_deref()
            .and_then(|b| b.strip_prefix(IIIF_PREFIX))
        else {
            continue; // not on the IIIF server we can cut from
        };
        let era_bits = eras
            .iter()
            .enumerate()
            .filter(|(_, era)| p.eras.contains(era))
            .fold(0u32, |bits, (i, _)| bits | (1 << i));
        let license = (m.license.clone(), m.license_url.clone().unwrap_or_default());
        let license_idx = if let Some(i) = licenses.iter().position(|l| *l == license) {
            i
        } else {
            licenses.push(license);
            licenses.len() - 1
        };
        let mut crops = Vec::new();
        for t in &screens {
            let name = variants::crop_name(t);
            let plan = p
                .plans
                .get(&name)
                .with_context(|| format!("{} has no {name} plan", m.key))?;
            crops.extend([
                json!(round5(plan.x)),
                json!(round5(plan.y)),
                json!(round5(plan.w)),
                json!(round5(plan.h)),
                json!(plan.window_x.max(plan.window_y)),
            ]);
        }
        keys.insert(m.key.clone());
        rows.push(json!([
            m.key,
            iiif,
            m.title,
            m.artist,
            m.date,
            m.object_number,
            era_bits,
            license_idx,
            round5(f64::from(p.width) / f64::from(p.height)),
            crops
        ]));
    }

    let featured: Vec<&str> = featured
        .iter()
        .map(String::as_str)
        .filter(|k| keys.contains(*k))
        .collect();
    let body = json!({
        "version": VERSION,
        "iiifPrefix": IIIF_PREFIX,
        "webPrefix": "https://www.rijksmuseum.nl/en/collection/",
        "eras": eras.iter().map(|e| e.name()).collect::<Vec<_>>(),
        "licenses": licenses.iter().map(|(l, u)| json!([l, u])).collect::<Vec<_>>(),
        "screens": variants::SCREENS.iter().map(|&(w, h, round)| json!([w, h, round])).collect::<Vec<_>>(),
        "slack": crate::imaging::COVER_SLACK_PX,
        "featured": featured,
        "paintings": rows,
    });
    let n = rows_len(&body);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&body)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(n)
}

fn rows_len(body: &Value) -> usize {
    body["paintings"].as_array().map_or(0, Vec::len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::testing::{planned, TempDir};

    #[test]
    fn writes_ready_paintings_with_their_featured_days() {
        let dir = TempDir::new("bundle");
        let c = planned(&dir, 1);
        // The fixture plans one screen only; give every screen the same plan.
        let plan = c.bundle_rows().unwrap()[0]
            .plans
            .values()
            .next()
            .copied()
            .unwrap();
        for t in variants::cover() {
            c.put_plan("1", &variants::crop_name(&t), "h", &plan)
                .unwrap();
        }
        let names: Vec<String> = variants::cover().iter().map(variants::crop_name).collect();
        c.finish_painting("1", &names).unwrap();
        let out = dir.path().join("catalog.json");

        let n = write(&c, &["1".to_string(), "gone".to_string()], &out).unwrap();

        let body: Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!(n, 1);
        assert_eq!(body["featured"], json!(["1"]));
        let row = &body["paintings"][0];
        assert_eq!(row[0], "1");
        assert_eq!(row[1], "x"); // iiif id after the prefix
        assert_eq!(row[6], 2); // 1600s = bit 1
        assert_eq!(row[8], 0.75); // 300 x 400
        assert_eq!(
            row[9].as_array().unwrap().len(),
            5 * variants::SCREENS.len()
        );
    }
}
