//! End-to-end tests of scan ingestion over a local mirror of tiny synthetic MRMS
//! scans (see `testkit`): every level, dual-pol and aux product goes through the
//! real download → decode → reduce → assemble path.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock, Semaphore};

use super::processor::ingest_timestamp;
use super::testkit::{self, Packing, grib_field, gzip};
use crate::config::Config;
use crate::constants::{
    LEVEL_TAGS, MRMS_BRIGHT_BAND_BOTTOM_PRODUCT, MRMS_BRIGHT_BAND_TOP_PRODUCT,
    MRMS_ECHO_TOP_18_PRODUCT, MRMS_ECHO_TOP_30_PRODUCT, MRMS_ECHO_TOP_50_PRODUCT,
    MRMS_ECHO_TOP_60_PRODUCT, MRMS_MODEL_FREEZING_HEIGHT_PRODUCT, MRMS_MODEL_SURFACE_TEMP_PRODUCT,
    MRMS_MODEL_WET_BULB_TEMP_PRODUCT, MRMS_PRECIP_FLAG_PRODUCT, MRMS_PRODUCT_PREFIX,
    MRMS_RHOHV_PRODUCT_PREFIX, MRMS_RQI_PRODUCT, MRMS_ZDR_PRODUCT_PREFIX,
};
use crate::traffic::TrafficStore;
use crate::types::{AppState, ScanSnapshot};

const NI: u32 = 48;
const NJ: u32 = 32;
const POINTS: usize = (NI * NJ) as usize;
const TILE: u32 = 16;
const SCAN: &str = "20260923-201442";

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    state: AppState,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("mirror");
        std::fs::create_dir_all(&root).unwrap();

        let mut cfg = Config::from_env().unwrap();
        cfg.storage_dir = dir.path().join("storage");
        cfg.tile_size = TILE as u16;
        cfg.ingest_local_data_dir = Some(root.clone());
        cfg.ingest_local_data_offline = true;
        let state = AppState {
            cfg: Arc::new(cfg),
            http: reqwest::Client::new(),
            latest: Arc::new(RwLock::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            recent_timestamps: Arc::new(Mutex::new(HashSet::new())),
            ingest_parse_limiter: Arc::new(Semaphore::new(3)),
            traffic_store: Arc::new(TrafficStore::new(dir.path().join("traffic.db")).unwrap()),
        };
        Self {
            _dir: dir,
            root,
            state,
        }
    }

    fn path(&self, product: &str, timestamp: &str) -> PathBuf {
        let date = &timestamp[..8];
        self.root
            .join("CONUS")
            .join(product)
            .join(date)
            .join(format!("MRMS_{product}_{timestamp}.grib2.gz"))
    }

    fn write(&self, product: &str, timestamp: &str, packing: Packing, samples: &[u32]) {
        self.write_grid(product, timestamp, NI, NJ, packing, samples);
    }

    fn write_grid(
        &self,
        product: &str,
        timestamp: &str,
        ni: u32,
        nj: u32,
        packing: Packing,
        samples: &[u32],
    ) {
        let path = self.path(product, timestamp);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, gzip(&grib_field(ni, nj, packing, samples))).unwrap();
    }

    fn remove(&self, product: &str, timestamp: &str) {
        std::fs::remove_file(self.path(product, timestamp)).unwrap();
    }

    fn write_reflectivity(&self) {
        for (level, tag) in LEVEL_TAGS.iter().enumerate() {
            let samples: Vec<u32> = (0..POINTS).map(|i| reflectivity_sample(level, i)).collect();
            self.write(
                &format!("{MRMS_PRODUCT_PREFIX}_{tag}"),
                SCAN,
                testkit::REFLECTIVITY,
                &samples,
            );
        }
    }

    /// ZDR 0.8 dB and RhoHV 0.99 everywhere, for every level of `timestamp`.
    fn write_dual_pol(&self, timestamp: &str) {
        for tag in LEVEL_TAGS {
            self.write(
                &format!("{MRMS_ZDR_PRODUCT_PREFIX}_{tag}"),
                timestamp,
                testkit::ZDR,
                &[9_998; POINTS],
            );
            self.write(
                &format!("{MRMS_RHOHV_PRODUCT_PREFIX}_{tag}"),
                timestamp,
                testkit::RHOHV,
                &[99_999; POINTS],
            );
        }
    }

    fn write_thermo_and_echo_tops(&self) {
        let constant = |value: u32| vec![value; POINTS];
        self.write(
            MRMS_PRECIP_FLAG_PRODUCT,
            "20260923-201400",
            testkit::PRECIP_FLAG,
            &constant(3),
        );
        self.write(
            MRMS_MODEL_FREEZING_HEIGHT_PRODUCT,
            "20260923-200000",
            testkit::HEIGHT_METERS,
            &constant(3_003),
        );
        self.write(
            MRMS_MODEL_WET_BULB_TEMP_PRODUCT,
            "20260923-200000",
            testkit::HEIGHT_METERS,
            &constant(15),
        );
        self.write(
            MRMS_MODEL_SURFACE_TEMP_PRODUCT,
            "20260923-200000",
            testkit::HEIGHT_METERS,
            &constant(18),
        );
        self.write(
            MRMS_BRIGHT_BAND_TOP_PRODUCT,
            "20260923-200600",
            testkit::HEIGHT_METERS,
            &constant(3_503),
        );
        self.write(
            MRMS_BRIGHT_BAND_BOTTOM_PRODUCT,
            "20260923-200600",
            testkit::HEIGHT_METERS,
            &constant(3_003),
        );
        self.write(
            MRMS_RQI_PRODUCT,
            "20260923-201400",
            testkit::RQI,
            &constant(40),
        );
        // 10 km tops on every 11th grid point, zero (no echo) elsewhere.
        let tops: Vec<u32> = (0..POINTS)
            .map(|i| if i % 11 == 0 { 13_000 } else { 3_000 })
            .collect();
        for product in [
            MRMS_ECHO_TOP_18_PRODUCT,
            MRMS_ECHO_TOP_30_PRODUCT,
            MRMS_ECHO_TOP_50_PRODUCT,
            MRMS_ECHO_TOP_60_PRODUCT,
        ] {
            self.write(product, SCAN, testkit::ECHO_TOP_KM, &tops);
        }
    }

    async fn ingest(&self) -> anyhow::Result<Arc<ScanSnapshot>> {
        ingest_timestamp(&self.state, SCAN).await
    }
}

