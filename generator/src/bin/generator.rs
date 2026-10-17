//! `treasure-trove-generator`: builds `catalog.json`, the painting catalog the
//! watchface and the settings page use.
//!
//! Run it monthly (or whenever); it only redoes work whose inputs changed. See
//! `--help` and docs/GENERATOR.md.

use std::path::PathBuf;

use anyhow::{bail, Result};
use tracing_subscriber::EnvFilter;
use treasure_trove::generate::{self, Options};

const HELP: &str = "\
treasure-trove-generator: fetch paintings politely, plan their crops, write catalog.json

USAGE: treasure-trove-generator [OPTIONS]

OPTIONS (environment variable in brackets):
  --data DIR            working directory: catalog.sqlite + art/  [DATA_DIR, ./data]
  --bundle FILE         where to write catalog.json                [BUNDLE_PATH, ./catalog/catalog.json]
  --export FILE         also write paintings.jsonl (for diffs)     [EXPORT_PATH]
  --rps N               requests per second to outside services   [REQUESTS_PER_SECOND, 1]
  --contact TEXT        your email or a URL, sent in the User-Agent [CONTACT]
                        (Wikimedia requires it for Wikipedia pageviews; without it
                        Featured is ranked by number of Wikipedia articles)
  --refresh-days N      re-check metadata/pools older than this   [REFRESH_DAYS, 25]
  --featured FILE       the Featured list (a release artifact); built only when missing
                        [FEATURED_PATH, ./catalog/featured.json]
  --refresh-featured    rebuild the Featured list (e.g. once a year, ~20 min)
  --limit N             only N paintings (test runs)
  --only KEY            only this painting (repeatable), e.g. 200107928
  --skip-fetch          plan from what's on disk, no network
  --skip-plan           fetch only
  -h, --help            this text

Other settings: RIJKS_SEARCH_URL, POOL_MAX_PAGES (80), PD_FALLBACK_YEAR (1850),
SAFE_CROP_PX (20), SOURCE_SIZE (1200), USER_AGENT, RAYON_NUM_THREADS.
";

fn var<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn parse_args() -> Result<Options> {
    let mut o = Options {
        data_dir: var("DATA_DIR", PathBuf::from("./data")),
        export: std::env::var("EXPORT_PATH").ok().map(PathBuf::from),
        bundle: var("BUNDLE_PATH", PathBuf::from("./catalog/catalog.json")),
        requests_per_second: var("REQUESTS_PER_SECOND", 1.0),
        refresh_days: var("REFRESH_DAYS", 25),
        limit: None,
        only: Vec::new(),
        skip_fetch: false,
        skip_plan: false,
        search_url: var(
            "RIJKS_SEARCH_URL",
            "https://data.rijksmuseum.nl/search/collection?type=painting&imageAvailable=true"
                .to_string(),
        ),
        pool_max_pages: var("POOL_MAX_PAGES", 80),
        pd_fallback_year: var("PD_FALLBACK_YEAR", 1850),
        safe_crop_px: var("SAFE_CROP_PX", 20),
        source_size: var("SOURCE_SIZE", 1200),
        contact: std::env::var("CONTACT")
            .ok()
            .filter(|c| !c.trim().is_empty()),
        featured_path: var("FEATURED_PATH", PathBuf::from("./catalog/featured.json")),
        refresh_featured: false,
        user_agent: String::new(),
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut value = |name: &str| {
            args.next()
                .ok_or_else(|| anyhow::anyhow!("{name} needs a value"))
        };
        match a.as_str() {
            "--data" => o.data_dir = value("--data")?.into(),
            "--export" => o.export = Some(value("--export")?.into()),
            "--bundle" => o.bundle = value("--bundle")?.into(),
            "--rps" => o.requests_per_second = value("--rps")?.parse()?,
            "--contact" => o.contact = Some(value("--contact")?),
            "--featured" => o.featured_path = value("--featured")?.into(),
            "--refresh-featured" => o.refresh_featured = true,
            "--refresh-days" => o.refresh_days = value("--refresh-days")?.parse()?,
            "--limit" => o.limit = Some(value("--limit")?.parse()?),
            "--only" => o.only.push(value("--only")?),
            "--skip-fetch" => o.skip_fetch = true,
            "--skip-plan" => o.skip_plan = true,
            "-h" | "--help" => {
                print!("{HELP}");
                std::process::exit(0);
            }
            other => bail!("unknown option {other}\n\n{HELP}"),
        }
    }
    // Wikimedia's policy: "<client>/<version> (<contact>) <library>".
    o.user_agent = std::env::var("USER_AGENT").unwrap_or_else(|_| match &o.contact {
        Some(c) => format!("TreasureTrove/0.2 ({c}; Pebble watchface generator) reqwest"),
        None => "TreasureTrove/0.2 (Pebble watchface generator; not affiliated with the Rijksmuseum) reqwest".to_string(),
    });
    Ok(o)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let opts = parse_args()?;
    tracing::info!(?opts, "starting");
    generate::run(opts).await
}
