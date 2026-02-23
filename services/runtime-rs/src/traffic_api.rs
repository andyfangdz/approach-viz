use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::future::join_all;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{info, warn};

use crate::types::AppState;

const DEFAULT_RADIUS_NM: f64 = 80.0;
const MIN_RADIUS_NM: f64 = 5.0;
const MAX_RADIUS_NM: f64 = 220.0;
const DEFAULT_LIMIT: usize = 250;
const MAX_LIMIT: usize = 800;
const MAX_HISTORY_MINUTES: f64 = 60.0;
const HISTORY_MAX_POINTS_PER_AIRCRAFT: usize = 3_800;
const REQUEST_TIMEOUT_MS: u64 = 5500;
const CACHE_POLL_INTERVAL_MS: u64 = 1000;
const RETENTION_SWEEP_INTERVAL_MS: i64 = 5 * 60_000;
const CACHE_RETENTION_MS: i64 = 60 * 60_000;
const CACHE_CURRENT_STALE_MS: i64 = 15_000;
const TRACE_HISTORY_DISCOVERY_MAX_SPEED_KT: f64 = 620.0;
const BINCRAFT_MIN_STRIDE_BYTES: usize = 112;
const BINCRAFT_MAX_STRIDE_BYTES: usize = 256;
const BINCRAFT_S32_SEEN_VERSION: u32 = 20240218;
const DEFAULT_HIDE_GROUND_TRAFFIC: bool = false;
const EARTH_RADIUS_NM: f64 = 3440.065;
const PARTITION_BUCKET_MS: i64 = 5 * 60_000;
const RING_SLOT_COUNT: i64 = CACHE_RETENTION_MS / PARTITION_BUCKET_MS;
const WRITE_QUEUE_CAPACITY: usize = 256;
const READ_QUEUE_CAPACITY: usize = 128;
const READ_POOL_SIZE: usize = 3;
const READ_BUSY_TIMEOUT_MS: u64 = 500;
const READ_QUERY_LOCK_RETRIES: usize = 18;
const READ_QUERY_LOCK_RETRY_DELAY_MS: u64 = 25;
const WRITE_QUERY_LOCK_RETRIES: usize = 18;
const WRITE_QUERY_LOCK_RETRY_DELAY_MS: u64 = 50;
const WAL_MAINTENANCE_INTERVAL_MS: i64 = 60_000;
const WAL_CHECKPOINT_PASSIVE_BYTES: u64 = 8 * 1024 * 1024;
const WAL_CHECKPOINT_TRUNCATE_BYTES: u64 = 64 * 1024 * 1024;
const WAL_TRUNCATE_COOLDOWN_MS: i64 = 10 * 60_000;

const META_KEY_SOURCE: &str = "source";
const META_KEY_UPDATED_AT_MS: &str = "updated_at_ms";

static TRAFFIC_STORE: OnceLock<Arc<TrafficStore>> = OnceLock::new();
static TRAFFIC_STORE_INIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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

#[derive(Debug, Clone)]
struct PartitionInfo {
    slot: i64,
    bucket_start_ms: i64,
    points_table: String,
    rtree_table: String,
}

#[derive(Debug, Default)]
struct RingPartitionCache {
    by_bucket_start_ms: HashMap<i64, PartitionInfo>,
    by_slot: HashMap<i64, PartitionInfo>,
}

struct TrafficStore {
    writer_tx: mpsc::Sender<WriteCommand>,
    reader_txs: Vec<mpsc::Sender<ReadCommand>>,
    next_reader: AtomicUsize,
}

impl TrafficStore {
    async fn write_ingest(
        &self,
        source: String,
        aircraft: Vec<TrafficAircraft>,
        polled_at_ms: i64,
        run_retention_sweep: bool,
    ) -> Result<(), String> {
        let (response_tx, response_rx) = oneshot::channel();
        self.writer_tx
            .send(WriteCommand::Ingest {
                source,
                aircraft,
                polled_at_ms,
                run_retention_sweep,
                response: response_tx,
            })
            .await
            .map_err(|_| "Traffic store writer is unavailable".to_string())?;

        response_rx
            .await
            .map_err(|_| "Traffic store writer dropped response".to_string())?
    }

    async fn read_query(&self, request: QueryRequest) -> Result<QueryResult, String> {
        let (response_tx, response_rx) = oneshot::channel();
        let reader_idx =
            self.next_reader.fetch_add(1, AtomicOrdering::Relaxed) % self.reader_txs.len();
        self.reader_txs[reader_idx]
            .send(ReadCommand::Query {
                request,
                response: response_tx,
            })
            .await
            .map_err(|_| "Traffic store reader is unavailable".to_string())?;

        response_rx
            .await
            .map_err(|_| "Traffic store reader dropped response".to_string())?
    }

