use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use tokio::time::{interval, MissedTickBehavior};
use tracing::warn;

use crate::storage::persist_traffic_cache;
use crate::types::{AppState, TrafficCachePoint, TrafficCacheState, TrafficCacheTrack};

const DEFAULT_RADIUS_NM: f64 = 80.0;
const MIN_RADIUS_NM: f64 = 5.0;
const MAX_RADIUS_NM: f64 = 220.0;
const DEFAULT_LIMIT: usize = 250;
const MAX_LIMIT: usize = 800;
const MAX_HISTORY_MINUTES: f64 = 60.0;
const HISTORY_MAX_AIRCRAFT: usize = 800;
const HISTORY_MAX_POINTS_PER_AIRCRAFT: usize = 3_800;
const REQUEST_TIMEOUT_MS: u64 = 5500;
const CACHE_POLL_INTERVAL_MS: u64 = 1000;
const CACHE_PERSIST_INTERVAL_MS: i64 = 5000;
const CACHE_RETENTION_MS: i64 = 60 * 60_000;
const CACHE_CURRENT_STALE_MS: i64 = 15_000;
const CACHE_MAX_POINTS_PER_TRACK: usize = 3_800;
const CACHE_MAX_TRACKS: usize = 30_000;
const TRACE_HISTORY_DISCOVERY_MAX_SPEED_KT: f64 = 620.0;
const BINCRAFT_MIN_STRIDE_BYTES: usize = 112;
const BINCRAFT_MAX_STRIDE_BYTES: usize = 256;
const BINCRAFT_S32_SEEN_VERSION: u32 = 20240218;
const DEFAULT_HIDE_GROUND_TRAFFIC: bool = false;
const EARTH_RADIUS_NM: f64 = 3440.065;

const US_FETCH_BOXES: [BoundingBox; 4] = [
    // CONUS
    BoundingBox {
        south: 23.0,
        north: 50.0,
        west: -127.0,
        east: -65.0,
    },
    // Alaska
    BoundingBox {
        south: 50.0,
        north: 72.0,
        west: -171.0,
        east: -129.0,
    },
    // Hawaii
    BoundingBox {
        south: 18.0,
        north: 23.5,
        west: -161.5,
        east: -153.5,
    },
    // Puerto Rico / USVI
    BoundingBox {
        south: 17.0,
        north: 19.5,
        west: -68.5,
        east: -64.0,
    },
];

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
    #[serde(rename = "historyHexes")]
    history_hexes: Option<String>,
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

pub fn spawn_traffic_cache_worker(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_millis(CACHE_POLL_INTERVAL_MS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut next_persist_at_ms = now_ms() + CACHE_PERSIST_INTERVAL_MS;

        loop {
            ticker.tick().await;
            let polled_at_ms = now_ms();
            match fetch_us_aircraft_snapshot(&state).await {
                Ok((source, aircraft)) => {
                    update_traffic_cache(&state, source, aircraft, polled_at_ms).await;
                }
                Err(error) => {
                    warn!("Traffic cache poll failed: {error}");
                }
            }

            let current_ms = now_ms();
            if current_ms >= next_persist_at_ms {
                if let Err(error) = persist_traffic_cache_to_disk(&state).await {
                    warn!("Traffic cache persist failed: {error}");
                }
                next_persist_at_ms = current_ms + CACHE_PERSIST_INTERVAL_MS;
            }
        }
    });
}

