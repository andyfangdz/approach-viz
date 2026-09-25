use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// Query policy, binCraft decoding, and AVTR encoding live in core so the web
// proxy's direct fallback reports current aircraft exactly as this service does.
pub use approach_viz_core::traffic_query::{
    box_param, build_bounding_box, clamp, distance_nm, merge_aircraft_candidate, BoundingBox,
    TrafficAircraft, TrafficBinaryPayload, TrafficHistoryPoint, CACHE_CURRENT_STALE_MS,
    MAX_RADIUS_NM, MIN_RADIUS_NM,
};

pub(crate) const HISTORY_MAX_POINTS_PER_AIRCRAFT: usize = 3_800;
pub(crate) const TRACE_HISTORY_DISCOVERY_MAX_SPEED_KT: f64 = 620.0;
pub(crate) const TRAFFIC_STALE_CURRENT_HEADER: &str =
    "x-approach-viz-traffic-stale-current";
pub(crate) const TRAFFIC_SNAPSHOT_AGE_MS_HEADER: &str =
    "x-approach-viz-traffic-snapshot-age-ms";

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrafficSuccessPayload {
    pub source: String,
    pub fetched_at_ms: i64,
    pub snapshot_age_ms: i64,
    pub stale_current: bool,
    pub aircraft: Vec<TrafficAircraft>,
    pub history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrafficErrorPayload {
    pub source: Option<String>,
    pub fetched_at_ms: i64,
    pub snapshot_age_ms: Option<i64>,
    pub stale_current: Option<bool>,
    pub aircraft: Vec<TrafficAircraft>,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct QueryRequest {
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
pub struct QueryResult {
    pub source: Option<String>,
    pub fetched_at_ms: i64,
    pub snapshot_age_ms: i64,
    pub stale_current: bool,
    pub aircraft: Vec<TrafficAircraft>,
    pub history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
    pub warming: bool,
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

#[derive(Debug, Default, Clone)]
pub(crate) struct RingPartitionCache {
    pub by_bucket_start_ms: HashMap<i64, PartitionInfo>,
    pub by_slot: HashMap<i64, PartitionInfo>,
}

pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    duration.as_millis().min(i64::MAX as u128) as i64
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

pub(crate) fn add_traffic_snapshot_headers(
    headers: &mut axum::http::HeaderMap,
    stale_current: bool,
    snapshot_age_ms: i64,
) {
    headers.insert(
        TRAFFIC_STALE_CURRENT_HEADER,
        axum::http::HeaderValue::from_static(if stale_current { "1" } else { "0" }),
    );
    if let Ok(value) = axum::http::HeaderValue::from_str(&snapshot_age_ms.max(0).to_string()) {
        headers.insert(TRAFFIC_SNAPSHOT_AGE_MS_HEADER, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approach_viz_core::traffic_query::parse_history_hexes;

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
