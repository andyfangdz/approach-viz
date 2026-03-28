use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, params_from_iter, Connection};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, instrument, warn};

use super::memory_store::{
    CurrentSnapshot, HistoryPoint, TrackEntry, TrafficMemoryStore, PARTITION_BUCKET_MS,
};
use super::types::{
    distance_nm, is_sqlite_locked_error, now_ms, DbTrackState, PartitionInfo, QueryRequest,
    QueryResult, RingPartitionCache, TrafficAircraft,
};

const CACHE_RETENTION_MS: i64 = 60 * 60_000;
const RING_SLOT_COUNT: i64 = CACHE_RETENTION_MS / PARTITION_BUCKET_MS;
const WRITE_QUEUE_CAPACITY: usize = 256;
const WRITE_QUERY_LOCK_RETRIES: usize = 18;
const WRITE_QUERY_LOCK_RETRY_DELAY_MS: u64 = 50;
const WAL_CHECKPOINT_PASSIVE_BYTES: u64 = 8 * 1024 * 1024;
const WAL_CHECKPOINT_TRUNCATE_BYTES: u64 = 64 * 1024 * 1024;
const WAL_TRUNCATE_COOLDOWN_MS: i64 = 10 * 60_000;

const META_KEY_SOURCE: &str = "source";
const META_KEY_UPDATED_AT_MS: &str = "updated_at_ms";

pub struct TrafficStore {
    writer_tx: mpsc::Sender<WriteCommand>,
    memory: Arc<TrafficMemoryStore>,
}

impl TrafficStore {
    pub(crate) fn new(db_path: PathBuf) -> Result<Self, String> {
        let bootstrap_connection = open_traffic_db(&db_path)?;
        reconcile_partition_tables(&bootstrap_connection)?;

        let memory = Arc::new(TrafficMemoryStore::load_from_sqlite(&bootstrap_connection)?);
        drop(bootstrap_connection);

        let (writer_tx, writer_rx) = mpsc::channel::<WriteCommand>(WRITE_QUEUE_CAPACITY);
        spawn_writer_worker(db_path, writer_rx, Arc::clone(&memory));

        Ok(TrafficStore { writer_tx, memory })
    }

