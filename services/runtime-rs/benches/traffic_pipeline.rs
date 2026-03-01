/// Benchmarks for the traffic (ADS-B) pipeline hot paths:
///   1. binCraft decode (zstd + binary parsing)
///   2. AVTR v3 binary encode (SoA serialization)
///   3. distance_nm (Haversine, called per-aircraft in query filter)
///
/// Synthetic data is generated to match realistic ADS-B snapshots
/// (~2500 aircraft, ~150 with history of ~200 points each).

use std::collections::HashMap;
use std::io::Cursor;

use approach_viz_runtime::traffic::{
    decode_bincraft_aircraft, distance_nm, encode_traffic_fb, TrafficAircraft,
    TrafficBinaryPayload, TrafficHistoryPoint,
};
use criterion::{criterion_group, criterion_main, Criterion};
use rusqlite::{params, params_from_iter, Connection};

// ---------------------------------------------------------------------------
// Minimal seeded PRNG (same as weather bench)
// ---------------------------------------------------------------------------

struct SimpleRng(u64);

impl SimpleRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1);
        self.0
    }

    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn next_bool(&mut self, probability: f64) -> bool {
        self.next_f64() < probability
    }
}

fn lerp_f64(lo: f64, hi: f64, t: f64) -> f64 {
    lo + (hi - lo) * t
}

// ---------------------------------------------------------------------------
// Synthetic data generators
// ---------------------------------------------------------------------------

fn generate_aircraft(count: usize) -> Vec<TrafficAircraft> {
    let mut rng = SimpleRng::new(0xAD5B_CAFE_1234);
    (0..count)
        .map(|i| {
            let hex = format!("{:06x}", i);
            let lat = lerp_f64(24.0, 49.0, rng.next_f64());
            let lon = lerp_f64(-125.0, -67.0, rng.next_f64());
            let is_on_ground = rng.next_bool(0.05);
            TrafficAircraft {
                hex,
                flight: if rng.next_bool(0.8) {
                    Some(format!("TST{:04}", i % 10000))
                } else {
                    None
                },
                lat,
                lon,
                is_on_ground,
                altitude_feet: if is_on_ground {
                    None
                } else {
                    Some(lerp_f64(1000.0, 45000.0, rng.next_f64()))
                },
                ground_speed_kt: Some(lerp_f64(50.0, 550.0, rng.next_f64())),
                track_deg: Some(lerp_f64(0.0, 360.0, rng.next_f64())),
                last_seen_seconds: Some(lerp_f64(0.0, 14.0, rng.next_f64())),
            }
        })
        .collect()
}

fn generate_history(
    aircraft: &[TrafficAircraft],
    fraction_with_history: f64,
    points_per_aircraft: usize,
) -> HashMap<String, Vec<TrafficHistoryPoint>> {
    let mut rng = SimpleRng::new(0x1115_CAFE_5678);
    let mut history = HashMap::new();
    for ac in aircraft {
        if !rng.next_bool(fraction_with_history) {
            continue;
        }
        let base_ts = 1700000000000_i64;
        let points: Vec<TrafficHistoryPoint> = (0..points_per_aircraft)
            .map(|j| TrafficHistoryPoint {
                lat: ac.lat + lerp_f64(-0.5, 0.5, rng.next_f64()),
                lon: ac.lon + lerp_f64(-0.5, 0.5, rng.next_f64()),
                altitude_feet: ac.altitude_feet.unwrap_or(0.0)
                    + lerp_f64(-500.0, 500.0, rng.next_f64()),
                timestamp_ms: base_ts + (j as i64 * 1000),
            })
            .collect();
        history.insert(ac.hex.clone(), points);
    }
    history
}

