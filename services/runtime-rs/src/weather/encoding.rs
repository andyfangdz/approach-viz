use anyhow::Result;
use rustc_hash::FxHashMap;
use std::cmp::min;

use super::projection::{QueryProjection, QueryWindow};
use super::EchoTopCellRecord;
use crate::constants::{
    WIRE_DBZ_QUANT_STEP_TENTHS,
    WIRE_MAX_SPAN_HIGH_DBZ, WIRE_MAX_SPAN_LOW_DBZ, WIRE_MAX_VERTICAL_SPAN,
};
use crate::types::ScanSnapshot;
use crate::utils::{round_i16, round_u16, shortest_lon_delta_degrees, to_lon360};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct MergeKey {
    phase: u8,
    dbz_tenths: i16,
}

#[derive(Clone, Copy, Debug)]
struct MergeCell {
    row: u32,
    col: u32,
    key: MergeKey,
    surface_phase: u8,
}

#[derive(Clone, Copy, Debug)]
struct RowRun {
    col_start: u32,
    col_end: u32,
    key: MergeKey,
    surface_phase: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct RunSignature {
    col_start: u32,
    col_end: u32,
    key: MergeKey,
}

#[derive(Clone, Copy, Debug)]
struct HorizontalRect {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    key: MergeKey,
    surface_phase: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct VerticalSignature {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    key: MergeKey,
}

#[derive(Clone, Copy, Debug)]
struct BrickCandidate {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    level_start: u8,
    level_end: u8,
    key: MergeKey,
    surface_phase: u8,
}

pub(crate) fn build_echo_top_cells(
    scan: &ScanSnapshot,
    window: &QueryWindow,
) -> Vec<EchoTopCellRecord> {
    let projection = QueryProjection::new(scan, window);
    let mut cells = Vec::new();
    for record in &scan.echo_tops {
        let row = record.row as u32;
        let col = record.col as u32;
        if row < window.row_start || row > window.row_end {
            continue;
        }
        if !window.lon_wrapped && (col < window.col_start || col > window.col_end) {
            continue;
        }

        let (x_nm, z_nm) = projection.project_cell_nm(row, col);
        if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
            continue;
        }

        cells.push(EchoTopCellRecord {
            x_nm: x_nm as f32,
            z_nm: z_nm as f32,
            top18_feet: record.top18_feet,
            top30_feet: record.top30_feet,
            top50_feet: record.top50_feet,
            top60_feet: record.top60_feet,
        });
    }
    cells
}

/// Build an AVET FlatBuffers payload for echo-top cells.
pub(crate) fn build_echo_top_wire_fb(
    scan: &ScanSnapshot,
    window: &QueryWindow,
    cells: &[EchoTopCellRecord],
) -> Vec<u8> {
    use approach_viz_core::generated::{EchoTops, EchoTopsArgs};

    let n = cells.len();
    let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(64 + n * 16);

    // Collect SoA columns
    let x_nm: Vec<f32> = cells.iter().map(|c| c.x_nm).collect();
    let z_nm: Vec<f32> = cells.iter().map(|c| c.z_nm).collect();
    let top18: Vec<u16> = cells.iter().map(|c| c.top18_feet).collect();
    let top30: Vec<u16> = cells.iter().map(|c| c.top30_feet).collect();
    let top50: Vec<u16> = cells.iter().map(|c| c.top50_feet).collect();
    let top60: Vec<u16> = cells.iter().map(|c| c.top60_feet).collect();

    // Create FlatBuffers vectors (must be done before creating the table)
    let x_nm_vec = builder.create_vector(&x_nm);
    let z_nm_vec = builder.create_vector(&z_nm);
    let top18_vec = builder.create_vector(&top18);
    let top30_vec = builder.create_vector(&top30);
    let top50_vec = builder.create_vector(&top50);
    let top60_vec = builder.create_vector(&top60);

    let echo_tops = EchoTops::create(
        &mut builder,
        &EchoTopsArgs {
            cell_count: n as u32,
            source_cell_count: scan.echo_tops.len() as u32,
            footprint_x_milli: window.footprint_x_milli,
            footprint_y_milli: window.footprint_y_milli,
            generated_at_ms: scan.generated_at_ms,
            scan_time_ms: scan.scan_time_ms,
            max_top18_feet: scan.echo_top_debug.max_top18_feet.unwrap_or(0),
            max_top30_feet: scan.echo_top_debug.max_top30_feet.unwrap_or(0),
            max_top50_feet: scan.echo_top_debug.max_top50_feet.unwrap_or(0),
            max_top60_feet: scan.echo_top_debug.max_top60_feet.unwrap_or(0),
            x_nm: Some(x_nm_vec),
            z_nm: Some(z_nm_vec),
            top18_feet: Some(top18_vec),
            top30_feet: Some(top30_vec),
            top50_feet: Some(top50_vec),
            top60_feet: Some(top60_vec),
        },
    );

    builder.finish(echo_tops, Some("AVET"));
    builder.finished_data().to_vec()
}

/// Build an AVMR v5 FlatBuffers payload for the MRMS volume.
///
/// Same pipeline as `build_volume_wire_impl` (voxel filtering, brick merging)
/// but serializes the output via FlatBuffers instead of the hand-rolled AVMR v4
/// binary format.
pub(crate) fn build_volume_wire_fb(
    scan: &ScanSnapshot,
    origin_lat: f64,
    origin_lon: f64,
    min_dbz: f64,
    max_range_nm: f64,
) -> Result<Vec<u8>> {
    let window = super::projection::build_query_window(scan, origin_lat, origin_lon, min_dbz, max_range_nm);
    Ok(build_volume_wire_fb_impl(scan, &window))
}

fn build_volume_wire_fb_impl(scan: &ScanSnapshot, window: &QueryWindow) -> Vec<u8> {
    use approach_viz_core::generated::{MrmsVolume, MrmsVolumeArgs};

    let projection = QueryProjection::new(scan, window);

    // --- Same voxel filtering + brick merging as build_volume_wire_impl ---
    let mut layer_counts = vec![0_u32; scan.level_bounds.len()];
    let mut source_voxel_count: u32 = 0;
    let mut cells_by_level: Vec<Vec<MergeCell>> = vec![Vec::new(); scan.level_bounds.len()];

    for tile_row in window.tile_row_start..=window.tile_row_end {
        for tile_col in window.tile_col_start..=window.tile_col_end {
            let tile_idx = (tile_row * scan.tile_cols as u32 + tile_col) as usize;
            if tile_idx + 1 >= scan.tile_offsets.len() {
                continue;
            }
            let start = scan.tile_offsets[tile_idx] as usize;
            let end = scan.tile_offsets[tile_idx + 1] as usize;
            for record in &scan.voxels[start..end] {
                let row = record.row as u32;
                let col = record.col as u32;
                if row < window.row_start || row > window.row_end {
                    continue;
                }
                if !window.lon_wrapped && (col < window.col_start || col > window.col_end) {
                    continue;
                }
                if record.dbz_tenths < window.min_dbz_tenths {
                    continue;
                }

                let (x_nm, z_nm) = projection.project_cell_nm(row, col);
                if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
                    continue;
                }

                let level_idx = record.level_idx as usize;
                if level_idx >= cells_by_level.len() {
                    continue;
                }
                layer_counts[level_idx] = layer_counts[level_idx].saturating_add(1);
                source_voxel_count = source_voxel_count.saturating_add(1);
                cells_by_level[level_idx].push(MergeCell {
                    row,
                    col,
                    key: MergeKey {
                        phase: record.phase,
                        dbz_tenths: quantize_dbz_tenths(
                            record.dbz_tenths,
                            WIRE_DBZ_QUANT_STEP_TENTHS,
                        ),
                    },
                    surface_phase: record.surface_phase,
                });
            }
        }
    }