async fn persist_traffic_cache_to_disk(state: &AppState) -> Result<(), String> {
    let mut snapshot = state.traffic_cache.read().await.clone();
    sanitize_cache_retention(&mut snapshot, now_ms());
    persist_traffic_cache(&state.cfg, &snapshot)
        .await
        .map_err(|error| error.to_string())
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
    let history_hexes = parse_history_hexes(query.history_hexes.as_deref());

    let now_ms = now_ms();
    let history_discovery_radius_nm =
        history_discovery_radius_nm(radius_nm, history_minutes, &history_hexes);

    let cache = state.traffic_cache.read().await;
    if cache.tracks_by_hex.is_empty() {
        return (
            StatusCode::OK,
            no_store_headers(),
            Json(TrafficErrorPayload {
                source: cache.source.clone(),
                fetched_at_ms: cache.updated_at_ms.max(now_ms),
                aircraft: Vec::new(),
                error: "Traffic cache is warming up.".to_string(),
            }),
        )
            .into_response();
    }

    let source = cache
        .source
        .clone()
        .unwrap_or_else(|| "traffic-cache".to_string());
    let fetched_at_ms = cache.updated_at_ms.max(now_ms);

    let live_candidates = collect_current_aircraft_candidates(
        &cache,
        now_ms,
        lat,
        lon,
        history_discovery_radius_nm,
        hide_ground_traffic,
    );

    let mut aircraft = live_candidates
        .iter()
        .filter(|candidate| distance_nm(lat, lon, candidate.lat, candidate.lon) <= radius_nm)
        .cloned()
        .collect::<Vec<_>>();
    aircraft.sort_by(|left, right| {
        let left_seen = left.last_seen_seconds.unwrap_or(f64::INFINITY);
        let right_seen = right.last_seen_seconds.unwrap_or(f64::INFINITY);
        left_seen
            .partial_cmp(&right_seen)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                let left_distance = distance_nm(lat, lon, left.lat, left.lon);
                let right_distance = distance_nm(lat, lon, right.lat, right.lon);
                left_distance
                    .partial_cmp(&right_distance)
                    .unwrap_or(Ordering::Equal)
            })
    });
    aircraft.truncate(limit);

    let mut history_by_hex = HashMap::new();
    if history_minutes > 0.0 {
        let history_cutoff_ms = now_ms - (history_minutes * 60_000.0) as i64;
        let targets = if history_hexes.is_empty() {
            collect_history_target_hexes(
                &cache,
                now_ms,
                lat,
                lon,
                radius_nm,
                history_cutoff_ms,
                hide_ground_traffic,
            )
        } else {
            history_hexes
        };

        for hex in targets {
            let Some(track) = cache.tracks_by_hex.get(&hex) else {
                continue;
            };
            let mut points = track
                .points
                .iter()
                .filter(|point| point.timestamp_ms >= history_cutoff_ms)
                .filter(|point| !hide_ground_traffic || !point.is_on_ground)
                .map(|point| TrafficHistoryPoint {
                    lat: point.lat,
                    lon: point.lon,
                    altitude_feet: point.altitude_feet,
                    timestamp_ms: point.timestamp_ms,
                })
                .collect::<Vec<_>>();
            if points.is_empty() {
                continue;
            }
            points.sort_by_key(|point| point.timestamp_ms);
            if points.len() > HISTORY_MAX_POINTS_PER_AIRCRAFT {
                points = points[points.len() - HISTORY_MAX_POINTS_PER_AIRCRAFT..].to_vec();
            }
            history_by_hex.insert(hex, points);
        }

        history_by_hex
            .retain(|_, points| history_points_intersect_scene(points, lat, lon, radius_nm));
    }

    (
        StatusCode::OK,
        no_store_headers(),
        Json(TrafficSuccessPayload {
            source,
            fetched_at_ms,
            aircraft,
            history_by_hex,
        }),
    )
        .into_response()
}

fn collect_current_aircraft_candidates(
    cache: &TrafficCacheState,
    now_ms: i64,
    center_lat: f64,
    center_lon: f64,
    discovery_radius_nm: f64,
    hide_ground_traffic: bool,
) -> Vec<TrafficAircraft> {
    let stale_cutoff_ms = now_ms - CACHE_CURRENT_STALE_MS;
    let mut candidates = cache
        .tracks_by_hex
        .values()
        .filter_map(|track| {
            if track.last_observed_at_ms < stale_cutoff_ms {
                return None;
            }
            let last_point = track.points.back()?;
            if hide_ground_traffic && track.is_on_ground {
                return None;
            }
            let distance = distance_nm(center_lat, center_lon, last_point.lat, last_point.lon);
            if distance > discovery_radius_nm {
                return None;
            }

            let last_seen_seconds = ((now_ms - track.last_observed_at_ms).max(0) as f64) / 1000.0;
            Some(TrafficAircraft {
                hex: track.hex.clone(),
                flight: track.flight.clone(),
                lat: last_point.lat,
                lon: last_point.lon,
                is_on_ground: track.is_on_ground,
                altitude_feet: track.altitude_feet,
                ground_speed_kt: track.ground_speed_kt,
                track_deg: track.track_deg,
                last_seen_seconds: Some(last_seen_seconds),
            })
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        let left_distance = distance_nm(center_lat, center_lon, left.lat, left.lon);
        let right_distance = distance_nm(center_lat, center_lon, right.lat, right.lon);
        left_distance
            .partial_cmp(&right_distance)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                let left_seen = left.last_seen_seconds.unwrap_or(f64::INFINITY);
                let right_seen = right.last_seen_seconds.unwrap_or(f64::INFINITY);
                left_seen
                    .partial_cmp(&right_seen)
                    .unwrap_or(Ordering::Equal)
            })
    });

    candidates
}

