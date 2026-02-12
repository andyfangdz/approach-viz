use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use futures::future::join_all;
use serde::Serialize;
use serde_json::Value;
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    io::Cursor,
    time::Duration as StdDuration,
};

use crate::AppState;

const DEFAULT_RADIUS_NM: f64 = 80.0;
const MIN_RADIUS_NM: f64 = 5.0;
const MAX_RADIUS_NM: f64 = 220.0;
const DEFAULT_LIMIT: usize = 250;
const MAX_LIMIT: usize = 800;
const REQUEST_TIMEOUT_MS: u64 = 5500;
const EARTH_RADIUS_NM: f64 = 3440.065;
const BINCRAFT_MIN_STRIDE_BYTES: usize = 112;
const BINCRAFT_MAX_STRIDE_BYTES: usize = 256;
const BINCRAFT_S32_SEEN_VERSION: i32 = 20240218;
const MAX_HISTORY_MINUTES: f64 = 30.0;
const TRACE_HISTORY_MAX_AIRCRAFT: usize = 80;
const TRACE_HISTORY_BATCH_SIZE: usize = 8;
const TRACE_REQUEST_TIMEOUT_MS: u64 = 3500;
const TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT: usize = 240;
const DEFAULT_HIDE_GROUND_TRAFFIC: bool = false;