    let mut active: FxHashMap<VerticalSignature, usize> = FxHashMap::default();
    let mut merged_bricks: Vec<BrickCandidate> = Vec::new();

    for (level_idx, cells) in cells_by_level.iter_mut().enumerate() {
        let mut rectangles = build_level_rectangles(cells);
        let mut split_rectangles: Vec<HorizontalRect> = Vec::with_capacity(rectangles.len());
        for rect in rectangles.drain(..) {
            let max_span = max_span_for_dbz(rect.key.dbz_tenths);
            split_rectangle(rect, max_span, &mut split_rectangles);
        }

        let mut next_active: FxHashMap<VerticalSignature, usize> =
            FxHashMap::with_capacity_and_hasher(split_rectangles.len(), Default::default());
        for rect in split_rectangles {
            let signature = VerticalSignature {
                row_start: rect.row_start,
                row_end: rect.row_end,
                col_start: rect.col_start,
                col_end: rect.col_end,
                key: rect.key,
            };

            let mut extended = false;
            if let Some(existing_idx) = active.remove(&signature) {
                let current = merged_bricks[existing_idx];
                let next_vertical_span = level_idx as u16 - current.level_start as u16 + 1_u16;
                if current.level_end as usize + 1 == level_idx
                    && next_vertical_span <= WIRE_MAX_VERTICAL_SPAN
                {
                    let prev_bounds = scan.level_bounds[current.level_end as usize];
                    let next_bounds = scan.level_bounds[level_idx];
                    if next_bounds.bottom_feet <= prev_bounds.top_feet.saturating_add(1) {
                        merged_bricks[existing_idx].level_end = level_idx as u8;
                        next_active.insert(signature, existing_idx);
                        extended = true;
                    }
                }
            }

            if !extended {
                let new_idx = merged_bricks.len();
                merged_bricks.push(BrickCandidate {
                    row_start: rect.row_start,
                    row_end: rect.row_end,
                    col_start: rect.col_start,
                    col_end: rect.col_end,
                    level_start: level_idx as u8,
                    level_end: level_idx as u8,
                    key: rect.key,
                    surface_phase: rect.surface_phase,
                });
                next_active.insert(signature, new_idx);
            }
        }
        active = next_active;
    }

