use super::{clamp_i64, round_u16, shortest_lon_delta_degrees, to_lon360, GridDef, ScanMeta};
use crate::coords::projection_scales_nm_per_degree;

#[derive(Clone, Copy)]
/// The grid rows/columns and tiles a query can touch, plus the local
/// projection frame centered on the query origin.
pub struct QueryWindow {
    pub min_dbz_tenths: i16,
    pub origin_lat: f64,
    pub origin_lon: f64,
    pub origin_lon360: f64,
    pub max_range_nm: f64,
    pub max_range_squared_nm: f64,
    pub east_nm_per_lon_deg_safe: f64,
    pub north_nm_per_lat_deg_safe: f64,
    pub row_start: u32,
    pub row_end: u32,
    pub col_start: u32,
    pub col_end: u32,
    pub lon_wrapped: bool,
    pub tile_row_start: u32,
    pub tile_row_end: u32,
    pub tile_col_start: u32,
    pub tile_col_end: u32,
    pub footprint_x_milli: u16,
    pub footprint_y_milli: u16,
}

impl QueryWindow {
    /// Row-major indices of the tiles the window touches, in the order every
    /// source must visit them (brick merging depends on the voxel order).
    pub fn tile_indices(&self, tile_cols: u16) -> impl Iterator<Item = usize> + '_ {
        (self.tile_row_start..=self.tile_row_end).flat_map(move |tile_row| {
            (self.tile_col_start..=self.tile_col_end)
                .map(move |tile_col| (tile_row * tile_cols as u32 + tile_col) as usize)
        })
    }
}

pub struct QueryProjection {
    pub row_start: u32,
    pub col_start: u32,
    pub row_z_nm: Vec<f64>,
    pub col_x_nm: Vec<f64>,
}

impl QueryProjection {
    pub fn new(grid: &GridDef, window: &QueryWindow) -> Self {
        let row_count = (window.row_end.saturating_sub(window.row_start) + 1) as usize;
        let col_count = (window.col_end.saturating_sub(window.col_start) + 1) as usize;

        let mut row_z_nm = Vec::with_capacity(row_count);
        for row in window.row_start..=window.row_end {
            let lat_deg = grid.la1_deg + row as f64 * grid.lat_step_deg;
            row_z_nm.push(-(lat_deg - window.origin_lat) * window.north_nm_per_lat_deg_safe);
        }

        let mut col_x_nm = Vec::with_capacity(col_count);
        for col in window.col_start..=window.col_end {
            let lon_deg360 = to_lon360(grid.lo1_deg360 + col as f64 * grid.lon_step_deg);
            let delta_lon_deg = shortest_lon_delta_degrees(lon_deg360, window.origin_lon360);
            col_x_nm.push(delta_lon_deg * window.east_nm_per_lon_deg_safe);
        }

        Self {
            row_start: window.row_start,
            col_start: window.col_start,
            row_z_nm,
            col_x_nm,
        }
    }

    #[inline]
    pub fn project_cell_nm(&self, row: u32, col: u32) -> (f64, f64) {
        debug_assert!(row >= self.row_start);
        debug_assert!(col >= self.col_start);
        let row_idx = (row - self.row_start) as usize;
        let col_idx = (col - self.col_start) as usize;
        (self.col_x_nm[col_idx], self.row_z_nm[row_idx])
    }
}

pub fn build_query_window(
    scan: &impl ScanMeta,
    origin_lat: f64,
    origin_lon: f64,
    min_dbz: f64,
    max_range_nm: f64,
) -> QueryWindow {
    build_query_window_for_grid(
        scan.grid(),
        scan.tile_size(),
        scan.tile_cols(),
        origin_lat,
        origin_lon,
        min_dbz,
        max_range_nm,
    )
}

/// [`build_query_window`] for a source known only by its grid and tile layout.
pub fn build_query_window_for_grid(
    grid: &GridDef,
    tile_size: u16,
    tile_cols: u16,
    origin_lat: f64,
    origin_lon: f64,
    min_dbz: f64,
    max_range_nm: f64,
) -> QueryWindow {
    let min_dbz_tenths = (min_dbz * 10.0).round() as i16;
    let max_range_squared_nm = max_range_nm * max_range_nm;

    let origin_lon360 = to_lon360(origin_lon);
    let (east_nm_per_lon_deg, north_nm_per_lat_deg) = projection_scales_nm_per_degree(origin_lat);
    let east_nm_per_lon_deg_safe = east_nm_per_lon_deg.abs().max(1e-6);
    let north_nm_per_lat_deg_safe = north_nm_per_lat_deg.abs().max(1e-6);

    let lat_padding_deg = max_range_nm / north_nm_per_lat_deg_safe;
    let lon_padding_deg = max_range_nm / east_nm_per_lon_deg_safe;

    let lat_min = origin_lat - lat_padding_deg;
    let lat_max = origin_lat + lat_padding_deg;
    let lon_min360 = origin_lon360 - lon_padding_deg;
    let lon_max360 = origin_lon360 + lon_padding_deg;
    let lon_wrapped = lon_min360 < 0.0 || lon_max360 >= 360.0;

    let row_from_lat = |lat: f64| (lat - grid.la1_deg) / grid.lat_step_deg;
    let row_start = clamp_i64(
        (row_from_lat(lat_min).min(row_from_lat(lat_max)) - 1.0).floor() as i64,
        0,
        grid.ny as i64 - 1,
    ) as u32;
    let row_end = clamp_i64(
        (row_from_lat(lat_min).max(row_from_lat(lat_max)) + 1.0).ceil() as i64,
        0,
        grid.ny as i64 - 1,
    ) as u32;

    let (col_start, col_end) = if lon_wrapped {
        (0_u32, grid.nx - 1)
    } else {
        let col_from_lon = |lon: f64| (lon - grid.lo1_deg360) / grid.lon_step_deg;
        let start = clamp_i64(
            (col_from_lon(lon_min360).min(col_from_lon(lon_max360)) - 1.0).floor() as i64,
            0,
            grid.nx as i64 - 1,
        ) as u32;
        let end = clamp_i64(
            (col_from_lon(lon_min360).max(col_from_lon(lon_max360)) + 1.0).ceil() as i64,
            0,
            grid.nx as i64 - 1,
        ) as u32;
        (start, end)
    };

    let tile_size = tile_size as u32;
    let tile_row_start = row_start / tile_size;
    let tile_row_end = row_end / tile_size;
    let tile_col_start = if lon_wrapped {
        0
    } else {
        col_start / tile_size
    };
    let tile_col_end = if lon_wrapped {
        tile_cols as u32 - 1
    } else {
        col_end / tile_size
    };

    let footprint_x_milli = round_u16(grid.di_deg.abs() * east_nm_per_lon_deg_safe * 1000.0);
    let footprint_y_milli = round_u16(grid.dj_deg.abs() * north_nm_per_lat_deg_safe * 1000.0);

    QueryWindow {
        min_dbz_tenths,
        origin_lat,
        origin_lon,
        origin_lon360,
        max_range_nm,
        max_range_squared_nm,
        east_nm_per_lon_deg_safe,
        north_nm_per_lat_deg_safe,
        row_start,
        row_end,
        col_start,
        col_end,
        lon_wrapped,
        tile_row_start,
        tile_row_end,
        tile_col_start,
        tile_col_end,
        footprint_x_milli,
        footprint_y_milli,
    }
}