    pub(crate) async fn write_ingest(
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

    pub(crate) async fn write_wal_maintenance(&self, now_ms: i64) -> Result<(), String> {
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

fn spawn_writer_worker(
    db_path: PathBuf,
    mut receiver: mpsc::Receiver<WriteCommand>,
    memory: Arc<TrafficMemoryStore>,
) {
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
                        let result = ingest_snapshot(
                            &mut connection,
                            &memory,
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

#[instrument(
    name = "runtime.traffic.store.query",
    skip(store, request),
    fields(
        lat = request.lat,
        lon = request.lon,
        radius_nm = request.radius_nm,
        discovery_radius_nm = request.discovery_radius_nm,
        limit = request.limit,
        history_minutes = request.history_minutes,
        history_hex_count = request.history_hexes.len(),
        hide_ground_traffic = request.hide_ground_traffic
    )
)]
pub(crate) async fn query_store(
    store: &TrafficStore,
    request: QueryRequest,
) -> Result<QueryResult, String> {
    let memory = Arc::clone(&store.memory);
    tokio::task::spawn_blocking(move || Ok(memory.query(&request)))
        .await
        .map_err(|e| format!("Traffic query task panicked: {e}"))?
}

pub(crate) async fn ingest_to_store(
    store: &TrafficStore,
    source: String,
    aircraft: Vec<TrafficAircraft>,
    polled_at_ms: i64,
    run_retention_sweep: bool,
) -> Result<(), String> {
    store
        .write_ingest(source, aircraft, polled_at_ms, run_retention_sweep)
        .await
}

pub(crate) async fn wal_maintenance(store: &TrafficStore, now_ms: i64) -> Result<(), String> {
    store.write_wal_maintenance(now_ms).await
}

// ---------------------------------------------------------------------------
// Ingest: update memory first, then persist to SQLite
// ---------------------------------------------------------------------------

fn ingest_snapshot(
    connection: &mut Connection,
    memory: &TrafficMemoryStore,
    source: String,
    aircraft: Vec<TrafficAircraft>,
    polled_at_ms: i64,
    run_retention_sweep: bool,
) -> Result<(), String> {
    let retention_cutoff_ms = polled_at_ms - CACHE_RETENTION_MS;

    // ── Build new in-memory snapshot ────────────────────────────────
    let prev_snapshot = memory.current.load();

    let mut new_tracks = Vec::with_capacity(prev_snapshot.tracks.len());
    let mut new_by_hex = std::collections::HashMap::with_capacity(prev_snapshot.by_hex.len());
    let mut history_points: Vec<(String, HistoryPoint)> = Vec::new();

    // Carry forward all non-expired tracks from previous snapshot.
    for prev_track in &prev_snapshot.tracks {
        if prev_track.last_observed_at_ms < retention_cutoff_ms {
            continue;
        }
        new_by_hex.insert(prev_track.hex.clone(), new_tracks.len());
        new_tracks.push(prev_track.clone());
    }

    // Merge incoming aircraft.
    for candidate in &aircraft {
        let observed_at_ms = candidate
            .last_seen_seconds
            .map(|seconds| (polled_at_ms as f64 - seconds * 1000.0).round() as i64)
            .unwrap_or(polled_at_ms)
            .max(retention_cutoff_ms)
            .min(polled_at_ms);

        let track = if let Some(&idx) = new_by_hex.get(&candidate.hex) {
            let track = &mut new_tracks[idx];

            if let Some(flight) = candidate.flight.clone() {
                track.flight = Some(flight);
            }

            if observed_at_ms >= track.last_observed_at_ms {
                track.last_observed_at_ms = observed_at_ms;
                track.lat = candidate.lat;
                track.lon = candidate.lon;
                track.is_on_ground = candidate.is_on_ground;
                track.altitude_feet = candidate.altitude_feet.or(track.altitude_feet);
                track.ground_speed_kt = candidate.ground_speed_kt.or(track.ground_speed_kt);
                track.track_deg = candidate.track_deg.or(track.track_deg);
            } else {
                track.altitude_feet = track.altitude_feet.or(candidate.altitude_feet);
                track.ground_speed_kt = track.ground_speed_kt.or(candidate.ground_speed_kt);
                track.track_deg = track.track_deg.or(candidate.track_deg);
            }
            track
        } else {
            let idx = new_tracks.len();
            new_by_hex.insert(candidate.hex.clone(), idx);
            new_tracks.push(TrackEntry {
                hex: candidate.hex.clone(),
                flight: candidate.flight.clone(),
                lat: candidate.lat,
                lon: candidate.lon,
                is_on_ground: candidate.is_on_ground,
                altitude_feet: candidate.altitude_feet,
                ground_speed_kt: candidate.ground_speed_kt,
                track_deg: candidate.track_deg,
                last_observed_at_ms: observed_at_ms,
                last_point_ts_ms: None,
                last_point_lat: None,
                last_point_lon: None,
                last_point_altitude_feet: None,
                last_point_is_on_ground: None,
            });
            &mut new_tracks[idx]
        };

        let point_altitude_feet = track.altitude_feet.unwrap_or(0.0);
        let point_timestamp_ms = track
            .last_point_ts_ms
            .map(|last_ts| observed_at_ms.max(last_ts + 1))
            .unwrap_or(observed_at_ms);

        let should_append = match (
            track.last_point_ts_ms,
            track.last_point_lat,
            track.last_point_lon,
            track.last_point_altitude_feet,
            track.last_point_is_on_ground,
        ) {
            (
                Some(last_ts),
                Some(last_lat),
                Some(last_lon),
                Some(last_alt),
                Some(last_ground),
            ) => {
                point_timestamp_ms - last_ts >= 900
                    || distance_nm(last_lat, last_lon, candidate.lat, candidate.lon) >= 0.02
                    || (last_alt - point_altitude_feet).abs() >= 25.0
                    || last_ground != track.is_on_ground
            }
            _ => true,
        };

        if should_append {
            history_points.push((
                candidate.hex.clone(),
                HistoryPoint {
                    lat: candidate.lat,
                    lon: candidate.lon,
                    altitude_feet: point_altitude_feet,
                    timestamp_ms: point_timestamp_ms,
                    is_on_ground: track.is_on_ground,
                },
            ));
            track.last_point_ts_ms = Some(point_timestamp_ms);
            track.last_point_lat = Some(candidate.lat);
            track.last_point_lon = Some(candidate.lon);
            track.last_point_altitude_feet = Some(point_altitude_feet);
            track.last_point_is_on_ground = Some(track.is_on_ground);
        }
    }

    // ── Swap current snapshot (readers see this instantly) ───────────
    let new_snapshot = CurrentSnapshot {
        tracks: new_tracks,
        by_hex: new_by_hex,
        source: Some(source.clone()),
        fetched_at_ms: polled_at_ms,
    };
    memory.current.store(Arc::new(new_snapshot));

    // ── Append history points (write-lock ~100μs) ───────────────────
    {
        let mut ring = memory.history.write().expect("history lock poisoned");
        ring.rotate_if_needed(polled_at_ms);
        for (hex, point) in &history_points {
            ring.append_point(hex, point.clone());
        }
        if run_retention_sweep {
            ring.sweep_retention(retention_cutoff_ms);
        }
    }

    // ── Persist to SQLite (background, no readers depend on this) ───
    persist_to_sqlite(
        connection,
        &source,
        &aircraft,
        polled_at_ms,
        run_retention_sweep,
        retention_cutoff_ms,
    )?;

    Ok(())
}

fn persist_to_sqlite(
    connection: &mut Connection,
    source: &str,
    aircraft: &[TrafficAircraft],
    polled_at_ms: i64,
    run_retention_sweep: bool,
    retention_cutoff_ms: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    // Load existing tracks from SQLite for the merge (SQLite state tracks persistence).
    let hexes: Vec<String> = aircraft.iter().map(|a| a.hex.clone()).collect();
    let mut existing_tracks = load_existing_tracks(&transaction, &hexes)?;
    let mut partition_cache = load_partition_cache(&transaction)?;

    let mut last_history_table = String::new();

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
            let bkt = bucket_start_ms(point_timestamp_ms);
            let partition =
                ensure_partition_for_bucket(&transaction, &mut partition_cache, bkt)?;

            if partition.points_table != last_history_table {
                let sql = format!(
                    "INSERT INTO \"{}\" (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground) VALUES (?, ?, ?, ?, ?, ?)",
                    partition.points_table
                );
                transaction
                    .prepare_cached(&sql)
                    .map_err(|error| error.to_string())?;
                last_history_table = partition.points_table.clone();
            }
            {
                let mut stmt = transaction
                    .prepare_cached(&format!(
                        "INSERT INTO \"{}\" (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground) VALUES (?, ?, ?, ?, ?, ?)",
                        partition.points_table
                    ))
                    .map_err(|error| error.to_string())?;
                stmt.execute(params![
                    candidate.hex,
                    point_timestamp_ms,
                    candidate.lat,
                    candidate.lon,
                    point_altitude_feet,
                    if track.is_on_ground { 1_i64 } else { 0_i64 },
                ])
                .map_err(|error| error.to_string())?;
            }

            track.last_point_ts_ms = Some(point_timestamp_ms);
            track.last_point_lat = Some(candidate.lat);
            track.last_point_lon = Some(candidate.lon);
            track.last_point_altitude_feet = Some(point_altitude_feet);
            track.last_point_is_on_ground = Some(track.is_on_ground);
        }

        {
            let mut stmt = transaction
                .prepare_cached(
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
            stmt.execute(params![
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
    }

    if run_retention_sweep {
        sweep_expired_partitions(&transaction, retention_cutoff_ms)?;
        {
            let mut stmt = transaction
                .prepare_cached("DELETE FROM traffic_tracks WHERE last_observed_at_ms < ?")
                .map_err(|error| error.to_string())?;
            stmt.execute(params![retention_cutoff_ms])
                .map_err(|error| error.to_string())?;
        }
    }

    {
        let mut stmt = transaction
            .prepare_cached(
                "INSERT INTO traffic_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .map_err(|error| error.to_string())?;
        stmt.execute(params![META_KEY_SOURCE, source])
            .map_err(|error| error.to_string())?;
        stmt.execute(params![META_KEY_UPDATED_AT_MS, polled_at_ms.to_string()])
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// WAL maintenance
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SQLite schema and partition management
// ---------------------------------------------------------------------------

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

fn reconcile_partition_schema(
    connection: &Connection,
    partition: &PartitionInfo,
) -> Result<(), String> {
    let create_sql = partition_schema_sql(&partition.points_table);
    connection
        .execute_batch(&create_sql)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn partition_schema_sql(points_table: &str) -> String {
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
        CREATE INDEX IF NOT EXISTS \"idx_{points_table}_ts\" ON \"{points_table}\"(timestamp_ms);
        CREATE INDEX IF NOT EXISTS \"idx_{points_table}_hex_ts\" ON \"{points_table}\"(hex, timestamp_ms);",
        points_table = points_table,
    )
}

fn load_existing_tracks(
    connection: &Connection,
    hexes: &[String],
) -> Result<std::collections::HashMap<String, DbTrackState>, String> {
    let mut tracks = std::collections::HashMap::new();
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
    // Only clear the points table — R-tree tables are no longer created/maintained.
    // Tolerate missing R-tree tables from older schemas.
    let clear_sql = format!(
        "DELETE FROM \"{points_table}\";",
        points_table = partition.points_table,
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
            CREATE INDEX IF NOT EXISTS idx_traffic_tracks_last_seen ON traffic_tracks(last_observed_at_ms);
            CREATE INDEX IF NOT EXISTS idx_traffic_ring_slots_bucket ON traffic_ring_slots(bucket_start_ms);
            DROP TABLE IF EXISTS traffic_points;
            DROP TABLE IF EXISTS traffic_points_rtree;",
        )
        .map_err(|error| error.to_string())?;

    Ok(connection)
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

    let mut newest_by_slot: std::collections::HashMap<i64, (i64, String)> =
        std::collections::HashMap::new();
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

        let clear_sql = format!("DELETE FROM \"{ring_points_table}\";");
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

        let ring_rtree_table = partition_rtree_table_name(slot);
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
