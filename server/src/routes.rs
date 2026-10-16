//! HTTP layer (axum). TS analogy: an Express router where each handler receives
//! already-parsed query params (`Query<T>`) and shared state (`State<T>`).
//!
//! Everything is answered from the in-memory snapshot and the generator's files:
//!
//! GET /healthz                                          → catalog counts
//! GET /api/art/random?w&h&color&stride&round&fit&palette&frame[&era] → random painting, JSON
//!     era: any | pre1600 | 1600s | 1700s | 1800s | 1900s
//! GET /api/art/featured?day=N&…same…                     → the Featured painting for day N (0-based)
//! GET /api/art/resolve?q=SK-C-5                          → { key } for an object number, key or link
//! GET /api/art/{key}?…same…                             → one painting, JSON
//! GET /api/art/{key}/raw?…same…[&format=b64]            → watch bitmap bytes
//! GET /api/art/{key}/preview.png?…same…                 → the stored indexed PNG
//! GET /api/art/{key}/crop.webp?…same…                   → full-colour crop before dithering
//! GET /config/                                          → settings page (static files)

use std::sync::{Arc, PoisonError, RwLock};

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use treasure_trove::{
    era::Era,
    frame::Frame,
    imaging::{CropPlan, Fit, Target},
    palette::Reference,
    png8,
    rijks::ArtMeta,
    snapshot::Snapshot,
    variants,
    wiki::WikiLinks,
};

use crate::config::Config;

pub struct AppState {
    pub cfg: Config,
    /// Swapped wholesale when the generator publishes a new snapshot; requests
    /// take a cheap `Arc` clone and never hold the lock while working.
    pub snapshot: RwLock<Arc<Snapshot>>,
}

impl AppState {
    /// The current snapshot. A poisoned lock (a panic while swapping) still
    /// holds a complete `Arc`, so we keep serving it.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        Arc::clone(&self.snapshot.read().unwrap_or_else(PoisonError::into_inner))
    }

    pub fn replace(&self, fresh: Snapshot) {
        *self
            .snapshot
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Arc::new(fresh);
    }
}

type Shared = Arc<AppState>;

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/", get(|| async { Redirect::temporary("/config/") }))
        .route("/healthz", get(health))
        .route("/api/art/random", get(random))
        .route("/api/art/featured", get(featured))
        .route("/api/art/resolve", get(resolve))
        .route("/api/art/{key}", get(by_key))
        .route("/api/art/{key}/raw", get(raw))
        .route("/api/art/{key}/preview.png", get(preview))
        .route("/api/art/{key}/crop.webp", get(crop))
        .with_state(state)
}

// ---------- errors ----------

pub struct AppError(StatusCode, String);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "request failed");
        AppError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

fn bad_request(msg: impl Into<String>) -> AppError {
    AppError(StatusCode::BAD_REQUEST, msg.into())
}

fn not_generated() -> AppError {
    AppError(
        StatusCode::NOT_FOUND,
        "this painting or variant has not been generated".into(),
    )
}

// ---------- query parsing ----------

#[derive(Deserialize)]
pub struct TargetQuery {
    w: u32,
    h: u32,
    color: Option<u8>,
    stride: Option<u32>,
    round: Option<u8>,
    fit: Option<Fit>,
    palette: Option<String>,
    frame: Option<Frame>,
    format: Option<String>,
}

impl TargetQuery {
    /// The generated variant to look up. Variants are stored with stride = w;
    /// `stride()` gives the row stride to unpack the bytes to.
    fn target(&self, default_ref: Reference) -> Result<Target, AppError> {
        if self.color.unwrap_or(1) != 1 {
            return Err(bad_request("only colour watches are supported"));
        }
        let t = Target {
            w: self.w,
            h: self.h,
            color: true,
            stride: self.w,
            round: self.round.unwrap_or(0) == 1,
            fit: self.fit.unwrap_or(Fit::Fill),
            reference: match &self.palette {
                Some(p) => p.parse().map_err(bad_request)?,
                None => default_ref,
            },
            frame: self.frame.unwrap_or_default(),
        };
        if !variants::SCREENS.contains(&(t.w, t.h, t.round)) {
            return Err(bad_request(format!("unsupported screen {}x{}", t.w, t.h)));
        }
        Ok(t)
    }

    fn stride(&self) -> Result<u32, AppError> {
        let s = self.stride.unwrap_or(self.w);
        if s < self.w || s > 1024 {
            return Err(bad_request(format!(
                "stride must be between {} and 1024",
                self.w
            )));
        }
        Ok(s)
    }
}

fn query_string(t: &Target, stride: u32) -> String {
    format!(
        "w={}&h={}&color=1&stride={stride}&round={}&fit={}&palette={}&frame={}",
        t.w,
        t.h,
        t.round as u8,
        t.fit.name(),
        t.reference.name(),
        t.frame.name()
    )
}

#[derive(Deserialize)]
pub struct EraQuery {
    era: Option<Era>,
}

