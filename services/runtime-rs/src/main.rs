mod api;
mod config;
mod constants;
mod discovery;
mod grib;
mod http_client;
mod ingest;
mod storage;
mod traffic_api;
mod types;
mod utils;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::MatchedPath;
use axum::routing::get;
use axum::Router;
use reqwest::Client;
use tokio::fs;
use tokio::sync::{Mutex, RwLock, Semaphore};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::api::{echo_tops, healthz, meta, volume};
use crate::config::Config;
use crate::ingest::{enqueue_latest_from_s3, run_ingest_profile, spawn_background_workers};
use crate::storage::load_latest_snapshot;
use crate::traffic_api::{spawn_traffic_cache_worker, traffic_adsbx};
use crate::types::AppState;
use crate::utils::{init_tracing, shutdown_tracing};

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

    let latest = Arc::new(RwLock::new(load_latest_snapshot(&cfg).await?));
    let state = AppState {
        cfg: cfg.clone(),
        http: http.clone(),
        latest,
        pending: Arc::new(Mutex::new(HashMap::new())),
        recent_timestamps: Arc::new(Mutex::new(HashSet::new())),
        aux_timestamp_cache: Arc::new(Mutex::new(HashMap::new())),
        ingest_parse_limiter: Arc::new(Semaphore::new(cfg.ingest_parse_concurrency as usize)),
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

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/meta", get(meta))
        .route("/v1/weather/volume", get(volume))
        .route("/v1/weather/echo-tops", get(echo_tops))
        .route("/v1/volume", get(volume))
        .route("/v1/echo-tops", get(echo_tops))
        .route("/v1/traffic/adsbx", get(traffic_adsbx))
        .layer(CompressionLayer::new())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &axum::http::Request<_>| {
                    let matched_path = request
                        .extensions()
                        .get::<MatchedPath>()
                        .map(MatchedPath::as_str)
                        .unwrap_or(request.uri().path());
                    tracing::info_span!(
                        "http.server.request",
                        otel.name = "http.server.request",
                        otel.kind = "server",
                        "operation.name" = "http.server.request",
                        "resource.name" = matched_path,
                        method = %request.method(),
                        path = %request.uri().path(),
                        matched_path = %matched_path,
                        query = %request.uri().query().unwrap_or(""),
                        "http.request.method" = %request.method(),
                        "http.route" = %matched_path,
                        "url.path" = %request.uri().path(),
                        "url.query" = %request.uri().query().unwrap_or(""),
                        version = ?request.version(),
                        status_code = tracing::field::Empty,
                        "http.response.status_code" = tracing::field::Empty
                    )
                })
                .on_response(
                    |response: &axum::http::Response<_>,
                     latency: std::time::Duration,
                     span: &tracing::Span| {
                        span.record(
                            "status_code",
                            tracing::field::display(response.status().as_u16()),
                        );
                        span.record(
                            "http.response.status_code",
                            tracing::field::display(response.status().as_u16()),
                        );
                        tracing::info!(
                            parent: span,
                            latency_ms = latency.as_millis() as u64,
                            "http.response"
                        );
                    },
                ),
        )
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

    info!("Runtime rust service listening on {}", cfg.listen_addr);
    let serve_result = axum::serve(listener, app)
        .await
        .context("HTTP server failed");
    shutdown_tracing();
    serve_result?;
    Ok(())
}
