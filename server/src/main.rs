//! Treasure Trove server: picks public-domain paintings from the Rijksmuseum and
//! turns them into pixels a Pebble can display directly.
//!
//! New to Rust? Start with docs/RUST_FOR_TS_DEVS.md, then read the modules in
//! this order: config → routes → service → rijks → imaging → saliency → palette.

mod config;
mod imaging;
mod palette;
mod palette_data;
mod rijks;
mod routes;
mod saliency;
mod service;
mod store;

use std::time::Duration;

use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `treasure-trove-server healthcheck` is used by Docker's HEALTHCHECK, so the
    // runtime image doesn't need curl.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        let port = config::Config::from_env().bind.rsplit(':').next().unwrap_or("8080").to_string();
        let ok = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn".into()))
        .init();

    let cfg = config::Config::from_env();

    // `treasure-trove-server healthcheck` → used by Docker's HEALTHCHECK, since
    // the slim runtime image has no curl.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        let port = cfg.bind.rsplit(':').next().unwrap_or("8080");
        let ok = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing::info!(?cfg, "starting");
    let state = service::AppState::new(cfg.clone())?;

    // Build/refresh the pool in the background, then re-check every 12 hours.
    let bg = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = bg.ensure_pool().await {
                tracing::error!(error = %e, "pool update failed; retrying in 5 minutes");
                tokio::time::sleep(Duration::from_secs(300)).await;
                continue;
            }
            tokio::time::sleep(Duration::from_secs(12 * 3600)).await;
        }
    });

    let app = routes::router(state)
        .fallback_service(ServeDir::new(&cfg.static_dir))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!("listening on http://{}", cfg.bind);
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