/// Generate a synthetic binCraft-format payload (zstd compressed).
/// This closely mimics the real wire format from ADS-B Exchange.
fn generate_bincraft_payload(count: usize) -> Vec<u8> {
    let stride: u32 = 112; // minimum valid stride
    let version: u32 = 20240218; // BINCRAFT_S32_SEEN_VERSION

    let mut rng = SimpleRng::new(0xB10C_0AF7_9ABC);

    // Header record (first stride bytes)
    let mut raw = vec![0u8; stride as usize];
    raw[8..12].copy_from_slice(&stride.to_le_bytes());
    raw[40..44].copy_from_slice(&version.to_le_bytes());

    // Aircraft records
    for i in 0..count {
        let mut record = vec![0u8; stride as usize];

        // hex (i32 at offset 0)
        let hex_value = (i + 1) as i32;
        record[0..4].copy_from_slice(&hex_value.to_le_bytes());

        // seen (i32 at offset 4, tenths of seconds)
        let seen_tenths = (rng.next_f64() * 140.0) as i32; // 0-14 seconds
        record[4..8].copy_from_slice(&seen_tenths.to_le_bytes());

        // lon (i32 at offset 8, scaled by 1M)
        let lon = lerp_f64(-125.0, -67.0, rng.next_f64());
        let lon_scaled = (lon * 1_000_000.0) as i32;
        record[8..12].copy_from_slice(&lon_scaled.to_le_bytes());

        // lat (i32 at offset 12, scaled by 1M)
        let lat = lerp_f64(24.0, 49.0, rng.next_f64());
        let lat_scaled = (lat * 1_000_000.0) as i32;
        record[12..16].copy_from_slice(&lat_scaled.to_le_bytes());

        // altitude (i16 at offset 22, units of 25 feet)
        let alt_units = (lerp_f64(40.0, 1800.0, rng.next_f64())) as i16; // 1000-45000 ft
        record[22..24].copy_from_slice(&alt_units.to_le_bytes());

        // ground speed (i16 at offset 34, tenths)
        let speed_tenths = (lerp_f64(500.0, 5500.0, rng.next_f64())) as i16;
        record[34..36].copy_from_slice(&speed_tenths.to_le_bytes());

        // track (i16 at offset 40, 90ths of degree)
        let track_90ths = (lerp_f64(0.0, 32400.0, rng.next_f64())) as i16;
        record[40..42].copy_from_slice(&track_90ths.to_le_bytes());

        // airground (byte 68, lower nibble: 0=air, 1=ground)
        record[68] = if rng.next_bool(0.05) { 1 } else { 0 };

        // validity73: bit 6 (lon valid=64), bit 5 (baro alt=32), bit 3 (flight=8), bit 7 (speed=128)
        record[73] = 64 | 32 | 8 | 128;

        // byte 74 bit 3: track valid
        record[74] = 8;

        // flight (bytes 78-86)
        let callsign = format!("TST{:04}\0", i % 10000);
        let bytes = callsign.as_bytes();
        let copy_len = bytes.len().min(8);
        record[78..78 + copy_len].copy_from_slice(&bytes[..copy_len]);

        // seen_pos (i32 at offset 108, tenths of seconds)
        let seen_pos_tenths = (rng.next_f64() * 100.0) as i32;
        record[108..112].copy_from_slice(&seen_pos_tenths.to_le_bytes());

        raw.extend_from_slice(&record);
    }

    // Compress with zstd
    zstd::stream::encode_all(Cursor::new(raw), 3).expect("zstd encode failed")
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_bincraft_decode(c: &mut Criterion) {
    let payload_500 = generate_bincraft_payload(500);
    let payload_2500 = generate_bincraft_payload(2500);
    let payload_5000 = generate_bincraft_payload(5000);

    c.bench_function("bincraft_decode_500ac", |b| {
        b.iter(|| {
            let result = decode_bincraft_aircraft(&payload_500).unwrap();
            std::hint::black_box(result.len())
        })
    });

    c.bench_function("bincraft_decode_2500ac", |b| {
        b.iter(|| {
            let result = decode_bincraft_aircraft(&payload_2500).unwrap();
            std::hint::black_box(result.len())
        })
    });

    c.bench_function("bincraft_decode_5000ac", |b| {
        b.iter(|| {
            let result = decode_bincraft_aircraft(&payload_5000).unwrap();
            std::hint::black_box(result.len())
        })
    });
}

fn bench_avtr_encode(c: &mut Criterion) {
    let aircraft_250 = generate_aircraft(250);
    let aircraft_800 = generate_aircraft(800);

    // No history
    let payload_no_history = TrafficBinaryPayload {
        source: Some("benchmark".to_string()),
        fetched_at_ms: 1700000000000,
        snapshot_age_ms: 0,
        stale_current: false,
        aircraft: aircraft_250.clone(),
        history_by_hex: HashMap::new(),
        error: None,
    };

    c.bench_function("avtr_encode_250ac_no_history", |b| {
        b.iter(|| {
            let bytes = encode_traffic_fb(&payload_no_history);
            std::hint::black_box(bytes.len())
        })
    });

    // With history (150 aircraft × 200 points = 30K points)
    let history = generate_history(&aircraft_800, 0.2, 200);
    let payload_with_history = TrafficBinaryPayload {
        source: Some("benchmark".to_string()),
        fetched_at_ms: 1700000000000,
        snapshot_age_ms: 0,
        stale_current: false,
        aircraft: aircraft_800,
        history_by_hex: history,
        error: None,
    };

    c.bench_function("avtr_encode_800ac_with_history", |b| {
        b.iter(|| {
            let bytes = encode_traffic_fb(&payload_with_history);
            std::hint::black_box(bytes.len())
        })
    });
}

fn bench_distance_nm(c: &mut Criterion) {
    let aircraft = generate_aircraft(2500);
    let center_lat = 40.6413;
    let center_lon = -73.7781;

    c.bench_function("distance_nm_2500ac_filter", |b| {
        b.iter(|| {
            let count = aircraft
                .iter()
                .filter(|ac| distance_nm(center_lat, center_lon, ac.lat, ac.lon) <= 220.0)
                .count();
            std::hint::black_box(count)
        })
    });

    // Tight loop: just the distance computation
    let lats: Vec<f64> = aircraft.iter().map(|ac| ac.lat).collect();
    let lons: Vec<f64> = aircraft.iter().map(|ac| ac.lon).collect();

    c.bench_function("distance_nm_2500_scalar", |b| {
        b.iter(|| {
            let mut sum = 0.0_f64;
            for i in 0..lats.len() {
                sum += distance_nm(center_lat, center_lon, lats[i], lons[i]);
            }
            std::hint::black_box(sum)
        })
    });
}

// ---------------------------------------------------------------------------
// SQLite write-path profiling
// ---------------------------------------------------------------------------

/// Create an in-memory SQLite DB with the exact traffic schema.
fn setup_traffic_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").ok(); // WAL not supported in-memory, but matches prod config
    conn.pragma_update(None, "synchronous", "OFF").unwrap(); // OFF for bench (NORMAL in prod)
    conn.pragma_update(None, "temp_store", "MEMORY").unwrap();

    conn.execute_batch(
        "CREATE TABLE traffic_tracks (
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
        CREATE VIRTUAL TABLE traffic_tracks_rtree USING rtree(
            id, min_lat, max_lat, min_lon, max_lon
        );
        CREATE TRIGGER trg_traffic_tracks_rtree_insert AFTER INSERT ON traffic_tracks
        BEGIN
            DELETE FROM traffic_tracks_rtree WHERE id = new.rowid;
            INSERT INTO traffic_tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
            VALUES (new.rowid, new.last_lat, new.last_lat, new.last_lon, new.last_lon);
        END;
        CREATE TRIGGER trg_traffic_tracks_rtree_update AFTER UPDATE OF last_lat, last_lon ON traffic_tracks
        BEGIN
            DELETE FROM traffic_tracks_rtree WHERE id = new.rowid;
            INSERT INTO traffic_tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
            VALUES (new.rowid, new.last_lat, new.last_lat, new.last_lon, new.last_lon);
        END;
        CREATE INDEX idx_traffic_tracks_last_seen ON traffic_tracks(last_observed_at_ms);
        CREATE INDEX idx_traffic_tracks_live ON traffic_tracks(last_observed_at_ms, last_lat, last_lon);
        CREATE TABLE traffic_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

        -- History partition (single partition for benchmark)
        CREATE TABLE traffic_points_ring_s0 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hex TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            altitude_feet REAL NOT NULL,
            is_on_ground INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE traffic_points_ring_s0_rtree USING rtree(
            id, min_lat, max_lat, min_lon, max_lon
        );
        CREATE TRIGGER trg_traffic_points_ring_s0_rtree_insert AFTER INSERT ON traffic_points_ring_s0
        BEGIN
            DELETE FROM traffic_points_ring_s0_rtree WHERE id = new.id;
            INSERT INTO traffic_points_ring_s0_rtree (id, min_lat, max_lat, min_lon, max_lon)
            VALUES (new.id, new.lat, new.lat, new.lon, new.lon);
        END;
        CREATE INDEX idx_traffic_points_ring_s0_ts ON traffic_points_ring_s0(timestamp_ms);
        CREATE INDEX idx_traffic_points_ring_s0_hex_ts ON traffic_points_ring_s0(hex, timestamp_ms);
        ",
    )
    .unwrap();

    conn
}