/// Every 7th cell (offset by level) holds an echo of 5.0-54.9 dBZ; the rest is
/// the "no coverage" value.
fn reflectivity_sample(level: usize, index: usize) -> u32 {
    if (index + level) % 7 == 0 {
        10_040 + ((index * 13 + level * 29) % 500) as u32
    } else {
        9_000
    }
}

fn expected_dbz_tenths(level: usize, index: usize) -> i16 {
    reflectivity_sample(level, index) as i16 - 9_990
}

fn expected_voxels_per_level(level: usize) -> usize {
    (0..POINTS).filter(|&i| (i + level) % 7 == 0).count()
}

fn detail_value(scan: &ScanSnapshot, key: &str) -> String {
    scan.phase_debug
        .detail
        .split(',')
        .find_map(|part| part.strip_prefix(&format!("{key}=")))
        .unwrap_or_else(|| panic!("{key} missing from {}", scan.phase_debug.detail))
        .to_string()
}

/// Structural invariants that must hold for any assembled scan.
fn assert_well_formed(scan: &ScanSnapshot) {
    let tiles = ((NI / TILE) * (NJ / TILE)) as usize;
    assert_eq!(
        (scan.tile_cols, scan.tile_rows),
        ((NI / TILE) as u16, (NJ / TILE) as u16)
    );
    assert_eq!(scan.tile_offsets.len(), tiles + 1);
    assert_eq!(scan.tile_offsets[0], 0);
    assert_eq!(
        *scan.tile_offsets.last().unwrap() as usize,
        scan.voxels.len()
    );
    assert!(scan.tile_offsets.windows(2).all(|w| w[0] <= w[1]));

    let expected_total: usize = (0..LEVEL_TAGS.len()).map(expected_voxels_per_level).sum();
    assert_eq!(scan.voxels.len(), expected_total);

    let mut per_level = vec![0usize; LEVEL_TAGS.len()];
    for tile in 0..tiles {
        let (start, end) = (
            scan.tile_offsets[tile] as usize,
            scan.tile_offsets[tile + 1] as usize,
        );
        let (tile_row, tile_col) = (
            tile as u32 / scan.tile_cols as u32,
            tile as u32 % scan.tile_cols as u32,
        );
        let mut previous_level = 0u8;
        for voxel in &scan.voxels[start..end] {
            // Voxels sit in the tile that contains them, level-major within it.
            assert_eq!(u32::from(voxel.row) / TILE, tile_row);
            assert_eq!(u32::from(voxel.col) / TILE, tile_col);
            assert!(
                voxel.level_idx >= previous_level,
                "levels out of order in tile {tile}"
            );
            previous_level = voxel.level_idx;

            let index = voxel.row as usize * NI as usize + voxel.col as usize;
            let level = voxel.level_idx as usize;
            assert_eq!(voxel.dbz_tenths, expected_dbz_tenths(level, index));
            assert!(voxel.phase <= 2 && voxel.surface_phase <= 2);
            per_level[level] += 1;
        }
    }
    for (level, count) in per_level.into_iter().enumerate() {
        assert_eq!(count, expected_voxels_per_level(level), "level {level}");
    }
}

