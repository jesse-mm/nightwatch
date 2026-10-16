//! The generator: fetch what changed, render what's outdated, export metadata.
//!
//! **Fetch** (network, throttled, resumable)
//! 1. Wikidata link table (one query) and the painting pool + era pools (search
//!    pages), when older than `refresh_days`.
//! 2. Metadata for every pool painting not checked within `refresh_days`. A
//!    master image is downloaded only when the painting has none yet or its
//!    IIIF URL changed (IIIF images are immutable).
//!
//! **Render** (local only, parallel)
//! 3. For each eligible painting with a master image, rebuild only the crops and
//!    variants whose input hash changed: new painting, new image, new frame or
//!    tuning, or a `PIPELINE_VERSION` bump. Never touches the network.
//!
//! **Export**
//! 4. `paintings.jsonl` for git: metadata and hashes, no binaries.
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
    variants, wiki,
};

#[derive(Clone, Debug)]
pub struct Options {
    pub data_dir: PathBuf,
    /// Write `paintings.jsonl` here after the run (for git).
    pub export: Option<PathBuf>,
    /// Requests per second to the Rijksmuseum/IIIF/Wikidata (fractional OK).
    pub requests_per_second: f64,
    /// Re-check metadata, pools and Wikidata older than this.
    pub refresh_days: u64,
    /// Fetch at most this many paintings' metadata, and render at most this
    /// many paintings (for test runs).
    pub limit: Option<usize>,
    /// Only these painting keys (fetch + render), e.g. for testing.
    pub only: Vec<String>,
    pub skip_fetch: bool,
    pub skip_render: bool,
    pub search_url: String,
    pub pool_max_pages: usize,
    pub pd_fallback_year: i32,
    pub safe_crop_px: u32,
    /// Longest side of the master image downloaded per painting.
    pub source_size: u32,
    pub user_agent: String,
    /// Email or URL in the User-Agent; Wikimedia requires it for pageviews.
    pub contact: Option<String>,
    /// The Featured list (in git). Built only when missing or when
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
        refresh_wiki(&mut catalog, &rijks, &opts).await?;
        refresh_pools(&mut catalog, &rijks, &opts).await?;
        fetch_paintings(&catalog, &rijks, &opts).await?;
        if featured_keys.is_empty() || opts.refresh_featured {
            featured_keys = build_featured(&catalog, &rijks, &opts).await?;
        }
    }
    let (year, _) = popularity::year_month(now_secs());
    let day_order = featured::day_order(&featured_keys, year);
    catalog.publish(&day_order)?;
    if !opts.skip_render {
        render_all(&mut catalog, &opts, &day_order)?;
    }
    catalog.publish(&day_order)?;
    tracing::info!("published serve.sqlite for the server");
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

async fn refresh_wiki(catalog: &mut Catalog, rijks: &Rijks, opts: &Options) -> Result<()> {
    if !is_stale(catalog, "wiki_built_at", opts)? {
        return Ok(());
    }
    match wiki::fetch(rijks).await {
        Ok(links) if !links.is_empty() => {
            catalog.set_wiki(&links)?;
            catalog.set_kv("wiki_built_at", &now_secs().to_string())?;
            tracing::info!(paintings = links.len(), "wikidata links updated");
        }
        Ok(_) => tracing::warn!("wikidata returned nothing; keeping old links"),
        Err(e) => tracing::warn!(error = %e, "wikidata failed; keeping old links"),
    }
    Ok(())
}

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

// ---------------------------------------------------------------- render

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

/// What a worker produced for one painting; written to SQLite by the caller.
struct Rendered {
    key: String,
    crops: Vec<(String, String, CropPlan, String, usize)>,
}

fn render_all(catalog: &mut Catalog, opts: &Options, featured_days: &[String]) -> Result<()> {
    let mut work = catalog.renderable()?;
    if !opts.only.is_empty() {
        work.retain(|(k, _)| opts.only.iter().any(|o| key_of(o) == k));
    }
    if let Some(n) = opts.limit {
        work.truncate(n);
    }
    let targets = variants::all();
    let names: Vec<String> = targets.iter().map(variants::crop_name).collect();
    let total = work.len();
    tracing::info!(
        paintings = total,
        threads = rayon::current_num_threads(),
        "rendering"
    );
    let started = Instant::now();
    let (mut crops_done, mut failed) = (0, 0);

    // Chunks keep memory flat and give regular progress + commits.
    for (n, chunk) in work.chunks(16).enumerate() {
        let existing: Vec<HashMap<String, String>> = chunk
            .iter()
            .map(|(k, _)| catalog.crop_hashes(k))
            .collect::<Result<_>>()?;
        let results: Vec<Result<Rendered>> = chunk
            .par_iter()
            .zip(existing.par_iter())
            .map(|((key, sha), have)| {
                render_painting(&opts.data_dir, key, sha, have, &targets, opts)
            })
            .collect();
        catalog.transaction(|c| {
            for r in results {
                match r {
                    Ok(r) => {
                        for (name, hash, plan, path, bytes) in &r.crops {
                            c.put_crop(&r.key, name, hash, plan, path, *bytes)?;
                        }
                        c.finish_painting(&r.key, &names)?;
                        crops_done += r.crops.len();
                    }
                    Err(e) => {
                        failed += 1;
                        tracing::warn!(error = %e, "render failed");
                    }
                }
            }
            Ok(())
        })?;
        // Let the server offer finished paintings during long runs.
        if (n + 1) % 50 == 0 {
            catalog.publish(featured_days)?;
        }
        let done = ((n + 1) * 16).min(total);
        let per = started.elapsed().as_secs_f64() / done.max(1) as f64;
        tracing::info!(
            done,
            total,
            crops_done,
            failed,
            eta_min = (per * (total - done) as f64 / 60.0).round(),
            "render progress"
        );
    }
    Ok(())
}

/// Folders from the old layout (pre-dithered variants and WebP crops), removed
/// the first time a painting is rendered with the current one.
const OLD_LAYOUT: [&str; 2] = ["v", "crops"];

fn render_painting(
    root: &Path,
    key: &str,
    source_sha: &str,
    have: &HashMap<String, String>,
    targets: &[Target],
    opts: &Options,
) -> Result<Rendered> {
    let mut out = Rendered {
        key: key.to_string(),
        crops: Vec::new(),
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
        let rel = format!("art/{key}/c/{name}.png");
        if have.get(&name) == Some(&hash) && root.join(&rel).exists() {
            continue;
        }
        let src = match &src {
            Some(img) => img,
            None => src.insert(load_source(root, key)?),
        };
        // Always from the master image, never from a stored crop.
        let plan = imaging::plan_crop(src, t, opts.safe_crop_px);
        let art = imaging::tone_image(&imaging::crop_locally(src, &plan));
        let png = encode_png(&art)?;
        write_atomic(&root.join(&rel), &png)?;
        out.crops.push((name, hash, plan, rel, png.len()));
    }
    Ok(out)
}

/// Lossless PNG with the strongest compression (crops are written once).
fn encode_png(img: &RgbImage) -> Result<Vec<u8>> {
    use image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        ImageEncoder,
    };
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Best, FilterType::Adaptive)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )?;
    Ok(out)
}
