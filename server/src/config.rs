//! Server configuration, read once from environment variables at startup.
//!
//! TS analogy: this is your `config.ts` that reads `process.env` and exports a
//! typed object. Every field has a default so `cargo run` works out of the box.

use std::{env, path::PathBuf, str::FromStr};

#[derive(Clone, Debug)]
pub struct Config {
    /// Address the HTTP server listens on.
    pub bind: String,
    /// The generator's output: catalog.sqlite + art/ (can be mounted read-only).
    pub data_dir: PathBuf,
    /// Folder that holds the settings page (`static/config/index.html`).
    pub static_dir: PathBuf,
}

pub fn var<T: FromStr>(key: &str, default: T) -> T {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            bind: var("BIND_ADDR", "0.0.0.0:8080".to_string()),
            data_dir: var("DATA_DIR", PathBuf::from("./data")),
            static_dir: var("STATIC_DIR", PathBuf::from("./static")),
        }
    }
}
