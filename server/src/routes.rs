//! HTTP layer (axum). TS analogy: an Express router where each handler receives
//! already-parsed query params (`Query<T>`) and shared state (`State<T>`).
//!
//! GET /healthz                              → pool status
//! GET /api/art/random?w&h&color&stride&round&fit&palette&frame[&era] → pick + render, returns JSON
//!     era: any | pre1600 | 1600s | 1700s | 1800s | 1900s
//! GET /api/art/{key}?…same…                 → render a specific painting
//! GET /api/art/{key}/raw?…same…[&format=b64] → watch bitmap bytes
//! GET /api/art/{key}/preview.png?…same…     → preview of those pixels
//! GET /config/                              → settings page (static files)

use std::sync::Arc;

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

use crate::{
    era::Era,
    frame::Frame,
    imaging::{Fit, Target},
    palette::Reference,
    rijks::ArtMeta,
    service::{AppState, RenderInfo},
    wiki::WikiLinks,
};

type Shared = Arc<AppState>;

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/", get(|| async { Redirect::temporary("/config/") }))
        .route("/healthz", get(health))
        .route("/api/art/random", get(random))
        .route("/api/art/{key}", get(by_key))
        .route("/api/art/{key}/raw", get(raw))
        .route("/api/art/{key}/preview.png", get(preview))
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
        AppError(StatusCode::BAD_GATEWAY, e.to_string())
    }
}

fn bad_request(msg: impl Into<String>) -> AppError {
    AppError(StatusCode::BAD_REQUEST, msg.into())
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
    fn target(&self, default_ref: Reference) -> Result<Target, AppError> {
        if !(16..=400).contains(&self.w) || !(16..=400).contains(&self.h) {
            return Err(bad_request("w and h must be between 16 and 400"));
        }
        let color = self.color.unwrap_or(1) == 1;
        let min_stride = if color { self.w } else { self.w.div_ceil(8) };
        let default_stride = if color { self.w } else { self.w.div_ceil(32) * 4 };
        let stride = self.stride.unwrap_or(default_stride);
        if stride < min_stride || stride > 1024 {
            return Err(bad_request(format!("stride must be between {min_stride} and 1024")));
        }
        Ok(Target {
            w: self.w,
            h: self.h,
            color,
            stride,
            round: self.round.unwrap_or(0) == 1,
            fit: self.fit.unwrap_or(Fit::Fill),
            reference: match &self.palette {
                Some(p) => p.parse().map_err(bad_request)?,
                None => default_ref,
            },
            frame: self.frame.unwrap_or_default(),
        })
    }
}

fn query_string(t: &Target) -> String {
    format!(
        "w={}&h={}&color={}&stride={}&round={}&fit={}&palette={}&frame={}",
        t.w,
        t.h,
        t.color as u8,
        t.stride,
        t.round as u8,
        match t.fit {
            Fit::Fill => "fill",
            Fit::Whole => "whole",
        },
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
struct ArtResponse {
    #[serde(flatten)]
    meta: ArtMeta,
    render: RenderInfo,
    /// Wikidata item and Wikipedia articles, when Wikidata knows the painting.
    #[serde(skip_serializing_if = "Option::is_none")]
    wiki: Option<WikiLinks>,
    raw_url: String,
    preview_url: String,
    attribution: &'static str,
}

const ATTRIBUTION: &str =
    "Artwork data and images: Rijksmuseum, Amsterdam, via the Rijksmuseum data services (https://data.rijksmuseum.nl/about/). Treasure Trove is not affiliated with the Rijksmuseum.";

async fn respond(state: &AppState, meta: ArtMeta, t: &Target) -> Result<Response, AppError> {
    let render = state.render(&meta, t).await?;
    let qs = query_string(t);
    let wiki = state.wiki_links(meta.object_number.as_deref()).await;
    let body = ArtResponse {
        wiki,
        raw_url: format!("/api/art/{}/raw?{qs}", meta.key),
        preview_url: format!("/api/art/{}/preview.png?{qs}", meta.key),
        meta,
        render,
        attribution: ATTRIBUTION,
    };
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

async fn health(State(state): State<Shared>) -> impl IntoResponse {
    let pool = state.pool.read().await;
    Json(json!({ "ok": true, "paintings": pool.ids.len(), "poolComplete": pool.complete }))
}

async fn random(
    State(state): State<Shared>,
    Query(q): Query<TargetQuery>,
    Query(e): Query<EraQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let meta = state.pick_random(e.era.unwrap_or_default()).await?;
    respond(&state, meta, &t).await
}

async fn by_key(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let meta = state.meta_by_key(&key).await?;
    if !meta.eligible {
        return Err(AppError(StatusCode::NOT_FOUND, "painting is not available".into()));
    }
    respond(&state, meta, &t).await
}

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

async fn raw(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let bytes = state.read_render(&key, &t, "raw").await?;
    if q.format.as_deref() == Some("b64") {
        // PebbleKit JS can't always read binary XHR responses; text is universal.
        let text = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(([(header::CONTENT_TYPE, "text/plain"), (header::CACHE_CONTROL, IMMUTABLE)], text).into_response());
    }
    Ok(([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, IMMUTABLE)], bytes).into_response())
}

async fn preview(
    State(state): State<Shared>,
    Path(key): Path<String>,
    Query(q): Query<TargetQuery>,
) -> Result<Response, AppError> {
    let t = q.target(state.cfg.reference)?;
    let bytes = state.read_render(&key, &t, "png").await?;
    Ok(([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, IMMUTABLE)], bytes).into_response())
}
