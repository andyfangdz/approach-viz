mod api;
mod config;
mod constants;
mod discovery;
mod grib;
mod http_client;
mod ingest;
mod storage;
mod types;
mod utils;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::routing::get;
use axum::Router;
use reqwest::Client;
use tokio::fs;
use tokio::sync::{Mutex, RwLock};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::api::{healthz, meta, volume};
use crate::config::Config;
use crate::ingest::{enqueue_latest_from_s3, spawn_background_workers};
use crate::storage::load_latest_snapshot;
use crate::types::AppState;
use crate::utils::init_tracing;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cfg = Arc::new(Config::from_env()?);
    fs::create_dir_all(cfg.scans_dir())
        .await
        .with_context(|| format!("Failed to create {}", cfg.scans_dir().display()))?;

    let http = Client::builder()
        .timeout(cfg.request_timeout)
        .user_agent("approach-viz-mrms-rs/1.0")
        .build()
        .context("Failed to build reqwest client")?;

    let latest = Arc::new(RwLock::new(load_latest_snapshot(&cfg).await?));
    let state = AppState {
        cfg: cfg.clone(),
        http: http.clone(),
        latest,
        pending: Arc::new(Mutex::new(HashMap::new())),
        recent_timestamps: Arc::new(Mutex::new(HashSet::new())),
    };

    if state.latest.read().await.is_none() {
        if let Err(error) = enqueue_latest_from_s3(&state).await {
            warn!("Initial S3 bootstrap enqueue failed: {error:#}");
        }
    }

    spawn_background_workers(state.clone()).await?;

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/meta", get(meta))
        .route("/v1/volume", get(volume))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.listen_addr)
        .await
        .with_context(|| format!("Failed to bind {}", cfg.listen_addr))?;

    info!("MRMS rust service listening on {}", cfg.listen_addr);
    axum::serve(listener, app)
        .await
        .context("HTTP server failed")?;
    Ok(())
}
