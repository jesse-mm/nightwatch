//! Runtime configuration, read once from environment variables at startup.
//!
//! TS analogy: this is your `config.ts` that reads `process.env` and exports a
//! typed object. Every field has a default so `cargo run` works out of the box.

use std::{env, path::PathBuf, str::FromStr};

use crate::palette::Reference;

#[derive(Clone, Debug)]
pub struct Config {
    /// Address the HTTP server listens on.
    pub bind: String,
    /// Where pool, metadata and rendered images are stored (mount a volume here).
    pub data_dir: PathBuf,
    /// Folder that holds the settings page (`static/config/index.html`).
    pub static_dir: PathBuf,
    /// Rijksmuseum Search API endpoint, already filtered to paintings with images.
    pub search_url: String,
    /// Upper bound on search pages crawled when building the painting pool.
    pub pool_max_pages: usize,
    /// Rebuild the pool after this many days.
    pub pool_refresh_days: u64,
    /// "Almost fits" threshold: if filling the screen trims at most this many
    /// (screen) pixels, we simply center-crop instead of running smart crop.
    pub safe_crop_px: u32,
    /// If a record carries no machine-readable licence, accept it only when it was
    /// made no later than this year (0 = never accept unlicensed records).
    pub pd_fallback_year: i32,
    /// Longest side (px) of the analysis image we download per painting.
    pub source_size: u32,
    /// Default colour tuning when a request doesn't pass `palette=`.
    pub reference: Reference,
    pub user_agent: String,
}

fn var<T: FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            bind: var("BIND_ADDR", "0.0.0.0:8080".to_string()),
            data_dir: var("DATA_DIR", PathBuf::from("./data")),
            static_dir: var("STATIC_DIR", PathBuf::from("./static")),
            search_url: var(
                "RIJKS_SEARCH_URL",
                "https://data.rijksmuseum.nl/search/collection?type=painting&imageAvailable=true"
                    .to_string(),
            ),
            pool_max_pages: var("POOL_MAX_PAGES", 80),
            pool_refresh_days: var("POOL_REFRESH_DAYS", 7),
            safe_crop_px: var("SAFE_CROP_PX", 20),
            pd_fallback_year: var("PD_FALLBACK_YEAR", 1850),
            source_size: var("SOURCE_SIZE", 1200),
            reference: var("PALETTE_REFERENCE", Reference::Defined),
            user_agent: var(
                "USER_AGENT",
                "TreasureTrove/0.1 (Pebble watchface; not affiliated with the Rijksmuseum)"
                    .to_string(),
            ),
        }
    }
}
