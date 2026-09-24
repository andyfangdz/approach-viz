//! Steady-state harness for the real `TrafficStore` ingest and query paths.
//!
//! Criterion micro-iterations cannot show the costs that dominate production: a large
//! history ring, bucket rollover, and a database bigger than SQLite's page cache. This
//! drives the actual store with a deterministic fleet in simulated time and reports:
//!
//!   * per-ingest latency percentiles and CPU-seconds per ingest (== core utilisation at 1 Hz)
//!   * query latency for the scenes the web client issues
//!   * a state fingerprint of the live memory state and of the state reloaded from SQLite,
//!     which must be identical before and after any optimisation (same idea as the MRMS
//!     `Scan fingerprint`).
//!
//! Usage: `cargo bench --bench traffic_store -- [--aircraft N] [--warm TICKS] [--measure TICKS]
//!         [--dir PATH] [--keep] [--legacy-schema] [--reuse]`
//! `--legacy-schema` seeds the objects older releases left in production databases; `--reuse`
//! only times opening an existing database in `--dir` (startup migration and load).
//! Defaults approximate production: 8,000 aircraft, 400 s warm-up (crosses a 5-minute bucket
//! rollover), 120 measured ticks.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::Instant;

use approach_viz_runtime::traffic::{
    QueryRequest, TrafficAircraft, TrafficStore, ingest_to_store, query_store,
};

const START_BUCKET_MS: i64 = 1_700_000_100_000 / 300_000 * 300_000;
const RETENTION_SWEEP_TICKS: i64 = 300;

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
}

struct Sim {
    id: u32,
    flight: Option<String>,
    lat: f64,
    lon: f64,
    speed_kt: f64,
    track_deg: f64,
    altitude_feet: f64,
    on_ground: bool,
    stationary: bool,
    dropout_ticks: u32,
    silent_seconds: f64,
}

struct Fleet {
    rng: Rng,
    next_id: u32,
    aircraft: Vec<Sim>,
    all_hexes: Vec<String>,
}

impl Fleet {
    fn new(count: usize) -> Self {
        let mut fleet = Self {
            rng: Rng(0x9E37_79B9_7F4A_7C15),
            next_id: 0x0a_0000,
            aircraft: Vec::with_capacity(count),
            all_hexes: Vec::new(),
        };
        for _ in 0..count {
            let sim = fleet.spawn();
            fleet.aircraft.push(sim);
        }
        fleet
    }

    fn spawn(&mut self) -> Sim {
        let id = self.next_id;
        self.next_id += 1;
        self.all_hexes.push(format!("{id:06x}"));
        let on_ground = self.rng.unit() < 0.10;
        // Concentrate traffic around a few hubs so scene queries return realistic counts.
        let hubs = [
            (40.64, -73.78),
            (33.94, -118.41),
            (41.98, -87.90),
            (33.64, -84.43),
        ];
        let (lat, lon) = if self.rng.unit() < 0.5 {
            let hub = hubs[(self.rng.next_u64() % hubs.len() as u64) as usize];
            (
                hub.0 + self.rng.range(-2.5, 2.5),
                hub.1 + self.rng.range(-3.0, 3.0),
            )
        } else {
            (self.rng.range(25.0, 48.5), self.rng.range(-124.0, -68.0))
        };
        Sim {
            id,
            flight: (self.rng.unit() < 0.8).then(|| format!("TST{:04}", id % 10_000)),
            lat,
            lon,
            speed_kt: if on_ground {
                0.0
            } else {
                self.rng.range(90.0, 520.0)
            },
            track_deg: self.rng.range(0.0, 360.0),
            altitude_feet: if on_ground {
                0.0
            } else {
                self.rng.range(1_000.0, 41_000.0)
            },
            on_ground,
            stationary: on_ground && self.rng.unit() < 0.6,
            dropout_ticks: 0,
            silent_seconds: 0.0,
        }
    }