#[tokio::test]
async fn ingests_a_complete_scan_with_every_product() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    fx.write_dual_pol("20260923-201242"); // exact timestamp absent: latest earlier scan is used
    fx.write_thermo_and_echo_tops();

    let scan = fx.ingest().await.unwrap();

    assert_well_formed(&scan);
    assert_eq!(scan.timestamp, SCAN);
    assert_eq!(detail_value(&scan, "aux_fallback"), "no");
    assert_eq!(detail_value(&scan, "zdr_levels"), "33/33");
    assert_eq!(detail_value(&scan, "rhohv_levels"), "33/33");
    assert_eq!(detail_value(&scan, "dual_missing_voxels"), "0");
    assert_eq!(detail_value(&scan, "zdr_age_s"), "120");
    assert_eq!(
        scan.phase_debug.zdr_timestamp.as_deref(),
        Some("20260923-201242")
    );
    assert_eq!(
        scan.phase_debug.rhohv_timestamp.as_deref(),
        Some("20260923-201242")
    );
    assert_eq!(scan.phase_debug.zdr_age_seconds, Some(120));
    assert_eq!(
        scan.phase_debug.precip_flag_timestamp.as_deref(),
        Some("20260923-201400")
    );
    assert_eq!(
        scan.phase_debug.freezing_level_timestamp.as_deref(),
        Some("20260923-200000")
    );

    let echo_cells = (0..POINTS).filter(|i| i % 11 == 0).count();
    assert_eq!(scan.echo_tops.len(), echo_cells);
    assert_eq!(scan.echo_top_debug.max_top18_feet, Some(32_808));
    assert_eq!(scan.echo_top_debug.top50_timestamp.as_deref(), Some(SCAN));
    assert!(
        scan.echo_tops
            .iter()
            .all(|cell| (cell.row as usize * NI as usize + cell.col as usize) % 11 == 0)
    );
}

#[tokio::test]
async fn uses_the_exact_dual_pol_scan_when_it_is_published() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    fx.write_dual_pol(SCAN);
    fx.write_thermo_and_echo_tops();

    let scan = fx.ingest().await.unwrap();
    assert_well_formed(&scan);
    assert_eq!(scan.phase_debug.zdr_timestamp.as_deref(), Some(SCAN));
    assert_eq!(scan.phase_debug.zdr_age_seconds, Some(0));
    assert_eq!(detail_value(&scan, "aux_fallback"), "no");
}

#[tokio::test]
async fn ingest_is_deterministic() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    fx.write_dual_pol("20260923-201242");
    fx.write_thermo_and_echo_tops();

    let first = fx.ingest().await.unwrap();
    let second = fx.ingest().await.unwrap();
    let key = |scan: &ScanSnapshot| -> Vec<_> {
        scan.voxels
            .iter()
            .map(|v| {
                (
                    v.row,
                    v.col,
                    v.level_idx,
                    v.phase,
                    v.surface_phase,
                    v.dbz_tenths,
                )
            })
            .collect()
    };
    assert_eq!(key(&first), key(&second));
    assert_eq!(first.phase_debug.detail, second.phase_debug.detail);
}

