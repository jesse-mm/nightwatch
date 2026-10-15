//! Disk storage: the painting pool, metadata per painting and rendered images.
//!
//! Layout under DATA_DIR:
//!
//! ```text
//! pool.json                      ids we can pick from + when it was built
//! pool-<era>.json                same, filtered to one century (e.g. pool-1600s.json)
//! wikidata.json                  object number → Wikidata item + Wikipedia articles
//! art/<key>/meta.json            ArtMeta (also stored for ineligible paintings,
//!                                so we never resolve them twice)
//! art/<key>/source.jpg           analysis image (longest side ≈ SOURCE_SIZE)
//! art/<key>/v1/<target>.raw      bytes ready for the watch
//! art/<key>/v1/<target>.png      preview of exactly those pixels
//! art/<key>/v1/<target>.json     crop plan used
//! ```
//!
//! "When an image is optimised once we store the result": the render cache key
//! includes screen size, colour, row stride, shape and fit mode. Bump RENDER_VERSION
//! when the image pipeline changes to invalidate old renders.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub const RENDER_VERSION: &str = "v1";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Pool {
    /// Unix seconds.
    pub built_at: u64,
    pub ids: Vec<String>,
    pub complete: bool,
}

#[derive(Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn art_dir(&self, key: &str) -> PathBuf {
        self.root.join("art").join(sanitize(key))
    }

    pub fn meta_path(&self, key: &str) -> PathBuf {
        self.art_dir(key).join("meta.json")
    }

    pub fn source_path(&self, key: &str) -> PathBuf {
        self.art_dir(key).join("source.jpg")
    }

    pub fn render_path(&self, key: &str, target: &str, ext: &str) -> PathBuf {
        self.art_dir(key).join(RENDER_VERSION).join(format!("{target}.{ext}"))
    }

    pub fn pool_path(&self) -> PathBuf {
        self.root.join("pool.json")
    }

    /// Object number → Wikidata/Wikipedia links (see wiki.rs).
    pub fn wiki_path(&self) -> PathBuf {
        self.root.join("wikidata.json")
    }

    /// Pool for one "Paintings from" era, e.g. `pool-1600s.json`.
    pub fn era_pool_path(&self, era: &str) -> PathBuf {
        self.root.join(format!("pool-{era}.json"))
    }

    pub async fn read_json<T: DeserializeOwned>(&self, path: &Path) -> Option<T> {
        let bytes = tokio::fs::read(path).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub async fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<()> {
        self.write_bytes(path, &serde_json::to_vec_pretty(value)?).await
    }

    /// Write via a temp file + rename so readers never see half a file.
    pub async fn write_bytes(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        tokio::fs::write(&tmp, bytes).await?;
        tokio::fs::rename(&tmp, path).await?;
        Ok(())
    }
}

/// Keys come from URLs; only allow characters that are safe in a file name.
pub fn sanitize(key: &str) -> String {
    key.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect()
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