const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
#[derive(Debug, Clone)]
struct BoundingBox {
    south: f64,
    north: f64,
    west: f64,
    east: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tar1090Aircraft {
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
    aircraft: Vec<Tar1090Aircraft>,
    history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrafficFailurePayload {
    source: Option<String>,
    fetched_at_ms: i64,
    aircraft: Vec<Tar1090Aircraft>,
    error: String,
}
fn no_store_response<T: Serialize>(
    status: StatusCode,
    payload: &T,
    max_age_zero: bool,
) -> Response {
    let mut response = (status, Json(payload)).into_response();
    let cache_value = if max_age_zero {
        "no-store, max-age=0"
    } else {
        "no-store"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_value));
    response
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn to_finite_number(input: Option<&String>) -> Option<f64> {
    let value = input?.trim();
    if value.is_empty() {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite())
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.min(max).max(min)
}

fn clamp_i64(value: i64, min: i64, max: i64) -> i64 {
    value.min(max).max(min)
}

fn normalize_lat(value: Option<f64>) -> Option<f64> {
    let parsed = value?;
    if !(-90.0..=90.0).contains(&parsed) {
        return None;
    }
    Some(parsed)
}

fn normalize_lon(value: Option<f64>) -> Option<f64> {
    let parsed = value?;
    if !(-180.0..=180.0).contains(&parsed) {
        return None;
    }
    Some(parsed)
}

fn normalize_heading(value: f64) -> Option<f64> {
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

fn normalize_altitude_feet(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    Some(clamp(value, -2000.0, 70000.0))
}

fn normalize_speed_kt(value: f64) -> Option<f64> {
    if !value.is_finite() || value < 0.0 || value > 1800.0 {
        return None;
    }
    Some(value)
}

fn normalize_seen_seconds(value: f64) -> Option<f64> {
    if !value.is_finite() || value < 0.0 || value > 86400.0 {
        return None;
    }
    Some(value)
}

fn normalize_timestamp_ms(value: f64) -> Option<i64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let rounded = value.round() as i64;
    if rounded < 946684800000 {
        return None;
    }
    Some(rounded)
}

fn normalize_callsign(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_boolean_query_param(value: Option<&String>, fallback: bool) -> bool {
    let normalized = match value {
        Some(value) => value.trim().to_ascii_lowercase(),
        None => return fallback,
    };
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn to_radians(value: f64) -> f64 {
    value * std::f64::consts::PI / 180.0
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
    let lon_scale = to_radians(lat).cos().abs().max(0.01);
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

fn box_param(bounds: &BoundingBox) -> String {
    format!(
        "{:.6},{:.6},{:.6},{:.6}",
        bounds.south, bounds.north, bounds.west, bounds.east
    )
}

fn build_fetch_headers(base_url: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert(
        header::ACCEPT_LANGUAGE,
        HeaderValue::from_static("en-US,en;q=0.9"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert("pragma", HeaderValue::from_static("no-cache"));
    if let Ok(origin) = HeaderValue::from_str(base_url) {
        headers.insert("origin", origin);
    }
    if let Ok(referer) = HeaderValue::from_str(&format!("{base_url}/")) {
        headers.insert(header::REFERER, referer);
    }
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
    headers.insert(header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
    headers
}

fn read_i16_le(slice: &[u8], index: usize) -> i16 {
    let start = index * 2;
    i16::from_le_bytes([slice[start], slice[start + 1]])
}

fn read_u16_le(slice: &[u8], index: usize) -> u16 {
    let start = index * 2;
    u16::from_le_bytes([slice[start], slice[start + 1]])
}

fn read_i32_le(slice: &[u8], index: usize) -> i32 {
    let start = index * 4;
    i32::from_le_bytes([
        slice[start],
        slice[start + 1],
        slice[start + 2],
        slice[start + 3],
    ])
}

fn decode_flight(slice: &[u8]) -> Option<String> {
    let mut result = String::new();
    for index in 78..86 {
        let code = slice[index];
        if code == 0 {
            break;
        }
        result.push(code as char);
    }
    normalize_callsign(&result)
}

fn decode_bincraft_aircraft(payload: &[u8]) -> anyhow::Result<Vec<Tar1090Aircraft>> {
    let decoded = zstd::stream::decode_all(Cursor::new(payload))
        .map_err(|error| anyhow::anyhow!("binCraft zstd decode failed: {error}"))?;

    if decoded.len() < 44 {
        anyhow::bail!("binCraft payload is too small.");
    }

    let stride = u32::from_le_bytes([decoded[8], decoded[9], decoded[10], decoded[11]]) as usize;
    if stride < BINCRAFT_MIN_STRIDE_BYTES || stride > BINCRAFT_MAX_STRIDE_BYTES || stride % 4 != 0 {
        anyhow::bail!("Unexpected binCraft stride: {stride}");
    }

    let version = i32::from_le_bytes([decoded[40], decoded[41], decoded[42], decoded[43]]);
    let mut aircraft_by_hex: HashMap<String, Tar1090Aircraft> = HashMap::new();
    let max_offset = decoded.len() - (decoded.len() % stride);

    let mut offset = stride;
    while offset + stride <= max_offset {
        let slice = &decoded[offset..offset + stride];
        let validity73 = slice[73];
        if (validity73 & 64) == 0 {
            offset += stride;
            continue;
        }

        let lat = normalize_lat(Some(read_i32_le(slice, 3) as f64 / 1_000_000.0));
        let lon = normalize_lon(Some(read_i32_le(slice, 2) as f64 / 1_000_000.0));
        if lat.is_none() || lon.is_none() {
            offset += stride;
            continue;
        }

        let raw_hex = read_i32_le(slice, 0) as u32;
        let hex_base = format!("{:06x}", raw_hex & 0x00ff_ffff);
        if hex_base == "000000" {
            offset += stride;
            continue;
        }
        let is_temporary_hex = (raw_hex & (1 << 24)) != 0;
        let hex = if is_temporary_hex {
            format!("~{hex_base}")
        } else {
            hex_base
        };

        let altitude_feet = if (validity73 & 32) != 0 {
            normalize_altitude_feet((25 * read_i16_le(slice, 11) as i32) as f64)
        } else if (validity73 & 16) != 0 {
            normalize_altitude_feet((25 * read_i16_le(slice, 10) as i32) as f64)
        } else {
            None
        };

        let ground_speed_kt = if (validity73 & 128) != 0 {
            normalize_speed_kt(read_i16_le(slice, 17) as f64 / 10.0)
        } else {
            None
        };

        let track_deg = if (slice[74] & 8) != 0 {
            normalize_heading(read_i16_le(slice, 20) as f64 / 90.0)
        } else {
            None
        };

        let flight = if (validity73 & 8) != 0 {
            decode_flight(slice)
        } else {
            None
        };

        let airground = slice[68] & 15;
        let is_on_ground = airground == 1;

        let seen_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(slice, 1) as f64 / 10.0
        } else {
            read_u16_le(slice, 3) as f64 / 10.0
        };

        let seen_pos_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(slice, 27) as f64 / 10.0
        } else {
            read_u16_le(slice, 2) as f64 / 10.0
        };

        let aircraft = Tar1090Aircraft {
            hex: hex.clone(),
            flight,
            lat: lat.unwrap_or_default(),
            lon: lon.unwrap_or_default(),
            is_on_ground,
            altitude_feet,
            ground_speed_kt,
            track_deg,
            last_seen_seconds: normalize_seen_seconds(seen_pos_seconds)
                .or_else(|| normalize_seen_seconds(seen_seconds)),
        };

        match aircraft_by_hex.get(&hex) {
            Some(current) => {
                let current_seen = current.last_seen_seconds.unwrap_or(f64::INFINITY);
                let candidate_seen = aircraft.last_seen_seconds.unwrap_or(f64::INFINITY);
                if candidate_seen < current_seen {
                    aircraft_by_hex.insert(hex, aircraft);
                }
            }
            None => {
                aircraft_by_hex.insert(hex, aircraft);
            }
        }

        offset += stride;
    }

    Ok(aircraft_by_hex.into_values().collect())
}

async fn fetch_bincraft(
    state: &AppState,
    url: &str,
    base_url: &str,
) -> anyhow::Result<Vec<Tar1090Aircraft>> {
    let response = state
        .client
        .get(url)
        .headers(build_fetch_headers(base_url))
        .timeout(StdDuration::from_millis(REQUEST_TIMEOUT_MS))
        .send()
        .await?;

    if !response.status().is_success() {
        anyhow::bail!("HTTP {}", response.status().as_u16());
    }

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if !content_type.contains("application/zstd") {
        anyhow::bail!(
            "Unexpected content-type: {}",
            if content_type.is_empty() {
                "none"
            } else {
                content_type.as_str()
            }
        );
    }

    let payload = response.bytes().await?;
    if payload.is_empty() {
        anyhow::bail!("Empty response");
    }

    decode_bincraft_aircraft(&payload)
}

async fn fetch_from_host(
    state: &AppState,
    base_url: &str,
    bounds: &BoundingBox,
) -> anyhow::Result<(Vec<Tar1090Aircraft>, String, String)> {
    let request_url = format!("{base_url}/re-api/?binCraft&zstd&box={}", box_param(bounds));
    let aircraft = fetch_bincraft(state, &request_url, base_url).await?;
    Ok((
        aircraft,
        format!("{base_url} (/re-api binCraft+zstd)"),
        base_url.to_string(),
    ))
}

fn traffic_base_urls(state: &AppState) -> Vec<String> {
    let mut deduped = HashSet::new();
    let mut urls = Vec::new();

    let primary = state.traffic_primary_base_url.trim();
    if !primary.is_empty() && deduped.insert(primary.to_string()) {
        urls.push(primary.to_string());
    }

    for fallback in &state.traffic_fallback_base_urls {
        let trimmed = fallback.trim();
        if !trimmed.is_empty() && deduped.insert(trimmed.to_string()) {
            urls.push(trimmed.to_string());
        }
    }

    urls
}

async fn fetch_adsbx_traffic(
    state: &AppState,
    bounds: &BoundingBox,
) -> anyhow::Result<(Vec<Tar1090Aircraft>, String, String)> {
    let mut errors = Vec::new();

    for base_url in traffic_base_urls(state) {
        match fetch_from_host(state, &base_url, bounds).await {
            Ok(result) => return Ok(result),
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    anyhow::bail!(errors.join(" | "));
}

fn normalize_trace_hex(hex: &str) -> Option<String> {
    let normalized = if let Some(stripped) = hex.strip_prefix('~') {
        stripped
    } else {
        hex
    };

    if normalized.len() != 6 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }

    Some(normalized.to_ascii_lowercase())
}

fn to_finite_number_value(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return number.is_finite().then_some(number);
    }

    if let Some(string) = value.as_str() {
        let trimmed = string.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Ok(parsed) = trimmed.parse::<f64>() {
            return parsed.is_finite().then_some(parsed);
        }
    }

    None
}

fn normalize_altitude_from_value(value: &Value) -> Option<f64> {
    if let Some(string) = value.as_str() {
        if string.trim().eq_ignore_ascii_case("ground") {
            return None;
        }
    }
    normalize_altitude_feet(to_finite_number_value(value)?)
}

async fn fetch_trace_history_for_hex(
    state: &AppState,
    base_url: &str,
    aircraft_hex: &str,
    history_cutoff_ms: i64,
) -> (String, Vec<TrafficHistoryPoint>) {
    let trace_hex = match normalize_trace_hex(aircraft_hex) {
        Some(value) => value,
        None => return (aircraft_hex.to_string(), Vec::new()),
    };

    let trace_url = format!(
        "{base_url}/data/traces/{}/trace_recent_{}.json",
        &trace_hex[trace_hex.len() - 2..],
        trace_hex
    );

    let response = match state
        .client
        .get(&trace_url)
        .headers(build_fetch_headers(base_url))
        .timeout(StdDuration::from_millis(TRACE_REQUEST_TIMEOUT_MS))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return (aircraft_hex.to_string(), Vec::new()),
    };

    if !response.status().is_success() {
        return (aircraft_hex.to_string(), Vec::new());
    }

    let payload = match response.json::<Value>().await {
        Ok(payload) => payload,
        Err(_) => return (aircraft_hex.to_string(), Vec::new()),
    };

    let base_timestamp_seconds = payload.get("timestamp").and_then(to_finite_number_value);
    let trace = payload
        .get("trace")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if base_timestamp_seconds.is_none() || trace.is_empty() {
        return (aircraft_hex.to_string(), Vec::new());
    }

    let base_timestamp_seconds = base_timestamp_seconds.unwrap_or_default();
    let mut points = Vec::new();

    for entry in trace {
        let values = match entry.as_array() {
            Some(values) if values.len() >= 4 => values,
            _ => continue,
        };

        let offset_seconds = values
            .get(0)
            .and_then(to_finite_number_value)
            .unwrap_or(f64::NAN);
        if !offset_seconds.is_finite() {
            continue;
        }

        let lat = normalize_lat(values.get(1).and_then(to_finite_number_value));
        let lon = normalize_lon(values.get(2).and_then(to_finite_number_value));
        if lat.is_none() || lon.is_none() {
            continue;
        }

        let altitude_feet = values.get(3).and_then(normalize_altitude_from_value);
        if altitude_feet.is_none() {
            continue;
        }

        let timestamp_ms =
            normalize_timestamp_ms((base_timestamp_seconds + offset_seconds) * 1000.0);
        let timestamp_ms = match timestamp_ms {
            Some(timestamp_ms) if timestamp_ms >= history_cutoff_ms => timestamp_ms,
            _ => continue,
        };

        points.push(TrafficHistoryPoint {
            lat: lat.unwrap_or_default(),
            lon: lon.unwrap_or_default(),
            altitude_feet: altitude_feet.unwrap_or_default(),
            timestamp_ms,
        });
    }

    points.sort_by_key(|point| point.timestamp_ms);
    if points.len() > TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT {
        let start = points.len() - TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT;
        points = points[start..].to_vec();
    }

    (aircraft_hex.to_string(), points)
}

async fn fetch_recent_trace_history(
    state: &AppState,
    base_url: &str,
    aircraft: &[Tar1090Aircraft],
    history_minutes: f64,
) -> HashMap<String, Vec<TrafficHistoryPoint>> {
    if history_minutes <= 0.0 {
        return HashMap::new();
    }

    let history_cutoff_ms = now_ms() - (history_minutes * 60_000.0) as i64;
    let limited_aircraft = &aircraft[..aircraft.len().min(TRACE_HISTORY_MAX_AIRCRAFT)];
    let mut history_by_hex = HashMap::new();

    let mut index = 0;
    while index < limited_aircraft.len() {
        let batch_end = (index + TRACE_HISTORY_BATCH_SIZE).min(limited_aircraft.len());
        let batch = &limited_aircraft[index..batch_end];
        let tasks = batch.iter().map(|entry| {
            fetch_trace_history_for_hex(state, base_url, &entry.hex, history_cutoff_ms)
        });
        let results = join_all(tasks).await;

        for (hex, points) in results {
            if points.is_empty() {
                continue;
            }
            history_by_hex.insert(hex, points);
        }

        index = batch_end;
    }

    history_by_hex
}

pub(crate) async fn get(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let lat = normalize_lat(to_finite_number(params.get("lat")));
    let lon = normalize_lon(to_finite_number(params.get("lon")));

    if lat.is_none() || lon.is_none() {
        let payload = serde_json::json!({
            "error": "Valid lat/lon query params are required."
        });
        return no_store_response(StatusCode::BAD_REQUEST, &payload, true);
    }

    let lat = lat.unwrap_or_default();
    let lon = lon.unwrap_or_default();

    let radius_nm = clamp(
        to_finite_number(params.get("radiusNm")).unwrap_or(DEFAULT_RADIUS_NM),
        MIN_RADIUS_NM,
        MAX_RADIUS_NM,
    );
    let limit = clamp_i64(
        to_finite_number(params.get("limit"))
            .unwrap_or(DEFAULT_LIMIT as f64)
            .floor() as i64,
        1,
        MAX_LIMIT as i64,
    ) as usize;

    let history_minutes = clamp(
        to_finite_number(params.get("historyMinutes")).unwrap_or(0.0),
        0.0,
        MAX_HISTORY_MINUTES,
    );

    let hide_ground_traffic =
        parse_boolean_query_param(params.get("hideGround"), DEFAULT_HIDE_GROUND_TRAFFIC);
    let bounds = build_bounding_box(lat, lon, radius_nm);

    match fetch_adsbx_traffic(&state, &bounds).await {
        Ok((aircraft, source, base_url)) => {
            let mut filtered_aircraft = aircraft
                .into_iter()
                .filter(|candidate| {
                    distance_nm(lat, lon, candidate.lat, candidate.lon) <= radius_nm
                        && (!hide_ground_traffic || !candidate.is_on_ground)
                })
                .collect::<Vec<_>>();

            filtered_aircraft.sort_by(|left, right| {
                let seen_left = left.last_seen_seconds.unwrap_or(f64::INFINITY);
                let seen_right = right.last_seen_seconds.unwrap_or(f64::INFINITY);
                seen_left
                    .partial_cmp(&seen_right)
                    .unwrap_or(Ordering::Equal)
            });
            let limited_aircraft = filtered_aircraft
                .into_iter()
                .take(limit)
                .collect::<Vec<_>>();

            let history_by_hex = if history_minutes > 0.0 {
                fetch_recent_trace_history(&state, &base_url, &limited_aircraft, history_minutes)
                    .await
            } else {
                HashMap::new()
            };

            let payload = TrafficSuccessPayload {
                source,
                fetched_at_ms: now_ms(),
                aircraft: limited_aircraft,
                history_by_hex,
            };
            no_store_response(StatusCode::OK, &payload, true)
        }
        Err(error) => {
            let payload = TrafficFailurePayload {
                source: None,
                fetched_at_ms: now_ms(),
                aircraft: Vec::new(),
                error: error.to_string(),
            };
            no_store_response(StatusCode::OK, &payload, true)
        }
    }
}
