//! Treasure Trove: public-domain paintings from the Rijksmuseum, pre-rendered
//! for Pebble watches.
//!
//! Two programs share this library:
//! - **generator** (`src/bin/generator.rs`): fetches metadata and master images
//!   politely, renders every crop and variant, and records them in the catalog.
//! - **server** (`src/main.rs`): answers the watch and the settings page from
//!   the published snapshot (held in memory) and the files on disk. It never
//!   calls an outside service.
//!
//! New to Rust? Start with `docs/RUST_FOR_TS_DEVS.md`, then read: generate →
//! catalog → variants → imaging → snapshot → routes. Dithering and frames live
//! in `server/static/config/render.js` (shared with the phone).

pub mod bundle;
pub mod catalog;
pub mod era;
pub mod featured;
pub mod generate;
pub mod imaging;
pub mod popularity;
pub mod rijks;
pub mod saliency;
pub mod snapshot;
pub mod throttle;
pub mod variants;
