//! HTTP layer (axum). TS analogy: an Express router where each handler receives
//! already-parsed query params (`Query<T>`) and shared state (`State<T>`).
//!
//! Everything is answered from the in-memory snapshot and the generator's files.
//! The server hands out full-color crops; the phone and the settings page apply
//! the color tuning and frame themselves (`static/config/render.js`).
//!
//! `<screen>` = `w, h, round (0/1), fit (fill/whole)`
//!
//! GET /healthz                                  → catalog counts
//! GET /api/art/random?<screen>[&era=…]          → random painting, JSON
//!     era: any | pre1600 | 1600s | 1700s | 1800s | 1900s
//! GET /api/art/featured?day=N&<screen>          → the Featured painting for day N (0-based)
//! GET /api/art/resolve?q=SK-C-5                 → { key } for an object number, key or link
//! GET /api/art/{key}?<screen>                   → one painting, JSON
//! GET /api/art/{key}/crop.png?<screen>          → the crop: toned full-color PNG
//! GET /api/art/{key}/rgb?<screen>[&format=b64]  → the same pixels as raw RGB (for the phone)
//! GET /config/                                  → settings page (static files)

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
    imaging::{CropPlan, Fit, Target},
    rijks::ArtMeta,
    snapshot::Snapshot,
    variants,
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
        .route("/api/art/{key}/crop.png", get(crop_png))
        .route("/api/art/{key}/rgb", get(crop_rgb))
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
        "this painting has not been generated".into(),
    )
}

// ---------- query parsing ----------

/// The screen and fit a crop is for. Other parameters (color tuning, frame,
/// stride) are ignored: the phone applies those itself.
#[derive(Deserialize)]
pub struct TargetQuery {
    w: u32,
    h: u32,
    round: Option<u8>,
    fit: Option<Fit>,
    format: Option<String>,
}

impl TargetQuery {
    fn target(&self) -> Result<Target, AppError> {
        let t = variants::target(
            (self.w, self.h, self.round.unwrap_or(0) == 1),
            self.fit.unwrap_or_default(),
        );
        if !variants::SCREENS.contains(&(t.w, t.h, t.round)) {
            return Err(bad_request(format!("unsupported screen {}x{}", t.w, t.h)));
        }
        Ok(t)
    }
}

fn query_string(t: &Target) -> String {
    format!(
        "w={}&h={}&round={}&fit={}",
        t.w,
        t.h,
        u8::from(t.round),
        t.fit.name()
    )
}

#[derive(Deserialize)]
pub struct EraQuery {
    era: Option<Era>,
}

// ---------- painting JSON ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderInfo {
    crop: CropPlan,
    /// Size of the crop image (the screen for "fill", smaller for "whole").
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtResponse<'a> {
    #[serde(flatten)]
    meta: &'a ArtMeta,
    render: RenderInfo,
    crop_url: String,
    rgb_url: String,
    attribution: &'static str,
}

const ATTRIBUTION: &str =
    "Artwork data and images: Rijksmuseum, Amsterdam, via the Rijksmuseum data services (https://data.rijksmuseum.nl/about/). Treasure Trove is not affiliated with the Rijksmuseum.";

fn respond(snap: &Snapshot, key: &str, t: &Target) -> Result<Response, AppError> {
    let s = snap.served(key, t).ok_or_else(not_generated)?;
    let qs = query_string(t);
    let key = &s.painting.meta.key;
    let body = ArtResponse {
        crop_url: format!("/api/art/{key}/crop.png?{qs}"),
        rgb_url: format!("/api/art/{key}/rgb?{qs}"),
        render: RenderInfo {
            crop: *s.plan,
            width: s.plan.inner_w,
            height: s.plan.inner_h,
        },
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
    let t = q.target()?;
    let snap = state.snapshot();
    let key = snap.featured(f.day).ok_or_else(|| {
        AppError(
            StatusCode::NOT_FOUND,
            "no featured paintings generated yet".into(),
        )
    })?;
    respond(&snap, key, &t)
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
    let t = q.target()?;
    let era = e.era.unwrap_or_default();
    let snap = state.snapshot();
    let key = snap.random(era).ok_or_else(|| {
        let msg = match era {
            Era::Any => "no paintings generated yet".to_string(),
            e => format!("no paintings from the {} generated yet", e.name()),
        };
        AppError(StatusCode::NOT_FOUND, msg)
    })?;
    respond(&snap, key, &t)
}

async fn by_key(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    respond(&state.snapshot(), &key, &q.target()?)
}

// ---------- crop files ----------

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

async fn read_crop(state: &AppState, key: &str, t: &Target) -> Result<Vec<u8>, AppError> {
    let path = {
        let snap = state.snapshot();
        snap.served(key, t).ok_or_else(not_generated)?.crop_path
    };
    tokio::fs::read(&path).await.map_err(|e| {
        tracing::warn!(path = %path.display(), error = %e, "file in catalog is missing");
        not_generated()
    })
}

async fn crop_png(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let png = read_crop(&state, &key, &q.target()?).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, IMMUTABLE),
        ],
        png,
    )
        .into_response())
}

/// The crop as raw RGB (width × height × 3 bytes, from the JSON's `render`).
/// PebbleKit JS can't decode PNG, and can't always read binary responses, so
/// `format=b64` sends it as base64 text (gzip-compressed on the way).
async fn crop_rgb(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let png = read_crop(&state, &key, &q.target()?).await?;
    let rgb = tokio::task::spawn_blocking(move || {
        image::load_from_memory(&png).map(|img| img.to_rgb8().into_raw())
    })
    .await
    .map_err(|e| AppError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| anyhow::anyhow!("decoding crop: {e}"))?;
    if q.format.as_deref() == Some("b64") {
        let text = base64::engine::general_purpose::STANDARD.encode(rgb);
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
        rgb,
    )
        .into_response())
}
