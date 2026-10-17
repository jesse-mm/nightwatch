//! The generator: fetch what changed, plan what's outdated, write the catalog.
//!
//! **Fetch** (network, throttled, resumable)
//! 1. The painting pool + era pools (search pages), when older than
//!    `refresh_days`.
//! 2. Metadata for every pool painting not checked within `refresh_days`. A
//!    master image is downloaded only when the painting has none yet or its
//!    IIIF URL changed (IIIF images are immutable).
//! 3. The Featured list (Wikipedia readership), only when missing or asked for.
//!
//! **Plan** (local only, parallel)
//! 4. For each eligible painting with a master image, redo only the crop plans
//!    whose input hash changed: new image or a `PIPELINE_VERSION` bump.
//!
//! **Write**
//! 5. `catalog.json` for the phone and the settings page (bundle.rs), and
//!    `paintings.jsonl` (metadata and hashes, for diffs).
//!
//! Stopping at any point is safe: everything already written is recorded with
//! its hash and is skipped next time.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use anyhow::{anyhow, Context, Result};
use image::RgbImage;
use rayon::prelude::*;

use crate::{
    catalog::{key_of, Catalog},
    era::{self, Era},
    featured,
    imaging::{self, CropPlan, Target},
    popularity,
    rijks::Rijks,
    throttle::Throttle,
    variants,
};

#[derive(Clone, Debug)]
pub struct Options {
    pub data_dir: PathBuf,
    /// Write `paintings.jsonl` here after the run (metadata, for diffs).
    pub export: Option<PathBuf>,
    /// Write `catalog.json` here: the catalog the phone (bundled into the app)
    /// and the settings page use.
    pub bundle: PathBuf,
    /// Requests per second to the Rijksmuseum/IIIF/Wikidata (fractional OK).
    pub requests_per_second: f64,
    /// Re-check metadata, pools and Wikidata older than this.
    pub refresh_days: u64,
    /// Fetch at most this many paintings' metadata, and plan at most this
    /// many paintings (for test runs).
    pub limit: Option<usize>,
    /// Only these painting keys (fetch + plan), e.g. for testing.
    pub only: Vec<String>,
    pub skip_fetch: bool,
    pub skip_plan: bool,
    pub search_url: String,
    pub pool_max_pages: usize,
    pub pd_fallback_year: i32,
    pub safe_crop_px: u32,
    /// Longest side of the master image downloaded per painting.
    pub source_size: u32,
    pub user_agent: String,
    /// Email or URL in the User-Agent; Wikimedia requires it for pageviews.
    pub contact: Option<String>,
    /// The Featured list (a release artifact). Built only when missing or when
    /// `refresh_featured` is set; otherwise just read.
    pub featured_path: PathBuf,
    pub refresh_featured: bool,
}

