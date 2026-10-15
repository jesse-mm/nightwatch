//! `treasure-trove-generator`: builds everything the server serves.
//!
//! Run it monthly (or whenever); it only redoes work whose inputs changed. See
//! `--help` and docs/GENERATOR.md.

use std::path::PathBuf;

use anyhow::{bail, Result};
use tracing_subscriber::EnvFilter;
use treasure_trove::generate::{self, Options};

const HELP: &str = "\
treasure-trove-generator: fetch paintings politely, render every variant, export metadata

USAGE: treasure-trove-generator [OPTIONS]

OPTIONS (environment variable in brackets):
  --data DIR            output directory: catalog.sqlite + art/   [DATA_DIR, ./data]
  --export FILE         write the git-friendly catalog here        [EXPORT_PATH]
  --rps N               requests per second to outside services   [REQUESTS_PER_SECOND, 1]
  --refresh-days N      re-check metadata/pools older than this   [REFRESH_DAYS, 25]
  --limit N             only N paintings (test runs)
  --only KEY            only this painting (repeatable), e.g. 200107928
  --skip-fetch          render from what's on disk, no network
  --skip-render         fetch only
  -h, --help            this text

Other settings: RIJKS_SEARCH_URL, POOL_MAX_PAGES (80), PD_FALLBACK_YEAR (1850),
SAFE_CROP_PX (20), SOURCE_SIZE (1200), WEBP_QUALITY (90), USER_AGENT, RAYON_NUM_THREADS.
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
        requests_per_second: var("REQUESTS_PER_SECOND", 1.0),
        refresh_days: var("REFRESH_DAYS", 25),
        limit: None,
        only: Vec::new(),
        skip_fetch: false,
        skip_render: false,
        search_url: var(
            "RIJKS_SEARCH_URL",
            "https://data.rijksmuseum.nl/search/collection?type=painting&imageAvailable=true"
                .to_string(),
        ),
        pool_max_pages: var("POOL_MAX_PAGES", 80),
        pd_fallback_year: var("PD_FALLBACK_YEAR", 1850),
        safe_crop_px: var("SAFE_CROP_PX", 20),
        source_size: var("SOURCE_SIZE", 1200),
        webp_quality: var("WEBP_QUALITY", 90.0),
        user_agent: var(
            "USER_AGENT",
            "TreasureTrove/0.2 (Pebble watchface generator; not affiliated with the Rijksmuseum)"
                .to_string(),
        ),
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
            "--rps" => o.requests_per_second = value("--rps")?.parse()?,
            "--refresh-days" => o.refresh_days = value("--refresh-days")?.parse()?,
            "--limit" => o.limit = Some(value("--limit")?.parse()?),
            "--only" => o.only.push(value("--only")?),
            "--skip-fetch" => o.skip_fetch = true,
            "--skip-render" => o.skip_render = true,
            "-h" | "--help" => {
                print!("{HELP}");
                std::process::exit(0);
            }
            other => bail!("unknown option {other}\n\n{HELP}"),
        }
    }
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
