use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub(crate) const DEFAULT_RADIUS_NM: f64 = 80.0;
pub(crate) const MIN_RADIUS_NM: f64 = 5.0;
pub(crate) const MAX_RADIUS_NM: f64 = 220.0;
pub(crate) const DEFAULT_LIMIT: usize = 250;
pub(crate) const MAX_LIMIT: usize = 800;
pub(crate) const MAX_HISTORY_MINUTES: f64 = 60.0;
pub(crate) const HISTORY_MAX_POINTS_PER_AIRCRAFT: usize = 3_800;
pub(crate) const DEFAULT_HIDE_GROUND_TRAFFIC: bool = false;
pub(crate) const EARTH_RADIUS_NM: f64 = 3440.065;
pub(crate) const TRACE_HISTORY_DISCOVERY_MAX_SPEED_KT: f64 = 620.0;
pub(crate) const CACHE_CURRENT_STALE_MS: i64 = 15_000;

#[derive(Debug, Deserialize)]
pub(crate) struct TrafficQuery {
    pub lat: Option<String>,
    pub lon: Option<String>,
    #[serde(rename = "radiusNm")]
    pub radius_nm: Option<String>,
    pub limit: Option<String>,
    #[serde(rename = "historyMinutes")]
    pub history_minutes: Option<String>,
    #[serde(rename = "historyHexes")]
    pub history_hexes: Option<String>,
    #[serde(rename = "hideGround")]
    pub hide_ground: Option<String>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrafficResponseFormat {
    Json,
    Binary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficAircraft {
    pub hex: String,
    pub flight: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub is_on_ground: bool,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub last_seen_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficHistoryPoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: f64,
    pub timestamp_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrafficSuccessPayload {
    pub source: String,
    pub fetched_at_ms: i64,
    pub aircraft: Vec<TrafficAircraft>,
    pub history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrafficErrorPayload {
    pub source: Option<String>,
    pub fetched_at_ms: i64,
    pub aircraft: Vec<TrafficAircraft>,
    pub error: String,
}

#[derive(Debug)]
pub struct TrafficBinaryPayload {
    pub source: Option<String>,
    pub fetched_at_ms: i64,
    pub aircraft: Vec<TrafficAircraft>,
    pub history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct BoundingBox {
    pub south: f64,
    pub north: f64,
    pub west: f64,
    pub east: f64,
    pub crosses_dateline: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct QueryRequest {
    pub lat: f64,
    pub lon: f64,
    pub radius_nm: f64,
    pub discovery_radius_nm: f64,
    pub limit: usize,
    pub history_minutes: f64,
    pub history_hexes: Vec<String>,
    pub hide_ground_traffic: bool,
    pub now_ms: i64,
}

#[derive(Debug)]
pub(crate) struct QueryResult {
    pub source: Option<String>,
    pub fetched_at_ms: i64,
    pub aircraft: Vec<TrafficAircraft>,
    pub history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
    pub warming: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct DbTrackState {
    pub flight: Option<String>,
    pub is_on_ground: bool,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub last_observed_at_ms: i64,
    pub last_lat: f64,
    pub last_lon: f64,
    pub last_point_ts_ms: Option<i64>,
    pub last_point_lat: Option<f64>,
    pub last_point_lon: Option<f64>,
    pub last_point_altitude_feet: Option<f64>,
    pub last_point_is_on_ground: Option<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct HistoryTargetCandidate {
    pub closest_distance_nm: f64,
    pub latest_timestamp_ms: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct PartitionInfo {
    pub slot: i64,
    pub bucket_start_ms: i64,
    pub points_table: String,
    pub rtree_table: String,
}

#[derive(Debug, Default)]
pub(crate) struct RingPartitionCache {
    pub by_bucket_start_ms: HashMap<i64, PartitionInfo>,
    pub by_slot: HashMap<i64, PartitionInfo>,
}

pub(crate) fn to_radians(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

pub fn distance_nm(lat_a: f64, lon_a: f64, lat_b: f64, lon_b: f64) -> f64 {
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

pub(crate) fn build_bounding_box(lat: f64, lon: f64, radius_nm: f64) -> BoundingBox {
    let lat_delta = radius_nm / 60.0;
    let lon_scale = lat.to_radians().cos().abs().max(0.01);
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

    let crosses_dateline = west > east;
    BoundingBox {
        south,
        north,
        west,
        east,
        crosses_dateline,
    }
}

pub(crate) fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

pub(crate) fn clamp_usize(value: i64, min: usize, max: usize) -> usize {
    (value.max(min as i64).min(max as i64)) as usize
}

pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    duration.as_millis().min(i64::MAX as u128) as i64
}

pub(crate) fn to_finite_number(value: Option<&str>) -> Option<f64> {
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

pub(crate) fn parse_boolean_query_param(value: Option<&str>, fallback: bool) -> bool {
    let Some(value) = value else {
        return fallback;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

pub(crate) fn parse_traffic_response_format(value: Option<&str>) -> TrafficResponseFormat {
    let Some(value) = value else {
        return TrafficResponseFormat::Json;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "binary" | "bin" | "avtr" => TrafficResponseFormat::Binary,
        _ => TrafficResponseFormat::Json,
    }
}

pub(crate) fn parse_history_hexes(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut parsed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for candidate in value.split(',') {
        let hex = candidate.trim();
        if hex.is_empty() {
            continue;
        }
        let normalized = hex.to_ascii_lowercase();
        if !seen.insert(normalized.clone()) {
            continue;
        }
        parsed.push(normalized);
    }
    parsed
}

pub(crate) fn normalize_lat(raw: Option<&str>) -> Option<f64> {
    let parsed = to_finite_number(raw)?;
    normalize_lat_value(parsed)
}

pub(crate) fn normalize_lon(raw: Option<&str>) -> Option<f64> {
    let parsed = to_finite_number(raw)?;
    normalize_lon_value(parsed)
}

pub(crate) fn normalize_lat_value(parsed: f64) -> Option<f64> {
    if (-90.0..=90.0).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

pub(crate) fn normalize_lon_value(parsed: f64) -> Option<f64> {
    if (-180.0..=180.0).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

pub(crate) fn normalize_heading_value(value: f64) -> Option<f64> {
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

pub(crate) fn normalize_callsign(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn normalize_speed_kt(value: f64) -> Option<f64> {
    if !value.is_finite() || !(0.0..=1800.0).contains(&value) {
        return None;
    }
    Some(value)
}

pub(crate) fn normalize_seen_seconds_value(value: f64) -> Option<f64> {
    if !value.is_finite() || !(0.0..=86_400.0).contains(&value) {
        return None;
    }
    Some(value)
}

pub(crate) fn normalize_altitude_feet_value(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    Some(clamp(value, -2000.0, 70_000.0))
}

pub(crate) fn history_discovery_radius_nm(
    radius_nm: f64,
    history_minutes: f64,
    requested_hexes: &[String],
) -> f64 {
    if history_minutes <= 0.0 || !requested_hexes.is_empty() {
        return radius_nm;
    }
    let expansion_nm = TRACE_HISTORY_DISCOVERY_MAX_SPEED_KT * (history_minutes / 60.0);
    clamp(radius_nm + expansion_nm, MIN_RADIUS_NM, MAX_RADIUS_NM)
}

pub(crate) fn history_points_intersect_scene(
    points: &[TrafficHistoryPoint],
    center_lat: f64,
    center_lon: f64,
    radius_nm: f64,
) -> bool {
    points
        .iter()
        .any(|point| distance_nm(center_lat, center_lon, point.lat, point.lon) <= radius_nm)
}

pub(crate) fn box_param(bounds: BoundingBox) -> String {
    format!(
        "{:.6},{:.6},{:.6},{:.6}",
        bounds.south, bounds.north, bounds.west, bounds.east
    )
}

pub(crate) fn is_sqlite_locked_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("database is locked") || normalized.contains("database schema is locked")
}

pub(crate) fn no_store_headers() -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store, max-age=0"),
    );
    headers
}

pub(crate) fn no_store_headers_with_content_type(content_type: &'static str) -> axum::http::HeaderMap {
    let mut headers = no_store_headers();
    headers.insert("content-type", axum::http::HeaderValue::from_static(content_type));
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_discovery_expands_radius_without_targeted_hexes() {
        let radius = history_discovery_radius_nm(80.0, 3.0, &[]);
        assert!(radius > 80.0);
        assert!(radius <= 220.0);
    }

    #[test]
    fn history_discovery_keeps_radius_for_targeted_hexes() {
        let radius = history_discovery_radius_nm(80.0, 10.0, &[String::from("aabbcc")]);
        assert_eq!(radius, 80.0);
    }

    #[test]
    fn history_intersection_requires_any_point_inside_scene_radius() {
        let points = vec![
            TrafficHistoryPoint {
                lat: 34.0,
                lon: -118.0,
                altitude_feet: 10000.0,
                timestamp_ms: 1,
            },
            TrafficHistoryPoint {
                lat: 40.66,
                lon: -73.78,
                altitude_feet: 5000.0,
                timestamp_ms: 2,
            },
        ];
        assert!(history_points_intersect_scene(
            &points, 40.6413, -73.7781, 10.0
        ));
        assert!(!history_points_intersect_scene(
            &points, 47.4502, -122.3088, 5.0
        ));
    }

    #[test]
    fn parse_history_hexes_dedupes() {
        let parsed = parse_history_hexes(Some("ABC123,abc123,def456"));
        assert_eq!(parsed, vec!["abc123".to_string(), "def456".to_string()]);
    }
}