pub async fn run(opts: Options) -> Result<()> {
    let mut catalog = Catalog::open(&opts.data_dir)?;
    let started = Instant::now();

    let mut featured_keys: Vec<String> = featured::load(&opts.featured_path)?
        .map(|f| f.paintings.into_iter().map(|e| e.key).collect())
        .unwrap_or_default();
    if !opts.skip_fetch {
        let throttle = Arc::new(Throttle::per_second(opts.requests_per_second));
        let rijks = Rijks::new(&opts.user_agent, throttle)?;
        refresh_pools(&mut catalog, &rijks, &opts).await?;
        fetch_paintings(&catalog, &rijks, &opts).await?;
        if featured_keys.is_empty() || opts.refresh_featured {
            featured_keys = build_featured(&catalog, &rijks, &opts).await?;
        }
    }
    if !opts.skip_plan {
        plan_all(&mut catalog, &opts)?;
    }
    let (year, _) = popularity::year_month(now_secs());
    let day_order = featured::day_order(&featured_keys, year);
    let n = crate::bundle::write(&catalog, &day_order, &opts.bundle)?;
    tracing::info!(paintings = n, path = %opts.bundle.display(), "wrote catalog.json");
    if let Some(path) = &opts.export {
        let n = catalog.export_jsonl(path)?;
        tracing::info!(paintings = n, path = %path.display(), "exported catalog");
    }
    let stats = catalog.stats()?;
    tracing::info!(?stats, minutes = started.elapsed().as_secs() / 60, "done");
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_stale(catalog: &Catalog, kv_key: &str, opts: &Options) -> Result<bool> {
    let built: u64 = catalog
        .get_kv(kv_key)?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    Ok(now_secs().saturating_sub(built) >= opts.refresh_days * 86_400)
}

// ---------------------------------------------------------------- fetch

/// Build the Featured list: rank eligible paintings by Wikipedia readership
/// (one SPARQL query, then one pageviews request per article, ~20 minutes for
/// the collection) and save it to `featured_path` for git. Only a complete
/// list from a full run is saved, so test runs never overwrite it.
async fn build_featured(catalog: &Catalog, rijks: &Rijks, opts: &Options) -> Result<Vec<String>> {
    let candidates = catalog.featured_candidates()?;
    let articles = match popularity::articles(rijks).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(error = %e, "could not list Wikipedia articles; Featured not rebuilt");
            return Ok(Vec::new());
        }
    };
    let now = now_secs();
    let range = popularity::last_twelve_months(now);
    let mut views: HashMap<String, u64> = HashMap::new();
    let ranking = if opts.contact.is_some() {
        let todo: Vec<(&str, &Vec<String>)> = candidates
            .iter()
            .filter_map(|c| {
                articles
                    .get(&c.object_number)
                    .map(|l| (c.object_number.as_str(), l))
            })
            .collect();
        tracing::info!(
            paintings = todo.len(),
            articles = todo.iter().map(|(_, l)| l.len()).sum::<usize>(),
            "fetching Wikipedia pageviews"
        );
        for (i, (num, list)) in todo.iter().enumerate() {
            let mut total = 0;
            for article in *list {
                match popularity::views(rijks, article, &range).await {
                    Ok(v) => total += v,
                    Err(e) => tracing::warn!(article, error = %e, "pageviews failed; counted as 0"),
                }
            }
            views.insert((*num).to_string(), total);
            if (i + 1) % 50 == 0 || i + 1 == todo.len() {
                tracing::info!(done = i + 1, total = todo.len(), "pageviews progress");
            }
        }
        format!(
            "Wikipedia pageviews, all languages, {} to {} (months)",
            &range.0[..6],
            &range.1[..6]
        )
    } else {
        // Without contact info Wikimedia rejects pageview requests (429).
        tracing::warn!(
            "CONTACT not set: Featured is ranked by number of Wikipedia articles, not pageviews"
        );
        "number of Wikipedia articles, all languages (set CONTACT to rank by pageviews)".to_string()
    };

    let entries = featured::rank(candidates, &articles, &views);
    let keys = entries.iter().map(|e| e.key.clone()).collect();
    let full_run = opts.only.is_empty() && opts.limit.is_none();
    if full_run && entries.len() == featured::SIZE {
        let file = featured::FeaturedFile {
            generated: popularity::ymd(now),
            ranking,
            paintings: entries,
        };
        featured::save(&opts.featured_path, &file)?;
        tracing::info!(path = %opts.featured_path.display(), "saved the Featured list");
    } else {
        tracing::info!(
            paintings = entries.len(),
            "Featured list used for this run only (not a full list)"
        );
    }
    Ok(keys)
}