    // Collect into SoA vectors
    let mut soa_x: Vec<i16> = Vec::new();
    let mut soa_z: Vec<i16> = Vec::new();
    let mut soa_bottom: Vec<u16> = Vec::new();
    let mut soa_top: Vec<u16> = Vec::new();
    let mut soa_dbz: Vec<i16> = Vec::new();
    let mut soa_phase: Vec<u8> = Vec::new();
    let mut soa_surface_phase: Vec<u8> = Vec::new();
    let mut soa_span_x: Vec<u16> = Vec::new();
    let mut soa_span_y: Vec<u16> = Vec::new();
    let mut soa_span_z: Vec<u16> = Vec::new();

    let mut brick_count: u32 = 0;
    for brick in merged_bricks {
        let level_start_idx = brick.level_start as usize;
        let level_end_idx = brick.level_end as usize;
        let Some(level_start_bounds) = scan.level_bounds.get(level_start_idx) else {
            continue;
        };
        let Some(level_end_bounds) = scan.level_bounds.get(level_end_idx) else {
            continue;
        };

        let center_row = (brick.row_start as f64 + brick.row_end as f64) * 0.5;
        let center_col = (brick.col_start as f64 + brick.col_end as f64) * 0.5;
        let (x_nm, z_nm) = project_grid_position_nm(scan, window, center_row, center_col);
        if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
            continue;
        }

        let span_x = (brick.col_end - brick.col_start + 1).min(u16::MAX as u32) as u16;
        let span_y = (brick.row_end - brick.row_start + 1).min(u16::MAX as u32) as u16;
        let span_z = (level_end_idx - level_start_idx + 1).min(u16::MAX as usize) as u16;