    /// Advance one second and return the snapshot the poller would hand to the store.
    fn tick(&mut self) -> Vec<TrafficAircraft> {
        let churn = if self.rng.unit() < 0.4 { 1 } else { 0 };
        for _ in 0..churn {
            let index = (self.rng.next_u64() % self.aircraft.len() as u64) as usize;
            self.aircraft[index] = self.spawn();
        }

        let mut out = Vec::with_capacity(self.aircraft.len());
        for index in 0..self.aircraft.len() {
            let roll = self.rng.unit();
            let jitter = self.rng.range(0.0, 1.4);
            let turn = self.rng.range(-1.5, 1.5);
            let climb = self.rng.range(-60.0, 60.0);
            let sim = &mut self.aircraft[index];
            if sim.dropout_ticks > 0 {
                sim.dropout_ticks -= 1;
                continue;
            }
            if roll < 0.002 {
                sim.dropout_ticks = 3 + (roll * 10_000.0) as u32 % 25;
                continue;
            }
            if !sim.stationary {
                let distance_deg = sim.speed_kt / 3600.0 / 60.0;
                let radians = sim.track_deg.to_radians();
                sim.lat += distance_deg * radians.cos();
                sim.lon += distance_deg * radians.sin() / sim.lat.to_radians().cos().max(0.2);
                sim.track_deg = (sim.track_deg + turn).rem_euclid(360.0);
                if !sim.on_ground {
                    sim.altitude_feet = (sim.altitude_feet + climb).clamp(500.0, 45_000.0);
                }
                if !(23.5..=49.5).contains(&sim.lat) || !(-125.0..=-66.0).contains(&sim.lon) {
                    sim.track_deg = (sim.track_deg + 180.0).rem_euclid(360.0);
                    sim.lat = sim.lat.clamp(23.5, 49.5);
                    sim.lon = sim.lon.clamp(-125.0, -66.0);
                }
            }
            // A parked aircraft goes silent for a while; its last position ages instead of updating.
            let seen = if sim.stationary {
                sim.silent_seconds += 1.0;
                if sim.silent_seconds > 40.0 {
                    sim.silent_seconds = 0.0;
                }
                sim.silent_seconds
            } else {
                jitter
            };
            out.push(TrafficAircraft {
                hex: format!("{:06x}", sim.id),
                flight: sim.flight.clone(),
                lat: sim.lat,
                lon: sim.lon,
                is_on_ground: sim.on_ground,
                altitude_feet: (!sim.on_ground).then(|| (sim.altitude_feet / 25.0).round() * 25.0),
                ground_speed_kt: Some((sim.speed_kt * 10.0).round() / 10.0),
                track_deg: Some((sim.track_deg * 90.0).round() / 90.0),
                last_seen_seconds: Some((seen * 10.0).round() / 10.0),
            });
        }
        out
    }
}

fn self_usage() -> libc::rusage {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let status = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    assert_eq!(status, 0, "getrusage failed");
    usage
}

