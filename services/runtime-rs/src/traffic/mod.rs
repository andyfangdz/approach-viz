mod cache_worker;
mod encoding;
pub(crate) mod memory_store;
pub(crate) mod store;
pub(crate) mod types;

// Public re-exports for benchmarks
#[allow(unused_imports)]
pub use cache_worker::decode_bincraft_aircraft;
#[allow(unused_imports)]
pub use encoding::encode_traffic_fb;
#[allow(unused_imports)]
pub use memory_store::TrafficMemoryStore;
#[allow(unused_imports)]
pub use store::{ingest_to_store, query_store, TrafficStore};
#[allow(unused_imports)]
pub use types::{
    distance_nm, QueryRequest, TrafficAircraft, TrafficBinaryPayload, TrafficHistoryPoint,
};

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use tracing::{field, info_span, instrument, Instrument, Span};

#[allow(unused_imports)]
pub(crate) use cache_worker::spawn_traffic_cache_worker;

use self::encoding::traffic_binary_response;
use approach_viz_core::traffic_query::{parse_traffic_query, RawTrafficQuery};

use self::types::{
    add_traffic_snapshot_headers, history_discovery_radius_nm, no_store_headers, now_ms,
    parse_traffic_response_format, TrafficErrorPayload, TrafficQuery, TrafficResponseFormat,
    TrafficSuccessPayload,
};
use crate::types::AppState;

#[instrument(
    name = "runtime.traffic.adsbx",
    skip(state, query),
    fields(
        lat = field::Empty,
        lon = field::Empty,
        radius_nm = field::Empty,
        limit = field::Empty,
        history_minutes = field::Empty,
        hide_ground_traffic = field::Empty,
        history_hex_count = field::Empty,
        result_aircraft_count = field::Empty,
        result_history_hex_count = field::Empty,
        snapshot_age_ms = field::Empty,
        stale_snapshot = field::Empty,
        warming = field::Empty
    )
)]
pub(crate) async fn traffic_adsbx(
    State(state): State<AppState>,
    Query(query): Query<TrafficQuery>,
) -> Response {
    let response_format = parse_traffic_response_format(query.format.as_deref());
    let parsed = parse_traffic_query(RawTrafficQuery {
        lat: query.lat.as_deref(),
        lon: query.lon.as_deref(),
        radius_nm: query.radius_nm.as_deref(),
        limit: query.limit.as_deref(),
        history_minutes: query.history_minutes.as_deref(),
        hide_ground: query.hide_ground.as_deref(),
        history_hexes: query.history_hexes.as_deref(),
    });
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(message) => {
            return (
                StatusCode::BAD_REQUEST,
                no_store_headers(),
                Json(serde_json::json!({ "error": message })),
            )
                .into_response();
        }
    };
    let (lat, lon, radius_nm, limit, history_minutes, hide_ground_traffic, history_hexes) = (
        parsed.lat,
        parsed.lon,
        parsed.radius_nm,
        parsed.limit,
        parsed.history_minutes,
        parsed.hide_ground_traffic,
        parsed.history_hexes,
    );
    let now_ms = now_ms();
    let span = Span::current();
    span.record("lat", lat);
    span.record("lon", lon);
    span.record("radius_nm", radius_nm);
    span.record("limit", limit as i64);
    span.record("history_minutes", history_minutes);
    span.record("hide_ground_traffic", hide_ground_traffic);
    span.record("history_hex_count", history_hexes.len() as i64);

    let request = QueryRequest {
        lat,
        lon,
        radius_nm,
        discovery_radius_nm: history_discovery_radius_nm(
            radius_nm,
            history_minutes,
            &history_hexes,
        ),
        limit,
        history_minutes,
        history_hexes,
        hide_ground_traffic,
        now_ms,
    };

    let query_result = query_store(&state.traffic_store, request)
        .instrument(info_span!("runtime.traffic.adsbx.query_store"))
        .await;
    match query_result {
        Ok(result) => {
            span.record("result_aircraft_count", result.aircraft.len() as i64);
            span.record(
                "result_history_hex_count",
                result.history_by_hex.len() as i64,
            );
            span.record("snapshot_age_ms", result.snapshot_age_ms);
            span.record("stale_snapshot", result.stale_current);
            span.record("warming", result.warming);
            if result.warming {
                let source = result.source;
                let fetched_at_ms = result.fetched_at_ms;
                if response_format == TrafficResponseFormat::Binary {
                    return traffic_binary_response(TrafficBinaryPayload {
                        source,
                        fetched_at_ms,
                        snapshot_age_ms: result.snapshot_age_ms,
                        stale_current: result.stale_current,
                        aircraft: Vec::new(),
                        history_by_hex: HashMap::new(),
                        error: Some("Traffic cache is warming up.".to_string()),
                    });
                }
                let mut headers = no_store_headers();
                add_traffic_snapshot_headers(
                    &mut headers,
                    result.stale_current,
                    result.snapshot_age_ms,
                );
                return (
                    StatusCode::OK,
                    headers,
                    Json(TrafficErrorPayload {
                        source,
                        fetched_at_ms,
                        snapshot_age_ms: Some(result.snapshot_age_ms),
                        stale_current: Some(result.stale_current),
                        aircraft: Vec::new(),
                        error: "Traffic cache is warming up.".to_string(),
                    }),
                )
                    .into_response();
            }

            let payload = TrafficBinaryPayload {
                source: Some(result.source.unwrap_or_else(|| "traffic-store".to_string())),
                fetched_at_ms: result.fetched_at_ms,
                snapshot_age_ms: result.snapshot_age_ms,
                stale_current: result.stale_current,
                aircraft: result.aircraft,
                history_by_hex: result.history_by_hex,
                error: None,
            };
            if response_format == TrafficResponseFormat::Binary {
                return traffic_binary_response(payload);
            }
            let mut headers = no_store_headers();
            add_traffic_snapshot_headers(
                &mut headers,
                payload.stale_current,
                payload.snapshot_age_ms,
            );
            (
                StatusCode::OK,
                headers,
                Json(TrafficSuccessPayload {
                    source: payload.source.unwrap_or_else(|| "traffic-store".to_string()),
                    fetched_at_ms: payload.fetched_at_ms,
                    snapshot_age_ms: payload.snapshot_age_ms,
                    stale_current: payload.stale_current,
                    aircraft: payload.aircraft,
                    history_by_hex: payload.history_by_hex,
                }),
            )
                .into_response()
        }
        Err(error) => {
            if response_format == TrafficResponseFormat::Binary {
                return traffic_binary_response(TrafficBinaryPayload {
                    source: None,
                    fetched_at_ms: now_ms,
                    snapshot_age_ms: 0,
                    stale_current: false,
                    aircraft: Vec::new(),
                    history_by_hex: HashMap::new(),
                    error: Some(error),
                });
            }
            (
                StatusCode::OK,
                no_store_headers(),
                Json(TrafficErrorPayload {
                    source: None,
                    fetched_at_ms: now_ms,
                    snapshot_age_ms: None,
                    stale_current: None,
                    aircraft: Vec::new(),
                    error,
                }),
            )
                .into_response()
        }
    }
}
