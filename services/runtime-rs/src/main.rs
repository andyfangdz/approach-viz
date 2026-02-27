mod config;
mod constants;
mod http_client;
mod server;
mod traffic;
mod types;
mod utils;
mod weather;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{Context, Result};
use reqwest::Client;
use tokio::fs;
use tokio::sync::{Mutex, RwLock, Semaphore};
use tracing::{info, warn};

use crate::config::Config;
use crate::traffic::{spawn_traffic_cache_worker, TrafficStore};
use crate::types::AppState;
use crate::utils::{init_tracing, shutdown_tracing};
use crate::weather::{
    enqueue_latest_from_s3, load_latest_snapshot, run_ingest_profile, spawn_background_workers,
};

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cfg = Arc::new(Config::from_env()?);
    fs::create_dir_all(cfg.scans_dir())
        .await
        .with_context(|| format!("Failed to create {}", cfg.scans_dir().display()))?;

    let http = Client::builder()
        .timeout(cfg.request_timeout)
        .user_agent("approach-viz-runtime-rs/1.0")
        .build()
        .context("Failed to build reqwest client")?;

    let traffic_store = Arc::new(
        TrafficStore::new(cfg.traffic_db_file())
            .map_err(|error| anyhow::anyhow!("Failed to create traffic store: {error}"))?,
    );

    let latest = Arc::new(RwLock::new(load_latest_snapshot(&cfg).await?));
    let state = AppState {
        cfg: cfg.clone(),
        http: http.clone(),
        latest,
        pending: Arc::new(Mutex::new(HashMap::new())),
        recent_timestamps: Arc::new(Mutex::new(HashSet::new())),
        ingest_parse_limiter: Arc::new(Semaphore::new(cfg.ingest_parse_concurrency as usize)),
        traffic_store,
    };

    if let Some(timestamp) = state.cfg.ingest_profile_timestamp.clone() {
        run_ingest_profile(&state, &timestamp, state.cfg.ingest_profile_repeats).await?;
        shutdown_tracing();
        return Ok(());
    }

    if state.latest.read().await.is_none() {
        if let Err(error) = enqueue_latest_from_s3(&state).await {
            warn!("Initial S3 bootstrap enqueue failed: {error:#}");
        }
    }

    spawn_background_workers(state.clone()).await?;
    spawn_traffic_cache_worker(state.clone());

    let app = server::build_router(state);

    let listener = tokio::net::TcpListener::bind(&cfg.listen_addr)
        .await
        .with_context(|| format!("Failed to bind {}", cfg.listen_addr))?;

    info!("Runtime rust service listening on {}", cfg.listen_addr);
    let serve_result = axum::serve(listener, app)
        .await
        .context("HTTP server failed");
    shutdown_tracing();
    serve_result?;
    Ok(())
}
