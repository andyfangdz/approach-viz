//! MRMS query-time windowing and wire encoding (AVMR v5 volume, AVET v3 echo tops).
//!
//! The runtime serves these from its in-memory snapshot and the weather edge
//! Worker serves them from a scan pack in R2 (`crate::mrms_pack`). Both go
//! through the functions here, so a query answered by either is byte-identical.
//! A source only has to expose the snapshot's grid, tile layout, voxels per
//! tile, and echo tops through [`ScanSource`].

mod echo_tops;
mod volume;
mod window;

pub use echo_tops::build_echo_top_wire_fb;
pub use volume::{build_volume_wire_fb, VolumeCollector};
pub use window::{build_query_window, build_query_window_for_grid, QueryProjection, QueryWindow};

pub const DEFAULT_MIN_DBZ: f64 = 5.0;
pub const DEFAULT_MAX_RANGE_NM: f64 = 120.0;
pub const MIN_ALLOWED_DBZ: f64 = 5.0;
pub const MAX_ALLOWED_DBZ: f64 = 60.0;
pub const MIN_ALLOWED_RANGE_NM: f64 = 30.0;
pub const MAX_ALLOWED_RANGE_NM: f64 = 220.0;

pub const WIRE_MAX_SPAN_LOW_DBZ: u16 = 48;
pub const WIRE_MAX_SPAN_HIGH_DBZ: u16 = 20;
pub const WIRE_MAX_VERTICAL_SPAN: u16 = 4;

pub const VOLUME_FB_CONTENT_TYPE: &str = "application/vnd.approach-viz.mrms.v5";
pub const ECHO_TOP_FB_CONTENT_TYPE: &str = "application/vnd.approach-viz.echo-tops.v3";

#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct LevelBounds {
    pub bottom_feet: u16,
    pub top_feet: u16,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct StoredVoxel {
    pub row: u16,
    pub col: u16,
    pub level_idx: u8,
    pub phase: u8,
    pub surface_phase: u8, // from PrecipFlag_00.00, 0=rain, 1=mixed, 2=snow
    pub dbz_tenths: i16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct StoredEchoTop {
    pub row: u16,
    pub col: u16,
    pub top18_feet: u16,
    pub top30_feet: u16,
    pub top50_feet: u16,
    pub top60_feet: u16,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct GridDef {
    pub nx: u32,
    pub ny: u32,
    pub la1_deg: f64,
    pub lo1_deg360: f64,
    pub di_deg: f64,
    pub dj_deg: f64,
    pub scanning_mode: u8,
    pub lat_step_deg: f64,
    pub lon_step_deg: f64,
}

/// Scan-wide echo-top header values carried by every AVET payload.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EchoTopSummary {
    pub source_cell_count: u32,
    pub max_top18_feet: u16,
    pub max_top30_feet: u16,
    pub max_top50_feet: u16,
    pub max_top60_feet: u16,
}

/// Scan-wide metadata the query builders need.
pub trait ScanMeta {
    fn grid(&self) -> &GridDef;
    fn tile_size(&self) -> u16;
    fn tile_cols(&self) -> u16;
    fn level_bounds(&self) -> &[LevelBounds];
    fn generated_at_ms(&self) -> i64;
    fn scan_time_ms(&self) -> i64;
    fn echo_top_summary(&self) -> EchoTopSummary;
}

/// A scan whose voxels are all in memory, grouped by row-major tile.
pub trait ScanSource: ScanMeta {
    /// Voxels of tile `tile_idx` in stored order; empty for a tile index past
    /// the stored tiles.
    fn tile_voxels(&self, tile_idx: usize) -> &[StoredVoxel];
}

/// Validated, clamped query parameters shared by the volume and echo-top endpoints.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WeatherQuery {
    pub lat: f64,
    pub lon: f64,
    pub min_dbz: f64,
    pub max_range_nm: f64,
}

