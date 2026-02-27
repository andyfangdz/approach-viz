mod cache_worker;
mod encoding;
pub(crate) mod store;
pub(crate) mod types;

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use tracing::{field, info_span, instrument, Instrument, Span};

pub(crate) use cache_worker::spawn_traffic_cache_worker;
pub(crate) use store::TrafficStore;

use self::encoding::traffic_binary_response;
use self::store::query_store;
use self::types::{
    clamp, clamp_usize, history_discovery_radius_nm, no_store_headers, normalize_lat, normalize_lon,
    parse_boolean_query_param, parse_history_hexes, parse_traffic_response_format, to_finite_number,
    now_ms, QueryRequest, TrafficBinaryPayload, TrafficErrorPayload, TrafficQuery,
    TrafficResponseFormat, TrafficSuccessPayload, DEFAULT_HIDE_GROUND_TRAFFIC, DEFAULT_LIMIT,
    DEFAULT_RADIUS_NM, MAX_HISTORY_MINUTES, MAX_LIMIT, MAX_RADIUS_NM, MIN_RADIUS_NM,
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
        warming = field::Empty
    )
)]
pub(crate) async fn traffic_adsbx(
    State(state): State<AppState>,
    Query(query): Query<TrafficQuery>,
) -> Response {
    let response_format = parse_traffic_response_format(query.format.as_deref());
    let lat = normalize_lat(query.lat.as_deref());
    let lon = normalize_lon(query.lon.as_deref());
    if lat.is_none() || lon.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            no_store_headers(),
            Json(serde_json::json!({
                "error": "Valid lat/lon query params are required."
            })),
        )
            .into_response();
    }

    let lat = lat.unwrap_or_default();
    let lon = lon.unwrap_or_default();

    let radius_nm = clamp(
        to_finite_number(query.radius_nm.as_deref()).unwrap_or(DEFAULT_RADIUS_NM),
        MIN_RADIUS_NM,
        MAX_RADIUS_NM,
    );
    let limit = clamp_usize(
        to_finite_number(query.limit.as_deref())
            .map(|value| value.floor() as i64)
            .unwrap_or(DEFAULT_LIMIT as i64),
        1,
        MAX_LIMIT,
    );
    let history_minutes = clamp(
        to_finite_number(query.history_minutes.as_deref()).unwrap_or(0.0),
        0.0,
        MAX_HISTORY_MINUTES,
    );
    let hide_ground_traffic =
        parse_boolean_query_param(query.hide_ground.as_deref(), DEFAULT_HIDE_GROUND_TRAFFIC);
    let history_hexes = parse_history_hexes(query.history_hexes.as_deref());
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
            span.record("warming", result.warming);
            if result.warming {
                let source = result.source;
                let fetched_at_ms = result.fetched_at_ms;
                if response_format == TrafficResponseFormat::Binary {
                    return traffic_binary_response(TrafficBinaryPayload {
                        source,
                        fetched_at_ms,
                        aircraft: Vec::new(),
                        history_by_hex: HashMap::new(),
                        error: Some("Traffic cache is warming up.".to_string()),
                    });
                }
                return (
                    StatusCode::OK,
                    no_store_headers(),
                    Json(TrafficErrorPayload {
                        source,
                        fetched_at_ms,
                        aircraft: Vec::new(),
                        error: "Traffic cache is warming up.".to_string(),
                    }),
                )
                    .into_response();
            }

            let payload = TrafficBinaryPayload {
                source: Some(result.source.unwrap_or_else(|| "traffic-store".to_string())),
                fetched_at_ms: result.fetched_at_ms,
                aircraft: result.aircraft,
                history_by_hex: result.history_by_hex,
                error: None,
            };
            if response_format == TrafficResponseFormat::Binary {
                return traffic_binary_response(payload);
            }
            (
                StatusCode::OK,
                no_store_headers(),
                Json(TrafficSuccessPayload {
                    source: payload.source.unwrap_or_else(|| "traffic-store".to_string()),
                    fetched_at_ms: payload.fetched_at_ms,
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
                    aircraft: Vec::new(),
                    error,
                }),
            )
                .into_response()
        }
    }
}
