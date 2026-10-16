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
    catalog::{key_of, Catalog, Table},
    era::{self, Era},
    imaging::{self, CropPlan},
    png8, popularity,
    rijks::Rijks,
    throttle::Throttle,
    variants::{self, CropSet},
    wiki,
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
    pub webp_quality: f32,
    pub user_agent: String,
    /// Email or URL in the User-Agent; Wikimedia requires it for pageviews.
    pub contact: Option<String>,
}

pub async fn run(opts: Options) -> Result<()> {
    let mut catalog = Catalog::open(&opts.data_dir)?;
    let started = Instant::now();

    if !opts.skip_fetch {
        let throttle = Arc::new(Throttle::per_second(opts.requests_per_second));
        let rijks = Rijks::new(&opts.user_agent, throttle)?;
        refresh_wiki(&mut catalog, &rijks, &opts).await?;
        refresh_pools(&mut catalog, &rijks, &opts).await?;
        fetch_paintings(&catalog, &rijks, &opts).await?;
        refresh_popularity(&catalog, &rijks, &opts).await?;
        catalog.publish()?;
    }
    if !opts.skip_render {
        render_all(&mut catalog, &opts)?;
    }
    catalog.publish()?;
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

/// Wikipedia readership for eligible paintings, for the Featured year: one
/// SPARQL query for the article list, then one pageviews request per article
/// (~1,200 for the whole collection, ~20 minutes at 1 request/s).
async fn refresh_popularity(catalog: &Catalog, rijks: &Rijks, opts: &Options) -> Result<()> {
    let now = now_secs();
    let due = catalog.popularity_due(now.saturating_sub(opts.refresh_days * 86_400))?;
    if due.is_empty() {
        return Ok(());
    }
    let articles = match popularity::articles(rijks).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(error = %e, "could not list Wikipedia articles; popularity unchanged");
            return Ok(());
        }
    };
    let todo: Vec<(&String, &Vec<String>)> = due
        .iter()
        .filter_map(|num| articles.get(num).map(|list| (num, list)))
        .collect();
    // Without contact info Wikimedia rejects pageview requests (429), so rank by
    // the number of Wikipedia articles instead, and check again next run.
    if opts.contact.is_none() {
        tracing::warn!(
            "CONTACT not set: Featured is ranked by number of Wikipedia articles, not pageviews"
        );
        for (num, list) in &todo {
            catalog.set_popularity(num, list.len(), 0, 0)?;
        }
        return Ok(());
    }
    let range = popularity::last_twelve_months(now);
    tracing::info!(
        paintings = todo.len(),
        articles = todo.iter().map(|(_, l)| l.len()).sum::<usize>(),
        "fetching Wikipedia pageviews"
    );
    for (i, (num, list)) in todo.iter().enumerate() {
        let mut views = 0;
        for article in *list {
            match popularity::views(rijks, article, &range).await {
                Ok(v) => views += v,
                Err(e) => tracing::warn!(article, error = %e, "pageviews failed; counted as 0"),
            }
        }
        catalog.set_popularity(num, list.len(), views, now)?;
        if (i + 1) % 50 == 0 || i + 1 == todo.len() {
            tracing::info!(done = i + 1, total = todo.len(), "pageviews progress");
        }
    }
    Ok(())
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
    variants: Vec<(String, String, String, String, usize)>,
}

