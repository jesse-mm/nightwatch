//! The catalog the phone and the settings page use, as a folder of small
//! JSON files, so each only downloads and parses what it needs:
//!
//! ```text
//! manifest.json     shared fields, the files and their painting counts, and
//!                   `id`, a hash of everything (a new id = new files)
//! featured.json     the Featured paintings, one per day of the year, in order
//! pre1600.json …    one file per era (1600s, 1700s, 1800s, 1900s)
//! undated.json      paintings without a usable date (era from the search
//!                   pools, or else from the painting's date)
//! search.json       title, artist, date and object number of every painting
//!                   and the file it's in: for searching by title on the
//!                   settings page (loaded only when someone searches)
//! ```
//!
//! Every painting is in exactly one era file (or undated), and Featured ones
//! also in featured.json. A painting is a row, as an array to keep it small:
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
//! Pictures come straight from the Rijksmuseum's IIIF image server, cut to the
//! planned crop. The web page and image links follow from the object number
//! and IIIF id. `docs/schema/catalog.schema.json` describes the files.

use std::{collections::HashMap, path::Path};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::{
    catalog::Catalog,
    era::Era,
    imaging::{Fit, Target},
    variants,
};

pub const VERSION: u32 = 2;
const IIIF_PREFIX: &str = "https://iiif.micr.io/";
/// The file for paintings without an era.
pub const UNDATED: &str = "undated";

/// Fractions with 5 decimals: well below a pixel on a 1200 px master.
fn round5(v: f64) -> f64 {
    (v * 100_000.0).round() / 100_000.0
}

/// Write the catalog folder; returns the number of paintings.
/// `featured`: Featured keys in day-of-year order (see featured.rs).
pub fn write(catalog: &Catalog, featured: &[String], dir: &Path) -> Result<usize> {
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
    let mut by_key: HashMap<String, Value> = HashMap::new();
    // Pool name → rows, in file order: eras first, then undated.
    let mut pools: Vec<(String, Vec<Value>)> = eras
        .iter()
        .map(|e| (e.name().to_string(), Vec::new()))
        .chain(std::iter::once((UNDATED.to_string(), Vec::new())))
        .collect();

    for p in catalog.bundle_rows()? {
        let m = &p.meta;
        let Some(iiif) = m
            .iiif_base
            .as_deref()
            .and_then(|b| b.strip_prefix(IIIF_PREFIX))
        else {
            continue; // not on the IIIF server we can cut from
        };
        // The search's era pools, or else the painting's own date (they miss
        // approximate dates like "c. 1650").
        let era = eras.iter().position(|e| p.eras.contains(e)).or_else(|| {
            let from_date = m.date.as_deref().and_then(Era::from_date)?;
            eras.iter().position(|e| *e == from_date)
        });
        let era_bits = era.map_or(0u32, |i| 1 << i);
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
        let row = json!([
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
        ]);
        by_key.insert(m.key.clone(), row.clone());
        pools[era.unwrap_or(eras.len())].1.push(row);
    }

    let featured_rows: Vec<Value> = featured
        .iter()
        .filter_map(|k| by_key.get(k).cloned())
        .collect();
    // For searching by title: [key, title, artist, date, objectNumber, pool].
    let search: Vec<Value> = pools
        .iter()
        .flat_map(|(pool, rows)| {
            rows.iter()
                .map(move |r| json!([r[0], r[2], r[3], r[4], r[5], pool]))
        })
        .collect();
    let mut files: Vec<(String, Vec<Value>)> = vec![("featured".to_string(), featured_rows)];
    files.extend(pools);

    // One id for the whole set, so a reader never mixes files from two runs.
    let parts: Vec<Vec<u8>> = files
        .iter()
        .map(|(_, rows)| serde_json::to_vec(rows))
        .collect::<Result<_, _>>()?;
    let id = variants::sha256_hex(&parts.concat())[..12].to_string();

    std::fs::create_dir_all(dir)?;
    for (pool, rows) in &files {
        write_json(
            &dir.join(format!("{pool}.json")),
            &json!({ "version": VERSION, "id": id, "pool": pool, "paintings": rows }),
        )?;
    }
    write_json(
        &dir.join("search.json"),
        &json!({ "version": VERSION, "id": id, "entries": search }),
    )?;
    let manifest = json!({
        "version": VERSION,
        "id": id,
        "iiifPrefix": IIIF_PREFIX,
        "webPrefix": "https://www.rijksmuseum.nl/en/collection/",
        "eras": eras.iter().map(|e| e.name()).collect::<Vec<_>>(),
        "licenses": licenses.iter().map(|(l, u)| json!([l, u])).collect::<Vec<_>>(),
        "screens": variants::SCREENS.iter().map(|&(w, h, round)| json!([w, h, round])).collect::<Vec<_>>(),
        "slack": crate::imaging::COVER_SLACK_PX,
        "files": files
            .iter()
            .map(|(pool, rows)| json!({ "pool": pool, "file": format!("{pool}.json"), "count": rows.len() }))
            .collect::<Vec<_>>(),
        "search": { "file": "search.json", "count": search.len() },
    });
    // The manifest last: readers that see the new id find the new files.
    write_json(&dir.join("manifest.json"), &manifest)?;
    Ok(by_key.len())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::testing::{planned, TempDir};

    fn read(dir: &Path, file: &str) -> Value {
        serde_json::from_slice(&std::fs::read(dir.join(file)).unwrap()).unwrap()
    }

    #[test]
    fn writes_a_manifest_featured_and_one_file_per_era() {
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
        let out = dir.path().join("web");

        let n = write(&c, &["1".to_string(), "gone".to_string()], &out).unwrap();

        assert_eq!(n, 1);
        let manifest = read(&out, "manifest.json");
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(files.len(), 1 + Era::FILTERED.len() + 1); // featured, eras, undated
        assert_eq!(
            files[0],
            json!({ "pool": "featured", "file": "featured.json", "count": 1 })
        );
        let featured = read(&out, "featured.json");
        assert_eq!(featured["id"], manifest["id"]);
        assert_eq!(featured["paintings"][0][0], "1");
        let era = read(&out, "1600s.json");
        let row = &era["paintings"][0];
        assert_eq!(row[1], "x"); // iiif id after the prefix
        assert_eq!(row[6], 2); // 1600s = bit 1
        assert_eq!(row[8], 0.75); // 300 x 400
        assert_eq!(
            row[9].as_array().unwrap().len(),
            5 * variants::SCREENS.len()
        );
        assert_eq!(read(&out, "undated.json")["paintings"], json!([]));
        assert_eq!(
            manifest["search"],
            json!({ "file": "search.json", "count": 1 })
        );
        let search = read(&out, "search.json");
        assert_eq!(search["id"], manifest["id"]);
        assert_eq!(
            search["entries"][0],
            json!(["1", "The Night Watch", "A", "1642", "SK-C-5", "1600s"])
        );
    }
}
