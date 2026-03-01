use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock};

use arc_swap::ArcSwap;
use rusqlite::Connection;
use tracing::info;

use super::types::{
    build_bounding_box, distance_nm, BoundingBox, HistoryTargetCandidate, QueryRequest,
    QueryResult, TrafficAircraft, TrafficHistoryPoint, CACHE_CURRENT_STALE_MS,
    HISTORY_MAX_POINTS_PER_AIRCRAFT,
};

// Partition constants (mirrored from store.rs).
pub(crate) const PARTITION_BUCKET_MS: i64 = 5 * 60_000;
const CACHE_RETENTION_MS: i64 = 60 * 60_000;
const RING_SLOT_COUNT: usize = (CACHE_RETENTION_MS / PARTITION_BUCKET_MS) as usize;

// Spatial grid: 0.5° cells (~30 nm lat, ~20 nm lon at mid-latitudes).
const GRID_CELL_SIZE_DEG: f64 = 0.5;
const GRID_INV_CELL_SIZE: f64 = 1.0 / GRID_CELL_SIZE_DEG;

// ---------------------------------------------------------------------------
// SpatialPresenceGrid
// ---------------------------------------------------------------------------

/// Maps geographic grid cells to sets of aircraft hex identifiers.
/// Coarse spatial filter — callers do exact `distance_nm` checks afterward.
pub(crate) struct SpatialPresenceGrid {
    cells: HashMap<(i32, i32), HashSet<String>>,
}

impl SpatialPresenceGrid {
    pub(crate) fn new() -> Self {
        Self {
            cells: HashMap::new(),
        }
    }

    #[inline]
    fn cell(lat: f64, lon: f64) -> (i32, i32) {
        (
            (lat * GRID_INV_CELL_SIZE).floor() as i32,
            (lon * GRID_INV_CELL_SIZE).floor() as i32,
        )
    }

    pub(crate) fn insert(&mut self, lat: f64, lon: f64, hex: &str) {
        let key = Self::cell(lat, lon);
        self.cells
            .entry(key)
            .or_default()
            .insert(hex.to_owned());
    }

    pub(crate) fn hexes_in_bbox(&self, bounds: &BoundingBox) -> HashSet<String> {
        let r_min = (bounds.south * GRID_INV_CELL_SIZE).floor() as i32;
        let r_max = (bounds.north * GRID_INV_CELL_SIZE).floor() as i32;
        let mut result = HashSet::new();

        if bounds.crosses_dateline {
            // Two lon ranges: [west..180] and [-180..east]
            let c_west_start = (bounds.west * GRID_INV_CELL_SIZE).floor() as i32;
            let c_west_end = (180.0_f64 * GRID_INV_CELL_SIZE).floor() as i32;
            let c_east_start = (-180.0_f64 * GRID_INV_CELL_SIZE).floor() as i32;
            let c_east_end = (bounds.east * GRID_INV_CELL_SIZE).floor() as i32;
            for r in r_min..=r_max {
                for c in c_west_start..=c_west_end {
                    if let Some(hexes) = self.cells.get(&(r, c)) {
                        result.extend(hexes.iter().cloned());
                    }
                }
                for c in c_east_start..=c_east_end {
                    if let Some(hexes) = self.cells.get(&(r, c)) {
                        result.extend(hexes.iter().cloned());
                    }
                }
            }
        } else {
            let c_min = (bounds.west * GRID_INV_CELL_SIZE).floor() as i32;
            let c_max = (bounds.east * GRID_INV_CELL_SIZE).floor() as i32;
            for r in r_min..=r_max {
                for c in c_min..=c_max {
                    if let Some(hexes) = self.cells.get(&(r, c)) {
                        result.extend(hexes.iter().cloned());
                    }
                }
            }
        }
        result
    }
}

// ---------------------------------------------------------------------------
// HistoryPoint (internal — includes is_on_ground for filtering)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct HistoryPoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: f64,
    pub timestamp_ms: i64,
    pub is_on_ground: bool,
}