        soa_x.push(round_i16(x_nm * 100.0));
        soa_z.push(round_i16(z_nm * 100.0));
        soa_bottom.push(level_start_bounds.bottom_feet);
        soa_top.push(level_end_bounds.top_feet);
        soa_dbz.push(brick.key.dbz_tenths);
        soa_phase.push(brick.key.phase);
        soa_surface_phase.push(brick.surface_phase);
        soa_span_x.push(span_x);
        soa_span_y.push(span_y);
        soa_span_z.push(span_z);
        brick_count = brick_count.saturating_add(1);
    }

    // --- FlatBuffers serialization ---
    let n = brick_count as usize;
    let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(128 + n * 20);

    let layer_voxel_counts_vec = builder.create_vector(&layer_counts);
    let x_vec = builder.create_vector(&soa_x);
    let z_vec = builder.create_vector(&soa_z);
    let bottom_vec = builder.create_vector(&soa_bottom);
    let top_vec = builder.create_vector(&soa_top);
    let dbz_vec = builder.create_vector(&soa_dbz);
    let phase_vec = builder.create_vector(&soa_phase);
    let surface_phase_vec = builder.create_vector(&soa_surface_phase);
    let span_x_vec = builder.create_vector(&soa_span_x);
    let span_y_vec = builder.create_vector(&soa_span_y);
    let span_z_vec = builder.create_vector(&soa_span_z);

    let volume = MrmsVolume::create(
        &mut builder,
        &MrmsVolumeArgs {
            source_voxel_count,
            brick_count,
            layer_count: scan.level_bounds.len() as u16,
            generated_at_ms: scan.generated_at_ms,
            scan_time_ms: scan.scan_time_ms,
            footprint_x_milli: window.footprint_x_milli,
            footprint_y_milli: window.footprint_y_milli,
            min_dbz_tenths: window.min_dbz_tenths,
            max_range_tenths_nm: round_u16(window.max_range_nm * 10.0),
            tile_size: scan.tile_size,
            encoding_hint: WIRE_DBZ_QUANT_STEP_TENTHS as u16,
            origin_lat_microdeg: (window.origin_lat * 1_000_000.0).round() as i32,
            origin_lon_microdeg: (window.origin_lon * 1_000_000.0).round() as i32,
            layer_voxel_counts: Some(layer_voxel_counts_vec),
            x_hundredths: Some(x_vec),
            z_hundredths: Some(z_vec),
            bottom_feet: Some(bottom_vec),
            top_feet: Some(top_vec),
            dbz_tenths: Some(dbz_vec),
            phase: Some(phase_vec),
            surface_phase: Some(surface_phase_vec),
            span_x: Some(span_x_vec),
            span_y: Some(span_y_vec),
            span_z: Some(span_z_vec),
        },
    );

    builder.finish(volume, Some("AVMR"));
    builder.finished_data().to_vec()
}

fn project_grid_position_nm(
    scan: &ScanSnapshot,
    window: &QueryWindow,
    row: f64,
    col: f64,
) -> (f64, f64) {
    let lat_deg = scan.grid.la1_deg + row * scan.grid.lat_step_deg;
    let lon_deg360 = to_lon360(scan.grid.lo1_deg360 + col * scan.grid.lon_step_deg);
    let delta_lon_deg = shortest_lon_delta_degrees(lon_deg360, window.origin_lon360);
    let x_nm = delta_lon_deg * window.east_nm_per_lon_deg_safe;
    let z_nm = -(lat_deg - window.origin_lat) * window.north_nm_per_lat_deg_safe;
    (x_nm, z_nm)
}