/// Seed the DB with existing tracks (simulates steady-state where most aircraft already exist).
fn seed_existing_tracks(conn: &mut Connection, aircraft: &[TrafficAircraft], polled_at_ms: i64) {
    let tx = conn.transaction().unwrap();
    for ac in aircraft {
        let observed_at_ms = ac
            .last_seen_seconds
            .map(|s| (polled_at_ms as f64 - s * 1000.0).round() as i64)
            .unwrap_or(polled_at_ms);
        tx.execute(
            "INSERT OR REPLACE INTO traffic_tracks
             (hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
              last_observed_at_ms, last_lat, last_lon,
              last_point_ts_ms, last_point_lat, last_point_lon, last_point_altitude_feet, last_point_is_on_ground)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                ac.hex,
                ac.flight,
                if ac.is_on_ground { 1_i64 } else { 0 },
                ac.altitude_feet,
                ac.ground_speed_kt,
                ac.track_deg,
                observed_at_ms,
                ac.lat,
                ac.lon,
                observed_at_ms,
                ac.lat,
                ac.lon,
                ac.altitude_feet.unwrap_or(0.0),
                if ac.is_on_ground { 1_i64 } else { 0 },
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

/// Replicate the exact ingest write path from store.rs:
///   1. load_existing_tracks (SELECT ... WHERE hex IN (...))
///   2. Per-aircraft: INSERT OR REPLACE into traffic_tracks
///   3. Per-aircraft: conditional INSERT into history partition
fn ingest_current_approach(
    conn: &mut Connection,
    aircraft: &[TrafficAircraft],
    polled_at_ms: i64,
) {
    let tx = conn.transaction().unwrap();

    // Phase 1: load_existing_tracks (chunked SELECT)
    let hexes: Vec<&str> = aircraft.iter().map(|ac| ac.hex.as_str()).collect();
    let mut existing: HashMap<String, (i64, f64, f64)> = HashMap::new();
    for chunk in hexes.chunks(800) {
        let placeholders: String = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT hex, last_observed_at_ms, last_lat, last_lon
             FROM traffic_tracks WHERE hex IN ({placeholders})"
        );
        let mut stmt = tx.prepare(&sql).unwrap();
        let rows = stmt
            .query_map(params_from_iter(chunk.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })
            .unwrap();
        for row in rows {
            let (hex, ts, lat, lon) = row.unwrap();
            existing.insert(hex, (ts, lat, lon));
        }
    }

    // Phase 2+3: per-aircraft upsert track + insert history point
    for ac in aircraft {
        let observed_at_ms = ac
            .last_seen_seconds
            .map(|s| (polled_at_ms as f64 - s * 1000.0).round() as i64)
            .unwrap_or(polled_at_ms);

        // Upsert track
        tx.execute(
            "INSERT INTO traffic_tracks
             (hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
              last_observed_at_ms, last_lat, last_lon,
              last_point_ts_ms, last_point_lat, last_point_lon, last_point_altitude_feet, last_point_is_on_ground)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                ac.hex,
                ac.flight,
                if ac.is_on_ground { 1_i64 } else { 0 },
                ac.altitude_feet,
                ac.ground_speed_kt,
                ac.track_deg,
                observed_at_ms,
                ac.lat,
                ac.lon,
                observed_at_ms,
                ac.lat,
                ac.lon,
                ac.altitude_feet.unwrap_or(0.0),
                if ac.is_on_ground { 1_i64 } else { 0 },
            ],
        )
        .unwrap();

        // Insert history point (always, for worst-case measurement)
        tx.execute(
            "INSERT INTO traffic_points_ring_s0 (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                ac.hex,
                observed_at_ms,
                ac.lat,
                ac.lon,
                ac.altitude_feet.unwrap_or(0.0),
                if ac.is_on_ground { 1_i64 } else { 0 },
            ],
        )
        .unwrap();
    }

    tx.execute(
        "INSERT INTO traffic_meta (key, value) VALUES ('updated_at_ms', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![polled_at_ms.to_string()],
    )
    .unwrap();

    tx.commit().unwrap();
}