#[tokio::test]
async fn a_missing_dual_pol_level_switches_to_aux_fallback() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    fx.write_dual_pol("20260923-201242");
    fx.write_thermo_and_echo_tops();
    fx.remove(
        &format!("{MRMS_ZDR_PRODUCT_PREFIX}_05.00"),
        "20260923-201242",
    );

    let scan = fx.ingest().await.unwrap();
    assert_well_formed(&scan);
    assert_eq!(detail_value(&scan, "zdr_levels"), "32/33");
    assert_eq!(detail_value(&scan, "rhohv_levels"), "33/33");
    assert_eq!(detail_value(&scan, "aux_fallback"), "yes");
    assert!(
        scan.phase_debug.mode.contains("aux-fallback") || scan.phase_debug.mode.contains("stale")
    );
}

#[tokio::test]
async fn stale_dual_pol_switches_to_aux_fallback() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    fx.write_dual_pol("20260923-200742"); // 7 min (420 s) older than the scan
    fx.write_thermo_and_echo_tops();

    let scan = fx.ingest().await.unwrap();
    assert_well_formed(&scan);
    assert_eq!(scan.phase_debug.zdr_age_seconds, Some(420));
    assert_eq!(detail_value(&scan, "aux_fallback"), "yes");
    assert_eq!(detail_value(&scan, "zdr_levels"), "33/33");
}

#[tokio::test]
async fn ingests_without_any_dual_pol_or_aux_products() {
    let fx = Fixture::new();
    fx.write_reflectivity();

    let scan = fx.ingest().await.unwrap();
    assert_well_formed(&scan);
    assert_eq!(detail_value(&scan, "zdr_levels"), "0/33");
    assert_eq!(detail_value(&scan, "rhohv_levels"), "0/33");
    assert_eq!(detail_value(&scan, "aux_any"), "no");
    assert_eq!(detail_value(&scan, "aux_fallback"), "yes");
    assert_eq!(scan.phase_debug.zdr_timestamp, None);
    assert_eq!(scan.phase_debug.zdr_age_seconds, None);
    assert!(scan.echo_tops.is_empty());
    assert_eq!(scan.echo_top_debug.max_top18_feet, None);
}

#[tokio::test]
async fn a_dual_pol_level_on_a_different_grid_is_counted_but_unused() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    fx.write_dual_pol("20260923-201242");
    fx.write_thermo_and_echo_tops();
    // Level 03.00 (index 10) of ZDR arrives on a smaller grid.
    fx.write_grid(
        &format!("{MRMS_ZDR_PRODUCT_PREFIX}_03.00"),
        "20260923-201242",
        NI / 2,
        NJ,
        testkit::ZDR,
        &vec![9_998; POINTS / 2],
    );

    let scan = fx.ingest().await.unwrap();
    assert_well_formed(&scan);
    // The level decoded, so the bundle is complete, but its voxels have no ZDR.
    assert_eq!(detail_value(&scan, "zdr_levels"), "33/33");
    assert_eq!(detail_value(&scan, "aux_fallback"), "no");
    let missing: usize = detail_value(&scan, "dual_missing_voxels").parse().unwrap();
    assert_eq!(missing, expected_voxels_per_level(10));
}

#[tokio::test]
async fn a_missing_reflectivity_level_fails_the_scan() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    fx.write_dual_pol("20260923-201242");
    fx.write_thermo_and_echo_tops();
    fx.remove(&format!("{MRMS_PRODUCT_PREFIX}_12.00"), SCAN);

    let error = fx.ingest().await.map(|_| ()).unwrap_err();
    assert!(format!("{error:#}").contains("12.00"), "{error:#}");
}

#[tokio::test]
async fn corrupt_reflectivity_fails_the_scan_loudly() {
    let fx = Fixture::new();
    fx.write_reflectivity();
    let path: &Path = &fx.path(&format!("{MRMS_PRODUCT_PREFIX}_07.00"), SCAN);
    std::fs::write(path, gzip(b"GRIB but not really a message")).unwrap();

    let error = fx.ingest().await.map(|_| ()).unwrap_err();
    assert!(format!("{error:#}").contains("07.00"), "{error:#}");
}

/// Moves a reflectivity level's file to a different second, as NOAA does for
/// some levels of ~8% of scans.
fn restamp_reflectivity_level(fx: &Fixture, level_tag: &str, new_stamp: &str) {
    let product = format!("{MRMS_PRODUCT_PREFIX}_{level_tag}");
    let bytes = std::fs::read(fx.path(&product, SCAN)).unwrap();
    fx.remove(&product, SCAN);
    let target = fx.path(&product, new_stamp);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, bytes).unwrap();
}