fn collect_history_target_hexes(
    cache: &TrafficCacheState,
    now_ms: i64,
    center_lat: f64,
    center_lon: f64,
    radius_nm: f64,
    history_cutoff_ms: i64,
    hide_ground_traffic: bool,
) -> Vec<String> {
    let mut candidates = Vec::new();

    for track in cache.tracks_by_hex.values() {
        let mut intersects = false;
        let mut closest_distance_nm = f64::INFINITY;

        for point in track.points.iter().rev() {
            if point.timestamp_ms < history_cutoff_ms {
                break;
            }
            if hide_ground_traffic && point.is_on_ground {
                continue;
            }
            let distance = distance_nm(center_lat, center_lon, point.lat, point.lon);
            if distance <= radius_nm {
                intersects = true;
                closest_distance_nm = distance;
                break;
            }
        }

        if !intersects {
            continue;
        }

        let last_seen_seconds = ((now_ms - track.last_observed_at_ms).max(0) as f64) / 1000.0;
        candidates.push((
            track.hex.clone(),
            closest_distance_nm,
            last_seen_seconds,
            track.last_observed_at_ms,
        ));
    }

    candidates.sort_by(|left, right| {
        left.1
            .partial_cmp(&right.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.2.partial_cmp(&right.2).unwrap_or(Ordering::Equal))
            .then_with(|| right.3.cmp(&left.3))
    });

    candidates
        .into_iter()
        .take(HISTORY_MAX_AIRCRAFT)
        .map(|(hex, _, _, _)| hex)
        .collect()
}

async fn fetch_us_aircraft_snapshot(
    state: &AppState,
) -> Result<(String, Vec<TrafficAircraft>), String> {
    let futures = US_FETCH_BOXES
        .iter()
        .copied()
        .map(|bounds| fetch_adsbx_traffic(state, bounds));
    let results = join_all(futures).await;

    let mut by_hex = HashMap::new();
    let mut sources = HashSet::new();
    let mut errors = Vec::new();

    for result in results {
        match result {
            Ok((source, _base_url, aircraft)) => {
                sources.insert(source);
                for candidate in aircraft {
                    merge_aircraft_candidate(&mut by_hex, candidate);
                }
            }
            Err(error) => errors.push(error),
        }
    }

    if by_hex.is_empty() {
        return Err(errors.join(" | "));
    }

    let mut source_list = sources.into_iter().collect::<Vec<_>>();
    source_list.sort();
    Ok((
        format!("traffic-cache ({})", source_list.join(", ")),
        by_hex.into_values().collect(),
    ))
}

fn merge_aircraft_candidate(
    by_hex: &mut HashMap<String, TrafficAircraft>,
    candidate: TrafficAircraft,
) {
    match by_hex.get(&candidate.hex) {
        Some(current) => {
            let current_seen = current.last_seen_seconds.unwrap_or(f64::INFINITY);
            let candidate_seen = candidate.last_seen_seconds.unwrap_or(f64::INFINITY);
            if candidate_seen < current_seen {
                by_hex.insert(candidate.hex.clone(), candidate);
            }
        }
        None => {
            by_hex.insert(candidate.hex.clone(), candidate);
        }
    }
}

async fn update_traffic_cache(
    state: &AppState,
    source: String,
    aircraft: Vec<TrafficAircraft>,
    polled_at_ms: i64,
) {
    let retention_cutoff_ms = polled_at_ms - CACHE_RETENTION_MS;
    let mut cache = state.traffic_cache.write().await;
    cache.updated_at_ms = polled_at_ms;
    cache.source = Some(source);

    for candidate in aircraft {
        let observed_at_ms = candidate
            .last_seen_seconds
            .map(|seconds| (polled_at_ms as f64 - seconds * 1000.0).round() as i64)
            .unwrap_or(polled_at_ms)
            .max(retention_cutoff_ms)
            .min(polled_at_ms);

        let entry = cache
            .tracks_by_hex
            .entry(candidate.hex.clone())
            .or_insert_with(|| TrafficCacheTrack {
                hex: candidate.hex.clone(),
                flight: candidate.flight.clone(),
                is_on_ground: candidate.is_on_ground,
                altitude_feet: candidate.altitude_feet,
                ground_speed_kt: candidate.ground_speed_kt,
                track_deg: candidate.track_deg,
                last_observed_at_ms: observed_at_ms,
                points: std::collections::VecDeque::new(),
            });

        if let Some(flight) = candidate.flight {
            entry.flight = Some(flight);
        }
        entry.is_on_ground = candidate.is_on_ground;
        entry.altitude_feet = candidate.altitude_feet.or(entry.altitude_feet);
        entry.ground_speed_kt = candidate.ground_speed_kt.or(entry.ground_speed_kt);
        entry.track_deg = candidate.track_deg.or(entry.track_deg);
        if observed_at_ms > entry.last_observed_at_ms {
            entry.last_observed_at_ms = observed_at_ms;
        }

        let point_timestamp_ms = entry
            .points
            .back()
            .map(|point| (observed_at_ms).max(point.timestamp_ms + 1))
            .unwrap_or(observed_at_ms);

        let point_altitude_feet =
            entry
                .altitude_feet
                .unwrap_or(if entry.is_on_ground { 0.0 } else { 0.0 });

        let should_append = match entry.points.back() {
            Some(last) => {
                point_timestamp_ms - last.timestamp_ms >= 900
                    || distance_nm(last.lat, last.lon, candidate.lat, candidate.lon) >= 0.02
                    || (last.altitude_feet - point_altitude_feet).abs() >= 25.0
                    || last.is_on_ground != entry.is_on_ground
            }
            None => true,
        };

        if should_append {
            entry.points.push_back(TrafficCachePoint {
                timestamp_ms: point_timestamp_ms,
                lat: candidate.lat,
                lon: candidate.lon,
                altitude_feet: point_altitude_feet,
                is_on_ground: entry.is_on_ground,
            });
        }

        prune_track_points(entry, retention_cutoff_ms);
    }

    sanitize_cache_retention(&mut cache, polled_at_ms);
}

