use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::future::join_all;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use tokio::task;
use tokio::time::{interval, MissedTickBehavior};
use tracing::warn;

use crate::types::AppState;

const DEFAULT_RADIUS_NM: f64 = 80.0;
const MIN_RADIUS_NM: f64 = 5.0;
const MAX_RADIUS_NM: f64 = 220.0;
const DEFAULT_LIMIT: usize = 250;
const MAX_LIMIT: usize = 800;
const MAX_HISTORY_MINUTES: f64 = 60.0;
const HISTORY_MAX_AIRCRAFT: usize = 800;
const HISTORY_MAX_POINTS_PER_AIRCRAFT: usize = 3_800;
const HISTORY_TARGET_SCAN_LIMIT: usize = 450_000;
const REQUEST_TIMEOUT_MS: u64 = 5500;
const CACHE_POLL_INTERVAL_MS: u64 = 1000;
const RETENTION_SWEEP_INTERVAL_MS: i64 = 15_000;
const CACHE_RETENTION_MS: i64 = 60 * 60_000;
const CACHE_CURRENT_STALE_MS: i64 = 15_000;
const TRACE_HISTORY_DISCOVERY_MAX_SPEED_KT: f64 = 620.0;
const BINCRAFT_MIN_STRIDE_BYTES: usize = 112;
const BINCRAFT_MAX_STRIDE_BYTES: usize = 256;
const BINCRAFT_S32_SEEN_VERSION: u32 = 20240218;
const DEFAULT_HIDE_GROUND_TRAFFIC: bool = false;
const EARTH_RADIUS_NM: f64 = 3440.065;

const META_KEY_SOURCE: &str = "source";
const META_KEY_UPDATED_AT_MS: &str = "updated_at_ms";