#[tokio::test]
async fn levels_stamped_a_few_seconds_off_the_base_level_are_still_used() {
    let exact = Fixture::new();
    exact.write_reflectivity();
    exact.write_dual_pol("20260923-201242");
    exact.write_thermo_and_echo_tops();
    let expected = exact.ingest().await.unwrap();

    let skewed = Fixture::new();
    skewed.write_reflectivity();
    skewed.write_dual_pol("20260923-201242");
    skewed.write_thermo_and_echo_tops();
    restamp_reflectivity_level(&skewed, "08.00", "20260923-201438"); // 4 s early
    restamp_reflectivity_level(&skewed, "12.00", "20260923-201445"); // 3 s late
    restamp_reflectivity_level(&skewed, "19.00", "20260923-201452"); // exactly at the 10 s limit

    let scan = skewed.ingest().await.unwrap();
    assert_well_formed(&scan);
    let voxels = |scan: &ScanSnapshot| -> Vec<_> {
        scan.voxels
            .iter()
            .map(|v| {
                (
                    v.row,
                    v.col,
                    v.level_idx,
                    v.phase,
                    v.surface_phase,
                    v.dbz_tenths,
                )
            })
            .collect()
    };
    assert_eq!(voxels(&scan), voxels(&expected));
    assert_eq!(scan.phase_debug.detail, expected.phase_debug.detail);
}

#[tokio::test]
async fn a_level_stamped_outside_the_tolerance_is_not_borrowed() {
    // 11 s late and 11 s early are outside the tolerance; so is the previous
    // scan's file (120 s earlier), which must never stand in for this scan's.
    for stamp in ["20260923-201453", "20260923-201431", "20260923-201242"] {
        let fx = Fixture::new();
        fx.write_reflectivity();
        restamp_reflectivity_level(&fx, "12.00", stamp);
        let error = fx.ingest().await.map(|_| ()).unwrap_err();
        assert!(crate::http_client::is_not_found(&error), "{stamp}: {error:#}");
        assert!(format!("{error:#}").contains("12.00"), "{stamp}: {error:#}");
    }

    // 10 s early is the edge of the tolerance and still accepted.
    let fx = Fixture::new();
    fx.write_reflectivity();
    restamp_reflectivity_level(&fx, "12.00", "20260923-201432");
    assert!(fx.ingest().await.is_ok());
}

#[tokio::test]
async fn the_closest_stamp_wins_when_two_are_in_range() {
    let fx = Fixture::new();
    let level = format!("{MRMS_PRODUCT_PREFIX}_12.00");
    let samples = vec![9_000u32; POINTS];
    fx.write(&level, "20260923-201435", testkit::REFLECTIVITY, &samples);
    fx.write(&level, "20260923-201441", testkit::REFLECTIVITY, &samples);
    fx.write(&level, "20260923-201449", testkit::REFLECTIVITY, &samples);

    let key = super::sources::find_level_key_near(&fx.state, MRMS_PRODUCT_PREFIX, "12.00", SCAN)
        .await
        .unwrap()
        .unwrap();
    assert!(key.ends_with("_12.00_20260923-201441.grib2.gz"), "{key}");
}

#[tokio::test]
async fn neighbor_lookup_spans_midnight() {
    let fx = Fixture::new();
    let level = format!("{MRMS_PRODUCT_PREFIX}_05.00");
    let samples = vec![9_000u32; POINTS];
    // A scan stamped just after midnight whose level was stamped 5 s before it,
    // in the previous day's directory.
    fx.write(&level, "20260923-235958", testkit::REFLECTIVITY, &samples);
    let key = super::sources::find_level_key_near(
        &fx.state,
        MRMS_PRODUCT_PREFIX,
        "05.00",
        "20260924-000003",
    )
    .await
    .unwrap();
    assert!(key.is_some_and(|key| key.ends_with("_05.00_20260923-235958.grib2.gz")));

    // ...and the reverse: a scan just before midnight, level stamped after it.
    fx.write(&level, "20260924-000002", testkit::REFLECTIVITY, &samples);
    let key = super::sources::find_level_key_near(
        &fx.state,
        MRMS_PRODUCT_PREFIX,
        "05.00",
        "20260923-235957",
    )
    .await
    .unwrap();
    assert!(key.is_some_and(|key| key.ends_with("_05.00_20260923-235958.grib2.gz")));
}