    async fn write_wal_maintenance(&self, now_ms: i64) -> Result<(), String> {
        let (response_tx, response_rx) = oneshot::channel();
        self.writer_tx
            .send(WriteCommand::WalMaintenance {
                now_ms,
                response: response_tx,
            })
            .await
            .map_err(|_| "Traffic store writer is unavailable".to_string())?;

        response_rx
            .await
            .map_err(|_| "Traffic store writer dropped response".to_string())?
    }
}

enum WriteCommand {
    Ingest {
        source: String,
        aircraft: Vec<TrafficAircraft>,
        polled_at_ms: i64,
        run_retention_sweep: bool,
        response: oneshot::Sender<Result<(), String>>,
    },
    WalMaintenance {
        now_ms: i64,
        response: oneshot::Sender<Result<(), String>>,
    },
}

enum ReadCommand {
    Query {
        request: QueryRequest,
        response: oneshot::Sender<Result<QueryResult, String>>,
    },
}

pub fn spawn_traffic_cache_worker(state: AppState) {
    tokio::spawn(async move {
        if let Err(error) = ensure_traffic_store(&state).await {
            warn!("Traffic store init failed: {error}");
            return;
        }

        let mut ticker = interval(Duration::from_millis(CACHE_POLL_INTERVAL_MS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut next_retention_sweep_at_ms = now_ms() + RETENTION_SWEEP_INTERVAL_MS;
        let mut next_wal_maintenance_at_ms = now_ms() + WAL_MAINTENANCE_INTERVAL_MS;

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

            if polled_at_ms >= next_wal_maintenance_at_ms {
                next_wal_maintenance_at_ms = polled_at_ms + WAL_MAINTENANCE_INTERVAL_MS;
                if let Err(error) = run_wal_maintenance_to_store(&state, polled_at_ms).await {
                    warn!("Traffic WAL maintenance failed: {error}");
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
    let _ = traffic_store(state.cfg.traffic_db_file())?;
    Ok(())
}

fn traffic_store(db_path: PathBuf) -> Result<Arc<TrafficStore>, String> {
    if let Some(existing) = TRAFFIC_STORE.get() {
        return Ok(existing.clone());
    }

    let init_lock = TRAFFIC_STORE_INIT_LOCK.get_or_init(|| Mutex::new(()));
    let _init_guard = init_lock
        .lock()
        .map_err(|_| "Traffic store init lock is poisoned".to_string())?;
    if let Some(existing) = TRAFFIC_STORE.get() {
        return Ok(existing.clone());
    }

    let store = Arc::new(create_traffic_store(db_path)?);
    if TRAFFIC_STORE.set(store.clone()).is_err() {
        if let Some(existing) = TRAFFIC_STORE.get() {
            return Ok(existing.clone());
        }
    }

    Ok(store)
}

fn create_traffic_store(db_path: PathBuf) -> Result<TrafficStore, String> {
    // Bootstrap schema/migration up-front.
    let bootstrap_connection = open_traffic_db(&db_path)?;
    reconcile_tracks_rtree(&bootstrap_connection)?;
    reconcile_partition_tables(&bootstrap_connection)?;
    drop(bootstrap_connection);

    let (writer_tx, writer_rx) = mpsc::channel::<WriteCommand>(WRITE_QUEUE_CAPACITY);
    spawn_writer_worker(db_path.clone(), writer_rx);

    let mut reader_txs = Vec::new();
    for worker_idx in 0..READ_POOL_SIZE {
        let (reader_tx, reader_rx) = mpsc::channel::<ReadCommand>(READ_QUEUE_CAPACITY);
        spawn_reader_worker(db_path.clone(), worker_idx, reader_rx);
        reader_txs.push(reader_tx);
    }

    Ok(TrafficStore {
        writer_tx,
        reader_txs,
        next_reader: AtomicUsize::new(0),
    })
}

fn reconcile_partition_tables(connection: &Connection) -> Result<(), String> {
    if RING_SLOT_COUNT <= 0 {
        return Err("RING_SLOT_COUNT must be positive".to_string());
    }

    connection
        .execute(
            "DELETE FROM traffic_ring_slots WHERE slot < 0 OR slot >= ?",
            params![RING_SLOT_COUNT],
        )
        .map_err(|error| error.to_string())?;

    for slot in 0..RING_SLOT_COUNT {
        let points_table = partition_points_table_name(slot);
        let rtree_table = partition_rtree_table_name(slot);
        let partition = PartitionInfo {
            slot,
            bucket_start_ms: -1,
            points_table: points_table.clone(),
            rtree_table: rtree_table.clone(),
        };
        reconcile_partition_schema(connection, &partition)?;

        connection
            .execute(
                "INSERT INTO traffic_ring_slots (slot, bucket_start_ms, points_table, rtree_table)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(slot) DO UPDATE SET
                     points_table = excluded.points_table,
                     rtree_table = excluded.rtree_table",
                params![slot, -1_i64, points_table, rtree_table],
            )
            .map_err(|error| error.to_string())?;
    }

    migrate_legacy_partitions_to_ring(connection)?;

    Ok(())
}

fn reconcile_tracks_rtree(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "INSERT OR IGNORE INTO traffic_tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
             SELECT t.rowid, t.last_lat, t.last_lat, t.last_lon, t.last_lon
             FROM traffic_tracks t
             LEFT JOIN traffic_tracks_rtree r ON r.id = t.rowid
             WHERE r.id IS NULL;",
        )
        .map_err(|error| error.to_string())
}

fn migrate_legacy_partitions_to_ring(connection: &Connection) -> Result<(), String> {
    let ring_rows: i64 = connection
        .query_row(
            "SELECT COUNT(1) FROM traffic_ring_slots WHERE bucket_start_ms >= 0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if ring_rows > 0 {
        return Ok(());
    }

    let retention_cutoff_ms = now_ms() - CACHE_RETENTION_MS;
    let min_bucket_start_ms = bucket_start_ms(retention_cutoff_ms);

    let mut statement = connection
        .prepare(
            "SELECT bucket_start_ms, points_table
             FROM traffic_partitions
             WHERE bucket_start_ms >= ?
             ORDER BY bucket_start_ms ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![min_bucket_start_ms], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;

    let legacy_rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if legacy_rows.is_empty() {
        return Ok(());
    }

    let mut newest_by_slot: HashMap<i64, (i64, String)> = HashMap::new();
    for (bucket_start_ms, points_table) in legacy_rows {
        if !points_table.starts_with("traffic_points_p") {
            continue;
        }
        let slot = ring_slot_for_bucket(bucket_start_ms);
        match newest_by_slot.get(&slot) {
            Some((existing_bucket_start_ms, _)) if *existing_bucket_start_ms >= bucket_start_ms => {
            }
            _ => {
                newest_by_slot.insert(slot, (bucket_start_ms, points_table));
            }
        }
    }

    let mut migrated_slots = 0usize;
    for (slot, (bucket_start_ms, legacy_points_table)) in newest_by_slot {
        let ring_points_table = partition_points_table_name(slot);
        let ring_rtree_table = partition_rtree_table_name(slot);

        let clear_sql =
            format!("DELETE FROM \"{ring_rtree_table}\"; DELETE FROM \"{ring_points_table}\";",);
        if let Err(error) = connection.execute_batch(&clear_sql) {
            warn!(
                "Failed clearing ring slot {} before legacy migration: {}",
                slot, error
            );
            continue;
        }

        let copy_sql = format!(
            "INSERT INTO \"{ring_points_table}\" (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground)
             SELECT hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground
             FROM \"{legacy_points_table}\"
             WHERE timestamp_ms >= ?",
        );
        if let Err(error) = connection.execute(&copy_sql, params![retention_cutoff_ms]) {
            warn!(
                "Failed migrating legacy table {} into ring slot {}: {}",
                legacy_points_table, slot, error
            );
            continue;
        }

        if let Err(error) = connection.execute(
            "UPDATE traffic_ring_slots
             SET bucket_start_ms = ?, points_table = ?, rtree_table = ?
             WHERE slot = ?",
            params![bucket_start_ms, ring_points_table, ring_rtree_table, slot,],
        ) {
            warn!(
                "Failed updating ring slot {} metadata during legacy migration: {}",
                slot, error
            );
            continue;
        }

        migrated_slots += 1;
    }

    if migrated_slots > 0 {
        info!(
            "Migrated {} legacy traffic partition(s) into fixed ring slots.",
            migrated_slots
        );
    }

    Ok(())
}

fn reconcile_partition_schema(
    connection: &Connection,
    partition: &PartitionInfo,
) -> Result<(), String> {
    let create_sql = partition_schema_sql(&partition.points_table, &partition.rtree_table);
    connection
        .execute_batch(&create_sql)
        .map_err(|error| error.to_string())?;

    let backfill_sql = format!(
        "INSERT OR IGNORE INTO \"{rtree_table}\" (id, min_lat, max_lat, min_lon, max_lon)
         SELECT p.id, p.lat, p.lat, p.lon, p.lon
         FROM \"{points_table}\" p
         LEFT JOIN \"{rtree_table}\" r ON r.id = p.id
         WHERE r.id IS NULL;",
        points_table = partition.points_table,
        rtree_table = partition.rtree_table,
    );
    connection
        .execute_batch(&backfill_sql)
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn partition_schema_sql(points_table: &str, rtree_table: &str) -> String {
    let trigger_insert = format!("trg_{points_table}_rtree_insert");
    let trigger_update = format!("trg_{points_table}_rtree_update");
    let trigger_delete = format!("trg_{points_table}_rtree_delete");

    format!(
        "CREATE TABLE IF NOT EXISTS \"{points_table}\" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hex TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            altitude_feet REAL NOT NULL,
            is_on_ground INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS \"{rtree_table}\" USING rtree(
            id,
            min_lat,
            max_lat,
            min_lon,
            max_lon
        );
        CREATE INDEX IF NOT EXISTS \"idx_{points_table}_ts\" ON \"{points_table}\"(timestamp_ms);
        CREATE INDEX IF NOT EXISTS \"idx_{points_table}_hex_ts\" ON \"{points_table}\"(hex, timestamp_ms);
        CREATE TRIGGER IF NOT EXISTS \"{trigger_insert}\" AFTER INSERT ON \"{points_table}\"
        BEGIN
            DELETE FROM \"{rtree_table}\" WHERE id = new.id;
            INSERT INTO \"{rtree_table}\" (id, min_lat, max_lat, min_lon, max_lon)
            VALUES (new.id, new.lat, new.lat, new.lon, new.lon);
        END;
        CREATE TRIGGER IF NOT EXISTS \"{trigger_update}\" AFTER UPDATE OF lat, lon ON \"{points_table}\"
        BEGIN
            DELETE FROM \"{rtree_table}\" WHERE id = new.id;
            INSERT INTO \"{rtree_table}\" (id, min_lat, max_lat, min_lon, max_lon)
            VALUES (new.id, new.lat, new.lat, new.lon, new.lon);
        END;
        CREATE TRIGGER IF NOT EXISTS \"{trigger_delete}\" AFTER DELETE ON \"{points_table}\"
        BEGIN
            DELETE FROM \"{rtree_table}\" WHERE id = old.id;
        END;",
        points_table = points_table,
        rtree_table = rtree_table,
        trigger_insert = trigger_insert,
        trigger_update = trigger_update,
        trigger_delete = trigger_delete,
    )
}

fn spawn_writer_worker(db_path: PathBuf, mut receiver: mpsc::Receiver<WriteCommand>) {
    tokio::task::spawn_blocking(move || {
        let mut connection = match open_traffic_db(&db_path) {
            Ok(connection) => connection,
            Err(error) => {
                while let Some(command) = receiver.blocking_recv() {
                    match command {
                        WriteCommand::Ingest { response, .. } => {
                            let _ = response.send(Err(format!(
                                "Traffic writer failed to open DB {}: {error}",
                                db_path.display()
                            )));
                        }
                        WriteCommand::WalMaintenance { response, .. } => {
                            let _ = response.send(Err(format!(
                                "Traffic writer failed to open DB {}: {error}",
                                db_path.display()
                            )));
                        }
                    }
                }
                return;
            }
        };
        let mut last_wal_truncate_at_ms = 0_i64;

        while let Some(command) = receiver.blocking_recv() {
            match command {
                WriteCommand::Ingest {
                    source,
                    aircraft,
                    polled_at_ms,
                    run_retention_sweep,
                    response,
                } => {
                    let mut attempts = 0usize;
                    let result = loop {
                        let result = ingest_snapshot_with_connection(
                            &mut connection,
                            source.clone(),
                            aircraft.clone(),
                            polled_at_ms,
                            run_retention_sweep,
                        );
                        if let Err(error) = &result {
                            if is_sqlite_locked_error(error) && attempts < WRITE_QUERY_LOCK_RETRIES
                            {
                                attempts += 1;
                                std::thread::sleep(Duration::from_millis(
                                    WRITE_QUERY_LOCK_RETRY_DELAY_MS,
                                ));
                                continue;
                            }
                        }
                        break result;
                    };
                    let _ = response.send(result);
                }
                WriteCommand::WalMaintenance { now_ms, response } => {
                    let result = run_wal_maintenance_with_connection(
                        &connection,
                        &db_path,
                        now_ms,
                        &mut last_wal_truncate_at_ms,
                    );
                    let _ = response.send(result);
                }
            }
        }
    });
}

fn spawn_reader_worker(
    db_path: PathBuf,
    worker_idx: usize,
    mut receiver: mpsc::Receiver<ReadCommand>,
) {
    tokio::task::spawn_blocking(move || {
        let connection = match open_traffic_db(&db_path) {
            Ok(connection) => connection,
            Err(error) => {
                while let Some(command) = receiver.blocking_recv() {
                    let ReadCommand::Query { response, .. } = command;
                    let _ = response.send(Err(format!(
                        "Traffic reader #{worker_idx} failed to open DB {}: {error}",
                        db_path.display()
                    )));
                }
                return;
            }
        };
        if let Err(error) = connection.busy_timeout(Duration::from_millis(READ_BUSY_TIMEOUT_MS)) {
            while let Some(command) = receiver.blocking_recv() {
                let ReadCommand::Query { response, .. } = command;
                let _ = response.send(Err(format!(
                    "Traffic reader #{worker_idx} failed to set busy timeout: {error}"
                )));
            }
            return;
        }

        while let Some(command) = receiver.blocking_recv() {
            match command {
                ReadCommand::Query { request, response } => {
                    let mut attempts = 0usize;
                    let result = loop {
                        let result = query_store_snapshot_blocking(&connection, request.clone());
                        if let Err(error) = &result {
                            if is_sqlite_locked_error(error) && attempts < READ_QUERY_LOCK_RETRIES {
                                attempts += 1;
                                std::thread::sleep(Duration::from_millis(
                                    READ_QUERY_LOCK_RETRY_DELAY_MS,
                                ));
                                continue;
                            }
                        }
                        break result;
                    };
                    let _ = response.send(result);
                }
            }
        }
    });
}

async fn ingest_snapshot_to_store(
    state: &AppState,
    source: String,
    aircraft: Vec<TrafficAircraft>,
    polled_at_ms: i64,
    run_retention_sweep: bool,
) -> Result<(), String> {
    let store = traffic_store(state.cfg.traffic_db_file())?;
    store
        .write_ingest(source, aircraft, polled_at_ms, run_retention_sweep)
        .await
}

async fn run_wal_maintenance_to_store(state: &AppState, now_ms: i64) -> Result<(), String> {
    let store = traffic_store(state.cfg.traffic_db_file())?;
    store.write_wal_maintenance(now_ms).await
}

fn ingest_snapshot_with_connection(
    connection: &mut Connection,
    source: String,
    aircraft: Vec<TrafficAircraft>,
    polled_at_ms: i64,
    run_retention_sweep: bool,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let hexes = aircraft
        .iter()
        .map(|candidate| candidate.hex.clone())
        .collect::<Vec<_>>();
    let mut existing_tracks = load_existing_tracks(&transaction, &hexes)?;
    let mut partition_cache = load_partition_cache(&transaction)?;

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
            let bucket_start_ms = bucket_start_ms(point_timestamp_ms);
            let partition =
                ensure_partition_for_bucket(&transaction, &mut partition_cache, bucket_start_ms)?;

            let insert_point_sql = format!(
                "INSERT INTO \"{}\" (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground) VALUES (?, ?, ?, ?, ?, ?)",
                partition.points_table
            );
            transaction
                .execute(
                    &insert_point_sql,
                    params![
                        candidate.hex,
                        point_timestamp_ms,
                        candidate.lat,
                        candidate.lon,
                        point_altitude_feet,
                        if track.is_on_ground { 1_i64 } else { 0_i64 },
                    ],
                )
                .map_err(|error| error.to_string())?;

            track.last_point_ts_ms = Some(point_timestamp_ms);
            track.last_point_lat = Some(candidate.lat);
            track.last_point_lon = Some(candidate.lon);
            track.last_point_altitude_feet = Some(point_altitude_feet);
            track.last_point_is_on_ground = Some(track.is_on_ground);
        }

        transaction
            .execute(
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
                params![
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
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    if run_retention_sweep {
        sweep_expired_partitions(&transaction, retention_cutoff_ms)?;
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

fn run_wal_maintenance_with_connection(
    connection: &Connection,
    db_path: &Path,
    now_ms: i64,
    last_truncate_at_ms: &mut i64,
) -> Result<(), String> {
    let wal_path = db_path.with_extension("db-wal");
    let wal_size = std::fs::metadata(&wal_path)
        .ok()
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    if wal_size < WAL_CHECKPOINT_PASSIVE_BYTES {
        return Ok(());
    }

    let (passive_busy, passive_frames, passive_checkpointed): (i64, i64, i64) = connection
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;

    info!(
        "Traffic WAL checkpoint(PASSIVE): busy={}, frames={}, checkpointed={}, wal_bytes_before={}",
        passive_busy, passive_frames, passive_checkpointed, wal_size
    );

    if wal_size < WAL_CHECKPOINT_TRUNCATE_BYTES {
        return Ok(());
    }
    if now_ms.saturating_sub(*last_truncate_at_ms) < WAL_TRUNCATE_COOLDOWN_MS {
        return Ok(());
    }

    let (truncate_busy, truncate_frames, truncate_checkpointed): (i64, i64, i64) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;

    info!(
        "Traffic WAL checkpoint(TRUNCATE): busy={}, frames={}, checkpointed={}, wal_bytes_before={}",
        truncate_busy, truncate_frames, truncate_checkpointed, wal_size
    );

    if truncate_busy == 0 {
        *last_truncate_at_ms = now_ms;
    }

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

fn load_partition_cache(connection: &Connection) -> Result<RingPartitionCache, String> {
    let mut cache = RingPartitionCache::default();
    let mut statement = connection
        .prepare(
            "SELECT slot, bucket_start_ms, points_table, rtree_table
             FROM traffic_ring_slots
             WHERE bucket_start_ms >= 0",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok(PartitionInfo {
                slot: row.get(0)?,
                bucket_start_ms: row.get(1)?,
                points_table: row.get(2)?,
                rtree_table: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;

    for row in rows {
        let partition = row.map_err(|error| error.to_string())?;
        cache
            .by_bucket_start_ms
            .insert(partition.bucket_start_ms, partition.clone());
        cache.by_slot.insert(partition.slot, partition);
    }

    Ok(cache)
}

fn ensure_partition_for_bucket(
    connection: &Connection,
    cache: &mut RingPartitionCache,
    bucket_start_ms: i64,
) -> Result<PartitionInfo, String> {
    if let Some(existing) = cache.by_bucket_start_ms.get(&bucket_start_ms) {
        return Ok(existing.clone());
    }

    let slot = ring_slot_for_bucket(bucket_start_ms);
    let points_table = partition_points_table_name(slot);
    let rtree_table = partition_rtree_table_name(slot);

    let partition = PartitionInfo {
        slot,
        bucket_start_ms,
        points_table,
        rtree_table,
    };

    if let Some(existing_slot) = cache.by_slot.get(&slot).cloned() {
        if existing_slot.bucket_start_ms != bucket_start_ms {
            clear_ring_slot(connection, &existing_slot)?;
            cache
                .by_bucket_start_ms
                .remove(&existing_slot.bucket_start_ms);
        }
    }

    connection
        .execute(
            "UPDATE traffic_ring_slots
             SET bucket_start_ms = ?, points_table = ?, rtree_table = ?
             WHERE slot = ?",
            params![
                partition.bucket_start_ms,
                partition.points_table,
                partition.rtree_table,
                partition.slot
            ],
        )
        .map_err(|error| error.to_string())?;

    cache
        .by_bucket_start_ms
        .insert(bucket_start_ms, partition.clone());
    cache.by_slot.insert(slot, partition.clone());
    Ok(partition)
}

fn sweep_expired_partitions(
    connection: &Connection,
    retention_cutoff_ms: i64,
) -> Result<(), String> {
    let keep_from_bucket_ms = bucket_start_ms(retention_cutoff_ms);

    let mut statement = connection
        .prepare(
            "SELECT slot, bucket_start_ms, points_table, rtree_table
             FROM traffic_ring_slots
             WHERE bucket_start_ms >= 0
               AND bucket_start_ms < ?",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![keep_from_bucket_ms], |row| {
            Ok(PartitionInfo {
                slot: row.get(0)?,
                bucket_start_ms: row.get(1)?,
                points_table: row.get(2)?,
                rtree_table: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;

    let expired = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for partition in expired {
        clear_ring_slot(connection, &partition)?;
        connection
            .execute(
                "UPDATE traffic_ring_slots
                 SET bucket_start_ms = -1
                 WHERE slot = ?",
                params![partition.slot],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn clear_ring_slot(connection: &Connection, partition: &PartitionInfo) -> Result<(), String> {
    let clear_sql = format!(
        "DELETE FROM \"{rtree_table}\"; DELETE FROM \"{points_table}\";",
        points_table = partition.points_table,
        rtree_table = partition.rtree_table,
    );
    connection
        .execute_batch(&clear_sql)
        .map_err(|error| error.to_string())
}

fn partition_points_table_name(slot: i64) -> String {
    format!("traffic_points_ring_s{slot}")
}

fn partition_rtree_table_name(slot: i64) -> String {
    format!("traffic_points_ring_s{slot}_rtree")
}

fn ring_slot_for_bucket(bucket_start_ms: i64) -> i64 {
    (bucket_start_ms / PARTITION_BUCKET_MS).rem_euclid(RING_SLOT_COUNT)
}

fn bucket_start_ms(timestamp_ms: i64) -> i64 {
    if timestamp_ms < 0 {
        return 0;
    }
    (timestamp_ms / PARTITION_BUCKET_MS) * PARTITION_BUCKET_MS
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
    let store = traffic_store(state.cfg.traffic_db_file())?;
    store.read_query(request).await
}

fn query_store_snapshot_blocking(
    connection: &Connection,
    request: QueryRequest,
) -> Result<QueryResult, String> {
    let source = read_meta_value(connection, META_KEY_SOURCE)?;
    let fetched_at_ms = read_meta_value(connection, META_KEY_UPDATED_AT_MS)?
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
        connection,
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
        let partitions = history_partitions(connection, history_cutoff_ms)?;

        let targets = if request.history_hexes.is_empty() {
            collect_history_target_hexes(
                connection,
                &partitions,
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
            connection,
            &partitions,
            &targets,
            history_cutoff_ms,
            request.hide_ground_traffic,
        )?;

        for points in history_by_hex.values_mut() {
            points.sort_by_key(|point| point.timestamp_ms);
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

fn history_partitions(
    connection: &Connection,
    history_cutoff_ms: i64,
) -> Result<Vec<PartitionInfo>, String> {
    let min_bucket_start_ms = bucket_start_ms(history_cutoff_ms);
    let mut statement = connection
        .prepare(
            "SELECT slot, bucket_start_ms, points_table, rtree_table
             FROM traffic_ring_slots
             WHERE bucket_start_ms >= 0
               AND bucket_start_ms >= ?
             ORDER BY bucket_start_ms ASC",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![min_bucket_start_ms], |row| {
            Ok(PartitionInfo {
                slot: row.get(0)?,
                bucket_start_ms: row.get(1)?,
                points_table: row.get(2)?,
                rtree_table: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
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

    let mut candidates = Vec::new();

    if bounds.crosses_dateline {
        let mut statement = connection
            .prepare(
                "SELECT
                    t.hex, t.flight, t.is_on_ground, t.altitude_feet, t.ground_speed_kt, t.track_deg,
                    t.last_observed_at_ms, t.last_lat, t.last_lon
                 FROM traffic_tracks t
                 JOIN traffic_tracks_rtree r ON r.id = t.rowid
                 WHERE t.last_observed_at_ms >= ?
                   AND r.min_lat <= ?
                   AND r.max_lat >= ?
                   AND ((r.min_lon <= 180.0 AND r.max_lon >= ?)
                     OR (r.min_lon <= ? AND r.max_lon >= -180.0))",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map(
                params![
                    stale_cutoff_ms,
                    bounds.north,
                    bounds.south,
                    bounds.west,
                    bounds.east,
                ],
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
    } else {
        let mut statement = connection
            .prepare(
                "SELECT
                    t.hex, t.flight, t.is_on_ground, t.altitude_feet, t.ground_speed_kt, t.track_deg,
                    t.last_observed_at_ms, t.last_lat, t.last_lon
                 FROM traffic_tracks t
                 JOIN traffic_tracks_rtree r ON r.id = t.rowid
                 WHERE t.last_observed_at_ms >= ?
                   AND r.min_lat <= ?
                   AND r.max_lat >= ?
                   AND r.min_lon <= ?
                   AND r.max_lon >= ?",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map(
                params![
                    stale_cutoff_ms,
                    bounds.north,
                    bounds.south,
                    bounds.east,
                    bounds.west,
                ],
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
    partitions: &[PartitionInfo],
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

    for partition in partitions.iter().rev() {
        let sql = if bounds.crosses_dateline {
            format!(
                "SELECT p.hex, p.lat, p.lon, p.timestamp_ms, p.is_on_ground
                 FROM \"{points_table}\" p
                 JOIN \"{rtree_table}\" r ON r.id = p.id
                 WHERE p.timestamp_ms >= ?
                   AND r.min_lat <= ?
                   AND r.max_lat >= ?
                   AND ((r.min_lon <= 180.0 AND r.max_lon >= ?)
                     OR (r.min_lon <= ? AND r.max_lon >= -180.0))
                 ORDER BY p.timestamp_ms DESC",
                points_table = partition.points_table,
                rtree_table = partition.rtree_table,
            )
        } else {
            format!(
                "SELECT p.hex, p.lat, p.lon, p.timestamp_ms, p.is_on_ground
                 FROM \"{points_table}\" p
                 JOIN \"{rtree_table}\" r ON r.id = p.id
                 WHERE p.timestamp_ms >= ?
                   AND r.min_lat <= ?
                   AND r.max_lat >= ?
                   AND r.min_lon <= ?
                   AND r.max_lon >= ?
                 ORDER BY p.timestamp_ms DESC",
                points_table = partition.points_table,
                rtree_table = partition.rtree_table,
            )
        };

        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        if bounds.crosses_dateline {
            let rows = statement
                .query_map(
                    params![
                        history_cutoff_ms,
                        bounds.north,
                        bounds.south,
                        bounds.west,
                        bounds.east,
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
            let rows = statement
                .query_map(
                    params![
                        history_cutoff_ms,
                        bounds.north,
                        bounds.south,
                        bounds.east,
                        bounds.west,
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
    }

    let mut ranked = candidates.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        left.1
            .closest_distance_nm
            .partial_cmp(&right.1.closest_distance_nm)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.1.latest_timestamp_ms.cmp(&left.1.latest_timestamp_ms))
    });

    Ok(ranked.into_iter().map(|(hex, _)| hex).collect())
}

fn load_history_points_for_hexes(
    connection: &Connection,
    partitions: &[PartitionInfo],
    hexes: &[String],
    history_cutoff_ms: i64,
    hide_ground_traffic: bool,
) -> Result<HashMap<String, Vec<TrafficHistoryPoint>>, String> {
    let mut by_hex: HashMap<String, Vec<TrafficHistoryPoint>> = HashMap::new();
    if hexes.is_empty() || partitions.is_empty() {
        return Ok(by_hex);
    }

    for partition in partitions {
        for chunk in hexes.chunks(700) {
            let placeholders = std::iter::repeat("?")
                .take(chunk.len())
                .collect::<Vec<_>>()
                .join(", ");

            let mut sql = format!(
                "SELECT hex, lat, lon, altitude_feet, timestamp_ms, is_on_ground
                 FROM \"{}\"
                 WHERE timestamp_ms >= ?
                   AND hex IN ({placeholders})",
                partition.points_table
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
        .pragma_update(None, "wal_autocheckpoint", 2000_i64)
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(
            None,
            "journal_size_limit",
            WAL_CHECKPOINT_TRUNCATE_BYTES as i64,
        )
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
            CREATE TABLE IF NOT EXISTS traffic_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS traffic_partitions (
                bucket_start_ms INTEGER PRIMARY KEY,
                points_table TEXT NOT NULL,
                rtree_table TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS traffic_ring_slots (
                slot INTEGER PRIMARY KEY,
                bucket_start_ms INTEGER NOT NULL,
                points_table TEXT NOT NULL,
                rtree_table TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS traffic_tracks_rtree USING rtree(
                id,
                min_lat,
                max_lat,
                min_lon,
                max_lon
            );
            CREATE TRIGGER IF NOT EXISTS trg_traffic_tracks_rtree_insert AFTER INSERT ON traffic_tracks
            BEGIN
                DELETE FROM traffic_tracks_rtree WHERE id = new.rowid;
                INSERT INTO traffic_tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
                VALUES (new.rowid, new.last_lat, new.last_lat, new.last_lon, new.last_lon);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_traffic_tracks_rtree_update AFTER UPDATE OF last_lat, last_lon ON traffic_tracks
            BEGIN
                DELETE FROM traffic_tracks_rtree WHERE id = new.rowid;
                INSERT INTO traffic_tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
                VALUES (new.rowid, new.last_lat, new.last_lat, new.last_lon, new.last_lon);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_traffic_tracks_rtree_delete AFTER DELETE ON traffic_tracks
            BEGIN
                DELETE FROM traffic_tracks_rtree WHERE id = old.rowid;
            END;
            CREATE INDEX IF NOT EXISTS idx_traffic_tracks_last_seen ON traffic_tracks(last_observed_at_ms);
            CREATE INDEX IF NOT EXISTS idx_traffic_tracks_live ON traffic_tracks(last_observed_at_ms, last_lat, last_lon);
            CREATE INDEX IF NOT EXISTS idx_traffic_ring_slots_bucket ON traffic_ring_slots(bucket_start_ms);
            DROP TABLE IF EXISTS traffic_points;
            DROP TABLE IF EXISTS traffic_points_rtree;",
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

fn is_sqlite_locked_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("database is locked") || normalized.contains("database schema is locked")
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
    fn parse_history_hexes_dedupes() {
        let parsed = parse_history_hexes(Some("ABC123,abc123,def456"));
        assert_eq!(parsed, vec!["abc123".to_string(), "def456".to_string()]);
    }
}