// ---------- handlers ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderInfo {
    crop: CropPlan,
    raw_len: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtResponse<'a> {
    #[serde(flatten)]
    meta: &'a ArtMeta,
    render: RenderInfo,
    /// Wikidata item and Wikipedia articles, when Wikidata knows the painting.
    #[serde(skip_serializing_if = "Option::is_none")]
    wiki: Option<&'a WikiLinks>,
    raw_url: String,
    preview_url: String,
    crop_url: String,
    attribution: &'static str,
}

const ATTRIBUTION: &str =
    "Artwork data and images: Rijksmuseum, Amsterdam, via the Rijksmuseum data services (https://data.rijksmuseum.nl/about/). Treasure Trove is not affiliated with the Rijksmuseum.";

fn respond(snap: &Snapshot, key: &str, t: &Target, stride: u32) -> Result<Response, AppError> {
    let s = snap.served(key, t).ok_or_else(not_generated)?;
    let qs = query_string(t, stride);
    let key = &s.painting.meta.key;
    let body = ArtResponse {
        raw_url: format!("/api/art/{key}/raw?{qs}"),
        preview_url: format!("/api/art/{key}/preview.png?{qs}"),
        crop_url: format!("/api/art/{key}/crop.webp?{qs}"),
        render: RenderInfo {
            crop: *s.plan,
            raw_len: (stride * t.h) as usize,
        },
        wiki: s.painting.wiki.as_ref(),
        meta: &s.painting.meta,
        attribution: ATTRIBUTION,
    };
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

async fn health(State(state): State<Shared>) -> Response {
    let snap = state.snapshot();
    Json(json!({
        "ok": true,
        "paintings": snap.ready(),
        "eligible": snap.eligible,
        "pool": snap.pool,
        "featured": snap.featured_len(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct FeaturedQuery {
    day: usize,
}

async fn featured(
    State(state): State<Shared>,
    Query(q): Query<TargetQuery>,
    Query(f): Query<FeaturedQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let stride = q.stride()?;
    let snap = state.snapshot();
    let key = snap.featured(f.day).ok_or_else(|| {
        AppError(
            StatusCode::NOT_FOUND,
            "no featured paintings generated yet".into(),
        )
    })?;
    respond(&snap, key, &t, stride)
}

#[derive(Deserialize)]
pub struct ResolveQuery {
    q: String,
}

/// Look up a painting from an object number, key or link, for pinning.
async fn resolve(
    State(state): State<Shared>,
    Query(r): Query<ResolveQuery>,
) -> Result<Response, AppError> {
    let snap = state.snapshot();
    let key = snap.resolve(&r.q).ok_or_else(|| {
        AppError(
            StatusCode::NOT_FOUND,
            format!(
                "\"{}\" isn't one of the public-domain paintings available here",
                r.q.trim()
            ),
        )
    })?;
    Ok(Json(json!({ "key": key })).into_response())
}

async fn random(
    State(state): State<Shared>,
    Query(q): Query<TargetQuery>,
    Query(e): Query<EraQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let stride = q.stride()?;
    let era = e.era.unwrap_or_default();
    let snap = state.snapshot();
    let key = snap.random(era).ok_or_else(|| {
        let msg = match era {
            Era::Any => "no paintings generated yet".to_string(),
            e => format!("no paintings from the {} generated yet", e.name()),
        };
        AppError(StatusCode::NOT_FOUND, msg)
    })?;
    respond(&snap, key, &t, stride)
}

async fn by_key(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let stride = q.stride()?;
    respond(&state.snapshot(), &key, &t, stride)
}

/// Path of a variant (or its crop) for this request, if generated.
fn file_path(
    state: &AppState,
    key: &str,
    t: &Target,
    crop: bool,
) -> Result<std::path::PathBuf, AppError> {
    let snap = state.snapshot();
    let s = snap.served(key, t).ok_or_else(not_generated)?;
    Ok(if crop { s.crop_path } else { s.variant_path })
}

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

async fn read_file(path: std::path::PathBuf) -> Result<Vec<u8>, AppError> {
    tokio::fs::read(&path).await.map_err(|e| {
        tracing::warn!(path = %path.display(), error = %e, "file in catalog is missing");
        not_generated()
    })
}

async fn raw(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let stride = q.stride()?;
    let png = read_file(file_path(&state, &key, &t, false)?).await?;
    let (_, _, bytes) = png8::decode_to_raw(&png, stride)?;
    if q.format.as_deref() == Some("b64") {
        // PebbleKit JS can't always read binary XHR responses; text is universal.
        let text = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok((
            [
                (header::CONTENT_TYPE, "text/plain"),
                (header::CACHE_CONTROL, IMMUTABLE),
            ],
            text,
        )
            .into_response());
    }
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, IMMUTABLE),
        ],
        bytes,
    )
        .into_response())
}

async fn preview(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let png = read_file(file_path(&state, &key, &t, false)?).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, IMMUTABLE),
        ],
        png,
    )
        .into_response())
}

async fn crop(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let webp = read_file(file_path(&state, &key, &t, true)?).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, IMMUTABLE),
        ],
        webp,
    )
        .into_response())
}
