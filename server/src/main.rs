//! Treasure Trove server: serves pre-rendered paintings from the generator's
//! snapshot (held in memory) and files. No outside calls, no rendering: if a painting or variant
//! isn't generated yet, it's a 404.
//!
//! New to Rust? Start with `docs/RUST_FOR_TS_DEVS.md`, then read routes.rs.

mod config;
mod routes;

use std::{
    path::Path,
    sync::{Arc, RwLock},
    time::{Duration, SystemTime},
};

use tower_http::{
    compression::CompressionLayer, cors::CorsLayer, services::ServeDir, trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;
use treasure_trove::{catalog::Catalog, snapshot::Snapshot};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = config::Config::from_env();

    // `treasure-trove-server healthcheck` is used by Docker's HEALTHCHECK, so the
    // runtime image doesn't need curl.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        let port = cfg.bind.rsplit(':').next().unwrap_or("8080");
        let ok = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();
    tracing::info!(?cfg, "starting");

    let snapshot = Snapshot::load(&cfg.data_dir)?;
    tracing::info!(
        paintings = snapshot.ready(),
        pool = snapshot.pool,
        "snapshot loaded into memory"
    );
    let state = Arc::new(routes::AppState {
        cfg: cfg.clone(),
        snapshot: RwLock::new(Arc::new(snapshot)),
    });
    tokio::spawn(reload_when_changed(state.clone()));

    let app = routes::router(state)
        .fallback_service(ServeDir::new(&cfg.static_dir))
        // Mostly for the base64 crops the phone downloads.
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!("listening on http://{}", cfg.bind);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// The snapshot lives in memory; when the generator publishes a new
/// serve.sqlite, load it and swap it in.
async fn reload_when_changed(state: Arc<routes::AppState>) {
    let stamp = |dir: &Path| -> Option<SystemTime> {
        Catalog::serve_path(dir)
            .metadata()
            .and_then(|m| m.modified())
            .ok()
    };
    let mut seen = stamp(&state.cfg.data_dir);
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let now = stamp(&state.cfg.data_dir);
        if now == seen {
            continue;
        }
        let dir = state.cfg.data_dir.clone();
        match tokio::task::spawn_blocking(move || Snapshot::load(&dir)).await {
            Ok(Ok(fresh)) => {
                tracing::info!(
                    paintings = fresh.ready(),
                    pool = fresh.pool,
                    "snapshot reloaded"
                );
                state.replace(fresh);
                seen = now;
            }
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "could not reload snapshot; keeping the old one")
            }
            Err(e) => tracing::warn!(error = %e, "snapshot reload task failed"),
        }
    }
}

/// Stop on Ctrl-C or SIGTERM (what `docker stop` sends).
async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { () = ctrl_c => {}, () = term => {} }
    tracing::info!("shutting down");
}
