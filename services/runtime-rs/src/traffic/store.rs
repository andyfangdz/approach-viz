use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, CachedStatement, Connection};
use rustc_hash::FxHashMap;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, instrument};

use super::memory_store::{
    load_tracks, CurrentSnapshot, HistoryPoint, TrackEntry, TrafficMemoryStore,
    PARTITION_BUCKET_MS,
};
use super::types::{
    distance_nm, is_sqlite_locked_error, PartitionInfo, QueryRequest, QueryResult,
    RingPartitionCache, TrafficAircraft,
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
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
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
        let mut persisted = match PersistedState::load(&connection) {
            Ok(persisted) => persisted,
            Err(error) => {
                while let Some(command) = receiver.blocking_recv() {
                    let message = format!("Traffic writer failed to load persisted state: {error}");
                    match command {
                        WriteCommand::Ingest { response, .. } => {
                            let _ = response.send(Err(message));
                        }
                        WriteCommand::WalMaintenance { response, .. } => {
                            let _ = response.send(Err(message));
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
                    let result = ingest_snapshot(
                        &mut connection,
                        &memory,
                        &mut persisted,
                        &source,
                        &aircraft,
                        polled_at_ms,
                        run_retention_sweep,
                    );
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
pub async fn query_store(
    store: &TrafficStore,
    request: QueryRequest,
) -> Result<QueryResult, String> {
    let memory = Arc::clone(&store.memory);
    tokio::task::spawn_blocking(move || Ok(memory.query(&request)))
        .await
        .map_err(|e| format!("Traffic query task panicked: {e}"))?
}

pub async fn ingest_to_store(
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

fn observed_at(candidate: &TrafficAircraft, polled_at_ms: i64, cutoff_ms: i64) -> i64 {
    approach_viz_core::traffic_query::observed_at_ms(candidate, polled_at_ms, cutoff_ms)
}

fn new_track(candidate: &TrafficAircraft, polled_at_ms: i64, cutoff_ms: i64) -> TrackEntry {
    TrackEntry {
        hex: candidate.hex.clone(),
        flight: candidate.flight.clone(),
        lat: candidate.lat,
        lon: candidate.lon,
        is_on_ground: candidate.is_on_ground,
        altitude_feet: candidate.altitude_feet,
        ground_speed_kt: candidate.ground_speed_kt,
        track_deg: candidate.track_deg,
        last_observed_at_ms: observed_at(candidate, polled_at_ms, cutoff_ms),
        last_point_ts_ms: None,
        last_point_lat: None,
        last_point_lon: None,
        last_point_altitude_feet: None,
        last_point_is_on_ground: None,
    }
}

/// Merge and history sampling policy, independent of memory publication and SQLite commit.
fn merge_track(
    track: &mut TrackEntry,
    candidate: &TrafficAircraft,
    polled_at_ms: i64,
    cutoff_ms: i64,
) -> Option<HistoryPoint> {
    let observed_at_ms = observed_at(candidate, polled_at_ms, cutoff_ms);
    if let Some(flight) = &candidate.flight {
        track.flight = Some(flight.clone());
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
    let altitude_feet = track.altitude_feet.unwrap_or(0.0);
    let timestamp_ms = track
        .last_point_ts_ms
        .map(|last| observed_at_ms.max(last + 1))
        .unwrap_or(observed_at_ms);
    let append = match (
        track.last_point_ts_ms,
        track.last_point_lat,
        track.last_point_lon,
        track.last_point_altitude_feet,
        track.last_point_is_on_ground,
    ) {
        (Some(ts), Some(lat), Some(lon), Some(alt), Some(ground)) => {
            timestamp_ms - ts >= 900
                || distance_nm(lat, lon, candidate.lat, candidate.lon) >= 0.02
                || (alt - altitude_feet).abs() >= 25.0
                || ground != track.is_on_ground
        }
        _ => true,
    };
    if !append {
        return None;
    }
    track.last_point_ts_ms = Some(timestamp_ms);
    track.last_point_lat = Some(candidate.lat);
    track.last_point_lon = Some(candidate.lon);
    track.last_point_altitude_feet = Some(altitude_feet);
    track.last_point_is_on_ground = Some(track.is_on_ground);
    Some(HistoryPoint {
        lat: candidate.lat,
        lon: candidate.lon,
        altitude_feet,
        timestamp_ms,
        is_on_ground: track.is_on_ground,
    })
}

fn ingest_snapshot(
    connection: &mut Connection,
    memory: &TrafficMemoryStore,
    persisted: &mut PersistedState,
    source: &str,
    aircraft: &[TrafficAircraft],
    polled_at_ms: i64,
    run_retention_sweep: bool,
) -> Result<(), String> {
    let retention_cutoff_ms = polled_at_ms - CACHE_RETENTION_MS;
    publish_to_memory(
        memory,
        source,
        aircraft,
        polled_at_ms,
        run_retention_sweep,
        retention_cutoff_ms,
    );

    // ── Persist to SQLite (no readers depend on this; memory stays live on failure) ──
    let mut attempts = 0usize;
    loop {
        let result = persist_to_sqlite(
            connection,
            persisted,
            source,
            aircraft,
            polled_at_ms,
            run_retention_sweep,
            retention_cutoff_ms,
        );
        match &result {
            Err(error)
                if is_sqlite_locked_error(error) && attempts < WRITE_QUERY_LOCK_RETRIES =>
            {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(WRITE_QUERY_LOCK_RETRY_DELAY_MS));
            }
            _ => return result,
        }
    }
}

fn publish_to_memory(
    memory: &TrafficMemoryStore,
    source: &str,
    aircraft: &[TrafficAircraft],
    polled_at_ms: i64,
    run_retention_sweep: bool,
    retention_cutoff_ms: i64,
) {
    // ── Build new in-memory snapshot ────────────────────────────────
    let prev_snapshot = memory.current.load();

    let mut new_tracks = Vec::with_capacity(prev_snapshot.tracks.len() + aircraft.len() / 16);
    let mut new_by_hex: FxHashMap<&str, usize> =
        FxHashMap::with_capacity_and_hasher(new_tracks.capacity(), Default::default());
    let mut history_points: Vec<(usize, HistoryPoint)> = Vec::with_capacity(aircraft.len());

    // Carry forward all non-expired tracks from previous snapshot.
    for prev_track in &prev_snapshot.tracks {
        if prev_track.last_observed_at_ms < retention_cutoff_ms {
            continue;
        }
        new_by_hex.insert(&prev_track.hex, new_tracks.len());
        new_tracks.push(prev_track.clone());
    }

    // Merge incoming aircraft.
    for candidate in aircraft {
        let index = match new_by_hex.get(candidate.hex.as_str()) {
            Some(&index) => index,
            None => {
                let index = new_tracks.len();
                new_by_hex.insert(&candidate.hex, index);
                new_tracks.push(new_track(candidate, polled_at_ms, retention_cutoff_ms));
                index
            }
        };
        if let Some(point) =
            merge_track(&mut new_tracks[index], candidate, polled_at_ms, retention_cutoff_ms)
        {
            history_points.push((index, point));
        }
    }

    // ── Swap current snapshot (readers see this instantly) ───────────
    let snapshot = Arc::new(CurrentSnapshot {
        tracks: new_tracks,
        source: Some(source.to_string()),
        fetched_at_ms: polled_at_ms,
    });
    memory.current.store(Arc::clone(&snapshot));

    // ── Append history points (write-lock ~100μs) ───────────────────
    let mut ring = memory.history.write().expect("history lock poisoned");
    ring.rotate_if_needed(polled_at_ms);
    for (index, point) in history_points {
        ring.append_point(&snapshot.tracks[index].hex, point);
    }
    if run_retention_sweep {
        ring.sweep_retention(retention_cutoff_ms);
    }
}

/// The writer's copy of what SQLite holds. Each ingest merges against it instead of reading
/// tracks back, and it advances only after a transaction commits, so after a failed transaction
/// it still matches the rolled-back database.
struct PersistedState {
    tracks: FxHashMap<String, TrackEntry>,
    partitions: RingPartitionCache,
}

impl PersistedState {
    fn load(connection: &Connection) -> Result<Self, String> {
        let tracks = load_tracks(connection)?
            .into_iter()
            .map(|track| (track.hex.clone(), track))
            .collect();
        Ok(Self {
            tracks,
            partitions: load_partition_cache(connection)?,
        })
    }
}

const UPSERT_TRACK_SQL: &str = "INSERT INTO traffic_tracks (
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
        last_point_is_on_ground = excluded.last_point_is_on_ground";

fn persist_to_sqlite(
    connection: &mut Connection,
    persisted: &mut PersistedState,
    source: &str,
    aircraft: &[TrafficAircraft],
    polled_at_ms: i64,
    run_retention_sweep: bool,
    retention_cutoff_ms: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut partitions = persisted.partitions.clone();
    let mut merged: FxHashMap<&str, TrackEntry> =
        FxHashMap::with_capacity_and_hasher(aircraft.len(), Default::default());

    {
        let mut upsert_track = transaction
            .prepare_cached(UPSERT_TRACK_SQL)
            .map_err(|error| error.to_string())?;
        let mut insert_point: Option<(i64, CachedStatement<'_>)> = None;

        for candidate in aircraft {
            let stored = persisted.tracks.get(&candidate.hex);
            let track = merged.entry(candidate.hex.as_str()).or_insert_with(|| {
                stored.cloned().unwrap_or_else(|| {
                    new_track(candidate, polled_at_ms, retention_cutoff_ms)
                })
            });

            if let Some(point) = merge_track(track, candidate, polled_at_ms, retention_cutoff_ms)
            {
                let bucket = bucket_start_ms(point.timestamp_ms);
                let statement = match &mut insert_point {
                    Some((current, statement)) if *current == bucket => statement,
                    _ => {
                        let partition =
                            ensure_partition_for_bucket(&transaction, &mut partitions, bucket)?;
                        let statement = transaction
                            .prepare_cached(&format!(
                                "INSERT INTO \"{}\" (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground) VALUES (?, ?, ?, ?, ?, ?)",
                                partition.points_table
                            ))
                            .map_err(|error| error.to_string())?;
                        &mut insert_point.insert((bucket, statement)).1
                    }
                };
                statement
                    .execute(params![
                        candidate.hex,
                        point.timestamp_ms,
                        point.lat,
                        point.lon,
                        point.altitude_feet,
                        point.is_on_ground as i64,
                    ])
                    .map_err(|error| error.to_string())?;
            }

            // Parked aircraft whose position report only ages merge to an identical row.
            if stored == Some(&*track) {
                continue;
            }
            upsert_track
                .execute(params![
                    candidate.hex,
                    track.flight,
                    track.is_on_ground as i64,
                    track.altitude_feet,
                    track.ground_speed_kt,
                    track.track_deg,
                    track.last_observed_at_ms,
                    track.lat,
                    track.lon,
                    track.last_point_ts_ms,
                    track.last_point_lat,
                    track.last_point_lon,
                    track.last_point_altitude_feet,
                    track.last_point_is_on_ground.map(i64::from),
                ])
                .map_err(|error| error.to_string())?;
        }
    }

    if run_retention_sweep {
        sweep_expired_partitions(&transaction, &mut partitions, retention_cutoff_ms)?;
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

    // ── Advance the persisted mirror to the committed state ─────────
    persisted.partitions = partitions;
    for (hex, track) in merged {
        match persisted.tracks.get_mut(hex) {
            Some(stored) => *stored = track,
            None => {
                persisted.tracks.insert(hex.to_string(), track);
            }
        }
    }
    if run_retention_sweep {
        persisted
            .tracks
            .retain(|_, track| track.last_observed_at_ms >= retention_cutoff_ms);
    }

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
    drop_obsolete_schema(connection)?;

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

/// Points are written in timestamp order per aircraft and read back in rowid order, and every
/// query is served from memory, so the table needs no secondary indexes.
fn partition_schema_sql(points_table: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS \"{points_table}\" (
            id INTEGER PRIMARY KEY,
            hex TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            altitude_feet REAL NOT NULL,
            is_on_ground INTEGER NOT NULL
        );"
    )
}

/// Drop the maintenance earlier releases attached to this database. Long-lived databases carry
/// R*Tree mirrors whose triggers fire on every point insert and track update, plus track indexes
/// used only by removed SQL queries. Only the triggers and track-sized objects go here: startup
/// must stay fast, and freeing a large table reads every page of it. Each ring slot's R*Tree and
/// point indexes go when the slot is next recycled (`clear_ring_slot`). Pre-ring
/// `traffic_points` and `traffic_points_p*` tables are neither written nor read and are left for
/// offline cleanup.
fn drop_obsolete_schema(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT type, name FROM sqlite_master
             WHERE (type = 'trigger' AND name GLOB 'trg_traffic_*rtree*')
                OR (type = 'index' AND name IN ('idx_traffic_tracks_live', 'idx_traffic_tracks_last_seen'))
                OR (type = 'table' AND name = 'traffic_tracks_rtree')",
        )
        .map_err(|error| error.to_string())?;
    let mut objects = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if objects.is_empty() {
        return Ok(());
    }
    // Triggers reference the R*Tree tables; R*Tree tables drop their own shadow tables.
    objects.sort_by_key(|(kind, name)| match kind.as_str() {
        "trigger" => 0,
        "index" => 1,
        _ if name.ends_with("_rtree") => 2,
        _ => 3,
    });
    let mut sql = String::from("BEGIN;");
    for (kind, name) in &objects {
        sql.push_str(&format!("DROP {} IF EXISTS \"{name}\";", kind.to_uppercase()));
    }
    sql.push_str("COMMIT;");
    let started = std::time::Instant::now();
    connection
        .execute_batch(&sql)
        .map_err(|error| format!("Dropping obsolete traffic schema failed: {error}"))?;
    info!(
        dropped = objects.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "dropped obsolete traffic schema objects"
    );
    Ok(())
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
    cache: &mut RingPartitionCache,
    retention_cutoff_ms: i64,
) -> Result<(), String> {
    let keep_from_bucket_ms = bucket_start_ms(retention_cutoff_ms);
    let expired: Vec<PartitionInfo> = cache
        .by_bucket_start_ms
        .values()
        .filter(|partition| partition.bucket_start_ms < keep_from_bucket_ms)
        .cloned()
        .collect();

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
        cache.by_bucket_start_ms.remove(&partition.bucket_start_ms);
        cache.by_slot.remove(&partition.slot);
    }

    Ok(())
}

/// Recreate rather than delete: dropping a table frees its pages in one pass and rebuilds tables
/// left with an older schema, taking their point indexes and any legacy R*Tree mirror with them.
fn clear_ring_slot(connection: &Connection, partition: &PartitionInfo) -> Result<(), String> {
    connection
        .execute_batch(&format!(
            "DROP TABLE IF EXISTS \"{rtree_table}\";DROP TABLE IF EXISTS \"{points_table}\";{create}",
            rtree_table = partition.rtree_table,
            points_table = partition.points_table,
            create = partition_schema_sql(&partition.points_table),
        ))
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
            CREATE TABLE IF NOT EXISTS traffic_ring_slots (
                slot INTEGER PRIMARY KEY,
                bucket_start_ms INTEGER NOT NULL,
                points_table TEXT NOT NULL,
                rtree_table TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_traffic_ring_slots_bucket ON traffic_ring_slots(bucket_start_ms);",
        )
        .map_err(|error| error.to_string())?;

    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traffic::types::{QueryRequest, TrafficAircraft};

    const NOW_MS: i64 = 1_700_000_000_000;

    fn test_aircraft(hex: &str, lat: f64, lon: f64, on_ground: bool) -> TrafficAircraft {
        TrafficAircraft {
            hex: hex.to_string(),
            flight: Some(format!("TST{hex}")),
            lat,
            lon,
            is_on_ground: on_ground,
            altitude_feet: if on_ground { Some(0.0) } else { Some(10_000.0) },
            ground_speed_kt: Some(250.0),
            track_deg: Some(90.0),
            last_seen_seconds: Some(0.0),
        }
    }

    fn test_query(now_ms: i64) -> QueryRequest {
        QueryRequest {
            lat: 40.0,
            lon: -74.0,
            radius_nm: 80.0,
            discovery_radius_nm: 80.0,
            limit: 250,
            history_minutes: 0.0,
            history_hexes: Vec::new(),
            hide_ground_traffic: false,
            now_ms,
        }
    }

    fn make_store(dir: &tempfile::TempDir) -> TrafficStore {
        TrafficStore::new(dir.path().join("traffic-store.db")).expect("store should open")
    }

    #[test]
    fn merge_preserves_newer_position_and_fills_missing_fields() {
        let mut candidate = test_aircraft("abc123", 40.0, -74.0, false);
        candidate.altitude_feet = None;
        let mut track = new_track(&candidate, NOW_MS, NOW_MS - CACHE_RETENTION_MS);
        merge_track(&mut track, &candidate, NOW_MS, NOW_MS - CACHE_RETENTION_MS);
        candidate.lat = 41.0;
        candidate.last_seen_seconds = Some(10.0);
        candidate.altitude_feet = Some(12_000.0);
        merge_track(&mut track, &candidate, NOW_MS, NOW_MS - CACHE_RETENTION_MS);
        assert_eq!(track.lat, 40.0);
        assert_eq!(track.altitude_feet, Some(12_000.0));
        assert_eq!(track.last_observed_at_ms, NOW_MS);
        assert!(track.last_point_ts_ms.unwrap() > NOW_MS);
    }

    #[test]
    fn history_sampling_uses_time_motion_altitude_and_ground_changes() {
        let mut candidate = test_aircraft("abc123", 40.0, -74.0, false);
        let cutoff = NOW_MS - CACHE_RETENTION_MS;
        let mut track = new_track(&candidate, NOW_MS, cutoff);
        assert!(merge_track(&mut track, &candidate, NOW_MS, cutoff).is_some());
        assert!(merge_track(&mut track, &candidate, NOW_MS + 899, cutoff).is_none());
        assert!(merge_track(&mut track, &candidate, NOW_MS + 900, cutoff).is_some());
        candidate.altitude_feet = Some(10_025.0);
        assert!(merge_track(&mut track, &candidate, NOW_MS + 901, cutoff).is_some());
        candidate.is_on_ground = true;
        assert!(merge_track(&mut track, &candidate, NOW_MS + 902, cutoff).is_some());
        candidate.lat += 0.001;
        assert!(merge_track(&mut track, &candidate, NOW_MS + 903, cutoff).is_some());
    }

    #[test]
    fn persistence_failure_keeps_memory_live_and_next_ingest_recovers_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = open_traffic_db(&dir.path().join("traffic.db")).unwrap();
        reconcile_partition_tables(&connection).unwrap();
        let memory = TrafficMemoryStore::new_empty();
        let mut persisted = PersistedState::load(&connection).unwrap();
        connection.execute_batch("CREATE TRIGGER fail_write BEFORE INSERT ON traffic_tracks BEGIN SELECT RAISE(FAIL, 'test disk failure'); END;").unwrap();
        let aircraft = test_aircraft("abc123", 40.0, -74.0, false);
        assert!(ingest_snapshot(
            &mut connection,
            &memory,
            &mut persisted,
            "test",
            std::slice::from_ref(&aircraft),
            NOW_MS,
            false
        )
        .is_err());
        assert_eq!(memory.current.load().tracks.len(), 1);
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM traffic_tracks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        connection.execute_batch("DROP TRIGGER fail_write").unwrap();
        ingest_snapshot(
            &mut connection,
            &memory,
            &mut persisted,
            "test",
            &[aircraft],
            NOW_MS + 1000,
            false,
        )
        .unwrap();
        let reloaded = TrafficMemoryStore::load_from_sqlite(&connection).unwrap();
        let live = memory.current.load();
        let disk = reloaded.current.load();
        assert_eq!(live.tracks[0].lat, disk.tracks[0].lat);
        assert_eq!(
            live.tracks[0].last_point_ts_ms,
            disk.tracks[0].last_point_ts_ms
        );
    }

    /// The web proxy's direct fallback must report the same current aircraft
    /// this store would after ingesting only that one poll.
    #[test]
    fn direct_fallback_matches_a_store_holding_one_poll() {
        use approach_viz_core::traffic_query::{select_direct_aircraft, TrafficQuery};

        let mut aircraft = vec![
            test_aircraft("aaa001", 40.0, -74.0, false),
            test_aircraft("aaa002", 40.5, -74.2, false),
            test_aircraft("aaa003", 40.1, -73.9, true),
            test_aircraft("aaa004", 45.0, -74.0, false),
            test_aircraft("aaa005", 39.8, -74.1, false),
            test_aircraft("aaa006", 40.2, -74.3, false),
        ];
        aircraft[1].last_seen_seconds = Some(30.4);
        aircraft[4].last_seen_seconds = Some(95.0);
        aircraft[5].last_seen_seconds = None;

        let dir = tempfile::tempdir().unwrap();
        let mut connection = open_traffic_db(&dir.path().join("traffic.db")).unwrap();
        reconcile_partition_tables(&connection).unwrap();
        let memory = TrafficMemoryStore::new_empty();
        let mut persisted = PersistedState::load(&connection).unwrap();
        ingest_snapshot(
            &mut connection,
            &memory,
            &mut persisted,
            "test",
            &aircraft,
            NOW_MS,
            false,
        )
        .unwrap();

        for (hide_ground_traffic, limit) in [(false, 250), (true, 250), (false, 2)] {
            let mut request = test_query(NOW_MS);
            request.hide_ground_traffic = hide_ground_traffic;
            request.limit = limit;
            let from_store = memory.query(&request).aircraft;
            let direct = select_direct_aircraft(
                aircraft.clone(),
                &TrafficQuery {
                    lat: request.lat,
                    lon: request.lon,
                    radius_nm: request.radius_nm,
                    limit,
                    history_minutes: 0.0,
                    hide_ground_traffic,
                    history_hexes: Vec::new(),
                },
                NOW_MS,
            );
            assert_eq!(format!("{direct:?}"), format!("{from_store:?}"));
            assert!(!direct.is_empty());
        }
    }

    const LEGACY_RING_SLOT_SQL: &str = "
        CREATE TABLE traffic_points_ring_s0 (
            id INTEGER PRIMARY KEY AUTOINCREMENT, hex TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
            lat REAL NOT NULL, lon REAL NOT NULL, altitude_feet REAL NOT NULL, is_on_ground INTEGER NOT NULL);
        CREATE INDEX idx_traffic_points_ring_s0_hex_ts ON traffic_points_ring_s0(hex, timestamp_ms);
        CREATE VIRTUAL TABLE traffic_points_ring_s0_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);
        CREATE TRIGGER trg_traffic_points_ring_s0_rtree_insert AFTER INSERT ON traffic_points_ring_s0 BEGIN
            INSERT INTO traffic_points_ring_s0_rtree VALUES (new.id, new.lat, new.lat, new.lon, new.lon);
        END;
        INSERT INTO traffic_points_ring_s0 (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground)
        VALUES ('abc123', 1, 40.0, -74.0, 1000.0, 0);";

    fn schema_names(connection: &Connection, filter: &str) -> Vec<String> {
        connection
            .prepare(&format!("SELECT name FROM sqlite_master WHERE {filter} ORDER BY name"))
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn startup_drops_legacy_triggers_and_track_objects_only() {
        let dir = tempfile::tempdir().unwrap();
        let connection = open_traffic_db(&dir.path().join("traffic.db")).unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TABLE traffic_partitions (bucket_start_ms INTEGER PRIMARY KEY, points_table TEXT, rtree_table TEXT);
                 CREATE TABLE traffic_points_p1771805700000 (id INTEGER PRIMARY KEY, hex TEXT);
                 CREATE INDEX idx_traffic_tracks_live ON traffic_tracks(last_observed_at_ms, last_lat, last_lon);
                 CREATE VIRTUAL TABLE traffic_tracks_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);
                 CREATE TRIGGER trg_traffic_tracks_rtree_insert AFTER INSERT ON traffic_tracks BEGIN
                     INSERT INTO traffic_tracks_rtree VALUES (new.rowid, new.last_lat, new.last_lat, new.last_lon, new.last_lon);
                 END;
                 {LEGACY_RING_SLOT_SQL}"
            ))
            .unwrap();

        reconcile_partition_tables(&connection).unwrap();

        assert!(schema_names(&connection, "type = 'trigger'").is_empty());
        assert!(
            schema_names(
                &connection,
                "name IN ('traffic_tracks_rtree', 'idx_traffic_tracks_live')"
            )
            .is_empty()
        );
        // Large objects stay until their slot is recycled or an offline cleanup removes them.
        assert_eq!(
            schema_names(
                &connection,
                "name IN ('traffic_points_ring_s0_rtree', 'idx_traffic_points_ring_s0_hex_ts', 'traffic_points_p1771805700000')"
            )
            .len(),
            3
        );
        let points: i64 = connection
            .query_row("SELECT COUNT(*) FROM traffic_points_ring_s0", [], |row| row.get(0))
            .unwrap();
        assert_eq!(points, 1);
        // Idempotent on the next start.
        reconcile_partition_tables(&connection).unwrap();
    }

    #[test]
    fn recycled_slot_drops_legacy_rtree_indexes_and_autoincrement() {
        let dir = tempfile::tempdir().unwrap();
        let connection = open_traffic_db(&dir.path().join("traffic.db")).unwrap();
        connection.execute_batch(LEGACY_RING_SLOT_SQL).unwrap();
        reconcile_partition_tables(&connection).unwrap();
        let mut cache = load_partition_cache(&connection).unwrap();
        let first = RING_SLOT_COUNT * PARTITION_BUCKET_MS;
        ensure_partition_for_bucket(&connection, &mut cache, first).unwrap();
        ensure_partition_for_bucket(&connection, &mut cache, first * 2).unwrap();

        let (sql, points): (String, i64) = connection
            .query_row(
                "SELECT sql, (SELECT COUNT(*) FROM traffic_points_ring_s0)
                 FROM sqlite_master WHERE name = 'traffic_points_ring_s0'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(!sql.contains("AUTOINCREMENT"));
        assert_eq!(points, 0);
        assert!(
            schema_names(&connection, "name GLOB 'traffic_points_ring_s0?*'").is_empty()
                && schema_names(&connection, "name GLOB 'idx_traffic_points_ring_s0_*'").is_empty()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fresh_store_reports_warming() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(&dir);
        let result = query_store(&store, test_query(NOW_MS)).await.unwrap();
        assert!(result.warming);
        assert!(result.aircraft.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ingest_then_query_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(&dir);
        let aircraft = vec![
            test_aircraft("a1b2c3", 40.1, -74.1, false),
            // Far outside the 80 NM query radius.
            test_aircraft("d4e5f6", 30.0, -90.0, false),
        ];
        ingest_to_store(&store, "test-feed".to_string(), aircraft, NOW_MS, false)
            .await
            .unwrap();

        let result = query_store(&store, test_query(NOW_MS)).await.unwrap();
        assert!(!result.warming);
        assert!(!result.stale_current);
        assert_eq!(result.source.as_deref(), Some("test-feed"));
        let hexes: Vec<&str> = result.aircraft.iter().map(|a| a.hex.as_str()).collect();
        assert_eq!(hexes, vec!["a1b2c3"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn query_hides_ground_traffic_when_requested() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(&dir);
        let aircraft = vec![
            test_aircraft("a1b2c3", 40.1, -74.1, false),
            test_aircraft("0f0f0f", 40.1, -74.1, true),
        ];
        ingest_to_store(&store, "test-feed".to_string(), aircraft, NOW_MS, false)
            .await
            .unwrap();

        let mut request = test_query(NOW_MS);
        request.hide_ground_traffic = true;
        let result = query_store(&store, request).await.unwrap();
        let hexes: Vec<&str> = result.aircraft.iter().map(|a| a.hex.as_str()).collect();
        assert_eq!(hexes, vec!["a1b2c3"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn old_snapshot_is_marked_stale() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(&dir);
        ingest_to_store(
            &store,
            "test-feed".to_string(),
            vec![test_aircraft("a1b2c3", 40.1, -74.1, false)],
            NOW_MS,
            false,
        )
        .await
        .unwrap();

        let result = query_store(&store, test_query(NOW_MS + 2 * 60_000))
            .await
            .unwrap();
        assert!(result.stale_current);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn history_round_trip_with_targeted_hexes() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(&dir);
        // Two ingest cycles with movement so history points accumulate.
        ingest_to_store(
            &store,
            "test-feed".to_string(),
            vec![test_aircraft("a1b2c3", 40.10, -74.10, false)],
            NOW_MS,
            false,
        )
        .await
        .unwrap();
        ingest_to_store(
            &store,
            "test-feed".to_string(),
            vec![test_aircraft("a1b2c3", 40.20, -74.05, false)],
            NOW_MS + 5_000,
            false,
        )
        .await
        .unwrap();

        let mut request = test_query(NOW_MS + 6_000);
        request.history_minutes = 10.0;
        request.history_hexes = vec!["a1b2c3".to_string()];
        let result = query_store(&store, request).await.unwrap();
        let points = result
            .history_by_hex
            .get("a1b2c3")
            .expect("history should include the requested hex");
        assert!(!points.is_empty());
        assert!(points
            .windows(2)
            .all(|w| w[0].timestamp_ms <= w[1].timestamp_ms));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn store_reload_restores_persisted_state() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = make_store(&dir);
            ingest_to_store(
                &store,
                "test-feed".to_string(),
                vec![test_aircraft("a1b2c3", 40.1, -74.1, false)],
                NOW_MS,
                false,
            )
            .await
            .unwrap();
        }

        // Reopen against the same SQLite file; memory state must reload.
        let reopened = make_store(&dir);
        let result = query_store(&reopened, test_query(NOW_MS)).await.unwrap();
        assert!(!result.warming);
        let hexes: Vec<&str> = result.aircraft.iter().map(|a| a.hex.as_str()).collect();
        assert_eq!(hexes, vec!["a1b2c3"]);
    }
}
