//! What the server keeps in memory: the published `serve.sqlite` read once into
//! plain Rust maps. Answering a request is a hash lookup or a random index into
//! a list; no SQL, no locks held during a request.
//!
//! TS analogy: `const paintings = new Map(rows.map(r => [r.key, r]))` built at
//! startup, plus one array of keys per era for random picks.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use rand::seq::IndexedRandom;
use rusqlite::{Connection, OpenFlags};

use crate::{
    catalog::Catalog,
    era::Era,
    imaging::{CropPlan, Target},
    rijks::ArtMeta,
    variants,
    wiki::WikiLinks,
};

pub struct Painting {
    pub meta: ArtMeta,
    /// Crop name → plan, for the 32 crops.
    pub plans: HashMap<String, CropPlan>,
    pub wiki: Option<WikiLinks>,
}

/// Everything needed to answer for one painting + variant.
pub struct Served<'a> {
    pub painting: &'a Painting,
    pub plan: &'a CropPlan,
    pub variant_path: PathBuf,
    pub crop_path: PathBuf,
}

#[derive(Debug, Default)]
pub struct Snapshot {
    root: PathBuf,
    /// Only paintings that are eligible, in the pool and fully rendered.
    paintings: HashMap<String, Painting>,
    any: Vec<String>,
    by_era: HashMap<Era, Vec<String>>,
    pub pool: usize,
    pub eligible: usize,
}

impl std::fmt::Debug for Painting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.meta.key)
    }
}

impl Snapshot {
    /// Read `serve.sqlite` into memory. It's replaced by rename, never changed
    /// in place, so it's opened immutable (works on a read-only mount).
    pub fn load(root: &Path) -> Result<Self> {
        let path = Catalog::serve_path(root);
        if !path.exists() {
            bail!("{} not found (run the generator first)", path.display());
        }
        let uri = format!("file:{}?mode=ro&immutable=1", path.display());
        let db = Connection::open_with_flags(
            &uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .with_context(|| format!("open {}", path.display()))?;

        let count = |sql: &str| -> Result<usize> {
            Ok(db.query_row(sql, [], |r| r.get::<_, i64>(0))? as usize)
        };
        let mut snap = Snapshot {
            root: root.to_path_buf(),
            pool: count("SELECT count(*) FROM pool")?,
            eligible: count("SELECT count(*) FROM paintings WHERE eligible = 1")?,
            ..Default::default()
        };

        let mut wiki: HashMap<String, WikiLinks> = HashMap::new();
        let mut stmt = db.prepare("SELECT object_number, links FROM wiki")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (num, links) = row?;
            if let Ok(l) = serde_json::from_str(&links) {
                wiki.insert(num, l);
            }
        }

        let mut stmt = db.prepare(
            "SELECT p.meta, p.plans FROM paintings p JOIN pool ON pool.key = p.key
             WHERE p.eligible = 1 AND p.ready = 1 AND p.plans IS NOT NULL ORDER BY p.key",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (meta, plans) = row?;
            let meta: ArtMeta = serde_json::from_str(&meta)?;
            let plans: HashMap<String, CropPlan> = serde_json::from_str(&plans)?;
            let links = meta.object_number.as_ref().and_then(|n| wiki.remove(n));
            snap.any.push(meta.key.clone());
            snap.paintings.insert(
                meta.key.clone(),
                Painting {
                    meta,
                    plans,
                    wiki: links,
                },
            );
        }

        let mut stmt = db.prepare("SELECT key, era FROM painting_eras ORDER BY era, key")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (key, era) = row?;
            let Ok(era) = serde_json::from_value::<Era>(serde_json::Value::String(era)) else {
                continue;
            };
            if snap.paintings.contains_key(&key) {
                snap.by_era.entry(era).or_default().push(key);
            }
        }
        Ok(snap)
    }

    /// Paintings the server can offer (fully rendered).
    pub fn ready(&self) -> usize {
        self.paintings.len()
    }

    pub fn random(&self, era: Era) -> Option<&str> {
        let keys = if era == Era::Any {
            Some(&self.any)
        } else {
            self.by_era.get(&era)
        };
        keys?.choose(&mut rand::rng()).map(String::as_str)
    }

    /// File names follow from the variant (see variants.rs).
    pub fn served(&self, key: &str, variant: &Target) -> Option<Served<'_>> {
        let painting = self.paintings.get(key)?;
        let crop = variants::crop_name(variant);
        let plan = painting.plans.get(&crop)?;
        let dir = self.root.join("art").join(&painting.meta.key);
        Some(Served {
            painting,
            plan,
            variant_path: dir
                .join("v")
                .join(format!("{}.png", variants::variant_name(variant))),
            crop_path: dir.join("crops").join(format!("{crop}.webp")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        catalog::testing::{published, TempDir, CROP, VARIANT},
        frame::Frame,
        imaging::Fit,
        palette::Reference,
    };

    fn variant() -> Target {
        variants::target(
            (144, 168, false),
            Fit::Fill,
            Frame::None,
            Reference::Defined,
        )
    }

    #[test]
    fn random_skips_paintings_still_missing_variants() {
        let dir = TempDir::new("snap-incomplete");
        published(&dir, 2);

        assert_eq!(Snapshot::load(dir.path()).unwrap().random(Era::Any), None);
    }

    #[test]
    fn random_picks_a_fully_rendered_painting() {
        let dir = TempDir::new("snap-any");
        published(&dir, 1);

        assert_eq!(
            Snapshot::load(dir.path()).unwrap().random(Era::Any),
            Some("1")
        );
    }

    #[test]
    fn random_picks_from_the_requested_era() {
        let dir = TempDir::new("snap-era");
        published(&dir, 1);

        assert_eq!(
            Snapshot::load(dir.path()).unwrap().random(Era::C17),
            Some("1")
        );
    }

    #[test]
    fn random_returns_none_for_an_era_without_paintings() {
        let dir = TempDir::new("snap-empty-era");
        published(&dir, 1);

        assert_eq!(Snapshot::load(dir.path()).unwrap().random(Era::C18), None);
    }

    #[test]
    fn served_derives_the_variant_path_from_its_name() {
        let dir = TempDir::new("snap-variant-path");
        published(&dir, 1);
        let snap = Snapshot::load(dir.path()).unwrap();

        let served = snap.served("1", &variant()).unwrap();

        assert!(
            served
                .variant_path
                .ends_with(format!("art/1/v/{VARIANT}.png")),
            "{:?}",
            served.variant_path
        );
    }

    #[test]
    fn served_derives_the_crop_path_from_its_name() {
        let dir = TempDir::new("snap-crop-path");
        published(&dir, 1);
        let snap = Snapshot::load(dir.path()).unwrap();

        let served = snap.served("1", &variant()).unwrap();

        assert!(
            served
                .crop_path
                .ends_with(format!("art/1/crops/{CROP}.webp")),
            "{:?}",
            served.crop_path
        );
    }

    #[test]
    fn served_returns_the_crop_plan() {
        let dir = TempDir::new("snap-plan");
        published(&dir, 1);
        let snap = Snapshot::load(dir.path()).unwrap();

        assert_eq!(snap.served("1", &variant()).unwrap().plan.inner_w, 144);
    }

    #[test]
    fn load_fails_before_anything_is_published() {
        let dir = TempDir::new("snap-missing");

        assert!(Snapshot::load(dir.path()).is_err());
    }
}