/// Validate and clamp raw volume query parameters. Missing `min_dbz`/
/// `max_range_nm` take the defaults; non-finite values and out-of-range
/// coordinates are rejected with the message the endpoint returns as a 400.
pub fn normalize_volume_query(
    lat: f64,
    lon: f64,
    min_dbz: Option<f64>,
    max_range_nm: Option<f64>,
) -> Result<WeatherQuery, &'static str> {
    validate_coordinates(lat, lon)?;
    if min_dbz.is_some_and(|value| !value.is_finite())
        || max_range_nm.is_some_and(|value| !value.is_finite())
    {
        return Err("Invalid minDbz/maxRangeNm query parameters.");
    }
    Ok(WeatherQuery {
        lat,
        lon,
        min_dbz: clamp(
            min_dbz.unwrap_or(DEFAULT_MIN_DBZ),
            MIN_ALLOWED_DBZ,
            MAX_ALLOWED_DBZ,
        ),
        max_range_nm: clamp_range(max_range_nm),
    })
}

/// Echo-top counterpart of [`normalize_volume_query`]; echo tops take no
/// `minDbz`, so the window uses [`DEFAULT_MIN_DBZ`].
pub fn normalize_echo_top_query(
    lat: f64,
    lon: f64,
    max_range_nm: Option<f64>,
) -> Result<WeatherQuery, &'static str> {
    validate_coordinates(lat, lon)?;
    if max_range_nm.is_some_and(|value| !value.is_finite()) {
        return Err("Invalid maxRangeNm query parameter.");
    }
    Ok(WeatherQuery {
        lat,
        lon,
        min_dbz: DEFAULT_MIN_DBZ,
        max_range_nm: clamp_range(max_range_nm),
    })
}

fn validate_coordinates(lat: f64, lon: f64) -> Result<(), &'static str> {
    // NaN compares false against range bounds, so finiteness must be checked
    // explicitly before the range checks.
    if !lat.is_finite()
        || !lon.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
    {
        return Err("Invalid lat/lon query parameters.");
    }
    Ok(())
}

fn clamp_range(max_range_nm: Option<f64>) -> f64 {
    clamp(
        max_range_nm.unwrap_or(DEFAULT_MAX_RANGE_NM),
        MIN_ALLOWED_RANGE_NM,
        MAX_ALLOWED_RANGE_NM,
    )
}

pub fn clamp(value: f64, min_value: f64, max_value: f64) -> f64 {
    value.max(min_value).min(max_value)
}

pub fn round_i16(value: f64) -> i16 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

pub fn round_u16(value: f64) -> u16 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(0.0, u16::MAX as f64) as u16
}

pub fn to_lon360(lon_deg: f64) -> f64 {
    let normalized = lon_deg % 360.0;
    if normalized < 0.0 {
        normalized + 360.0
    } else {
        normalized
    }
}

pub fn shortest_lon_delta_degrees(lon_deg360: f64, origin_lon_deg360: f64) -> f64 {
    let mut delta = lon_deg360 - origin_lon_deg360;
    if delta > 180.0 {
        delta -= 360.0;
    }
    if delta < -180.0 {
        delta += 360.0;
    }
    delta
}