async fn crawl(rijks: &Rijks, start: &str, max_pages: usize) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    let mut url = Some(start.to_string());
    let mut pages = 0;
    while let Some(u) = url {
        if pages >= max_pages {
            tracing::warn!(start, pages, "stopped at POOL_MAX_PAGES");
            break;
        }
        let page = rijks
            .search_page(&u)
            .await
            .with_context(|| format!("search page {pages} of {start}"))?;
        ids.extend(page.ids);
        url = page.next;
        pages += 1;
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

async fn refresh_pools(catalog: &mut Catalog, rijks: &Rijks, opts: &Options) -> Result<()> {
    if !opts.only.is_empty() || !is_stale(catalog, "pool_built_at", opts)? {
        return Ok(());
    }
    tracing::info!("crawling the painting pool");
    let ids = crawl(rijks, &opts.search_url, opts.pool_max_pages).await?;
    if ids.is_empty() {
        return Err(anyhow!(
            "search returned no paintings; check RIJKS_SEARCH_URL"
        ));
    }
    let mut eras = Vec::new();
    for e in Era::FILTERED {
        let mut era_ids = Vec::new();
        for pattern in e.patterns() {
            era_ids.extend(
                crawl(
                    rijks,
                    &era::with_date(&opts.search_url, pattern),
                    opts.pool_max_pages,
                )
                .await?,
            );
        }
        tracing::info!(era = e.name(), paintings = era_ids.len(), "era pool");
        eras.push((e, era_ids));
    }
    catalog.set_pool(&ids, &eras)?;
    catalog.set_kv("pool_built_at", &now_secs().to_string())?;
    tracing::info!(paintings = ids.len(), "pool updated");
    Ok(())
}

async fn fetch_paintings(catalog: &Catalog, rijks: &Rijks, opts: &Options) -> Result<()> {
    let mut ids = if opts.only.is_empty() {
        catalog.due_for_fetch(now_secs().saturating_sub(opts.refresh_days * 86_400))?
    } else {
        opts.only
            .iter()
            .map(|k| format!("https://id.rijksmuseum.nl/{}", key_of(k)))
            .collect()
    };
    if let Some(n) = opts.limit {
        ids.truncate(n);
    }
    let total = ids.len();
    tracing::info!(paintings = total, "fetching metadata");
    let started = Instant::now();
    let (mut changed, mut images, mut failed) = (0, 0, 0);
    for (i, id) in ids.iter().enumerate() {
        match fetch_one(catalog, rijks, opts, id).await {
            Ok((c, img)) => {
                changed += c as usize;
                images += img as usize;
            }
            Err(e) => {
                failed += 1;
                tracing::warn!(id, error = %e, "could not fetch painting; will retry next run");
            }
        }
        if (i + 1) % 25 == 0 || i + 1 == total {
            let per = started.elapsed().as_secs_f64() / (i + 1) as f64;
            let eta_min = (per * (total - i - 1) as f64 / 60.0).round();
            tracing::info!(
                done = i + 1,
                total,
                changed,
                images,
                failed,
                eta_min,
                "fetch progress"
            );
        }
    }
    Ok(())
}

/// Returns (metadata changed, image downloaded).
async fn fetch_one(
    catalog: &Catalog,
    rijks: &Rijks,
    opts: &Options,
    id: &str,
) -> Result<(bool, bool)> {
    let meta = rijks.resolve(id, opts.pd_fallback_year).await?;
    let changed = catalog.upsert_painting(&meta, now_secs())?;
    if !meta.eligible {
        return Ok((changed, false));
    }
    let Some(base) = &meta.iiif_base else {
        return Ok((changed, false));
    };
    let n = opts.source_size;
    let url = format!("{base}/full/!{n},{n}/0/default.jpg");
    let path = source_path(&opts.data_dir, &meta.key);
    let state = catalog.painting_state(&meta.key)?;
    let have =
        state.as_ref().and_then(|s| s.source_url.as_deref()) == Some(url.as_str()) && path.exists();
    if have {
        return Ok((changed, false));
    }
    let bytes = rijks.download(&url).await?;
    image::load_from_memory(&bytes).context("downloaded image does not decode")?;
    write_atomic(&path, &bytes)?;
    catalog.set_source(&meta.key, &url, &variants::sha256_hex(&bytes))?;
    Ok((changed, true))
}

// ---------------------------------------------------------------- plan

fn source_path(root: &Path, key: &str) -> PathBuf {
    root.join("art").join(key).join("source.jpg")
}

fn load_source(root: &Path, key: &str) -> Result<RgbImage> {
    let bytes =
        std::fs::read(source_path(root, key)).with_context(|| format!("{key}: no source image"))?;
    Ok(image::load_from_memory(&bytes)
        .with_context(|| format!("{key}: bad source image"))?
        .to_rgb8())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn plan_all(catalog: &mut Catalog, opts: &Options) -> Result<()> {
    let mut work = catalog.plannable()?;
    if !opts.only.is_empty() {
        work.retain(|(k, _, _)| opts.only.iter().any(|o| key_of(o) == k));
    }
    if let Some(n) = opts.limit {
        work.truncate(n);
    }
    let targets = variants::cover();
    let names: Vec<String> = targets.iter().map(variants::crop_name).collect();
    let total = work.len();
    tracing::info!(
        paintings = total,
        threads = rayon::current_num_threads(),
        "planning crops"
    );
    let started = Instant::now();
    let (mut planned, mut failed) = (0, 0);

    // Chunks keep memory flat and give regular progress + commits.
    for (n, chunk) in work.chunks(32).enumerate() {
        let existing: Vec<HashMap<String, String>> = chunk
            .iter()
            .map(|(k, _, _)| catalog.plan_hashes(k))
            .collect::<Result<_>>()?;
        let results: Vec<Result<Planned>> = chunk
            .par_iter()
            .zip(existing.par_iter())
            .map(|((key, sha, title), have)| {
                let hints = imaging::CropHints {
                    portrait: imaging::is_portrait_title(title),
                };
                plan_painting(&opts.data_dir, key, sha, hints, have, &targets, opts)
            })
            .collect();
        catalog.transaction(|c| {
            for r in results {
                match r {
                    Ok(r) => {
                        for (name, hash, plan) in &r.plans {
                            c.put_plan(&r.key, name, hash, plan)?;
                        }
                        if let Some((w, h)) = r.size {
                            c.set_size(&r.key, w, h)?;
                        }
                        c.finish_painting(&r.key, &names)?;
                        planned += r.plans.len();
                    }
                    Err(e) => {
                        failed += 1;
                        tracing::warn!(error = %e, "planning failed");
                    }
                }
            }
            Ok(())
        })?;
        let done = ((n + 1) * 32).min(total);
        if (n + 1) % 20 == 0 || done == total {
            let per = started.elapsed().as_secs_f64() / done.max(1) as f64;
            tracing::info!(
                done,
                total,
                planned,
                failed,
                eta_min = (per * (total - done) as f64 / 60.0).round(),
                "plan progress"
            );
        }
    }
    Ok(())
}

/// Folders from older layouts (pre-dithered variants, WebP crops), removed the
/// first time a painting is planned. The rendered PNG crops (`c/`) are left
/// alone; delete them by hand once nothing serves them (see docs/GENERATOR.md).
const OLD_LAYOUT: [&str; 2] = ["v", "crops"];

/// What a worker produced for one painting; written to SQLite by the caller.
struct Planned {
    key: String,
    /// (crop name, input hash, plan) for the plans that were redone.
    plans: Vec<(String, String, CropPlan)>,
    /// The master image size, when it was decoded.
    size: Option<(u32, u32)>,
}

fn plan_painting(
    root: &Path,
    key: &str,
    source_sha: &str,
    hints: imaging::CropHints,
    have: &HashMap<String, String>,
    targets: &[Target],
    opts: &Options,
) -> Result<Planned> {
    let mut out = Planned {
        key: key.to_string(),
        plans: Vec::new(),
        size: None,
    };
    for old in OLD_LAYOUT {
        let dir = root.join("art").join(key).join(old);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
    }
    let mut src: Option<RgbImage> = None; // decoded only if something is outdated
    for t in targets {
        let name = variants::crop_name(t);
        let hash = variants::crop_hash(source_sha, t, opts.safe_crop_px);
        if have.get(&name) == Some(&hash) {
            continue;
        }
        let src = match &src {
            Some(img) => img,
            None => src.insert(load_source(root, key)?),
        };
        out.size = Some(src.dimensions());
        out.plans.push((
            name,
            hash,
            imaging::plan_crop(src, t, opts.safe_crop_px, hints),
        ));
    }
    Ok(out)
}
