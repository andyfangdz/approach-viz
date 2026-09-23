use std::time::Duration;

use axum::extract::MatchedPath;
use axum::routing::get;
use axum::Router;
use tower_http::compression::{CompressionLayer, CompressionLevel};
use tower_http::cors::{Any, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

/// Server-side backstop so a slow encode or stalled client cannot pin a
/// request task indefinitely; well above normal volume-encode latency.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// gzip level for responses. Compression dominates the cost of a weather query
/// (at the default level 6 it was ~3x the CPU of building the payload). Measured
/// on a 5.8 MB Miami volume with the zlib-rs backend: level 6 costs ~75 ms and
/// 1.13 MB, level 3 ~28 ms and 1.19 MB (+6% bytes), level 1 ~9 ms but 1.9 MB.
const RESPONSE_COMPRESSION_LEVEL: i32 = 3;

fn response_compression() -> CompressionLayer {
    CompressionLayer::new().quality(CompressionLevel::Precise(RESPONSE_COMPRESSION_LEVEL))
}

use crate::traffic::traffic_adsbx;
use crate::types::AppState;
use crate::weather::{echo_tops, healthz, meta, volume};

pub(crate) fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/meta", get(meta))
        .route("/v1/weather/volume", get(volume))
        .route("/v1/weather/echo-tops", get(echo_tops))
        .route("/v1/traffic/adsbx", get(traffic_adsbx))
        .layer(response_compression())
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(make_request_span)
                .on_response(on_response),
        )
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

fn make_request_span(request: &axum::http::Request<axum::body::Body>) -> tracing::Span {
    let matched_path = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or(request.uri().path());
    let http_version = http_protocol_version(request.version());
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
        "http.flavor" = %http_version,
        "network.protocol.version" = %http_version,
        "url.path" = %request.uri().path(),
        "url.query" = %request.uri().query().unwrap_or(""),
        status_code = tracing::field::Empty,
        "http.response.status_code" = tracing::field::Empty
    )
}

fn http_protocol_version(version: axum::http::Version) -> &'static str {
    match version {
        axum::http::Version::HTTP_09 => "0.9",
        axum::http::Version::HTTP_10 => "1.0",
        axum::http::Version::HTTP_11 => "1.1",
        axum::http::Version::HTTP_2 => "2",
        axum::http::Version::HTTP_3 => "3",
        _ => "unknown",
    }
}

fn on_response(
    response: &axum::http::Response<axum::body::Body>,
    latency: std::time::Duration,
    span: &tracing::Span,
) {
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
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[tokio::test]
    async fn responses_are_gzip_compressed_on_request_and_round_trip() {
        // Compressible, like the structure-of-arrays columns of the weather payloads.
        let expected: Vec<u8> = (0..200_000u32).map(|i| (i / 64) as u8).collect();
        let served = expected.clone();
        let app = Router::new()
            .route(
                "/payload",
                get(move || {
                    let body = served.clone();
                    async move { body }
                }),
            )
            .layer(response_compression());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = reqwest::Client::builder().no_gzip().build().unwrap();
        let url = format!("http://{address}/payload");

        let compressed = client
            .get(&url)
            .header("accept-encoding", "gzip")
            .send()
            .await
            .unwrap();
        assert_eq!(compressed.headers()["content-encoding"], "gzip");
        let compressed = compressed.bytes().await.unwrap();
        assert!(compressed.len() < expected.len() / 4, "{} bytes", compressed.len());
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(&compressed[..])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, expected);

        let plain = client.get(&url).send().await.unwrap();
        assert!(plain.headers().get("content-encoding").is_none());
        assert_eq!(plain.bytes().await.unwrap().as_ref(), expected.as_slice());
    }

    #[tokio::test]
    async fn only_canonical_weather_paths_are_routed() {
        use std::collections::{HashMap, HashSet};
        use std::sync::Arc;
        use tokio::sync::{Mutex, RwLock, Semaphore};

        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::Config::from_env().unwrap();
        cfg.storage_dir = dir.path().to_path_buf();
        let state = AppState {
            cfg: Arc::new(cfg),
            http: reqwest::Client::new(),
            latest: Arc::new(RwLock::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            recent_timestamps: Arc::new(Mutex::new(HashSet::new())),
            ingest_parse_limiter: Arc::new(Semaphore::new(1)),
            traffic_store: Arc::new(
                crate::traffic::TrafficStore::new(dir.path().join("traffic.db")).unwrap(),
            ),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = build_router(state);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = reqwest::Client::new();
        let status = |path: &'static str| {
            let client = client.clone();
            async move {
                client
                    .get(format!("http://{address}{path}?lat=40&lon=-74"))
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16()
            }
        };
        // No scan is loaded, so the canonical routes answer 503 rather than 404.
        assert_eq!(status("/v1/weather/volume").await, 503);
        assert_eq!(status("/v1/weather/echo-tops").await, 503);
        assert_eq!(status("/v1/volume").await, 404);
        assert_eq!(status("/v1/echo-tops").await, 404);
    }
}