/// Same as above but with prepared statements reused across aircraft.
fn ingest_prepared_statements(
    conn: &mut Connection,
    aircraft: &[TrafficAircraft],
    polled_at_ms: i64,
) {
    let tx = conn.transaction().unwrap();

    // Phase 1: load_existing_tracks (chunked SELECT) — same as current
    let hexes: Vec<&str> = aircraft.iter().map(|ac| ac.hex.as_str()).collect();
    let mut _existing_count = 0usize;
    for chunk in hexes.chunks(800) {
        let placeholders: String = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT hex FROM traffic_tracks WHERE hex IN ({placeholders})"
        );
        let mut stmt = tx.prepare(&sql).unwrap();
        let rows = stmt
            .query_map(params_from_iter(chunk.iter()), |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        for row in rows {
            let _ = row.unwrap();
            _existing_count += 1;
        }
    }

    // Phase 2+3: PREPARED statements (prepare once, execute N times)
    {
        let mut upsert_stmt = tx
            .prepare(
                "INSERT INTO traffic_tracks
                 (hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
                  last_observed_at_ms, last_lat, last_lon,
                  last_point_ts_ms, last_point_lat, last_point_lon, last_point_altitude_feet, last_point_is_on_ground)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            .unwrap();

        let mut history_stmt = tx
            .prepare(
                "INSERT INTO traffic_points_ring_s0 (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .unwrap();

        for ac in aircraft {
            let observed_at_ms = ac
                .last_seen_seconds
                .map(|s| (polled_at_ms as f64 - s * 1000.0).round() as i64)
                .unwrap_or(polled_at_ms);

            upsert_stmt
                .execute(params![
                    ac.hex,
                    ac.flight,
                    if ac.is_on_ground { 1_i64 } else { 0 },
                    ac.altitude_feet,
                    ac.ground_speed_kt,
                    ac.track_deg,
                    observed_at_ms,
                    ac.lat,
                    ac.lon,
                    observed_at_ms,
                    ac.lat,
                    ac.lon,
                    ac.altitude_feet.unwrap_or(0.0),
                    if ac.is_on_ground { 1_i64 } else { 0 },
                ])
                .unwrap();

            history_stmt
                .execute(params![
                    ac.hex,
                    observed_at_ms,
                    ac.lat,
                    ac.lon,
                    ac.altitude_feet.unwrap_or(0.0),
                    if ac.is_on_ground { 1_i64 } else { 0 },
                ])
                .unwrap();
        }
    }

    tx.execute(
        "INSERT INTO traffic_meta (key, value) VALUES ('updated_at_ms', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![polled_at_ms.to_string()],
    )
    .unwrap();

    tx.commit().unwrap();
}

fn bench_sqlite_ingest(c: &mut Criterion) {
    let aircraft = generate_aircraft(2500);
    let polled_at_ms = 1700000000000_i64;

    // --- Current approach: re-prepare SQL each aircraft ---
    {
        let mut conn = setup_traffic_db();
        seed_existing_tracks(&mut conn, &aircraft, polled_at_ms - 1000);

        c.bench_function("sqlite_ingest_2500ac_current", |b| {
            b.iter(|| {
                ingest_current_approach(&mut conn, &aircraft, polled_at_ms);
            })
        });
    }

    // --- Prepared statements: prepare once, execute N times ---
    {
        let mut conn = setup_traffic_db();
        seed_existing_tracks(&mut conn, &aircraft, polled_at_ms - 1000);

        c.bench_function("sqlite_ingest_2500ac_prepared", |b| {
            b.iter(|| {
                ingest_prepared_statements(&mut conn, &aircraft, polled_at_ms);
            })
        });
    }

    // --- Isolate: track upsert only (no history, measures R-tree trigger overhead) ---
    {
        let mut conn = setup_traffic_db();
        seed_existing_tracks(&mut conn, &aircraft, polled_at_ms - 1000);

        c.bench_function("sqlite_track_upsert_only_2500ac", |b| {
            b.iter(|| {
                let tx = conn.transaction().unwrap();
                {
                    let mut stmt = tx
                        .prepare_cached(
                            "INSERT INTO traffic_tracks
                             (hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
                              last_observed_at_ms, last_lat, last_lon,
                              last_point_ts_ms, last_point_lat, last_point_lon, last_point_altitude_feet, last_point_is_on_ground)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        .unwrap();
                    for ac in &aircraft {
                        let observed_at_ms = polled_at_ms;
                        stmt.execute(params![
                            ac.hex,
                            ac.flight,
                            if ac.is_on_ground { 1_i64 } else { 0 },
                            ac.altitude_feet,
                            ac.ground_speed_kt,
                            ac.track_deg,
                            observed_at_ms,
                            ac.lat,
                            ac.lon,
                            observed_at_ms,
                            ac.lat,
                            ac.lon,
                            ac.altitude_feet.unwrap_or(0.0),
                            if ac.is_on_ground { 1_i64 } else { 0 },
                        ])
                        .unwrap();
                    }
                }
                tx.commit().unwrap();
            })
        });
    }

    // --- Isolate: history INSERT only (measures history R-tree trigger overhead) ---
    {
        let mut conn = setup_traffic_db();

        c.bench_function("sqlite_history_insert_only_2500ac", |b| {
            // Clear history between iterations
            b.iter(|| {
                let tx = conn.transaction().unwrap();
                tx.execute("DELETE FROM traffic_points_ring_s0_rtree", [])
                    .unwrap();
                tx.execute("DELETE FROM traffic_points_ring_s0", [])
                    .unwrap();
                {
                    let mut stmt = tx
                        .prepare_cached(
                            "INSERT INTO traffic_points_ring_s0 (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground)
                             VALUES (?, ?, ?, ?, ?, ?)",
                        )
                        .unwrap();
                    for ac in &aircraft {
                        stmt.execute(params![
                            ac.hex,
                            polled_at_ms,
                            ac.lat,
                            ac.lon,
                            ac.altitude_feet.unwrap_or(0.0),
                            if ac.is_on_ground { 1_i64 } else { 0 },
                        ])
                        .unwrap();
                    }
                }
                tx.commit().unwrap();
            })
        });
    }

    // --- Isolate: load_existing_tracks SELECT ---
    {
        let mut conn = setup_traffic_db();
        seed_existing_tracks(&mut conn, &aircraft, polled_at_ms);

        let hexes: Vec<String> = aircraft.iter().map(|ac| ac.hex.clone()).collect();

        c.bench_function("sqlite_load_existing_tracks_2500ac", |b| {
            b.iter(|| {
                let mut count = 0usize;
                for chunk in hexes.chunks(800) {
                    let placeholders: String = std::iter::repeat("?")
                        .take(chunk.len())
                        .collect::<Vec<_>>()
                        .join(", ");
                    let sql = format!(
                        "SELECT hex, flight, is_on_ground, altitude_feet, ground_speed_kt, track_deg,
                                last_observed_at_ms, last_lat, last_lon,
                                last_point_ts_ms, last_point_lat, last_point_lon, last_point_altitude_feet, last_point_is_on_ground
                         FROM traffic_tracks WHERE hex IN ({placeholders})"
                    );
                    let mut stmt = conn.prepare(&sql).unwrap();
                    let rows = stmt
                        .query_map(params_from_iter(chunk.iter()), |row| {
                            row.get::<_, String>(0)
                        })
                        .unwrap();
                    for row in rows {
                        let _ = row.unwrap();
                        count += 1;
                    }
                }
                std::hint::black_box(count)
            })
        });
    }
}

// ---------------------------------------------------------------------------
// In-memory query benchmarks
// ---------------------------------------------------------------------------

fn bench_memory_query(c: &mut Criterion) {
    use approach_viz_runtime::traffic::{QueryRequest, TrafficMemoryStore};

    let now_ms = 1700000000000_i64;

    // Query warming state (baseline — no data, measures ArcSwap load overhead).
    c.bench_function("memory_query_warming_state", |b| {
        let store = TrafficMemoryStore::new_empty();
        let request = QueryRequest {
            lat: 40.6413,
            lon: -73.7781,
            radius_nm: 100.0,
            discovery_radius_nm: 100.0,
            limit: 250,
            history_minutes: 0.0,
            history_hexes: Vec::new(),
            hide_ground_traffic: false,
            now_ms,
        };
        b.iter(|| {
            let result = store.query(&request);
            std::hint::black_box(result.warming)
        })
    });

    // Distance filter benchmark at 10K tracks (simulates in-memory scan).
    let center_lat: f64 = 40.6413;
    let center_lon: f64 = -73.7781;
    let ac_10k = generate_aircraft(10_000);

    c.bench_function("distance_nm_10k_bbox_filter", |b| {
        let south = center_lat - 100.0 / 60.0;
        let north = center_lat + 100.0 / 60.0;
        let cos_lat = center_lat.to_radians().cos().abs().max(0.01);
        let west = center_lon - 100.0 / (60.0 * cos_lat);
        let east = center_lon + 100.0 / (60.0 * cos_lat);

        b.iter(|| {
            let count = ac_10k
                .iter()
                .filter(|ac| {
                    ac.lat >= south
                        && ac.lat <= north
                        && ac.lon >= west
                        && ac.lon <= east
                        && distance_nm(center_lat, center_lon, ac.lat, ac.lon) <= 100.0
                })
                .count();
            std::hint::black_box(count)
        })
    });
}

criterion_group!(
    benches,
    bench_bincraft_decode,
    bench_avtr_encode,
    bench_distance_nm,
    bench_sqlite_ingest,
    bench_memory_query
);
criterion_main!(benches);
