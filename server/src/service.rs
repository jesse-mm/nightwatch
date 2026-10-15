//! The app's core logic, independent of HTTP.
//!
//! TS analogy: `AppState` is a singleton service object shared by all request
//! handlers. `Arc` = shared reference-counted pointer; `RwLock` = many readers or
//! one writer at a time (needed because the pool is filled in the background
//! while requests read it).

use std::{collections::HashMap, io::Cursor, sync::Arc, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use image::{ImageFormat, RgbImage};
use rand::seq::IndexedRandom;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, Semaphore};

use crate::{
    config::Config,
    era::{self, Era},
    imaging::{self, CropPlan, Target},
    rijks::{ArtMeta, Rijks},
    store::{now_secs, sanitize, Pool, Store},
    wiki::{self, WikiLinks, WikiTable},
};

pub struct AppState {
    pub cfg: Config,
    pub rijks: Rijks,
    pub store: Store,
    pub pool: RwLock<Pool>,
    /// Smaller pools per century, built on first use (or warmed at startup).
    era_pools: RwLock<HashMap<Era, Pool>>,
    /// One era crawl at a time, so simultaneous first requests don't duplicate it.
    era_crawl: Mutex<()>,
    wiki: RwLock<WikiTable>,
    /// Limits simultaneous downloads/renders so a burst of requests can't
    /// overload a small home server.
    render_slots: Semaphore,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderInfo {
    pub crop: CropPlan,
    /// "iiif" when the museum's server cropped/resized for us, "local" otherwise.
    pub source: String,
    pub raw_len: usize,
}

impl AppState {
    pub fn new(cfg: Config) -> Result<Arc<Self>> {
        let rijks = Rijks::new(&cfg.user_agent)?;
        let store = Store::new(&cfg.data_dir);
        Ok(Arc::new(Self {
            cfg,
            rijks,
            store,
            pool: RwLock::new(Pool::default()),
            era_pools: RwLock::new(HashMap::new()),
            era_crawl: Mutex::new(()),
            wiki: RwLock::new(WikiTable::default()),
            render_slots: Semaphore::new(4),
        }))
    }

    // ---------------- pool ----------------

    /// Load the pool from disk, and (re)crawl it if missing, partial or stale.
    pub async fn ensure_pool(self: &Arc<Self>) -> Result<()> {
        if let Some(saved) = self.store.read_json::<Pool>(&self.store.pool_path()).await {
            let age_days = now_secs().saturating_sub(saved.built_at) / 86_400;
            let fresh = saved.complete && age_days < self.cfg.pool_refresh_days;
            tracing::info!(paintings = saved.ids.len(), age_days, fresh, "loaded pool from disk");
            *self.pool.write().await = saved;
            if fresh {
                return Ok(());
            }
        }
        self.crawl_pool().await
    }

    async fn crawl_pool(self: &Arc<Self>) -> Result<()> {
        tracing::info!(url = %self.cfg.search_url, "building painting pool");
        let mut ids: Vec<String> = Vec::new();
        let mut url = Some(self.cfg.search_url.clone());
        let mut pages = 0;
        while let Some(u) = url {
            if pages >= self.cfg.pool_max_pages {
                break;
            }
            let page = self.rijks.search_page(&u).await.with_context(|| format!("search page {pages}"))?;
            ids.extend(page.ids);
            url = page.next;
            pages += 1;
            // Let early requests use what we have so far.
            {
                let mut pool = self.pool.write().await;
                if !pool.complete || pool.ids.len() < ids.len() {
                    pool.ids = ids.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await; // be polite
        }
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            bail!("search returned no paintings — check RIJKS_SEARCH_URL");
        }
        let pool = Pool { built_at: now_secs(), ids, complete: true };
        self.store.write_json(&self.store.pool_path(), &pool).await?;
        tracing::info!(paintings = pool.ids.len(), pages, "pool ready");
        *self.pool.write().await = pool;
        Ok(())
    }

    async fn random_id(&self) -> Option<String> {
        let pool = self.pool.read().await;
        pool.ids.choose(&mut rand::rng()).cloned()
    }

    fn is_fresh(&self, pool: &Pool) -> bool {
        let age_days = now_secs().saturating_sub(pool.built_at) / 86_400;
        pool.complete && age_days < self.cfg.pool_refresh_days
    }

    /// Follow a search's `next` links and collect the object ids.
    async fn crawl_search(&self, start: &str) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        let mut url = Some(start.to_string());
        let mut pages = 0;
        while let Some(u) = url {
            if pages >= self.cfg.pool_max_pages {
                break;
            }
            let page = self.rijks.search_page(&u).await.with_context(|| format!("search page {pages} of {start}"))?;
            ids.extend(page.ids);
            url = page.next;
            pages += 1;
            tokio::time::sleep(Duration::from_millis(150)).await; // be polite
        }
        Ok(ids)
    }

