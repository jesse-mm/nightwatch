//! NightWatch's generator: builds the catalog (`catalog/web/`) the
//! watchface and the settings page load (from the static site) to show
//! public-domain Rijksmuseum paintings.
//!
//! It fetches metadata and a master image per painting politely, checks
//! licenses, sorts paintings into eras, ranks the Featured 365 by Wikipedia
//! readership and plans a smart crop per screen. The pictures themselves are
//! never stored for the watch: the phone and the settings page ask the
//! Rijksmuseum's IIIF server for exactly the planned crop.
//!
//! Reading order: generate →
//! catalog → imaging → saliency → bundle. Toning, dithering and frames live in
//! `site/render.js` (shared with the phone).

pub mod bundle;
pub mod catalog;
pub mod era;
pub mod featured;
pub mod generate;
pub mod imaging;
pub mod popularity;
pub mod rijks;
pub mod saliency;
pub mod throttle;
pub mod variants;