pub fn clamp_i64(value: i64, min_value: i64, max_value: i64) -> i64 {
    value.max(min_value).min(max_value)
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;

    /// A minimal in-memory scan with the runtime snapshot's layout.
    #[derive(Clone, Debug)]
    pub(crate) struct TestScan {
        pub generated_at_ms: i64,
        pub scan_time_ms: i64,
        pub grid: GridDef,
        pub tile_size: u16,
        pub tile_cols: u16,
        pub tile_rows: u16,
        pub level_bounds: Vec<LevelBounds>,
        pub tile_offsets: Vec<u32>,
        pub voxels: Vec<StoredVoxel>,
        pub echo_tops: Vec<StoredEchoTop>,
        pub echo_top_summary: EchoTopSummary,
    }

    impl ScanMeta for TestScan {
        fn grid(&self) -> &GridDef {
            &self.grid
        }
        fn tile_size(&self) -> u16 {
            self.tile_size
        }
        fn tile_cols(&self) -> u16 {
            self.tile_cols
        }
        fn level_bounds(&self) -> &[LevelBounds] {
            &self.level_bounds
        }
        fn generated_at_ms(&self) -> i64 {
            self.generated_at_ms
        }
        fn scan_time_ms(&self) -> i64 {
            self.scan_time_ms
        }
        fn echo_top_summary(&self) -> EchoTopSummary {
            self.echo_top_summary
        }
    }

    impl ScanSource for TestScan {
        fn tile_voxels(&self, tile_idx: usize) -> &[StoredVoxel] {
            if tile_idx + 1 >= self.tile_offsets.len() {
                return &[];
            }
            &self.voxels
                [self.tile_offsets[tile_idx] as usize..self.tile_offsets[tile_idx + 1] as usize]
        }
    }

    /// 8x6 grid near 35N 110W with 4-cell tiles and one level.
    pub(crate) fn sample_scan() -> TestScan {
        TestScan {
            generated_at_ms: 0,
            scan_time_ms: 0,
            grid: GridDef {
                nx: 8,
                ny: 6,
                la1_deg: 35.0,
                lo1_deg360: 250.0,
                di_deg: 0.05,
                dj_deg: 0.05,
                scanning_mode: 0,
                lat_step_deg: 0.05,
                lon_step_deg: 0.05,
            },
            tile_size: 4,
            tile_cols: 2,
            tile_rows: 2,
            level_bounds: vec![LevelBounds {
                bottom_feet: 1_000,
                top_feet: 2_000,
            }],
            tile_offsets: vec![0],
            voxels: Vec::new(),
            echo_tops: Vec::new(),
            echo_top_summary: EchoTopSummary::default(),
        }
    }

    /// Tile-group `voxels` the way the runtime ingest does (stable within a tile).
    pub(crate) fn with_voxels(mut scan: TestScan, voxels: Vec<StoredVoxel>) -> TestScan {
        let tile_size = scan.tile_size as usize;
        let tile_cols = scan.tile_cols as usize;
        let tile_count = tile_cols * scan.tile_rows as usize;
        let tile_of = |voxel: &StoredVoxel| {
            (voxel.row as usize / tile_size) * tile_cols + voxel.col as usize / tile_size
        };
        let mut grouped = voxels;
        grouped.sort_by_key(tile_of);
        let mut offsets = vec![0_u32; tile_count + 1];
        for voxel in &grouped {
            offsets[tile_of(voxel) + 1] += 1;
        }
        for idx in 1..offsets.len() {
            offsets[idx] += offsets[idx - 1];
        }
        scan.tile_offsets = offsets;
        scan.voxels = grouped;
        scan
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_non_finite_and_out_of_range_coordinates() {
        assert!(normalize_volume_query(f64::NAN, 0.0, None, None).is_err());
        assert!(normalize_volume_query(91.0, 0.0, None, None).is_err());
        assert!(normalize_volume_query(0.0, -181.0, None, None).is_err());
        assert!(normalize_volume_query(0.0, 0.0, Some(f64::INFINITY), None).is_err());
        assert!(normalize_volume_query(0.0, 0.0, None, Some(f64::NAN)).is_err());
        assert!(normalize_echo_top_query(0.0, 0.0, Some(f64::NAN)).is_err());
    }

    #[test]
    fn normalize_applies_defaults_and_clamps() {
        let query = normalize_volume_query(40.0, -105.0, None, None).unwrap();
        assert_eq!(query.min_dbz, DEFAULT_MIN_DBZ);
        assert_eq!(query.max_range_nm, DEFAULT_MAX_RANGE_NM);
        let query = normalize_volume_query(40.0, -105.0, Some(99.0), Some(1.0)).unwrap();
        assert_eq!(query.min_dbz, MAX_ALLOWED_DBZ);
        assert_eq!(query.max_range_nm, MIN_ALLOWED_RANGE_NM);
        let query = normalize_echo_top_query(40.0, -105.0, Some(500.0)).unwrap();
        assert_eq!(query.min_dbz, DEFAULT_MIN_DBZ);
        assert_eq!(query.max_range_nm, MAX_ALLOWED_RANGE_NM);
    }
}