fn render_all(catalog: &mut Catalog, opts: &Options) -> Result<()> {
    let mut work = catalog.renderable()?;
    if !opts.only.is_empty() {
        work.retain(|(k, _)| opts.only.iter().any(|o| key_of(o) == k));
    }
    if let Some(n) = opts.limit {
        work.truncate(n);
    }
    let matrix = variants::all();
    let variant_count: usize = matrix.iter().map(|c| c.variants.len()).sum();
    let total = work.len();
    tracing::info!(
        paintings = total,
        threads = rayon::current_num_threads(),
        "rendering"
    );
    let started = Instant::now();
    let (mut crops_done, mut variants_done, mut failed) = (0, 0, 0);

    // Chunks keep memory flat and give regular progress + commits.
    for (n, chunk) in work.chunks(16).enumerate() {
        let existing: Vec<(HashMap<String, String>, HashMap<String, String>)> = chunk
            .iter()
            .map(|(k, _)| {
                Ok((
                    catalog.hashes(Table::Crops, k)?,
                    catalog.hashes(Table::Variants, k)?,
                ))
            })
            .collect::<Result<_>>()?;
        let results: Vec<Result<Rendered>> = chunk
            .par_iter()
            .zip(existing.par_iter())
            .map(|((key, sha), (have_crops, have_variants))| {
                render_painting(
                    &opts.data_dir,
                    key,
                    sha,
                    have_crops,
                    have_variants,
                    &matrix,
                    opts,
                )
            })
            .collect();
        catalog.transaction(|c| {
            for r in results {
                match r {
                    Ok(r) => {
                        for (name, hash, plan, path, bytes) in &r.crops {
                            c.put_crop(&r.key, name, hash, plan, path, *bytes)?;
                        }
                        for (name, crop, hash, path, bytes) in &r.variants {
                            c.put_variant(&r.key, name, crop, hash, path, *bytes)?;
                        }
                        c.finish_painting(&r.key, variant_count)?;
                        crops_done += r.crops.len();
                        variants_done += r.variants.len();
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
            catalog.publish()?;
        }
        let done = ((n + 1) * 16).min(total);
        let per = started.elapsed().as_secs_f64() / done.max(1) as f64;
        tracing::info!(
            done,
            total,
            crops_done,
            variants_done,
            failed,
            eta_min = (per * (total - done) as f64 / 60.0).round(),
            "render progress"
        );
    }
    Ok(())
}

fn render_painting(
    root: &Path,
    key: &str,
    source_sha: &str,
    have_crops: &HashMap<String, String>,
    have_variants: &HashMap<String, String>,
    matrix: &[CropSet],
    opts: &Options,
) -> Result<Rendered> {
    let mut out = Rendered {
        key: key.to_string(),
        crops: Vec::new(),
        variants: Vec::new(),
    };
    let dir = root.join("art").join(key);
    let mut src: Option<RgbImage> = None; // decoded only if something is outdated

    for set in matrix {
        let crop_name = variants::crop_name(&set.crop);
        let crop_hash = variants::crop_hash(source_sha, &set.crop, opts.safe_crop_px);
        let crop_rel = format!("art/{key}/crops/{crop_name}.webp");
        let crop_ok =
            have_crops.get(&crop_name) == Some(&crop_hash) && root.join(&crop_rel).exists();

        let todo: Vec<_> = set
            .variants
            .iter()
            .filter(|t| {
                let name = variants::variant_name(t);
                let rel = format!("art/{key}/v/{name}.png");
                have_variants.get(&name) != Some(&variants::variant_hash(&crop_hash, t))
                    || !root.join(rel).exists()
            })
            .collect();
        if crop_ok && todo.is_empty() {
            continue;
        }

        let src = match &src {
            Some(img) => img,
            None => src.insert(load_source(root, key)?),
        };
        // Always crop from the master image, never from a stored (lossy) crop.
        let plan = imaging::plan_crop(src, &set.crop.opening(), opts.safe_crop_px);
        let art = imaging::crop_locally(src, &plan);

        if !crop_ok {
            let webp = webp::Encoder::from_rgb(art.as_raw(), art.width(), art.height())
                .encode(opts.webp_quality);
            write_atomic(&root.join(&crop_rel), &webp)?;
            out.crops.push((
                crop_name.clone(),
                crop_hash.clone(),
                plan,
                crop_rel,
                webp.len(),
            ));
        }
        for t in todo {
            let name = variants::variant_name(t);
            let rendered = imaging::render(&art, t);
            let png = png8::encode(&rendered.raw, t.w, t.h, t.stride)?;
            let rel = format!("art/{key}/v/{name}.png");
            write_atomic(&dir.join("v").join(format!("{name}.png")), &png)?;
            out.variants.push((
                name,
                crop_name.clone(),
                variants::variant_hash(&crop_hash, t),
                rel,
                png.len(),
            ));
        }
    }
    Ok(out)
}