fn quantize_dbz_tenths(dbz_tenths: i16, step_tenths: i16) -> i16 {
    if step_tenths <= 1 {
        return dbz_tenths;
    }
    let step = step_tenths as i32;
    let value = dbz_tenths as i32;
    let half = step / 2;
    let quantized = if value >= 0 {
        ((value + half) / step) * step
    } else {
        ((value - half) / step) * step
    };
    quantized.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

fn max_span_for_dbz(dbz_tenths: i16) -> u16 {
    if dbz_tenths >= 450 {
        WIRE_MAX_SPAN_HIGH_DBZ.max(1)
    } else {
        WIRE_MAX_SPAN_LOW_DBZ.max(1)
    }
}

fn split_rectangle(rect: HorizontalRect, max_span: u16, out: &mut Vec<HorizontalRect>) {
    let chunk_size = max_span.max(1) as u32;
    let mut row_start = rect.row_start;
    while row_start <= rect.row_end {
        let row_end = min(row_start.saturating_add(chunk_size - 1), rect.row_end);
        let mut col_start = rect.col_start;
        while col_start <= rect.col_end {
            let col_end = min(col_start.saturating_add(chunk_size - 1), rect.col_end);
            out.push(HorizontalRect {
                row_start,
                row_end,
                col_start,
                col_end,
                key: rect.key,
                surface_phase: rect.surface_phase,
            });
            if col_end == rect.col_end {
                break;
            }
            col_start = col_end.saturating_add(1);
        }
        if row_end == rect.row_end {
            break;
        }
        row_start = row_end.saturating_add(1);
    }
}

fn merge_row_runs_into_rectangles(
    row: u32,
    runs: &[RowRun],
    rectangles: &mut Vec<HorizontalRect>,
    active: &mut FxHashMap<RunSignature, usize>,
    prev_row: &mut Option<u32>,
) {
    if let Some(previous_row) = *prev_row {
        if row != previous_row.saturating_add(1) {
            active.clear();
        }
    }

    let mut next_active: FxHashMap<RunSignature, usize> =
        FxHashMap::with_capacity_and_hasher(runs.len(), Default::default());
    for run in runs {
        let signature = RunSignature {
            col_start: run.col_start,
            col_end: run.col_end,
            key: run.key,
        };
        if let Some(rect_idx) = active.remove(&signature) {
            rectangles[rect_idx].row_end = row;
            next_active.insert(signature, rect_idx);
        } else {
            let rect_idx = rectangles.len();
            rectangles.push(HorizontalRect {
                row_start: row,
                row_end: row,
                col_start: run.col_start,
                col_end: run.col_end,
                key: run.key,
                surface_phase: run.surface_phase,
            });
            next_active.insert(signature, rect_idx);
        }
    }

    *active = next_active;
    *prev_row = Some(row);
}

fn build_level_rectangles(cells: &mut [MergeCell]) -> Vec<HorizontalRect> {
    if cells.is_empty() {
        return Vec::new();
    }

    cells.sort_unstable_by_key(|cell| ((cell.row as u64) << 32) | cell.col as u64);

    let mut rectangles: Vec<HorizontalRect> = Vec::new();
    let mut active: FxHashMap<RunSignature, usize> = FxHashMap::default();
    let mut prev_row: Option<u32> = None;
    let mut runs_for_row: Vec<RowRun> = Vec::with_capacity(32);

    let mut run_row = cells[0].row;
    let mut run_col_start = cells[0].col;
    let mut run_col_end = cells[0].col;
    let mut run_key = cells[0].key;
    let mut run_surface_phase = cells[0].surface_phase;

    for cell in &cells[1..] {
        if cell.row == run_row && cell.key == run_key {
            if cell.col == run_col_end {
                continue;
            }
            if cell.col == run_col_end.saturating_add(1) {
                run_col_end = cell.col;
                continue;
            }
        }
        runs_for_row.push(RowRun {
            col_start: run_col_start,
            col_end: run_col_end,
            key: run_key,
            surface_phase: run_surface_phase,
        });
        if cell.row != run_row {
            merge_row_runs_into_rectangles(
                run_row,
                &runs_for_row,
                &mut rectangles,
                &mut active,
                &mut prev_row,
            );
            runs_for_row.clear();
        }
        run_row = cell.row;
        run_col_start = cell.col;
        run_col_end = cell.col;
        run_key = cell.key;
        run_surface_phase = cell.surface_phase;
    }

    runs_for_row.push(RowRun {
        col_start: run_col_start,
        col_end: run_col_end,
        key: run_key,
        surface_phase: run_surface_phase,
    });

    merge_row_runs_into_rectangles(
        run_row,
        &runs_for_row,
        &mut rectangles,
        &mut active,
        &mut prev_row,
    );

    rectangles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::DEFAULT_MIN_DBZ;
    use crate::types::{EchoTopDebugMetadata, GridDef, LevelBounds, PhaseDebugMetadata};
    use crate::weather::projection::build_query_window;

    fn sample_scan_for_projection() -> ScanSnapshot {
        ScanSnapshot {
            timestamp: "202602190000".to_string(),
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
            echo_top_debug: EchoTopDebugMetadata::default(),
            phase_debug: PhaseDebugMetadata::default(),
        }
    }

    #[test]
    fn projection_cache_matches_direct_projection_for_integer_cells() {
        let scan = sample_scan_for_projection();
        let window = build_query_window(&scan, 35.15, -109.55, DEFAULT_MIN_DBZ, 40.0);
        let projection = QueryProjection::new(&scan, &window);

        for row in window.row_start..=window.row_end {
            for col in window.col_start..=window.col_end {
                let (cached_x, cached_z) = projection.project_cell_nm(row, col);
                let (direct_x, direct_z) =
                    project_grid_position_nm(&scan, &window, row as f64, col as f64);
                assert!((cached_x - direct_x).abs() < 1e-9);
                assert!((cached_z - direct_z).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn build_level_rectangles_merges_runs_and_respects_row_gaps() {
        let key_a = MergeKey {
            phase: 1,
            dbz_tenths: 300,
        };
        let key_b = MergeKey {
            phase: 2,
            dbz_tenths: 300,
        };

        let mut cells = vec![
            MergeCell {
                row: 1,
                col: 1,
                key: key_a,
                surface_phase: 1,
            },
            MergeCell {
                row: 0,
                col: 1,
                key: key_a,
                surface_phase: 1,
            },
            MergeCell {
                row: 0,
                col: 0,
                key: key_a,
                surface_phase: 1,
            },
            MergeCell {
                row: 1,
                col: 0,
                key: key_a,
                surface_phase: 1,
            },
            MergeCell {
                row: 1,
                col: 4,
                key: key_a,
                surface_phase: 1,
            },
            MergeCell {
                row: 2,
                col: 4,
                key: key_a,
                surface_phase: 1,
            },
            MergeCell {
                row: 4,
                col: 0,
                key: key_a,
                surface_phase: 1,
            },
            MergeCell {
                row: 0,
                col: 6,
                key: key_b,
                surface_phase: 2,
            },
            MergeCell {
                row: 1,
                col: 6,
                key: key_b,
                surface_phase: 2,
            },
            MergeCell {
                row: 1,
                col: 6,
                key: key_b,
                surface_phase: 2,
            },
        ];

        let mut rectangles = build_level_rectangles(&mut cells);
        rectangles.sort_unstable_by(|a, b| {
            a.row_start
                .cmp(&b.row_start)
                .then(a.col_start.cmp(&b.col_start))
                .then(a.key.phase.cmp(&b.key.phase))
        });

        assert_eq!(rectangles.len(), 4);

        assert_eq!(rectangles[0].row_start, 0);
        assert_eq!(rectangles[0].row_end, 1);
        assert_eq!(rectangles[0].col_start, 0);
        assert_eq!(rectangles[0].col_end, 1);
        assert_eq!(rectangles[0].key, key_a);

        assert_eq!(rectangles[1].row_start, 0);
        assert_eq!(rectangles[1].row_end, 1);
        assert_eq!(rectangles[1].col_start, 6);
        assert_eq!(rectangles[1].col_end, 6);
        assert_eq!(rectangles[1].key, key_b);

        assert_eq!(rectangles[2].row_start, 1);
        assert_eq!(rectangles[2].row_end, 2);
        assert_eq!(rectangles[2].col_start, 4);
        assert_eq!(rectangles[2].col_end, 4);
        assert_eq!(rectangles[2].key, key_a);

        assert_eq!(rectangles[3].row_start, 4);
        assert_eq!(rectangles[3].row_end, 4);
        assert_eq!(rectangles[3].col_start, 0);
        assert_eq!(rectangles[3].col_end, 0);
        assert_eq!(rectangles[3].key, key_a);
    }
}
