use std::time::Duration;

use axum::extract::MatchedPath;
use axum::routing::get;
use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

/// Server-side backstop so a slow encode or stalled client cannot pin a
/// request task indefinitely; well above normal volume-encode latency.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

use crate::traffic::traffic_adsbx;
use crate::types::AppState;
use crate::weather::{echo_tops, healthz, meta, volume};

pub(crate) fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/meta", get(meta))
        .route("/v1/weather/volume", get(volume))
        .route("/v1/weather/echo-tops", get(echo_tops))
        .route("/v1/volume", get(volume))
        .route("/v1/echo-tops", get(echo_tops))
        .route("/v1/traffic/adsbx", get(traffic_adsbx))
        .layer(CompressionLayer::new())
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