/// User plus system CPU time of the whole process.
fn process_cpu_seconds() -> f64 {
    let usage = self_usage();
    let seconds = |time: libc::timeval| time.tv_sec as f64 + time.tv_usec as f64 / 1e6;
    seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

/// Peak resident set size; `ru_maxrss` is KiB on Linux and bytes on macOS.
fn peak_rss_mb() -> f64 {
    let max_rss = self_usage().ru_maxrss as f64;
    if cfg!(target_os = "macos") {
        max_rss / 1_048_576.0
    } else {
        max_rss / 1024.0
    }
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

fn summarize(label: &str, mut samples: Vec<f64>) {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    println!(
        "{label:<34} n={:<5} mean={mean:>8.2}ms p50={:>8.2} p95={:>8.2} p99={:>8.2} max={:>8.2}",
        samples.len(),
        percentile(&samples, 0.50),
        percentile(&samples, 0.95),
        percentile(&samples, 0.99),
        samples.last().unwrap()
    );
}

fn scene(lat: f64, lon: f64, now_ms: i64) -> QueryRequest {
    QueryRequest {
        lat,
        lon,
        radius_nm: 80.0,
        discovery_radius_nm: 80.0,
        limit: 250,
        history_minutes: 0.0,
        history_hexes: Vec::new(),
        hide_ground_traffic: false,
        now_ms,
    }
}

/// Everything the store holds, hashed in a canonical order.
async fn fingerprint(store: &TrafficStore, hexes: &[String], now_ms: i64) -> (u64, usize, usize) {
    let mut request = scene(0.0, -100.0, now_ms);
    request.radius_nm = 8_000.0;
    request.discovery_radius_nm = 8_000.0;
    request.limit = usize::MAX;
    request.history_minutes = 60.0;
    request.history_hexes = hexes.to_vec();
    let result = query_store(store, request).await.expect("dump query");

    let mut hasher = DefaultHasher::new();
    result.source.hash(&mut hasher);
    result.fetched_at_ms.hash(&mut hasher);
    let mut aircraft = result.aircraft;
    aircraft.sort_by(|a, b| a.hex.cmp(&b.hex));
    for ac in &aircraft {
        ac.hex.hash(&mut hasher);
        ac.flight.hash(&mut hasher);
        ac.lat.to_bits().hash(&mut hasher);
        ac.lon.to_bits().hash(&mut hasher);
        ac.is_on_ground.hash(&mut hasher);
        ac.altitude_feet.map(f64::to_bits).hash(&mut hasher);
        ac.ground_speed_kt.map(f64::to_bits).hash(&mut hasher);
        ac.track_deg.map(f64::to_bits).hash(&mut hasher);
        ac.last_seen_seconds.map(f64::to_bits).hash(&mut hasher);
    }
    let mut history: Vec<_> = result.history_by_hex.into_iter().collect();
    history.sort_by(|a, b| a.0.cmp(&b.0));
    let mut points = 0;
    for (hex, series) in &history {
        hex.hash(&mut hasher);
        for point in series {
            point.lat.to_bits().hash(&mut hasher);
            point.lon.to_bits().hash(&mut hasher);
            point.altitude_feet.to_bits().hash(&mut hasher);
            point.timestamp_ms.hash(&mut hasher);
            points += 1;
        }
    }
    (hasher.finish(), aircraft.len(), points)
}

/// Recreate the schema a long-lived production database still carries from earlier releases:
/// R*Tree mirrors maintained by triggers, AUTOINCREMENT point tables with time/hex indexes, the
/// extra live-track index, and expired `traffic_points_p*` tables from the pre-ring layout.
fn create_legacy_schema(db_path: &std::path::Path) {
    let connection = rusqlite::Connection::open(db_path).expect("open legacy db");
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
            CREATE TABLE traffic_tracks (
                hex TEXT PRIMARY KEY, flight TEXT, is_on_ground INTEGER NOT NULL,
                altitude_feet REAL, ground_speed_kt REAL, track_deg REAL,
                last_observed_at_ms INTEGER NOT NULL, last_lat REAL NOT NULL, last_lon REAL NOT NULL,
                last_point_ts_ms INTEGER, last_point_lat REAL, last_point_lon REAL,
                last_point_altitude_feet REAL, last_point_is_on_ground INTEGER
            );
            CREATE TABLE traffic_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE traffic_partitions (
                bucket_start_ms INTEGER PRIMARY KEY, points_table TEXT NOT NULL, rtree_table TEXT NOT NULL
            );
            CREATE TABLE traffic_ring_slots (
                slot INTEGER PRIMARY KEY, bucket_start_ms INTEGER NOT NULL,
                points_table TEXT NOT NULL, rtree_table TEXT NOT NULL
            );
            CREATE INDEX idx_traffic_tracks_last_seen ON traffic_tracks(last_observed_at_ms);
            CREATE INDEX idx_traffic_tracks_live ON traffic_tracks(last_observed_at_ms, last_lat, last_lon);
            CREATE INDEX idx_traffic_ring_slots_bucket ON traffic_ring_slots(bucket_start_ms);
            CREATE VIRTUAL TABLE traffic_tracks_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);
            CREATE TRIGGER trg_traffic_tracks_rtree_insert AFTER INSERT ON traffic_tracks BEGIN
                DELETE FROM traffic_tracks_rtree WHERE id = new.rowid;
                INSERT INTO traffic_tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
                VALUES (new.rowid, new.last_lat, new.last_lat, new.last_lon, new.last_lon);
            END;
            CREATE TRIGGER trg_traffic_tracks_rtree_update AFTER UPDATE OF last_lat, last_lon ON traffic_tracks BEGIN
                DELETE FROM traffic_tracks_rtree WHERE id = new.rowid;
                INSERT INTO traffic_tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
                VALUES (new.rowid, new.last_lat, new.last_lat, new.last_lon, new.last_lon);
            END;
            CREATE TRIGGER trg_traffic_tracks_rtree_delete AFTER DELETE ON traffic_tracks BEGIN
                DELETE FROM traffic_tracks_rtree WHERE id = old.rowid;
            END;",
        )
        .expect("legacy base schema");
    let mut tables: Vec<String> = (0..12)
        .map(|slot| format!("traffic_points_ring_s{slot}"))
        .collect();
    for index in 0..3 {
        let bucket = 1_771_805_700_000_i64 + index * 300_000;
        let table = format!("traffic_points_p{bucket}");
        connection
            .execute(
                "INSERT INTO traffic_partitions VALUES (?, ?, ?)",
                rusqlite::params![bucket, table, format!("{table}_rtree")],
            )
            .unwrap();
        tables.push(table);
    }
    for (slot, table) in tables.iter().enumerate() {
        connection
            .execute_batch(&format!(
                "CREATE TABLE \"{table}\" (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, hex TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
                    lat REAL NOT NULL, lon REAL NOT NULL, altitude_feet REAL NOT NULL, is_on_ground INTEGER NOT NULL
                );
                CREATE INDEX \"idx_{table}_ts\" ON \"{table}\"(timestamp_ms);
                CREATE INDEX \"idx_{table}_hex_ts\" ON \"{table}\"(hex, timestamp_ms);
                CREATE VIRTUAL TABLE \"{table}_rtree\" USING rtree(id, min_lat, max_lat, min_lon, max_lon);
                CREATE TRIGGER \"trg_{table}_rtree_insert\" AFTER INSERT ON \"{table}\" BEGIN
                    DELETE FROM \"{table}_rtree\" WHERE id = new.id;
                    INSERT INTO \"{table}_rtree\" (id, min_lat, max_lat, min_lon, max_lon)
                    VALUES (new.id, new.lat, new.lat, new.lon, new.lon);
                END;
                CREATE TRIGGER \"trg_{table}_rtree_update\" AFTER UPDATE OF lat, lon ON \"{table}\" BEGIN
                    DELETE FROM \"{table}_rtree\" WHERE id = new.id;
                    INSERT INTO \"{table}_rtree\" (id, min_lat, max_lat, min_lon, max_lon)
                    VALUES (new.id, new.lat, new.lat, new.lon, new.lon);
                END;
                CREATE TRIGGER \"trg_{table}_rtree_delete\" AFTER DELETE ON \"{table}\" BEGIN
                    DELETE FROM \"{table}_rtree\" WHERE id = old.id;
                END;"
            ))
            .expect("legacy point table");
        if slot < 12 {
            connection
                .execute(
                    "INSERT INTO traffic_ring_slots VALUES (?, -1, ?, ?)",
                    rusqlite::params![slot as i64, table, format!("{table}_rtree")],
                )
                .unwrap();
        }
    }
    // An expired legacy partition with a few rows, as left behind in production.
    connection
        .execute_batch(
            "INSERT INTO \"traffic_points_p1771805700000\" (hex, timestamp_ms, lat, lon, altitude_feet, is_on_ground)
             VALUES ('abcdef', 1771805700000, 40.0, -74.0, 1000.0, 0);",
        )
        .unwrap();
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1).cloned())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let aircraft_count: usize =
        arg_value(&args, "--aircraft").map_or(8_000, |v| v.parse().unwrap());
    let warm: i64 = arg_value(&args, "--warm").map_or(400, |v| v.parse().unwrap());
    let measure: i64 = arg_value(&args, "--measure").map_or(120, |v| v.parse().unwrap());
    let keep = args.iter().any(|arg| arg == "--keep");
    let dir = arg_value(&args, "--dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.tmp/traffic-store-bench")
        });
    // --reuse opens an existing database (e.g. one kept from a legacy-schema run) to time startup.
    let reuse = args.iter().any(|arg| arg == "--reuse");
    if !reuse {
        let _ = std::fs::remove_dir_all(&dir);
    }
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("traffic-store.db");
    if !reuse && args.iter().any(|arg| arg == "--legacy-schema") {
        create_legacy_schema(&db_path);
        println!("seeded legacy production schema");
    }

    let open_started = Instant::now();
    let store = TrafficStore::new(db_path.clone()).expect("open store");
    println!(
        "store open {:.0} ms",
        open_started.elapsed().as_secs_f64() * 1000.0
    );
    if reuse {
        return;
    }
    let mut fleet = Fleet::new(aircraft_count);
    let start_ms = START_BUCKET_MS + 150_000;

    let mut tick = 0_i64;
    let mut ingest = |tick: i64| -> (Vec<TrafficAircraft>, i64, bool) {
        (
            fleet.tick(),
            start_ms + tick * 1_000,
            tick % RETENTION_SWEEP_TICKS == RETENTION_SWEEP_TICKS - 1,
        )
    };

    println!("warming {warm} ticks with ~{aircraft_count} aircraft...");
    let warm_started = Instant::now();
    while tick < warm {
        let (aircraft, polled_at_ms, sweep) = ingest(tick);
        ingest_to_store(&store, "bench".into(), aircraft, polled_at_ms, sweep)
            .await
            .expect("warm ingest");
        tick += 1;
    }
    println!("warm-up wall {:.1}s", warm_started.elapsed().as_secs_f64());

    let cpu_before = process_cpu_seconds();
    let mut latencies = Vec::new();
    let mut rollover = Vec::new();
    let mut fed = 0_usize;
    let measure_started = Instant::now();
    for _ in 0..measure {
        let (aircraft, polled_at_ms, sweep) = ingest(tick);
        fed += aircraft.len();
        let started = Instant::now();
        ingest_to_store(&store, "bench".into(), aircraft, polled_at_ms, sweep)
            .await
            .expect("ingest");
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        if (start_ms + tick * 1_000) % 300_000 < 1_000 {
            rollover.push(elapsed_ms);
        }
        latencies.push(elapsed_ms);
        tick += 1;
    }
    let cpu_seconds = process_cpu_seconds() - cpu_before;
    let now_ms = start_ms + tick * 1_000;
    println!(
        "measured wall {:.1}s, avg {:.0} aircraft/tick",
        measure_started.elapsed().as_secs_f64(),
        fed as f64 / measure as f64
    );
    summarize("ingest latency", latencies);
    if !rollover.is_empty() {
        summarize("  (bucket rollover ticks)", rollover);
    }
    println!(
        "CPU per ingest: {:.1} ms  ->  {:.1}% of one core at 1 Hz   peak RSS {:.0} MB",
        cpu_seconds / measure as f64 * 1000.0,
        cpu_seconds / measure as f64 * 100.0,
        peak_rss_mb()
    );

    // Queries as the web client issues them (default scene, live poll + trail discovery).
    let scenes = [
        (40.64, -73.78),
        (33.94, -118.41),
        (41.98, -87.90),
        (39.86, -104.67),
    ];
    let mut live = Vec::new();
    let mut discovery = Vec::new();
    let mut targeted = Vec::new();
    let mut returned = 0;
    for round in 0..150 {
        let (lat, lon) = scenes[round % scenes.len()];
        let started = Instant::now();
        let result = query_store(&store, scene(lat, lon, now_ms)).await.unwrap();
        live.push(started.elapsed().as_secs_f64() * 1000.0);
        returned = result.aircraft.len();

        let mut request = scene(lat, lon, now_ms);
        request.history_minutes = 3.0;
        let started = Instant::now();
        let result = query_store(&store, request.clone()).await.unwrap();
        discovery.push(started.elapsed().as_secs_f64() * 1000.0);

        request.history_hexes = result.history_by_hex.keys().take(60).cloned().collect();
        let started = Instant::now();
        query_store(&store, request).await.unwrap();
        targeted.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    println!("scene returns {returned} aircraft");
    summarize("query live", live);
    summarize("query live + 3min discovery", discovery);
    summarize("query targeted history (60 hex)", targeted);

    let (live_hash, live_aircraft, live_points) =
        fingerprint(&store, &fleet.all_hexes, now_ms).await;
    println!(
        "Live fingerprint      {live_hash:016x} aircraft={live_aircraft} history_points={live_points}"
    );

    drop(store);
    // Give the writer thread a moment to drain and release its connection, then reload from disk.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let reload_started = Instant::now();
    let reloaded = TrafficStore::new(db_path.clone()).expect("reopen store");
    let reload_ms = reload_started.elapsed().as_secs_f64() * 1000.0;
    let (disk_hash, disk_aircraft, disk_points) =
        fingerprint(&reloaded, &fleet.all_hexes, now_ms).await;
    println!(
        "Reloaded fingerprint  {disk_hash:016x} aircraft={disk_aircraft} history_points={disk_points} (restart load {reload_ms:.0} ms)"
    );
    println!(
        "live == reloaded: {}",
        if live_hash == disk_hash {
            "yes"
        } else {
            "NO (persisted state diverges from memory)"
        }
    );
    let db_bytes = ["", "-wal"]
        .iter()
        .filter_map(|suffix| std::fs::metadata(format!("{}{suffix}", db_path.display())).ok())
        .map(|m| m.len())
        .sum::<u64>();
    println!("database on disk: {:.0} MB", db_bytes as f64 / 1_048_576.0);

    drop(reloaded);
    if !keep {
        let _ = std::fs::remove_dir_all(&dir);
    }
}
