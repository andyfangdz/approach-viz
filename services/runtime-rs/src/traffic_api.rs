use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::Cursor;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::AppState;

const DEFAULT_RADIUS_NM: f64 = 80.0;
const MIN_RADIUS_NM: f64 = 5.0;
const MAX_RADIUS_NM: f64 = 220.0;
const DEFAULT_LIMIT: usize = 250;
const MAX_LIMIT: usize = 800;
const REQUEST_TIMEOUT_MS: u64 = 5500;
const TRACE_REQUEST_TIMEOUT_MS: u64 = 3500;
const MAX_HISTORY_MINUTES: f64 = 30.0;
const TRACE_HISTORY_MAX_AIRCRAFT: usize = 80;
const TRACE_HISTORY_BATCH_SIZE: usize = 8;
const TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT: usize = 240;
const BINCRAFT_MIN_STRIDE_BYTES: usize = 112;
const BINCRAFT_MAX_STRIDE_BYTES: usize = 256;
const BINCRAFT_S32_SEEN_VERSION: u32 = 20240218;
const DEFAULT_HIDE_GROUND_TRAFFIC: bool = false;
const EARTH_RADIUS_NM: f64 = 3440.065;

const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

#[derive(Debug, Deserialize)]
pub(crate) struct TrafficQuery {
    lat: Option<String>,
    lon: Option<String>,
    #[serde(rename = "radiusNm")]
    radius_nm: Option<String>,
    limit: Option<String>,
    #[serde(rename = "historyMinutes")]
    history_minutes: Option<String>,
    #[serde(rename = "hideGround")]
    hide_ground: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrafficAircraft {
    hex: String,
    flight: Option<String>,
    lat: f64,
    lon: f64,
    is_on_ground: bool,
    altitude_feet: Option<f64>,
    ground_speed_kt: Option<f64>,
    track_deg: Option<f64>,
    last_seen_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrafficHistoryPoint {
    lat: f64,
    lon: f64,
    altitude_feet: f64,
    timestamp_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrafficSuccessPayload {
    source: String,
    fetched_at_ms: i64,
    aircraft: Vec<TrafficAircraft>,
    history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrafficErrorPayload {
    source: Option<String>,
    fetched_at_ms: i64,
    aircraft: Vec<TrafficAircraft>,
    error: String,
}

#[derive(Debug, Clone, Copy)]
struct BoundingBox {
    south: f64,
    north: f64,
    west: f64,
    east: f64,
}

#[derive(Debug)]
struct TraceFetchResult {
    hex: String,
    points: Vec<TrafficHistoryPoint>,
}

pub async fn traffic_adsbx(
    State(state): State<AppState>,
    Query(query): Query<TrafficQuery>,
) -> Response {
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

    let bounds = build_bounding_box(lat, lon, radius_nm);

    let fetch_result = fetch_adsbx_traffic(&state, bounds).await;
    match fetch_result {
        Ok((source, base_url, mut aircraft)) => {
            aircraft.retain(|candidate| {
                distance_nm(lat, lon, candidate.lat, candidate.lon) <= radius_nm
                    && (!hide_ground_traffic || !candidate.is_on_ground)
            });

            aircraft.sort_by(|left, right| {
                let left_seen = left.last_seen_seconds.unwrap_or(f64::INFINITY);
                let right_seen = right.last_seen_seconds.unwrap_or(f64::INFINITY);
                left_seen
                    .partial_cmp(&right_seen)
                    .unwrap_or(Ordering::Equal)
            });
            aircraft.truncate(limit);

            let history_by_hex = if history_minutes > 0.0 {
                fetch_recent_trace_history(&state, &base_url, &aircraft, history_minutes).await
            } else {
                HashMap::new()
            };

            (
                StatusCode::OK,
                no_store_headers(),
                Json(TrafficSuccessPayload {
                    source,
                    fetched_at_ms: now_ms(),
                    aircraft,
                    history_by_hex,
                }),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::OK,
            no_store_headers(),
            Json(TrafficErrorPayload {
                source: None,
                fetched_at_ms: now_ms(),
                aircraft: Vec::new(),
                error,
            }),
        )
            .into_response(),
    }
}

async fn fetch_adsbx_traffic(
    state: &AppState,
    bounds: BoundingBox,
) -> Result<(String, String, Vec<TrafficAircraft>), String> {
    let mut errors = Vec::new();
    for base_url in state.cfg.traffic_base_urls() {
        let request_url = format!("{base_url}/re-api/?binCraft&zstd&box={}", box_param(bounds));
        match fetch_bincraft(&state, &request_url, &base_url).await {
            Ok(aircraft) => {
                return Ok((
                    format!("{base_url} (/re-api binCraft+zstd)"),
                    base_url,
                    aircraft,
                ))
            }
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join(" | "))
}

async fn fetch_bincraft(
    state: &AppState,
    request_url: &str,
    base_url: &str,
) -> Result<Vec<TrafficAircraft>, String> {
    let response = state
        .http
        .get(request_url)
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .headers(build_fetch_headers(base_url))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !content_type.contains("application/zstd") {
        return Err(format!(
            "Unexpected content-type: {}",
            if content_type.is_empty() {
                "none"
            } else {
                content_type.as_str()
            }
        ));
    }

    let payload = response.bytes().await.map_err(|error| error.to_string())?;
    if payload.is_empty() {
        return Err("Empty response".to_string());
    }

    decode_bincraft_aircraft(&payload)
}

fn decode_bincraft_aircraft(payload: &[u8]) -> Result<Vec<TrafficAircraft>, String> {
    let decoded = zstd::stream::decode_all(Cursor::new(payload))
        .map_err(|error| format!("binCraft zstd decode failed: {error}"))?;

    if decoded.len() < 44 {
        return Err("binCraft payload is too small.".to_string());
    }

    let stride = read_u32_le(&decoded, 8).unwrap_or(0) as usize;
    if stride < BINCRAFT_MIN_STRIDE_BYTES || stride > BINCRAFT_MAX_STRIDE_BYTES || stride % 4 != 0 {
        return Err(format!("Unexpected binCraft stride: {stride}"));
    }

    let version = read_u32_le(&decoded, 40).unwrap_or_default();
    let max_offset = decoded.len() - (decoded.len() % stride);

    let mut by_hex: HashMap<String, TrafficAircraft> = HashMap::new();

    let mut offset = stride;
    while offset + stride <= max_offset {
        let u8 = &decoded[offset..offset + stride];
        let validity73 = u8[73];
        if (validity73 & 64) == 0 {
            offset += stride;
            continue;
        }

        let lat = read_i32_le(u8, 12)
            .map(|value| normalize_lat_value(value as f64 / 1_000_000.0))
            .flatten();
        let lon = read_i32_le(u8, 8)
            .map(|value| normalize_lon_value(value as f64 / 1_000_000.0))
            .flatten();
        let (lat, lon) = match (lat, lon) {
            (Some(lat), Some(lon)) => (lat, lon),
            _ => {
                offset += stride;
                continue;
            }
        };

        let raw_hex = read_i32_le(u8, 0).unwrap_or_default() as u32;
        let hex_base = raw_hex & 0x00ff_ffff;
        if hex_base == 0 {
            offset += stride;
            continue;
        }
        let is_temporary = (raw_hex & (1 << 24)) != 0;
        let hex = if is_temporary {
            format!("~{hex_base:06x}")
        } else {
            format!("{hex_base:06x}")
        };

        let altitude_feet = if (validity73 & 32) != 0 {
            normalize_altitude_feet_value(
                (25_i32 * read_i16_le(u8, 22).unwrap_or_default() as i32) as f64,
            )
        } else if (validity73 & 16) != 0 {
            normalize_altitude_feet_value(
                (25_i32 * read_i16_le(u8, 20).unwrap_or_default() as i32) as f64,
            )
        } else {
            None
        };

        let ground_speed_kt = if (validity73 & 128) != 0 {
            normalize_speed_kt(
                read_i16_le(u8, 34)
                    .map(|value| value as f64 / 10.0)
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        let track_deg = if (u8[74] & 8) != 0 {
            normalize_heading_value(
                read_i16_le(u8, 40)
                    .map(|value| value as f64 / 90.0)
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        let flight = if (validity73 & 8) != 0 {
            decode_flight(u8)
        } else {
            None
        };
        let airground = u8[68] & 15;
        let is_on_ground = airground == 1;

        let seen_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(u8, 4).map(|value| value as f64 / 10.0)
        } else {
            read_u16_le(u8, 6).map(|value| value as f64 / 10.0)
        };
        let seen_pos_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(u8, 108).map(|value| value as f64 / 10.0)
        } else {
            read_u16_le(u8, 4).map(|value| value as f64 / 10.0)
        };

        let last_seen_seconds = seen_pos_seconds
            .and_then(normalize_seen_seconds_value)
            .or_else(|| seen_seconds.and_then(normalize_seen_seconds_value));

        let aircraft = TrafficAircraft {
            hex: hex.clone(),
            flight,
            lat,
            lon,
            is_on_ground,
            altitude_feet,
            ground_speed_kt,
            track_deg,
            last_seen_seconds,
        };

        match by_hex.get(&hex) {
            Some(current) => {
                let current_seen = current.last_seen_seconds.unwrap_or(f64::INFINITY);
                let candidate_seen = aircraft.last_seen_seconds.unwrap_or(f64::INFINITY);
                if candidate_seen < current_seen {
                    by_hex.insert(hex, aircraft);
                }
            }
            None => {
                by_hex.insert(hex, aircraft);
            }
        }

        offset += stride;
    }

    Ok(by_hex.into_values().collect())
}

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    data.get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_i16_le(data: &[u8], offset: usize) -> Option<i16> {
    data.get(offset..offset + 2)
        .map(|slice| i16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32_le(data: &[u8], offset: usize) -> Option<i32> {
    data.get(offset..offset + 4)
        .map(|slice| i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn decode_flight(u8: &[u8]) -> Option<String> {
    let mut bytes = Vec::new();
    for index in 78..86 {
        let code = *u8.get(index)?;
        if code == 0 {
            break;
        }
        bytes.push(code);
    }

    let text = String::from_utf8_lossy(&bytes);
    normalize_callsign(Some(text.trim()))
}

async fn fetch_recent_trace_history(
    state: &AppState,
    base_url: &str,
    aircraft: &[TrafficAircraft],
    history_minutes: f64,
) -> HashMap<String, Vec<TrafficHistoryPoint>> {
    if history_minutes <= 0.0 {
        return HashMap::new();
    }

    let history_cutoff_ms = now_ms() - (history_minutes * 60_000.0) as i64;
    let limited_aircraft = &aircraft[..aircraft.len().min(TRACE_HISTORY_MAX_AIRCRAFT)];
    let mut history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>> = HashMap::new();

    for batch in limited_aircraft.chunks(TRACE_HISTORY_BATCH_SIZE) {
        let futures = batch.iter().map(|entry| {
            fetch_trace_history_for_hex(state, base_url, &entry.hex, history_cutoff_ms)
        });
        let results = join_all(futures).await;
        for result in results {
            if !result.points.is_empty() {
                history_by_hex.insert(result.hex, result.points);
            }
        }
    }

    history_by_hex
}

async fn fetch_trace_history_for_hex(
    state: &AppState,
    base_url: &str,
    aircraft_hex: &str,
    history_cutoff_ms: i64,
) -> TraceFetchResult {
    let Some(trace_hex) = normalize_trace_hex(aircraft_hex) else {
        return TraceFetchResult {
            hex: aircraft_hex.to_string(),
            points: Vec::new(),
        };
    };

    let trace_url = format!(
        "{base_url}/data/traces/{}/trace_recent_{trace_hex}.json",
        &trace_hex[trace_hex.len().saturating_sub(2)..]
    );

    let response = state
        .http
        .get(trace_url)
        .timeout(Duration::from_millis(TRACE_REQUEST_TIMEOUT_MS))
        .headers(build_fetch_headers(base_url))
        .send()
        .await;
    let Ok(response) = response else {
        return TraceFetchResult {
            hex: aircraft_hex.to_string(),
            points: Vec::new(),
        };
    };
    if !response.status().is_success() {
        return TraceFetchResult {
            hex: aircraft_hex.to_string(),
            points: Vec::new(),
        };
    }

    let payload = response.json::<Value>().await;
    let Ok(payload) = payload else {
        return TraceFetchResult {
            hex: aircraft_hex.to_string(),
            points: Vec::new(),
        };
    };

    let base_timestamp_seconds = value_to_finite(payload.get("timestamp"));
    let Some(base_timestamp_seconds) = base_timestamp_seconds else {
        return TraceFetchResult {
            hex: aircraft_hex.to_string(),
            points: Vec::new(),
        };
    };

    let mut points = Vec::new();
    if let Some(trace) = payload.get("trace").and_then(|value| value.as_array()) {
        for entry in trace {
            let Some(tuple) = entry.as_array() else {
                continue;
            };
            if tuple.len() < 4 {
                continue;
            }

            let Some(offset_seconds) = value_to_finite(tuple.first()) else {
                continue;
            };
            let lat = value_to_finite(tuple.get(1)).and_then(normalize_lat_value);
            let lon = value_to_finite(tuple.get(2)).and_then(normalize_lon_value);
            let (lat, lon) = match (lat, lon) {
                (Some(lat), Some(lon)) => (lat, lon),
                _ => continue,
            };

            let Some(altitude_feet) = normalize_altitude_from_value(tuple.get(3)) else {
                continue;
            };

            let timestamp_ms =
                normalize_timestamp_ms((base_timestamp_seconds + offset_seconds) * 1000.0);
            let Some(timestamp_ms) = timestamp_ms else {
                continue;
            };
            if timestamp_ms < history_cutoff_ms {
                continue;
            }

            points.push(TrafficHistoryPoint {
                lat,
                lon,
                altitude_feet,
                timestamp_ms,
            });
        }
    }

    points.sort_by_key(|point| point.timestamp_ms);
    if points.len() > TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT {
        points = points[points.len() - TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT..].to_vec();
    }

    TraceFetchResult {
        hex: aircraft_hex.to_string(),
        points,
    }
}

fn normalize_trace_hex(hex: &str) -> Option<String> {
    let normalized = hex.strip_prefix('~').unwrap_or(hex).to_ascii_lowercase();
    if normalized.len() != 6 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(normalized)
}

fn build_fetch_headers(base_url: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("*/*"));
    headers.insert(
        "accept-language",
        HeaderValue::from_static("en-US,en;q=0.9"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-cache"));
    headers.insert("pragma", HeaderValue::from_static("no-cache"));
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
    headers.insert("user-agent", HeaderValue::from_static(USER_AGENT));

    if let Ok(value) = HeaderValue::from_str(base_url) {
        headers.insert("origin", value);
    }
    if let Ok(value) = HeaderValue::from_str(&format!("{base_url}/")) {
        headers.insert("referer", value);
    }

    headers
}

fn no_store_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cache-control",
        HeaderValue::from_static("no-store, max-age=0"),
    );
    headers
}

fn to_finite_number(value: Option<&str>) -> Option<f64> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = trimmed.parse::<f64>().ok()?;
    if parsed.is_finite() {
        Some(parsed)
    } else {
        None
    }
}

fn value_to_finite(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let parsed = text.trim().parse::<f64>().ok()?;
            if parsed.is_finite() {
                Some(parsed)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn parse_boolean_query_param(value: Option<&str>, fallback: bool) -> bool {
    let Some(value) = value else {
        return fallback;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn clamp_usize(value: i64, min: usize, max: usize) -> usize {
    (value.max(min as i64).min(max as i64)) as usize
}

fn normalize_lat(raw: Option<&str>) -> Option<f64> {
    let parsed = to_finite_number(raw)?;
    normalize_lat_value(parsed)
}

fn normalize_lon(raw: Option<&str>) -> Option<f64> {
    let parsed = to_finite_number(raw)?;
    normalize_lon_value(parsed)
}

fn normalize_lat_value(parsed: f64) -> Option<f64> {
    if (-90.0..=90.0).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

fn normalize_lon_value(parsed: f64) -> Option<f64> {
    if (-180.0..=180.0).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

fn normalize_heading_value(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    let wrapped = value % 360.0;
    Some(if wrapped < 0.0 {
        wrapped + 360.0
    } else {
        wrapped
    })
}

fn normalize_callsign(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_speed_kt(value: f64) -> Option<f64> {
    if !value.is_finite() || !(0.0..=1800.0).contains(&value) {
        return None;
    }
    Some(value)
}

fn normalize_seen_seconds_value(value: f64) -> Option<f64> {
    if !value.is_finite() || !(0.0..=86_400.0).contains(&value) {
        return None;
    }
    Some(value)
}

fn normalize_altitude_feet_value(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    Some(clamp(value, -2000.0, 70_000.0))
}

fn normalize_altitude_from_value(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    if let Value::String(text) = value {
        if text.trim().eq_ignore_ascii_case("ground") {
            return None;
        }
    }

    let parsed = value_to_finite(Some(value))?;
    normalize_altitude_feet_value(parsed)
}

fn normalize_timestamp_ms(value: f64) -> Option<i64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let timestamp_ms = value.round() as i64;
    if timestamp_ms < 946_684_800_000 {
        return None;
    }
    Some(timestamp_ms)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    duration.as_millis().min(i64::MAX as u128) as i64
}

fn to_radians(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

fn distance_nm(lat_a: f64, lon_a: f64, lat_b: f64, lon_b: f64) -> f64 {
    let lat_a_rad = to_radians(lat_a);
    let lat_b_rad = to_radians(lat_b);
    let d_lat = lat_b_rad - lat_a_rad;
    let d_lon = to_radians(lon_b - lon_a);
    let sin_lat = (d_lat / 2.0).sin();
    let sin_lon = (d_lon / 2.0).sin();
    let a = sin_lat * sin_lat + lat_a_rad.cos() * lat_b_rad.cos() * sin_lon * sin_lon;
    let c = 2.0 * a.sqrt().atan2((1.0 - a).max(0.0).sqrt());
    EARTH_RADIUS_NM * c
}

fn build_bounding_box(lat: f64, lon: f64, radius_nm: f64) -> BoundingBox {
    let lat_delta = radius_nm / 60.0;
    let lon_scale = lat.to_radians().cos().max(0.01);
    let lon_delta = radius_nm / (60.0 * lon_scale);

    let south = clamp(lat - lat_delta, -90.0, 90.0);
    let north = clamp(lat + lat_delta, -90.0, 90.0);
    let mut west = lon - lon_delta;
    let mut east = lon + lon_delta;

    while west < -180.0 {
        west += 360.0;
    }
    while west > 180.0 {
        west -= 360.0;
    }
    while east < -180.0 {
        east += 360.0;
    }
    while east > 180.0 {
        east -= 360.0;
    }

    if west > east {
        west = -180.0;
        east = 180.0;
    }

    BoundingBox {
        south,
        north,
        west,
        east,
    }
}

fn box_param(bounds: BoundingBox) -> String {
    format!(
        "{:.6},{:.6},{:.6},{:.6}",
        bounds.south, bounds.north, bounds.west, bounds.east
    )
}
