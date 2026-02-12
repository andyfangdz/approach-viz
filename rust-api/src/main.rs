use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration as StdDuration};

mod traffic;
mod weather;

const ADSBX_TAR1090_PRIMARY_BASE_URL_DEFAULT: &str = "https://globe.adsbexchange.com";
const ADSBX_TAR1090_FALLBACK_BASE_URLS_DEFAULT: &str = "https://globe.theairtraffic.com";

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) client: reqwest::Client,
    pub(crate) traffic_primary_base_url: String,
    pub(crate) traffic_fallback_base_urls: Vec<String>,
    pub(crate) response_cache: Arc<tokio::sync::RwLock<HashMap<String, weather::CacheEntry>>>,
    pub(crate) level_timestamp_cache:
        Arc<tokio::sync::RwLock<HashMap<String, weather::MrmsLevelTimestampCacheEntry>>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let traffic_primary_base_url = std::env::var("ADSBX_TAR1090_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ADSBX_TAR1090_PRIMARY_BASE_URL_DEFAULT.to_string());

    let traffic_fallback_base_urls = std::env::var("ADSBX_TAR1090_FALLBACK_BASE_URLS")
        .unwrap_or_else(|_| ADSBX_TAR1090_FALLBACK_BASE_URLS_DEFAULT.to_string())
        .split(',')
        .map(normalize_base_url)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();

    let client = reqwest::Client::builder()
        .user_agent("approach-viz-rust-api/1.0")
        .connect_timeout(StdDuration::from_secs(8))
        .pool_max_idle_per_host(64)
        .pool_idle_timeout(StdDuration::from_secs(30))
        .tcp_keepalive(StdDuration::from_secs(30))
        .build()?;

    let state = AppState {
        client,
        traffic_primary_base_url: normalize_base_url(&traffic_primary_base_url),
        traffic_fallback_base_urls,
        response_cache: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
        level_timestamp_cache: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/traffic/adsbx", get(traffic::get))
        .route("/api/weather/nexrad", get(weather::get))
        .with_state(state);

    let host = std::env::var("RUST_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("RUST_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let address: SocketAddr = format!("{host}:{port}").parse()?;

    println!("rust-api listening on {address}");

    axum::Server::bind(&address)
        .serve(app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut sigterm) = signal(SignalKind::terminate()) {
            sigterm.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}