// ---------------------------------------------------------------------------
// HistoryPartition
// ---------------------------------------------------------------------------

pub(crate) struct HistoryPartition {
    pub bucket_start_ms: i64,
    pub points_by_hex: HashMap<String, Vec<HistoryPoint>>,
    pub grid: SpatialPresenceGrid,
}

impl HistoryPartition {
    fn new(bucket_start_ms: i64) -> Self {
        Self {
            bucket_start_ms,
            points_by_hex: HashMap::new(),
            grid: SpatialPresenceGrid::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// PartitionRing
// ---------------------------------------------------------------------------

pub(crate) struct PartitionRing {
    sealed: VecDeque<Arc<HistoryPartition>>,
    active: HistoryPartition,
}

impl PartitionRing {
    fn new() -> Self {
        Self {
            sealed: VecDeque::new(),
            active: HistoryPartition::new(0),
        }
    }

    fn from_partitions(mut partitions: Vec<HistoryPartition>) -> Self {
        if partitions.is_empty() {
            return Self::new();
        }
        let active = partitions.pop().unwrap();
        let sealed = partitions.into_iter().map(Arc::new).collect();
        Self { sealed, active }
    }

    pub(crate) fn rotate_if_needed(&mut self, now_ms: i64) {
        let current_bucket = bucket_start_ms(now_ms);
        if current_bucket == self.active.bucket_start_ms {
            return;
        }
        if self.active.bucket_start_ms > 0 {
            let sealed =
                std::mem::replace(&mut self.active, HistoryPartition::new(current_bucket));
            self.sealed.push_back(Arc::new(sealed));
            while self.sealed.len() >= RING_SLOT_COUNT {
                self.sealed.pop_front();
            }
        } else {
            self.active.bucket_start_ms = current_bucket;
        }
    }

    pub(crate) fn append_point(&mut self, hex: &str, point: HistoryPoint) {
        self.active.grid.insert(point.lat, point.lon, hex);
        self.active
            .points_by_hex
            .entry(hex.to_owned())
            .or_default()
            .push(point);
    }

    pub(crate) fn sweep_retention(&mut self, retention_cutoff_ms: i64) {
        let keep_from = bucket_start_ms(retention_cutoff_ms);
        while let Some(front) = self.sealed.front() {
            if front.bucket_start_ms < keep_from {
                self.sealed.pop_front();
            } else {
                break;
            }
        }
    }

    fn partitions_in_range(&self, min_bucket_ms: i64) -> Vec<&HistoryPartition> {
        let mut result: Vec<&HistoryPartition> = self
            .sealed
            .iter()
            .filter(|p| p.bucket_start_ms >= min_bucket_ms)
            .map(|arc| arc.as_ref())
            .collect();
        if self.active.bucket_start_ms >= min_bucket_ms {
            result.push(&self.active);
        }
        result
    }
}

pub(crate) fn bucket_start_ms(timestamp_ms: i64) -> i64 {
    (timestamp_ms / PARTITION_BUCKET_MS) * PARTITION_BUCKET_MS
}

// ---------------------------------------------------------------------------
// TrackEntry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct TrackEntry {
    pub hex: String,
    pub flight: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub is_on_ground: bool,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub last_observed_at_ms: i64,
    // For should_append logic (carried across ingest cycles):
    pub last_point_ts_ms: Option<i64>,
    pub last_point_lat: Option<f64>,
    pub last_point_lon: Option<f64>,
    pub last_point_altitude_feet: Option<f64>,
    pub last_point_is_on_ground: Option<bool>,
}

// ---------------------------------------------------------------------------
// CurrentSnapshot
// ---------------------------------------------------------------------------

pub(crate) struct CurrentSnapshot {
    pub tracks: Vec<TrackEntry>,
    pub by_hex: HashMap<String, usize>,
    pub source: Option<String>,
    pub fetched_at_ms: i64,
}

impl CurrentSnapshot {
    #[allow(dead_code)]
    pub(crate) fn empty() -> Self {
        Self {
            tracks: Vec::new(),
            by_hex: HashMap::new(),
            source: None,
            fetched_at_ms: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// TrafficMemoryStore
// ---------------------------------------------------------------------------

pub struct TrafficMemoryStore {
    pub(crate) current: ArcSwap<CurrentSnapshot>,
    pub(crate) history: RwLock<PartitionRing>,
}

impl TrafficMemoryStore {
    #[allow(dead_code)]
    pub fn new_empty() -> Self {
        Self {
            current: ArcSwap::from_pointee(CurrentSnapshot::empty()),
            history: RwLock::new(PartitionRing::new()),
        }
    }

    /// Load the in-memory store from an existing SQLite database.
    pub(crate) fn load_from_sqlite(connection: &Connection) -> Result<Self, String> {
        // ── Current tracks ──────────────────────────────────────────
        let mut tracks = Vec::new();
        let mut by_hex: HashMap<String, usize> = HashMap::new();
        {
            let mut stmt = connection
                .prepare(
                    "SELECT hex, flight, is_on_ground, altitude_feet, ground_speed_kt,
                            track_deg, last_observed_at_ms, last_lat, last_lon,
                            last_point_ts_ms, last_point_lat, last_point_lon,
                            last_point_altitude_feet, last_point_is_on_ground
                     FROM traffic_tracks",
                )
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map([], |row| {
                    Ok(TrackEntry {
                        hex: row.get(0)?,
                        flight: row.get(1)?,
                        is_on_ground: row.get::<_, i64>(2).map(|v| v == 1).unwrap_or(false),
                        altitude_feet: row.get(3)?,
                        ground_speed_kt: row.get(4)?,
                        track_deg: row.get(5)?,
                        last_observed_at_ms: row.get(6)?,
                        lat: row.get(7)?,
                        lon: row.get(8)?,
                        last_point_ts_ms: row.get(9)?,
                        last_point_lat: row.get(10)?,
                        last_point_lon: row.get(11)?,
                        last_point_altitude_feet: row.get(12)?,
                        last_point_is_on_ground: row
                            .get::<_, Option<i64>>(13)?
                            .map(|v| v == 1),
                    })
                })
                .map_err(|e| e.to_string())?;

            for row in rows {
                let entry = row.map_err(|e| e.to_string())?;
                by_hex.insert(entry.hex.clone(), tracks.len());
                tracks.push(entry);
            }
        }
        info!(track_count = tracks.len(), "loaded tracks from SQLite");

        // ── Metadata ────────────────────────────────────────────────
        let source = read_meta(connection, "source")?;
        let fetched_at_ms = read_meta(connection, "updated_at_ms")?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);

        let snapshot = CurrentSnapshot {
            tracks,
            by_hex,
            source,
            fetched_at_ms,
        };

        // ── History partitions ──────────────────────────────────────
        let mut partitions = Vec::new();
        {
            let mut stmt = connection
                .prepare(
                    "SELECT slot, bucket_start_ms, points_table
                     FROM traffic_ring_slots
                     WHERE bucket_start_ms >= 0
                     ORDER BY bucket_start_ms ASC",
                )
                .map_err(|e| e.to_string())?;

            let partition_infos: Vec<(i64, String)> = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(1)?, row.get::<_, String>(2)?))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            for (bucket_start, points_table) in partition_infos {
                let mut partition = HistoryPartition::new(bucket_start);

                // Check if the table exists before querying.
                let table_exists: bool = connection
                    .prepare(&format!(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{points_table}'"
                    ))
                    .and_then(|mut s| s.query_row([], |row| row.get::<_, i64>(0)))
                    .map(|c| c > 0)
                    .unwrap_or(false);

                if !table_exists {
                    continue;
                }

                let mut pts_stmt = connection
                    .prepare(&format!(
                        "SELECT hex, lat, lon, altitude_feet, timestamp_ms, is_on_ground
                         FROM \"{points_table}\"
                         ORDER BY hex ASC, timestamp_ms ASC"
                    ))
                    .map_err(|e| e.to_string())?;

                let point_rows = pts_stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            HistoryPoint {
                                lat: row.get(1)?,
                                lon: row.get(2)?,
                                altitude_feet: row.get(3)?,
                                timestamp_ms: row.get(4)?,
                                is_on_ground: row
                                    .get::<_, i64>(5)
                                    .map(|v| v == 1)
                                    .unwrap_or(false),
                            },
                        ))
                    })
                    .map_err(|e| e.to_string())?;

                let mut point_count = 0_usize;
                for row in point_rows {
                    let (hex, point) = row.map_err(|e| e.to_string())?;
                    partition.grid.insert(point.lat, point.lon, &hex);
                    partition
                        .points_by_hex
                        .entry(hex)
                        .or_default()
                        .push(point);
                    point_count += 1;
                }
                info!(
                    bucket_start_ms = bucket_start,
                    point_count, "loaded history partition from SQLite"
                );
                partitions.push(partition);
            }
        }

        let ring = PartitionRing::from_partitions(partitions);

        Ok(Self {
            current: ArcSwap::from_pointee(snapshot),
            history: RwLock::new(ring),
        })
    }

    // ------------------------------------------------------------------
    // Query
    // ------------------------------------------------------------------

    pub fn query(&self, request: &QueryRequest) -> QueryResult {
        use std::time::Instant;

        let snapshot = self.current.load();

        // Warming check — no tracks loaded yet.
        if snapshot.tracks.is_empty() {
            return QueryResult {
                source: snapshot.source.clone(),
                fetched_at_ms: snapshot.fetched_at_ms,
                aircraft: Vec::new(),
                history_by_hex: HashMap::new(),
                warming: true,
            };
        }

        let t0 = Instant::now();

        // ── Current aircraft within discovery radius ────────────────
        let mut aircraft = query_current_tracks(
            &snapshot,
            request.now_ms,
            request.lat,
            request.lon,
            request.discovery_radius_nm,
            request.hide_ground_traffic,
        );

        let t_current = t0.elapsed();

        // Exact radius filter, sort, truncate.
        aircraft.retain(|ac| {
            distance_nm(request.lat, request.lon, ac.lat, ac.lon) <= request.radius_nm
        });
        aircraft.sort_by(|left, right| {
            let left_seen = left.last_seen_seconds.unwrap_or(f64::INFINITY);
            let right_seen = right.last_seen_seconds.unwrap_or(f64::INFINITY);
            left_seen
                .partial_cmp(&right_seen)
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    let ld = distance_nm(request.lat, request.lon, left.lat, left.lon);
                    let rd = distance_nm(request.lat, request.lon, right.lat, right.lon);
                    ld.partial_cmp(&rd).unwrap_or(Ordering::Equal)
                })
        });
        aircraft.truncate(request.limit);

        let t_sort = t0.elapsed();

        // ── History ─────────────────────────────────────────────────
        let mut history_by_hex = HashMap::new();
        if request.history_minutes > 0.0 {
            let history_cutoff_ms =
                request.now_ms - (request.history_minutes * 60_000.0) as i64;
            let min_bucket = bucket_start_ms(history_cutoff_ms);

            let ring = self.history.read().expect("history lock poisoned");
            let t_lock = t0.elapsed();
            let partitions = ring.partitions_in_range(min_bucket);

            let targets = if request.history_hexes.is_empty() {
                collect_history_target_hexes(
                    &partitions,
                    request.lat,
                    request.lon,
                    request.discovery_radius_nm,
                    history_cutoff_ms,
                    request.hide_ground_traffic,
                )
            } else {
                request.history_hexes.clone()
            };
            let t_discover = t0.elapsed();

            history_by_hex = load_history_for_hexes(
                &partitions,
                &targets,
                history_cutoff_ms,
                request.hide_ground_traffic,
            );
            let t_load = t0.elapsed();
            let partition_count = partitions.len();
            drop(ring);

            // Post-process: sort, truncate, trail intersection filter.
            for points in history_by_hex.values_mut() {
                points.sort_by_key(|p| p.timestamp_ms);
                if points.len() > HISTORY_MAX_POINTS_PER_AIRCRAFT {
                    *points =
                        points[points.len() - HISTORY_MAX_POINTS_PER_AIRCRAFT..].to_vec();
                }
            }
            history_by_hex.retain(|_, points| {
                super::types::history_points_intersect_scene(
                    points,
                    request.lat,
                    request.lon,
                    request.radius_nm,
                )
            });
            let t_post = t0.elapsed();

            let total_ms = t_post.as_secs_f64() * 1000.0;
            let is_discovery = request.history_hexes.is_empty();
            if total_ms > 100.0 || (is_discovery && total_ms > 20.0) {
                info!(
                    current_ms = format!("{:.1}", t_current.as_secs_f64() * 1000.0),
                    sort_ms = format!("{:.1}", (t_sort - t_current).as_secs_f64() * 1000.0),
                    lock_ms = format!("{:.1}", (t_lock - t_sort).as_secs_f64() * 1000.0),
                    discover_ms = format!("{:.1}", (t_discover - t_lock).as_secs_f64() * 1000.0),
                    load_ms = format!("{:.1}", (t_load - t_discover).as_secs_f64() * 1000.0),
                    post_ms = format!("{:.1}", (t_post - t_load).as_secs_f64() * 1000.0),
                    total_ms = format!("{:.1}", total_ms),
                    target_hexes = targets.len(),
                    result_hexes = history_by_hex.len(),
                    partitions = partition_count,
                    discovery = is_discovery,
                    "traffic query timing"
                );
            }
        }

        QueryResult {
            source: snapshot.source.clone(),
            fetched_at_ms: snapshot.fetched_at_ms,
            aircraft,
            history_by_hex,
            warming: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

fn query_current_tracks(
    snapshot: &CurrentSnapshot,
    now_ms: i64,
    center_lat: f64,
    center_lon: f64,
    discovery_radius_nm: f64,
    hide_ground_traffic: bool,
) -> Vec<TrafficAircraft> {
    let stale_cutoff_ms = now_ms - CACHE_CURRENT_STALE_MS;
    let bounds = build_bounding_box(center_lat, center_lon, discovery_radius_nm);

    let mut candidates = Vec::new();
    for track in &snapshot.tracks {
        if track.last_observed_at_ms < stale_cutoff_ms {
            continue;
        }
        if hide_ground_traffic && track.is_on_ground {
            continue;
        }
        // Bbox pre-filter.
        if track.lat < bounds.south || track.lat > bounds.north {
            continue;
        }
        if bounds.crosses_dateline {
            if track.lon < bounds.west && track.lon > bounds.east {
                continue;
            }
        } else if track.lon < bounds.west || track.lon > bounds.east {
            continue;
        }
        // Exact distance check.
        if distance_nm(center_lat, center_lon, track.lat, track.lon) > discovery_radius_nm {
            continue;
        }

        let last_seen_seconds =
            ((now_ms - track.last_observed_at_ms).max(0) as f64) / 1000.0;
        candidates.push(TrafficAircraft {
            hex: track.hex.clone(),
            flight: track.flight.clone(),
            lat: track.lat,
            lon: track.lon,
            is_on_ground: track.is_on_ground,
            altitude_feet: track.altitude_feet,
            ground_speed_kt: track.ground_speed_kt,
            track_deg: track.track_deg,
            last_seen_seconds: Some(last_seen_seconds),
        });
    }
    candidates
}

fn collect_history_target_hexes(
    partitions: &[&HistoryPartition],
    center_lat: f64,
    center_lon: f64,
    radius_nm: f64,
    history_cutoff_ms: i64,
    hide_ground_traffic: bool,
) -> Vec<String> {
    let bounds = build_bounding_box(center_lat, center_lon, radius_nm);
    let mut candidates: HashMap<String, HistoryTargetCandidate> = HashMap::new();

    for partition in partitions.iter().rev() {
        let grid_hexes = partition.grid.hexes_in_bbox(&bounds);
        for hex in &grid_hexes {
            // Already confirmed this hex — skip remaining partitions for it.
            if candidates.contains_key(hex) {
                continue;
            }
            if let Some(points) = partition.points_by_hex.get(hex) {
                for point in points {
                    if point.timestamp_ms < history_cutoff_ms {
                        continue;
                    }
                    if hide_ground_traffic && point.is_on_ground {
                        continue;
                    }
                    let dist = distance_nm(center_lat, center_lon, point.lat, point.lon);
                    if dist <= radius_nm {
                        candidates.insert(
                            hex.clone(),
                            HistoryTargetCandidate {
                                closest_distance_nm: dist,
                                latest_timestamp_ms: point.timestamp_ms,
                            },
                        );
                        break; // Confirmed — stop scanning this hex's points.
                    }
                }
            }
        }
    }

    let mut ranked: Vec<_> = candidates.into_iter().collect();
    ranked.sort_by(|a, b| {
        a.1.closest_distance_nm
            .partial_cmp(&b.1.closest_distance_nm)
            .unwrap_or(Ordering::Equal)
            .then_with(|| b.1.latest_timestamp_ms.cmp(&a.1.latest_timestamp_ms))
    });
    ranked.into_iter().map(|(hex, _)| hex).collect()
}

fn load_history_for_hexes(
    partitions: &[&HistoryPartition],
    hexes: &[String],
    history_cutoff_ms: i64,
    hide_ground_traffic: bool,
) -> HashMap<String, Vec<TrafficHistoryPoint>> {
    let hex_set: HashSet<&str> = hexes.iter().map(|h| h.as_str()).collect();
    let mut by_hex: HashMap<String, Vec<TrafficHistoryPoint>> = HashMap::new();

    for partition in partitions {
        for hex in &hex_set {
            if let Some(points) = partition.points_by_hex.get(*hex) {
                let entry = by_hex.entry((*hex).to_string()).or_default();
                for point in points {
                    if point.timestamp_ms < history_cutoff_ms {
                        continue;
                    }
                    if hide_ground_traffic && point.is_on_ground {
                        continue;
                    }
                    entry.push(TrafficHistoryPoint {
                        lat: point.lat,
                        lon: point.lon,
                        altitude_feet: point.altitude_feet,
                        timestamp_ms: point.timestamp_ms,
                    });
                }
            }
        }
    }
    by_hex
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_meta(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .prepare("SELECT value FROM traffic_meta WHERE key = ?")
        .and_then(|mut s| {
            s.query_row([key], |row| row.get::<_, String>(0))
                .map(Some)
        })
        .or_else(|_| Ok(None))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_insert_and_query() {
        let mut grid = SpatialPresenceGrid::new();
        grid.insert(39.86, -104.67, "A12345");
        grid.insert(34.05, -118.25, "B67890");

        let bounds = build_bounding_box(39.86, -104.67, 50.0);
        let found = grid.hexes_in_bbox(&bounds);
        assert!(found.contains("A12345"));
        assert!(!found.contains("B67890"));
    }

    #[test]
    fn grid_dateline_crossing() {
        let mut grid = SpatialPresenceGrid::new();
        // Point near the dateline (Aleutian Islands).
        grid.insert(52.0, 179.5, "ALEUTIAN");
        grid.insert(52.0, -179.5, "ALEUTIAN2");

        let bounds = BoundingBox {
            south: 50.0,
            north: 54.0,
            west: 178.0,
            east: -178.0,
            crosses_dateline: true,
        };
        let found = grid.hexes_in_bbox(&bounds);
        assert!(found.contains("ALEUTIAN"));
        assert!(found.contains("ALEUTIAN2"));
    }

    #[test]
    fn grid_empty_query() {
        let grid = SpatialPresenceGrid::new();
        let bounds = build_bounding_box(40.0, -74.0, 100.0);
        assert!(grid.hexes_in_bbox(&bounds).is_empty());
    }

    #[test]
    fn partition_ring_rotation() {
        let mut ring = PartitionRing::new();
        let t0 = 1_000_000_000_i64;
        ring.rotate_if_needed(t0);
        assert_eq!(ring.active.bucket_start_ms, bucket_start_ms(t0));

        // Append a point.
        ring.append_point(
            "AAAAAA",
            HistoryPoint {
                lat: 40.0,
                lon: -74.0,
                altitude_feet: 10000.0,
                timestamp_ms: t0,
                is_on_ground: false,
            },
        );
        assert_eq!(ring.active.points_by_hex.len(), 1);

        // Advance 6 minutes — should seal the active partition.
        let t1 = t0 + 6 * 60_000;
        ring.rotate_if_needed(t1);
        assert_eq!(ring.sealed.len(), 1);
        assert_eq!(ring.active.bucket_start_ms, bucket_start_ms(t1));
    }

    #[test]
    fn partition_ring_sweep() {
        let mut ring = PartitionRing::new();
        let base = 1_000_000_000_i64;

        // Create several partitions spanning 30 minutes.
        for i in 0..6 {
            let t = base + i * PARTITION_BUCKET_MS;
            ring.rotate_if_needed(t);
            ring.append_point(
                &format!("HEX{i:03}"),
                HistoryPoint {
                    lat: 40.0,
                    lon: -74.0,
                    altitude_feet: 10000.0,
                    timestamp_ms: t,
                    is_on_ground: false,
                },
            );
        }
        // 5 sealed + 1 active.
        assert_eq!(ring.sealed.len(), 5);

        // Sweep: retain only partitions from the last 15 minutes.
        let cutoff = base + 3 * PARTITION_BUCKET_MS;
        ring.sweep_retention(cutoff);
        assert!(ring.sealed.len() <= 3);
    }

    #[test]
    fn memory_store_warming() {
        let store = TrafficMemoryStore::new_empty();
        let request = QueryRequest {
            lat: 40.0,
            lon: -74.0,
            radius_nm: 100.0,
            discovery_radius_nm: 100.0,
            limit: 250,
            history_minutes: 0.0,
            history_hexes: Vec::new(),
            hide_ground_traffic: false,
            now_ms: 1_000_000_000,
        };
        let result = store.query(&request);
        assert!(result.warming);
    }

    #[test]
    fn memory_store_query_current_tracks() {
        let now = 1_000_000_000_i64;
        let tracks = vec![
            TrackEntry {
                hex: "NEAR".into(),
                flight: None,
                lat: 40.0,
                lon: -74.0,
                is_on_ground: false,
                altitude_feet: Some(10000.0),
                ground_speed_kt: Some(250.0),
                track_deg: Some(90.0),
                last_observed_at_ms: now - 1000,
                last_point_ts_ms: None,
                last_point_lat: None,
                last_point_lon: None,
                last_point_altitude_feet: None,
                last_point_is_on_ground: None,
            },
            TrackEntry {
                hex: "FAR".into(),
                flight: None,
                lat: 50.0,
                lon: -74.0,
                is_on_ground: false,
                altitude_feet: Some(35000.0),
                ground_speed_kt: Some(450.0),
                track_deg: Some(180.0),
                last_observed_at_ms: now - 2000,
                last_point_ts_ms: None,
                last_point_lat: None,
                last_point_lon: None,
                last_point_altitude_feet: None,
                last_point_is_on_ground: None,
            },
        ];
        let by_hex = tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.hex.clone(), i))
            .collect();
        let snapshot = CurrentSnapshot {
            tracks,
            by_hex,
            source: Some("test".into()),
            fetched_at_ms: now,
        };
        let store = TrafficMemoryStore {
            current: ArcSwap::from_pointee(snapshot),
            history: RwLock::new(PartitionRing::new()),
        };

        let result = store.query(&QueryRequest {
            lat: 40.0,
            lon: -74.0,
            radius_nm: 100.0,
            discovery_radius_nm: 100.0,
            limit: 250,
            history_minutes: 0.0,
            history_hexes: Vec::new(),
            hide_ground_traffic: false,
            now_ms: now,
        });

        assert!(!result.warming);
        assert_eq!(result.aircraft.len(), 1);
        assert_eq!(result.aircraft[0].hex, "NEAR");
    }
}