    /// Painting ids for one era: from memory, from disk, or crawled now.
    async fn era_ids(&self, era: Era) -> Result<Vec<String>> {
        if let Some(p) = self.era_pools.read().await.get(&era).filter(|p| self.is_fresh(p)) {
            return Ok(p.ids.clone());
        }
        let _crawling = self.era_crawl.lock().await;
        // Someone else may have built it while we waited for the lock.
        if let Some(p) = self.era_pools.read().await.get(&era).filter(|p| self.is_fresh(p)) {
            return Ok(p.ids.clone());
        }
        let path = self.store.era_pool_path(era.name());
        let pool = match self.store.read_json::<Pool>(&path).await.filter(|p| self.is_fresh(p)) {
            Some(saved) => saved,
            None => {
                let mut ids = Vec::new();
                for pattern in era.patterns() {
                    ids.extend(self.crawl_search(&era::with_date(&self.cfg.search_url, pattern)).await?);
                }
                ids.sort();
                ids.dedup();
                let pool = Pool { built_at: now_secs(), ids, complete: true };
                self.store.write_json(&path, &pool).await?;
                tracing::info!(era = era.name(), paintings = pool.ids.len(), "era pool ready");
                pool
            }
        };
        let ids = pool.ids.clone();
        self.era_pools.write().await.insert(era, pool);
        Ok(ids)
    }

    // ---------------- wikidata ----------------

    /// Load the Wikidata link table from disk; refetch it when missing or stale.
    /// A failed refresh keeps the old table.
    pub async fn ensure_wiki(&self) {
        let path = self.store.wiki_path();
        if self.wiki.read().await.links.is_empty() {
            if let Some(saved) = self.store.read_json::<WikiTable>(&path).await {
                *self.wiki.write().await = saved;
            }
        }
        let age_days = now_secs().saturating_sub(self.wiki.read().await.built_at) / 86_400;
        if !self.wiki.read().await.links.is_empty() && age_days < self.cfg.pool_refresh_days {
            return;
        }
        match wiki::fetch(self.rijks.http()).await {
            Ok(links) if !links.is_empty() => {
                let table = WikiTable { built_at: now_secs(), links };
                let articles = table.links.values().filter(|l| l.wikipedia_en.is_some() || l.wikipedia_nl.is_some()).count();
                tracing::info!(paintings = table.links.len(), articles, "wikidata links ready");
                if let Err(e) = self.store.write_json(&path, &table).await {
                    tracing::warn!(error = %e, "could not save wikidata links");
                }
                *self.wiki.write().await = table;
            }
            Ok(_) => tracing::warn!("wikidata returned no links; keeping the old table"),
            Err(e) => tracing::warn!(error = %e, "could not fetch wikidata links"),
        }
    }

    pub async fn wiki_links(&self, object_number: Option<&str>) -> Option<WikiLinks> {
        self.wiki.read().await.links.get(object_number?).cloned()
    }

    pub async fn warm_eras(&self) {
        for era in Era::FILTERED {
            if let Err(e) = self.era_ids(era).await {
                tracing::warn!(era = era.name(), error = %e, "could not build era pool");
            }
        }
    }

    // ---------------- metadata ----------------

    pub async fn meta_by_id(&self, id: &str) -> Result<ArtMeta> {
        let key = sanitize(id.rsplit('/').next().unwrap_or(id));
        let path = self.store.meta_path(&key);
        if let Some(m) = self.store.read_json::<ArtMeta>(&path).await {
            return Ok(m);
        }
        let meta = self.rijks.resolve(id, self.cfg.pd_fallback_year).await?;
        self.store.write_json(&path, &meta).await?;
        if !meta.eligible {
            tracing::info!(key, reason = ?meta.reason, "skipping painting");
        }
        Ok(meta)
    }

    pub async fn meta_by_key(&self, key: &str) -> Result<ArtMeta> {
        self.meta_by_id(&format!("https://id.rijksmuseum.nl/{}", sanitize(key))).await
    }