const US_FETCH_BOXES: [BoundingBox; 4] = [
    // CONUS
    BoundingBox {
        south: 23.0,
        north: 50.0,
        west: -127.0,
        east: -65.0,
        crosses_dateline: false,
    },
    // Alaska
    BoundingBox {
        south: 50.0,
        north: 72.0,
        west: -171.0,
        east: -129.0,
        crosses_dateline: false,
    },
    // Hawaii
    BoundingBox {
        south: 18.0,
        north: 23.5,
        west: -161.5,
        east: -153.5,
        crosses_dateline: false,
    },
    // Puerto Rico / USVI
    BoundingBox {
        south: 17.0,
        north: 19.5,
        west: -68.5,
        east: -64.0,
        crosses_dateline: false,
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
    crosses_dateline: bool,
}

#[derive(Debug, Clone)]
struct QueryRequest {
    lat: f64,
    lon: f64,
    radius_nm: f64,
    discovery_radius_nm: f64,
    limit: usize,
    history_minutes: f64,
    history_hexes: Vec<String>,
    hide_ground_traffic: bool,
    now_ms: i64,
}

#[derive(Debug)]
struct QueryResult {
    source: Option<String>,
    fetched_at_ms: i64,
    aircraft: Vec<TrafficAircraft>,
    history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
    warming: bool,
}

#[derive(Debug, Clone)]
struct DbTrackState {
    flight: Option<String>,
    is_on_ground: bool,
    altitude_feet: Option<f64>,
    ground_speed_kt: Option<f64>,
    track_deg: Option<f64>,
    last_observed_at_ms: i64,
    last_lat: f64,
    last_lon: f64,
    last_point_ts_ms: Option<i64>,
    last_point_lat: Option<f64>,
    last_point_lon: Option<f64>,
    last_point_altitude_feet: Option<f64>,
    last_point_is_on_ground: Option<bool>,
}

#[derive(Debug, Clone)]
struct HistoryTargetCandidate {
    closest_distance_nm: f64,
    latest_timestamp_ms: i64,
}

pub fn spawn_traffic_cache_worker(state: AppState) {
    tokio::spawn(async move {
        if let Err(error) = ensure_traffic_store(&state).await {
            warn!("Traffic store init failed: {error}");
        }

        let mut ticker = interval(Duration::from_millis(CACHE_POLL_INTERVAL_MS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut next_retention_sweep_at_ms = now_ms() + RETENTION_SWEEP_INTERVAL_MS;

        loop {
            ticker.tick().await;
            let polled_at_ms = now_ms();
            match fetch_us_aircraft_snapshot(&state).await {
                Ok((source, aircraft)) => {
                    let should_sweep = polled_at_ms >= next_retention_sweep_at_ms;
                    if should_sweep {
                        next_retention_sweep_at_ms = polled_at_ms + RETENTION_SWEEP_INTERVAL_MS;
                    }
                    if let Err(error) = ingest_snapshot_to_store(
                        &state,
                        source,
                        aircraft,
                        polled_at_ms,
                        should_sweep,
                    )
                    .await
                    {
                        warn!("Traffic store ingest failed: {error}");
                    }
                }
                Err(error) => {
                    warn!("Traffic cache poll failed: {error}");
                }
            }
        }
    });
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

    let query_result = query_store_snapshot(&state, request).await;
    match query_result {
        Ok(result) => {
            if result.warming {
                return (
                    StatusCode::OK,
                    no_store_headers(),
                    Json(TrafficErrorPayload {
                        source: result.source,
                        fetched_at_ms: result.fetched_at_ms,
                        aircraft: Vec::new(),
                        error: "Traffic cache is warming up.".to_string(),
                    }),
                )
                    .into_response();
            }

            (
                StatusCode::OK,
                no_store_headers(),
                Json(TrafficSuccessPayload {
                    source: result.source.unwrap_or_else(|| "traffic-store".to_string()),
                    fetched_at_ms: result.fetched_at_ms,
                    aircraft: result.aircraft,
                    history_by_hex: result.history_by_hex,
                }),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::OK,
            no_store_headers(),
            Json(TrafficErrorPayload {
                source: None,
                fetched_at_ms: now_ms,
                aircraft: Vec::new(),
                error,
            }),
        )
            .into_response(),
    }
}

async fn ensure_traffic_store(state: &AppState) -> Result<(), String> {
    let db_path = state.cfg.traffic_db_file();
    task::spawn_blocking(move || {
        let _connection = open_traffic_db(&db_path)?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn ingest_snapshot_to_store(
    state: &AppState,
    source: String,
    aircraft: Vec<TrafficAircraft>,
    polled_at_ms: i64,
    run_retention_sweep: bool,
) -> Result<(), String> {
    let db_path = state.cfg.traffic_db_file();
    task::spawn_blocking(move || {
        ingest_snapshot_to_store_blocking(
            &db_path,
            source,
            aircraft,
            polled_at_ms,
            run_retention_sweep,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn ingest_snapshot_to_store_blocking(
    db_path: &Path,
    source: String,
    aircraft: Vec<TrafficAircraft>,
    polled_at_ms: i64,
    run_retention_sweep: bool,
) -> Result<(), String> {
    let mut connection = open_traffic_db(db_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let hexes = aircraft
        .iter()
        .map(|candidate| candidate.hex.clone())
        .collect::<Vec<_>>();
    let mut existing_tracks = load_existing_tracks(&transaction, &hexes)?;

    let mut insert_point_stmt = transaction
        .prepare(
            "INSERT INTO traffic_points (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .map_err(|error| error.to_string())?;
    let mut insert_rtree_stmt = transaction
        .prepare(
            "INSERT INTO traffic_points_rtree (id, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?)",
        )
        .map_err(|error| error.to_string())?;
    let mut upsert_track_stmt = transaction
        .prepare(
            "INSERT INTO traffic_tracks (
                hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
                last_observed_at_ms, last_lat, last_lon,
                last_point_ts_ms, last_point_lat, last_point_lon, last_point_altitude_feet, last_point_is_on_ground
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hex) DO UPDATE SET
                flight = excluded.flight,
                is_on_ground = excluded.is_on_ground,
                altitude_feet = excluded.altitude_feet,
                ground_speed_kt = excluded.ground_speed_kt,
                track_deg = excluded.track_deg,
                last_observed_at_ms = excluded.last_observed_at_ms,
                last_lat = excluded.last_lat,
                last_lon = excluded.last_lon,
                last_point_ts_ms = excluded.last_point_ts_ms,
                last_point_lat = excluded.last_point_lat,
                last_point_lon = excluded.last_point_lon,
                last_point_altitude_feet = excluded.last_point_altitude_feet,
                last_point_is_on_ground = excluded.last_point_is_on_ground",
        )
        .map_err(|error| error.to_string())?;

    let retention_cutoff_ms = polled_at_ms - CACHE_RETENTION_MS;

    for candidate in aircraft {
        let observed_at_ms = candidate
            .last_seen_seconds
            .map(|seconds| (polled_at_ms as f64 - seconds * 1000.0).round() as i64)
            .unwrap_or(polled_at_ms)
            .max(retention_cutoff_ms)
            .min(polled_at_ms);

        let mut track = existing_tracks
            .remove(&candidate.hex)
            .unwrap_or(DbTrackState {
                flight: candidate.flight.clone(),
                is_on_ground: candidate.is_on_ground,
                altitude_feet: candidate.altitude_feet,
                ground_speed_kt: candidate.ground_speed_kt,
                track_deg: candidate.track_deg,
                last_observed_at_ms: observed_at_ms,
                last_lat: candidate.lat,
                last_lon: candidate.lon,
                last_point_ts_ms: None,
                last_point_lat: None,
                last_point_lon: None,
                last_point_altitude_feet: None,
                last_point_is_on_ground: None,
            });

        if let Some(flight) = candidate.flight.clone() {
            track.flight = Some(flight);
        }

        let previous_observed_at_ms = track.last_observed_at_ms;
        if observed_at_ms >= previous_observed_at_ms {
            track.last_observed_at_ms = observed_at_ms;
            track.last_lat = candidate.lat;
            track.last_lon = candidate.lon;
            track.is_on_ground = candidate.is_on_ground;
            track.altitude_feet = candidate.altitude_feet.or(track.altitude_feet);
            track.ground_speed_kt = candidate.ground_speed_kt.or(track.ground_speed_kt);
            track.track_deg = candidate.track_deg.or(track.track_deg);
        } else {
            track.altitude_feet = track.altitude_feet.or(candidate.altitude_feet);
            track.ground_speed_kt = track.ground_speed_kt.or(candidate.ground_speed_kt);
            track.track_deg = track.track_deg.or(candidate.track_deg);
        }

        let point_altitude_feet = track.altitude_feet.unwrap_or(0.0);
        let point_timestamp_ms = track
            .last_point_ts_ms
            .map(|last_timestamp_ms| observed_at_ms.max(last_timestamp_ms + 1))
            .unwrap_or(observed_at_ms);

        let should_append = match (
            track.last_point_ts_ms,
            track.last_point_lat,
            track.last_point_lon,
            track.last_point_altitude_feet,
            track.last_point_is_on_ground,
        ) {
            (
                Some(last_timestamp_ms),
                Some(last_lat),
                Some(last_lon),
                Some(last_altitude_feet),
                Some(last_is_on_ground),
            ) => {
                point_timestamp_ms - last_timestamp_ms >= 900
                    || distance_nm(last_lat, last_lon, candidate.lat, candidate.lon) >= 0.02
                    || (last_altitude_feet - point_altitude_feet).abs() >= 25.0
                    || last_is_on_ground != track.is_on_ground
            }
            _ => true,
        };

        if should_append {
            insert_point_stmt
                .execute(params![
                    candidate.hex,
                    point_timestamp_ms,
                    candidate.lat,
                    candidate.lon,
                    point_altitude_feet,
                    if track.is_on_ground { 1_i64 } else { 0_i64 },
                ])
                .map_err(|error| error.to_string())?;
            let point_id = transaction.last_insert_rowid();
            insert_rtree_stmt
                .execute(params![
                    point_id,
                    candidate.lat,
                    candidate.lat,
                    candidate.lon,
                    candidate.lon
                ])
                .map_err(|error| error.to_string())?;

            track.last_point_ts_ms = Some(point_timestamp_ms);
            track.last_point_lat = Some(candidate.lat);
            track.last_point_lon = Some(candidate.lon);
            track.last_point_altitude_feet = Some(point_altitude_feet);
            track.last_point_is_on_ground = Some(track.is_on_ground);
        }

        upsert_track_stmt
            .execute(params![
                candidate.hex,
                track.flight,
                if track.is_on_ground { 1_i64 } else { 0_i64 },
                track.altitude_feet,
                track.ground_speed_kt,
                track.track_deg,
                track.last_observed_at_ms,
                track.last_lat,
                track.last_lon,
                track.last_point_ts_ms,
                track.last_point_lat,
                track.last_point_lon,
                track.last_point_altitude_feet,
                track
                    .last_point_is_on_ground
                    .map(|value| if value { 1_i64 } else { 0_i64 }),
            ])
            .map_err(|error| error.to_string())?;
    }

    drop(insert_point_stmt);
    drop(insert_rtree_stmt);
    drop(upsert_track_stmt);

    if run_retention_sweep {
        transaction
            .execute(
                "DELETE FROM traffic_points_rtree WHERE id IN (SELECT id FROM traffic_points WHERE timestamp_ms < ?)",
                params![retention_cutoff_ms],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM traffic_points WHERE timestamp_ms < ?",
                params![retention_cutoff_ms],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM traffic_tracks WHERE last_observed_at_ms < ?",
                params![retention_cutoff_ms],
            )
            .map_err(|error| error.to_string())?;
    }

    upsert_meta_value(&transaction, META_KEY_SOURCE, &source)?;
    upsert_meta_value(
        &transaction,
        META_KEY_UPDATED_AT_MS,
        &polled_at_ms.to_string(),
    )?;

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn load_existing_tracks(
    connection: &Connection,
    hexes: &[String],
) -> Result<HashMap<String, DbTrackState>, String> {
    let mut tracks = HashMap::new();
    if hexes.is_empty() {
        return Ok(tracks);
    }

    for chunk in hexes.chunks(800) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT
                hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
                last_observed_at_ms, last_lat, last_lon,
                last_point_ts_ms, last_point_lat, last_point_lon, last_point_altitude_feet, last_point_is_on_ground
             FROM traffic_tracks
             WHERE hex IN ({placeholders})"
        );

        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(chunk.iter()), |row| {
                let hex: String = row.get(0)?;
                let is_on_ground: i64 = row.get(2)?;
                let last_point_is_on_ground: Option<i64> = row.get(13)?;
                Ok((
                    hex,
                    DbTrackState {
                        flight: row.get(1)?,
                        is_on_ground: is_on_ground == 1,
                        altitude_feet: row.get(3)?,
                        ground_speed_kt: row.get(4)?,
                        track_deg: row.get(5)?,
                        last_observed_at_ms: row.get(6)?,
                        last_lat: row.get(7)?,
                        last_lon: row.get(8)?,
                        last_point_ts_ms: row.get(9)?,
                        last_point_lat: row.get(10)?,
                        last_point_lon: row.get(11)?,
                        last_point_altitude_feet: row.get(12)?,
                        last_point_is_on_ground: last_point_is_on_ground.map(|value| value == 1),
                    },
                ))
            })
            .map_err(|error| error.to_string())?;

        for row in rows {
            let (hex, track) = row.map_err(|error| error.to_string())?;
            tracks.insert(hex, track);
        }
    }

    Ok(tracks)
}

fn upsert_meta_value(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO traffic_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn query_store_snapshot(
    state: &AppState,
    request: QueryRequest,
) -> Result<QueryResult, String> {
    let db_path = state.cfg.traffic_db_file();
    task::spawn_blocking(move || query_store_snapshot_blocking(&db_path, request))
        .await
        .map_err(|error| error.to_string())?
}

fn query_store_snapshot_blocking(
    db_path: &Path,
    request: QueryRequest,
) -> Result<QueryResult, String> {
    let connection = open_traffic_db(db_path)?;

    let source = read_meta_value(&connection, META_KEY_SOURCE)?;
    let fetched_at_ms = read_meta_value(&connection, META_KEY_UPDATED_AT_MS)?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(request.now_ms);

    let track_count: i64 = connection
        .query_row("SELECT COUNT(1) FROM traffic_tracks", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if track_count == 0 {
        return Ok(QueryResult {
            source,
            fetched_at_ms,
            aircraft: Vec::new(),
            history_by_hex: HashMap::new(),
            warming: true,
        });
    }

    let mut aircraft = query_current_aircraft_candidates(
        &connection,
        request.now_ms,
        request.lat,
        request.lon,
        request.discovery_radius_nm,
        request.hide_ground_traffic,
    )?;

    aircraft.retain(|candidate| {
        distance_nm(request.lat, request.lon, candidate.lat, candidate.lon) <= request.radius_nm
    });
    aircraft.sort_by(|left, right| {
        let left_seen = left.last_seen_seconds.unwrap_or(f64::INFINITY);
        let right_seen = right.last_seen_seconds.unwrap_or(f64::INFINITY);
        left_seen
            .partial_cmp(&right_seen)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                let left_distance = distance_nm(request.lat, request.lon, left.lat, left.lon);
                let right_distance = distance_nm(request.lat, request.lon, right.lat, right.lon);
                left_distance
                    .partial_cmp(&right_distance)
                    .unwrap_or(Ordering::Equal)
            })
    });
    aircraft.truncate(request.limit);

    let mut history_by_hex = HashMap::new();
    if request.history_minutes > 0.0 {
        let history_cutoff_ms = request.now_ms - (request.history_minutes * 60_000.0) as i64;
        let targets = if request.history_hexes.is_empty() {
            collect_history_target_hexes(
                &connection,
                request.lat,
                request.lon,
                request.radius_nm,
                history_cutoff_ms,
                request.hide_ground_traffic,
            )?
        } else {
            request.history_hexes
        };

        history_by_hex = load_history_points_for_hexes(
            &connection,
            &targets,
            history_cutoff_ms,
            request.hide_ground_traffic,
        )?;

        for points in history_by_hex.values_mut() {
            if points.len() > HISTORY_MAX_POINTS_PER_AIRCRAFT {
                *points = points[points.len() - HISTORY_MAX_POINTS_PER_AIRCRAFT..].to_vec();
            }
        }

        history_by_hex.retain(|_, points| {
            history_points_intersect_scene(points, request.lat, request.lon, request.radius_nm)
        });
    }

    Ok(QueryResult {
        source,
        fetched_at_ms,
        aircraft,
        history_by_hex,
        warming: false,
    })
}

fn query_current_aircraft_candidates(
    connection: &Connection,
    now_ms: i64,
    center_lat: f64,
    center_lon: f64,
    discovery_radius_nm: f64,
    hide_ground_traffic: bool,
) -> Result<Vec<TrafficAircraft>, String> {
    let stale_cutoff_ms = now_ms - CACHE_CURRENT_STALE_MS;
    let bounds = build_bounding_box(center_lat, center_lon, discovery_radius_nm);

    let mut statement = connection
        .prepare(
            "SELECT
                hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
                last_observed_at_ms, last_lat, last_lon
             FROM traffic_tracks
             WHERE last_observed_at_ms >= ?
               AND last_lat BETWEEN ? AND ?",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(
            params![stale_cutoff_ms, bounds.south, bounds.north],
            |row| {
                let is_on_ground: i64 = row.get(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    is_on_ground == 1,
                    row.get::<_, Option<f64>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, Option<f64>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, f64>(7)?,
                    row.get::<_, f64>(8)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;

    let mut candidates = Vec::new();
    for row in rows {
        let (
            hex,
            flight,
            is_on_ground,
            altitude_feet,
            ground_speed_kt,
            track_deg,
            observed_at_ms,
            lat,
            lon,
        ) = row.map_err(|error| error.to_string())?;
        if hide_ground_traffic && is_on_ground {
            continue;
        }
        if bounds.crosses_dateline {
            if !((lon >= bounds.west && lon <= 180.0) || (lon >= -180.0 && lon <= bounds.east)) {
                continue;
            }
        } else if lon < bounds.west || lon > bounds.east {
            continue;
        }

        let distance = distance_nm(center_lat, center_lon, lat, lon);
        if distance > discovery_radius_nm {
            continue;
        }

        let last_seen_seconds = ((now_ms - observed_at_ms).max(0) as f64) / 1000.0;
        candidates.push(TrafficAircraft {
            hex,
            flight,
            lat,
            lon,
            is_on_ground,
            altitude_feet,
            ground_speed_kt,
            track_deg,
            last_seen_seconds: Some(last_seen_seconds),
        });
    }

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

    Ok(candidates)
}

fn collect_history_target_hexes(
    connection: &Connection,
    center_lat: f64,
    center_lon: f64,
    radius_nm: f64,
    history_cutoff_ms: i64,
    hide_ground_traffic: bool,
) -> Result<Vec<String>, String> {
    let bounds = build_bounding_box(center_lat, center_lon, radius_nm);
    let mut candidates: HashMap<String, HistoryTargetCandidate> = HashMap::new();

    let mut process_row =
        |hex: String, lat: f64, lon: f64, timestamp_ms: i64, is_on_ground_raw: i64| {
            let is_on_ground = is_on_ground_raw == 1;
            if hide_ground_traffic && is_on_ground {
                return;
            }

            let distance = distance_nm(center_lat, center_lon, lat, lon);
            if distance > radius_nm {
                return;
            }

            match candidates.get_mut(&hex) {
                Some(existing) => {
                    if distance < existing.closest_distance_nm {
                        existing.closest_distance_nm = distance;
                    }
                    if timestamp_ms > existing.latest_timestamp_ms {
                        existing.latest_timestamp_ms = timestamp_ms;
                    }
                }
                None => {
                    candidates.insert(
                        hex,
                        HistoryTargetCandidate {
                            closest_distance_nm: distance,
                            latest_timestamp_ms: timestamp_ms,
                        },
                    );
                }
            }
        };

    if bounds.crosses_dateline {
        let mut statement = connection
            .prepare(
                "SELECT p.hex, p.lat, p.lon, p.timestamp_ms, p.is_on_ground
                 FROM traffic_points p
                 JOIN traffic_points_rtree r ON r.id = p.id
                 WHERE p.timestamp_ms >= ?
                   AND r.min_lat <= ?
                   AND r.max_lat >= ?
                 ORDER BY p.timestamp_ms DESC
                 LIMIT ?",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    history_cutoff_ms,
                    bounds.north,
                    bounds.south,
                    HISTORY_TARGET_SCAN_LIMIT as i64,
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (hex, lat, lon, timestamp_ms, is_on_ground_raw) =
                row.map_err(|error| error.to_string())?;
            process_row(hex, lat, lon, timestamp_ms, is_on_ground_raw);
        }
    } else {
        let mut statement = connection
            .prepare(
                "SELECT p.hex, p.lat, p.lon, p.timestamp_ms, p.is_on_ground
                 FROM traffic_points p
                 JOIN traffic_points_rtree r ON r.id = p.id
                 WHERE p.timestamp_ms >= ?
                   AND r.min_lat <= ?
                   AND r.max_lat >= ?
                   AND r.min_lon <= ?
                   AND r.max_lon >= ?
                 ORDER BY p.timestamp_ms DESC
                 LIMIT ?",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    history_cutoff_ms,
                    bounds.north,
                    bounds.south,
                    bounds.east,
                    bounds.west,
                    HISTORY_TARGET_SCAN_LIMIT as i64,
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (hex, lat, lon, timestamp_ms, is_on_ground_raw) =
                row.map_err(|error| error.to_string())?;
            process_row(hex, lat, lon, timestamp_ms, is_on_ground_raw);
        }
    }

    let mut ranked = candidates.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        left.1
            .closest_distance_nm
            .partial_cmp(&right.1.closest_distance_nm)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.1.latest_timestamp_ms.cmp(&left.1.latest_timestamp_ms))
    });

    Ok(ranked
        .into_iter()
        .take(HISTORY_MAX_AIRCRAFT)
        .map(|(hex, _)| hex)
        .collect())
}

fn load_history_points_for_hexes(
    connection: &Connection,
    hexes: &[String],
    history_cutoff_ms: i64,
    hide_ground_traffic: bool,
) -> Result<HashMap<String, Vec<TrafficHistoryPoint>>, String> {
    let mut by_hex: HashMap<String, Vec<TrafficHistoryPoint>> = HashMap::new();
    if hexes.is_empty() {
        return Ok(by_hex);
    }

    for chunk in hexes.chunks(700) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");

        let mut sql = format!(
            "SELECT hex, lat, lon, altitude_feet, timestamp_ms, is_on_ground
             FROM traffic_points
             WHERE timestamp_ms >= ?
               AND hex IN ({placeholders})"
        );
        if hide_ground_traffic {
            sql.push_str(" AND is_on_ground = 0");
        }
        sql.push_str(" ORDER BY hex ASC, timestamp_ms ASC");

        let mut values = Vec::with_capacity(chunk.len() + 1);
        values.push(Value::Integer(history_cutoff_ms));
        for hex in chunk {
            values.push(Value::Text(hex.clone()));
        }

        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(values.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    TrafficHistoryPoint {
                        lat: row.get(1)?,
                        lon: row.get(2)?,
                        altitude_feet: row.get(3)?,
                        timestamp_ms: row.get(4)?,
                    },
                ))
            })
            .map_err(|error| error.to_string())?;

        for row in rows {
            let (hex, point) = row.map_err(|error| error.to_string())?;
            by_hex.entry(hex).or_default().push(point);
        }
    }

    Ok(by_hex)
}

fn read_meta_value(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    let result = connection.query_row(
        "SELECT value FROM traffic_meta WHERE key = ?",
        params![key],
        |row| row.get::<_, String>(0),
    );

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn open_traffic_db(path: &Path) -> Result<Connection, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid traffic DB path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .map_err(|error| error.to_string())?;

    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS traffic_tracks (
                hex TEXT PRIMARY KEY,
                flight TEXT,
                is_on_ground INTEGER NOT NULL,
                altitude_feet REAL,
                ground_speed_kt REAL,
                track_deg REAL,
                last_observed_at_ms INTEGER NOT NULL,
                last_lat REAL NOT NULL,
                last_lon REAL NOT NULL,
                last_point_ts_ms INTEGER,
                last_point_lat REAL,
                last_point_lon REAL,
                last_point_altitude_feet REAL,
                last_point_is_on_ground INTEGER
            );
            CREATE TABLE IF NOT EXISTS traffic_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hex TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                altitude_feet REAL NOT NULL,
                is_on_ground INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS traffic_points_rtree USING rtree(
                id,
                min_lat,
                max_lat,
                min_lon,
                max_lon
            );
            CREATE TABLE IF NOT EXISTS traffic_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_traffic_tracks_last_seen ON traffic_tracks(last_observed_at_ms);
            CREATE INDEX IF NOT EXISTS idx_traffic_points_ts ON traffic_points(timestamp_ms);
            CREATE INDEX IF NOT EXISTS idx_traffic_points_hex_ts ON traffic_points(hex, timestamp_ms);",
        )
        .map_err(|error| error.to_string())?;

    Ok(connection)
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
        format!("traffic-store ({})", source_list.join(", ")),
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
                ));
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

fn build_bounding_box(lat: f64, lon: f64, radius_nm: f64) -> BoundingBox {
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