fn sanitize_cache_retention(cache: &mut TrafficCacheState, reference_ms: i64) {
    let retention_cutoff_ms = reference_ms - CACHE_RETENTION_MS;
    cache.tracks_by_hex.retain(|_, track| {
        prune_track_points(track, retention_cutoff_ms);
        !track.points.is_empty() || track.last_observed_at_ms >= retention_cutoff_ms
    });

    if cache.tracks_by_hex.len() > CACHE_MAX_TRACKS {
        let mut oldest_tracks = cache
            .tracks_by_hex
            .iter()
            .map(|(hex, track)| (hex.clone(), track.last_observed_at_ms))
            .collect::<Vec<_>>();
        oldest_tracks.sort_by_key(|(_, last_observed_at_ms)| *last_observed_at_ms);
        let remove_count = cache.tracks_by_hex.len().saturating_sub(CACHE_MAX_TRACKS);
        for (hex, _) in oldest_tracks.into_iter().take(remove_count) {
            cache.tracks_by_hex.remove(&hex);
        }
    }
}

fn prune_track_points(track: &mut TrafficCacheTrack, retention_cutoff_ms: i64) {
    while let Some(point) = track.points.front() {
        if point.timestamp_ms >= retention_cutoff_ms {
            break;
        }
        track.points.pop_front();
    }

    while track.points.len() > CACHE_MAX_POINTS_PER_TRACK {
        track.points.pop_front();
    }
}

async fn fetch_adsbx_traffic(
    state: &AppState,
    bounds: BoundingBox,
) -> Result<(String, String, Vec<TrafficAircraft>), String> {
    let mut errors = Vec::new();
    for base_url in state.cfg.traffic_base_urls() {
        let request_url = format!("{base_url}/re-api/?binCraft&zstd&box={}", box_param(bounds));
        match fetch_bincraft(state, &request_url, &base_url).await {
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

        merge_aircraft_candidate(&mut by_hex, aircraft);
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

fn parse_history_hexes(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut parsed = Vec::new();
    let mut seen = HashSet::new();
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
        if parsed.len() >= HISTORY_MAX_AIRCRAFT {
            break;
        }
    }
    parsed
}

fn history_discovery_radius_nm(
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

fn history_points_intersect_scene(
    points: &[TrafficHistoryPoint],
    center_lat: f64,
    center_lon: f64,
    radius_nm: f64,
) -> bool {
    points
        .iter()
        .any(|point| distance_nm(center_lat, center_lon, point.lat, point.lon) <= radius_nm)
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

fn box_param(bounds: BoundingBox) -> String {
    format!(
        "{:.6},{:.6},{:.6},{:.6}",
        bounds.south, bounds.north, bounds.west, bounds.east
    )
}

#[cfg(test)]
mod tests {
    use super::{
        history_discovery_radius_nm, history_points_intersect_scene, parse_history_hexes,
        TrafficHistoryPoint,
    };

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
    fn parse_history_hexes_dedupes_and_caps() {
        let parsed = parse_history_hexes(Some("ABC123,abc123,def456"));
        assert_eq!(parsed, vec!["abc123".to_string(), "def456".to_string()]);
    }
}