    /// Pick a random painting that we're allowed to show and that has an image,
    /// optionally from one era.
    pub async fn pick_random(&self, era: Era) -> Result<ArtMeta> {
        let era_ids = if era == Era::Any {
            // On a fresh install the pool may still be filling; wait briefly.
            for _ in 0..20 {
                if !self.pool.read().await.ids.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            None
        } else {
            Some(self.era_ids(era).await?)
        };
        for _ in 0..15 {
            let id = match &era_ids {
                Some(ids) => ids.choose(&mut rand::rng()).cloned(),
                None => self.random_id().await,
            };
            let Some(id) = id else { bail!("no paintings in the {} pool", era.name()) };
            match self.meta_by_id(&id).await {
                Ok(m) if m.eligible => return Ok(m),
                Ok(_) => continue,
                Err(e) => tracing::warn!(id, error = %e, "could not resolve painting"),
            }
        }
        Err(anyhow!("no eligible painting found after 15 tries"))
    }

    // ---------------- images ----------------


    async fn fetch_image(&self, url: &str) -> Result<RgbImage> {
        let resp = self.rijks.http().get(url).send().await?.error_for_status()?;
        let bytes = resp.bytes().await?;
        decode(bytes.to_vec()).await
    }

    /// Analysis image, cached on disk.
    async fn source(&self, meta: &ArtMeta) -> Result<RgbImage> {
        let path = self.store.source_path(&meta.key);
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if let Ok(img) = decode(bytes).await {
                return Ok(img);
            }
        }
        let base = meta.iiif_base.as_ref().ok_or_else(|| anyhow!("painting has no image"))?;
        let n = self.cfg.source_size;
        let url = format!("{base}/full/!{n},{n}/0/default.jpg");
        let bytes = self.rijks.http().get(&url).send().await?.error_for_status()?.bytes().await?;
        self.store.write_bytes(&path, &bytes).await?;
        decode(bytes.to_vec()).await
    }

    /// Produce (or reuse) the watch-ready render for this painting and screen.
    pub async fn render(&self, meta: &ArtMeta, t: &Target) -> Result<RenderInfo> {
        let name = t.cache_name();
        let info_path = self.store.render_path(&meta.key, &name, "json");
        let raw_path = self.store.render_path(&meta.key, &name, "raw");
        if let (Some(info), true) =
            (self.store.read_json::<RenderInfo>(&info_path).await, raw_path.exists())
        {
            return Ok(info);
        }

        let _slot = self.render_slots.acquire().await?;
        let src = self.source(meta).await?;
        let plan = imaging::plan_crop(&src, &t.opening(), self.cfg.safe_crop_px);

        // Preferred: ask the IIIF server for exactly the region and size we need.
        let base = meta.iiif_base.as_ref().ok_or_else(|| anyhow!("painting has no image"))?;
        let iiif_url = format!("{base}/{}", imaging::iiif_path(&plan));
        let (art, source) = match self.fetch_image(&iiif_url).await {
            Ok(img) => (imaging::exact_size(img, &plan), "iiif"),
            Err(e) => {
                tracing::warn!(url = iiif_url, error = %e, "IIIF crop failed, cropping locally");
                (imaging::crop_locally(&src, &plan), "local")
            }
        };

        let t2 = *t;
        // Dithering is CPU-bound; keep it off the async worker threads.
        let rendered = tokio::task::block_in_place(|| imaging::render(&art, &t2));

        let mut png = Vec::new();
        rendered.preview.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)?;
        let info = RenderInfo { crop: plan, source: source.into(), raw_len: rendered.raw.len() };

        self.store.write_bytes(&raw_path, &rendered.raw).await?;
        self.store.write_bytes(&self.store.render_path(&meta.key, &name, "png"), &png).await?;
        self.store.write_json(&info_path, &info).await?;
        tracing::info!(key = meta.key, target = name, crop = ?plan.mode, source, "rendered");
        Ok(info)
    }

    pub async fn read_render(&self, key: &str, t: &Target, ext: &str) -> Result<Vec<u8>> {
        let path = self.store.render_path(&sanitize(key), &t.cache_name(), ext);
        if !path.exists() {
            let meta = self.meta_by_key(key).await?;
            if !meta.eligible {
                bail!("painting is not available");
            }
            self.render(&meta, t).await?;
        }
        Ok(tokio::fs::read(&path).await?)
    }
}

async fn decode(bytes: Vec<u8>) -> Result<RgbImage> {
    tokio::task::spawn_blocking(move || {
        let img = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?.decode()?;
        Ok::<_, anyhow::Error>(img.to_rgb8())
    })
    .await?
}
