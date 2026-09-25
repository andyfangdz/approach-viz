use std::cmp::min;

use rustc_hash::FxHashMap;

use super::{
    round_i16, round_u16, shortest_lon_delta_degrees, to_lon360, QueryProjection, QueryWindow,
    ScanMeta, ScanSource, StoredVoxel, WIRE_MAX_SPAN_HIGH_DBZ, WIRE_MAX_SPAN_LOW_DBZ,
    WIRE_MAX_VERTICAL_SPAN,
};
use crate::generated::{MrmsVolume, MrmsVolumeArgs};
use crate::types::MRMS_WIRE_DBZ_QUANT_STEP_TENTHS as WIRE_DBZ_QUANT_STEP_TENTHS;

/// Full merge identity: two cells may share a brick only when every keyed
/// field matches. `surface_phase` is keyed because the default client phase
/// mode colors by it — merging across a rain/snow surface boundary would
/// paint one cell's surface phase over the whole brick footprint.
/// `quantized_dbz_tenths` is the 5 dBZ grouping bucket; the true per-brick
/// maximum is tracked separately so the wire never understates intensity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct MergeKey {
    phase: u8,
    surface_phase: u8,
    quantized_dbz_tenths: i16,
}

/// One filtered voxel awaiting brick merging. Held for every voxel of the
/// window at once, so it stays 8 bytes: the grouping key is derived on use.
#[derive(Clone, Copy, Debug)]
struct MergeCell {
    row: u16,
    col: u16,
    phase: u8,
    surface_phase: u8,
    dbz_tenths: i16,
}

impl MergeCell {
    #[inline]
    fn row(&self) -> u32 {
        self.row as u32
    }

    #[inline]
    fn col(&self) -> u32 {
        self.col as u32
    }

    #[inline]
    fn key(&self) -> MergeKey {
        MergeKey {
            phase: self.phase,
            surface_phase: self.surface_phase,
            quantized_dbz_tenths: quantize_dbz_tenths(self.dbz_tenths, WIRE_DBZ_QUANT_STEP_TENTHS),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct RowRun {
    col_start: u32,
    col_end: u32,
    key: MergeKey,
    max_dbz_tenths: i16,
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
    max_dbz_tenths: i16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct VerticalSignature {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    key: MergeKey,
}

/// Grid rows/columns are `u16` in storage, so bricks keep them at that width
/// (one candidate per output brick is resident until serialization).
#[derive(Clone, Copy, Debug)]
struct BrickCandidate {
    row_start: u16,
    row_end: u16,
    col_start: u16,
    col_end: u16,
    level_start: u8,
    level_end: u8,
    key: MergeKey,
    max_dbz_tenths: i16,
}

/// Build an AVMR v5 FlatBuffers payload for the window of an in-memory scan.
pub fn build_volume_wire_fb(scan: &impl ScanSource, window: &QueryWindow) -> Vec<u8> {
    let mut collector = VolumeCollector::new(scan, window);
    for tile_idx in window.tile_indices(scan.tile_cols()) {
        collector.add_voxels(scan.tile_voxels(tile_idx));
    }
    collector.finish()
}

/// Filters a window's voxels tile by tile, then merges them into bricks and
/// serializes the bricks as SoA columns. Sources feed tiles in
/// [`QueryWindow::tile_indices`] order, so a source that decodes tiles on the
/// fly never has to hold the whole window's voxels.
pub struct VolumeCollector<'a, S: ScanMeta> {
    scan: &'a S,
    window: &'a QueryWindow,
    projection: QueryProjection,
    layer_counts: Vec<u32>,
    source_voxel_count: u32,
    cells_by_level: Vec<Chunked<MergeCell>>,
}

/// Append-only storage in fixed 64 KiB chunks. Collected cells and bricks
/// are a query's memory peak: doubling growth would leave up to half of each
/// as slack, and in the edge Worker's WASM heap the large reallocations
/// fragment memory that never shrinks. Equal-sized chunks instead reuse the
/// space freed by each other.
struct Chunked<T> {
    chunks: Vec<Vec<T>>,
    len: usize,
}

impl<T: Copy> Chunked<T> {
    const CHUNK_LEN: usize = {
        let len = 64 * 1024 / std::mem::size_of::<T>();
        if len == 0 {
            1
        } else {
            len
        }
    };

    fn new() -> Self {
        Self {
            chunks: Vec::new(),
            len: 0,
        }
    }

    fn len(&self) -> usize {
        self.len
    }

    /// Append `value`, returning its index.
    fn push(&mut self, value: T) -> usize {
        if self.len.is_multiple_of(Self::CHUNK_LEN) {
            self.chunks.push(Vec::with_capacity(Self::CHUNK_LEN));
        }
        self.chunks.last_mut().unwrap().push(value);
        self.len += 1;
        self.len - 1
    }

    fn get(&self, index: usize) -> &T {
        &self.chunks[index / Self::CHUNK_LEN][index % Self::CHUNK_LEN]
    }

    fn get_mut(&mut self, index: usize) -> &mut T {
        &mut self.chunks[index / Self::CHUNK_LEN][index % Self::CHUNK_LEN]
    }

    /// Keep only the values `keep` accepts, in order, compacting in place.
    fn retain(&mut self, mut keep: impl FnMut(&T) -> bool) {
        let mut kept = 0;
        for index in 0..self.len {
            let value = *self.get(index);
            if keep(&value) {
                *self.get_mut(kept) = value;
                kept += 1;
            }
        }
        self.len = kept;
        let chunk_count = kept.div_ceil(Self::CHUNK_LEN);
        self.chunks.truncate(chunk_count);
        if let Some(last) = self.chunks.last_mut() {
            last.truncate(kept - (chunk_count - 1) * Self::CHUNK_LEN);
        }
    }

    fn iter_rev(&self) -> impl Iterator<Item = &T> {
        self.chunks
            .iter()
            .rev()
            .flat_map(|chunk| chunk.iter().rev())
    }

    /// Copy into one contiguous vector, freeing each chunk once copied.
    fn into_vec(self) -> Vec<T> {
        let mut values = Vec::with_capacity(self.len);
        for chunk in self.chunks {
            values.extend_from_slice(&chunk);
        }
        values
    }
}

impl<'a, S: ScanMeta> VolumeCollector<'a, S> {
    pub fn new(scan: &'a S, window: &'a QueryWindow) -> Self {
        let level_count = scan.level_bounds().len();
        Self {
            scan,
            window,
            projection: QueryProjection::new(scan.grid(), window),
            layer_counts: vec![0_u32; level_count],
            source_voxel_count: 0,
            cells_by_level: (0..level_count).map(|_| Chunked::new()).collect(),
        }
    }

    /// Add one tile's voxels, in stored order.
    pub fn add_voxels(&mut self, voxels: &[StoredVoxel]) {
        let window = self.window;
        for record in voxels {
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

            let (x_nm, z_nm) = self.projection.project_cell_nm(row, col);
            if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
                continue;
            }

            let level_idx = record.level_idx as usize;
            if level_idx >= self.cells_by_level.len() {
                continue;
            }
            self.layer_counts[level_idx] = self.layer_counts[level_idx].saturating_add(1);
            self.source_voxel_count = self.source_voxel_count.saturating_add(1);
            self.cells_by_level[level_idx].push(MergeCell {
                row: record.row,
                col: record.col,
                phase: record.phase,
                surface_phase: record.surface_phase,
                dbz_tenths: record.dbz_tenths,
            });
        }
    }

    pub fn finish(self) -> Vec<u8> {
        let Self {
            scan,
            window,
            layer_counts,
            source_voxel_count,
            mut cells_by_level,
            ..
        } = self;
        let level_bounds = scan.level_bounds();
        let mut active: FxHashMap<VerticalSignature, usize> = FxHashMap::default();
        let mut merged_bricks: Chunked<BrickCandidate> = Chunked::new();

        for level_idx in 0..cells_by_level.len() {
            // Each level's cells are freed once merged, keeping the peak at
            // the collected cells rather than cells plus bricks.
            let mut cells =
                std::mem::replace(&mut cells_by_level[level_idx], Chunked::new()).into_vec();
            // `build_level_rectangles` leaves `cells` sorted by (row, col), which
            // `split_rectangle` relies on to recompute per-chunk maxima.
            let mut rectangles = build_level_rectangles(&mut cells);
            let mut split_rectangles: Vec<HorizontalRect> = Vec::with_capacity(rectangles.len());
            for rect in rectangles.drain(..) {
                let max_span = max_span_for_dbz(rect.key.quantized_dbz_tenths);
                split_rectangle(rect, max_span, &cells, &mut split_rectangles);
            }
            drop(cells);

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
                    let current = *merged_bricks.get(existing_idx);
                    let next_vertical_span = level_idx as u16 - current.level_start as u16 + 1_u16;
                    if current.level_end as usize + 1 == level_idx
                        && next_vertical_span <= WIRE_MAX_VERTICAL_SPAN
                    {
                        let prev_bounds = level_bounds[current.level_end as usize];
                        let next_bounds = level_bounds[level_idx];
                        if next_bounds.bottom_feet <= prev_bounds.top_feet.saturating_add(1) {
                            let brick = merged_bricks.get_mut(existing_idx);
                            brick.level_end = level_idx as u8;
                            brick.max_dbz_tenths = current.max_dbz_tenths.max(rect.max_dbz_tenths);
                            next_active.insert(signature, existing_idx);
                            extended = true;
                        }
                    }
                }

                if !extended {
                    let new_idx = merged_bricks.push(BrickCandidate {
                        row_start: rect.row_start as u16,
                        row_end: rect.row_end as u16,
                        col_start: rect.col_start as u16,
                        col_end: rect.col_end as u16,
                        level_start: level_idx as u8,
                        level_end: level_idx as u8,
                        key: rect.key,
                        max_dbz_tenths: rect.max_dbz_tenths,
                    });
                    next_active.insert(signature, new_idx);
                }
            }
            active = next_active;
        }
        drop(active);

        // Drop bricks that have no level bounds or whose center falls
        // outside the range circle, in place.
        merged_bricks.retain(|brick| {
            if level_bounds.get(brick.level_start as usize).is_none()
                || level_bounds.get(brick.level_end as usize).is_none()
            {
                return false;
            }
            let (x_nm, z_nm) = brick_center_nm(scan, window, brick);
            x_nm * x_nm + z_nm * z_nm <= window.max_range_squared_nm
        });
        let brick_count = merged_bricks.len() as u32;

        // --- FlatBuffers serialization ---
        // Columns are written straight from the bricks: no intermediate SoA
        // copy is ever resident next to the bricks and the finished buffer.
        let n = brick_count as usize;
        let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(128 + n * 20);
        fn column<'fbb, T: flatbuffers::Push<Output = T> + Copy>(
            builder: &mut flatbuffers::FlatBufferBuilder<'fbb>,
            bricks: &Chunked<BrickCandidate>,
            value: impl Fn(&BrickCandidate) -> T,
        ) -> flatbuffers::WIPOffset<flatbuffers::Vector<'fbb, T>> {
            // Same bytes as `create_vector`: FlatBuffers fills back to front.
            builder.start_vector::<T>(bricks.len());
            for brick in bricks.iter_rev() {
                builder.push(value(brick));
            }
            builder.end_vector::<T>(bricks.len())
        }
        let bricks = &merged_bricks;
        let layer_voxel_counts_vec = builder.create_vector(&layer_counts);
        let x_vec = column(&mut builder, bricks, |brick| {
            round_i16(brick_center_nm(scan, window, brick).0 * 100.0)
        });
        let z_vec = column(&mut builder, bricks, |brick| {
            round_i16(brick_center_nm(scan, window, brick).1 * 100.0)
        });
        let bottom_vec = column(&mut builder, bricks, |brick| {
            level_bounds[brick.level_start as usize].bottom_feet
        });
        let top_vec = column(&mut builder, bricks, |brick| {
            level_bounds[brick.level_end as usize].top_feet
        });
        // Ship the true maximum over the merged cells, not the quantized
        // grouping bucket, so a core is never rounded down on the wire.
        let dbz_vec = column(&mut builder, bricks, |brick| brick.max_dbz_tenths);
        let phase_vec = column(&mut builder, bricks, |brick| brick.key.phase);
        let surface_phase_vec = column(&mut builder, bricks, |brick| brick.key.surface_phase);
        let span_x_vec = column(&mut builder, bricks, |brick| {
            (brick.col_end as u32 - brick.col_start as u32 + 1).min(u16::MAX as u32) as u16
        });
        let span_y_vec = column(&mut builder, bricks, |brick| {
            (brick.row_end as u32 - brick.row_start as u32 + 1).min(u16::MAX as u32) as u16
        });
        let span_z_vec = column(&mut builder, bricks, |brick| {
            (brick.level_end as usize - brick.level_start as usize + 1).min(u16::MAX as usize)
                as u16
        });
        drop(merged_bricks);

        let volume = MrmsVolume::create(
            &mut builder,
            &MrmsVolumeArgs {
                source_voxel_count,
                brick_count,
                layer_count: level_bounds.len() as u16,
                generated_at_ms: scan.generated_at_ms(),
                scan_time_ms: scan.scan_time_ms(),
                footprint_x_milli: window.footprint_x_milli,
                footprint_y_milli: window.footprint_y_milli,
                min_dbz_tenths: window.min_dbz_tenths,
                max_range_tenths_nm: round_u16(window.max_range_nm * 10.0),
                tile_size: scan.tile_size(),
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
        // The builder fills its buffer back to front; shift the payload down
        // in place instead of copying it out.
        let (mut buffer, head) = builder.collapse();
        buffer.drain(..head);
        buffer
    }
}

fn brick_center_nm(
    scan: &impl ScanMeta,
    window: &QueryWindow,
    brick: &BrickCandidate,
) -> (f64, f64) {
    let center_row = (brick.row_start as f64 + brick.row_end as f64) * 0.5;
    let center_col = (brick.col_start as f64 + brick.col_end as f64) * 0.5;
    project_grid_position_nm(scan, window, center_row, center_col)
}

fn project_grid_position_nm(
    scan: &impl ScanMeta,
    window: &QueryWindow,
    row: f64,
    col: f64,
) -> (f64, f64) {
    let grid = scan.grid();
    let lat_deg = grid.la1_deg + row * grid.lat_step_deg;
    let lon_deg360 = to_lon360(grid.lo1_deg360 + col * grid.lon_step_deg);
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

/// True maximum `dbz_tenths` over the cells of `key` inside one chunk of a
/// rectangle. `cells` must be sorted by (row, col) — the order
/// `build_level_rectangles` leaves them in. Every chunk row is a sub-range of
/// a same-key run, so a matching cell always exists; if the invariant ever
/// breaks, the parent rectangle's maximum is the conservative answer (it can
/// overstate within the quantization bucket, never understate).
fn max_dbz_in_chunk(
    cells: &[MergeCell],
    key: MergeKey,
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    parent_max_dbz_tenths: i16,
) -> i16 {
    let mut max: Option<i16> = None;
    for row in row_start..=row_end {
        let target = (u64::from(row) << 32) | u64::from(col_start);
        let start = cells.partition_point(|cell| {
            ((u64::from(cell.row()) << 32) | u64::from(cell.col())) < target
        });
        for cell in &cells[start..] {
            if cell.row() != row || cell.col() > col_end {
                break;
            }
            if cell.key() == key {
                max = Some(max.map_or(cell.dbz_tenths, |m| m.max(cell.dbz_tenths)));
            }
        }
    }
    debug_assert!(max.is_some(), "split chunk contains no cell of its own key");
    max.unwrap_or(parent_max_dbz_tenths)
}

fn split_rectangle(
    rect: HorizontalRect,
    max_span: u16,
    cells: &[MergeCell],
    out: &mut Vec<HorizontalRect>,
) {
    let chunk_size = max_span.max(1) as u32;
    let splits =
        rect.row_end - rect.row_start >= chunk_size || rect.col_end - rect.col_start >= chunk_size;
    let mut row_start = rect.row_start;
    while row_start <= rect.row_end {
        let row_end = min(row_start.saturating_add(chunk_size - 1), rect.row_end);
        let mut col_start = rect.col_start;
        while col_start <= rect.col_end {
            let col_end = min(col_start.saturating_add(chunk_size - 1), rect.col_end);
            // An unsplit rectangle already carries its exact maximum; a split
            // chunk recomputes its own so a chunk without the strongest cell
            // is not pushed into a stronger 5 dBZ display band.
            let max_dbz_tenths = if splits {
                max_dbz_in_chunk(
                    cells,
                    rect.key,
                    row_start,
                    row_end,
                    col_start,
                    col_end,
                    rect.max_dbz_tenths,
                )
            } else {
                rect.max_dbz_tenths
            };
            out.push(HorizontalRect {
                row_start,
                row_end,
                col_start,
                col_end,
                key: rect.key,
                max_dbz_tenths,
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
            rectangles[rect_idx].max_dbz_tenths =
                rectangles[rect_idx].max_dbz_tenths.max(run.max_dbz_tenths);
            next_active.insert(signature, rect_idx);
        } else {
            let rect_idx = rectangles.len();
            rectangles.push(HorizontalRect {
                row_start: row,
                row_end: row,
                col_start: run.col_start,
                col_end: run.col_end,
                key: run.key,
                max_dbz_tenths: run.max_dbz_tenths,
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

    cells.sort_unstable_by_key(|cell| ((cell.row() as u64) << 32) | cell.col() as u64);

    let mut rectangles: Vec<HorizontalRect> = Vec::new();
    let mut active: FxHashMap<RunSignature, usize> = FxHashMap::default();
    let mut prev_row: Option<u32> = None;
    let mut runs_for_row: Vec<RowRun> = Vec::with_capacity(32);

    let mut run_row = cells[0].row();
    let mut run_col_start = cells[0].col();
    let mut run_col_end = cells[0].col();
    let mut run_key = cells[0].key();
    let mut run_max_dbz_tenths = cells[0].dbz_tenths;

    for cell in &cells[1..] {
        if cell.row() == run_row && cell.key() == run_key {
            if cell.col() == run_col_end {
                run_max_dbz_tenths = run_max_dbz_tenths.max(cell.dbz_tenths);
                continue;
            }
            if cell.col() == run_col_end.saturating_add(1) {
                run_col_end = cell.col();
                run_max_dbz_tenths = run_max_dbz_tenths.max(cell.dbz_tenths);
                continue;
            }
        }
        runs_for_row.push(RowRun {
            col_start: run_col_start,
            col_end: run_col_end,
            key: run_key,
            max_dbz_tenths: run_max_dbz_tenths,
        });
        if cell.row() != run_row {
            merge_row_runs_into_rectangles(
                run_row,
                &runs_for_row,
                &mut rectangles,
                &mut active,
                &mut prev_row,
            );
            runs_for_row.clear();
        }
        run_row = cell.row();
        run_col_start = cell.col();
        run_col_end = cell.col();
        run_key = cell.key();
        run_max_dbz_tenths = cell.dbz_tenths;
    }

    runs_for_row.push(RowRun {
        col_start: run_col_start,
        col_end: run_col_end,
        key: run_key,
        max_dbz_tenths: run_max_dbz_tenths,
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
    use crate::mrms_query::testkit::{sample_scan, with_voxels, TestScan};
    use crate::mrms_query::{build_query_window, LevelBounds, StoredVoxel, DEFAULT_MIN_DBZ};

    #[test]
    fn projection_cache_matches_direct_projection_for_integer_cells() {
        let scan = sample_scan();
        let window = build_query_window(&scan, 35.15, -109.55, DEFAULT_MIN_DBZ, 40.0);
        let projection = QueryProjection::new(&scan.grid, &window);

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

    fn cell(row: u16, col: u16, key: MergeKey, dbz_tenths: i16) -> MergeCell {
        let cell = MergeCell {
            row,
            col,
            phase: key.phase,
            surface_phase: key.surface_phase,
            dbz_tenths,
        };
        assert_eq!(
            cell.key(),
            key,
            "test cell dBZ must fall in its key's bucket"
        );
        cell
    }

    #[test]
    fn build_level_rectangles_merges_runs_and_respects_row_gaps() {
        let key_a = MergeKey {
            phase: 1,
            surface_phase: 1,
            quantized_dbz_tenths: 300,
        };
        let key_b = MergeKey {
            phase: 2,
            surface_phase: 2,
            quantized_dbz_tenths: 300,
        };

        let mut cells = vec![
            cell(1, 1, key_a, 300),
            cell(0, 1, key_a, 300),
            cell(0, 0, key_a, 300),
            cell(1, 0, key_a, 300),
            cell(1, 4, key_a, 300),
            cell(2, 4, key_a, 300),
            cell(4, 0, key_a, 300),
            cell(0, 6, key_b, 300),
            cell(1, 6, key_b, 300),
            cell(1, 6, key_b, 300),
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

    #[test]
    fn cells_with_different_surface_phase_never_share_a_rectangle() {
        // Same aloft phase and same quantized dBZ, but a surface rain/snow
        // boundary between columns 1 and 2: the run must split there, and the
        // rows must merge only within each surface-phase side.
        let key_rain = MergeKey {
            phase: 1,
            surface_phase: 0,
            quantized_dbz_tenths: 300,
        };
        let key_snow = MergeKey {
            phase: 1,
            surface_phase: 2,
            quantized_dbz_tenths: 300,
        };

        let mut cells = vec![
            cell(0, 0, key_rain, 300),
            cell(0, 1, key_rain, 300),
            cell(0, 2, key_snow, 300),
            cell(0, 3, key_snow, 300),
            cell(1, 0, key_rain, 300),
            cell(1, 1, key_rain, 300),
            cell(1, 2, key_snow, 300),
            cell(1, 3, key_snow, 300),
        ];

        let mut rectangles = build_level_rectangles(&mut cells);
        rectangles.sort_unstable_by_key(|r| r.col_start);

        assert_eq!(rectangles.len(), 2);
        assert_eq!(
            (rectangles[0].col_start, rectangles[0].col_end),
            (0, 1),
            "rain side should merge into its own 2x2 rectangle"
        );
        assert_eq!(rectangles[0].key, key_rain);
        assert_eq!(
            (rectangles[1].col_start, rectangles[1].col_end),
            (2, 3),
            "snow side should merge into its own 2x2 rectangle"
        );
        assert_eq!(rectangles[1].key, key_snow);
        assert_eq!(rectangles[0].row_end, 1);
        assert_eq!(rectangles[1].row_end, 1);
    }

    #[test]
    fn rectangles_carry_the_true_max_dbz_over_merged_cells() {
        // All cells quantize to the same 300-tenths bucket but the raw values
        // differ; the rectangle must report the maximum, not the bucket.
        let key = MergeKey {
            phase: 1,
            surface_phase: 1,
            quantized_dbz_tenths: 300,
        };

        let mut cells = vec![
            cell(0, 0, key, 288),
            cell(0, 1, key, 305),
            cell(1, 0, key, 297),
            cell(1, 1, key, 312),
        ];

        let rectangles = build_level_rectangles(&mut cells);
        assert_eq!(rectangles.len(), 1);
        assert_eq!(rectangles[0].max_dbz_tenths, 312);
        assert_eq!(rectangles[0].key.quantized_dbz_tenths, 300);
    }

    #[test]
    fn split_chunks_carry_their_own_max_dbz_not_the_parents() {
        // One 1x4 run, all in the 300-tenths bucket, strongest cell in the
        // second half. Splitting at span 2 must not push the weak first chunk
        // into the stronger chunk's display band.
        let key = MergeKey {
            phase: 1,
            surface_phase: 1,
            quantized_dbz_tenths: 300,
        };
        let mut cells = vec![
            cell(0, 0, key, 288),
            cell(0, 1, key, 291),
            cell(0, 2, key, 312),
            cell(0, 3, key, 289),
        ];

        let rectangles = build_level_rectangles(&mut cells);
        assert_eq!(rectangles.len(), 1);
        assert_eq!(rectangles[0].max_dbz_tenths, 312);

        let mut chunks = Vec::new();
        split_rectangle(rectangles[0], 2, &cells, &mut chunks);
        chunks.sort_unstable_by_key(|c| c.col_start);

        assert_eq!(chunks.len(), 2);
        assert_eq!((chunks[0].col_start, chunks[0].col_end), (0, 1));
        assert_eq!(
            chunks[0].max_dbz_tenths, 291,
            "weak chunk keeps its own max"
        );
        assert_eq!((chunks[1].col_start, chunks[1].col_end), (2, 3));
        assert_eq!(chunks[1].max_dbz_tenths, 312);
    }

    #[test]
    fn unsplit_rectangles_keep_their_exact_max_without_a_cell_lookup() {
        let key = MergeKey {
            phase: 1,
            surface_phase: 1,
            quantized_dbz_tenths: 300,
        };
        let mut cells = vec![cell(0, 0, key, 297), cell(0, 1, key, 302)];
        let rectangles = build_level_rectangles(&mut cells);
        assert_eq!(rectangles.len(), 1);

        let mut chunks = Vec::new();
        split_rectangle(rectangles[0], 48, &cells, &mut chunks);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].max_dbz_tenths, 302);
    }

    fn merge_scan(voxels: Vec<StoredVoxel>, levels: usize) -> TestScan {
        let mut scan = sample_scan();
        scan.level_bounds = (0..levels)
            .map(|i| LevelBounds {
                bottom_feet: (1_000 + i * 1_000) as u16,
                top_feet: (2_000 + i * 1_000) as u16,
            })
            .collect();
        with_voxels(scan, voxels)
    }

    fn build(scan: &TestScan, lat: f64, lon: f64, min_dbz: f64, max_range_nm: f64) -> Vec<u8> {
        let window = build_query_window(scan, lat, lon, min_dbz, max_range_nm);
        build_volume_wire_fb(scan, &window)
    }

    fn decode_wire(payload: &[u8]) -> MrmsVolume<'_> {
        flatbuffers::root::<MrmsVolume>(payload).expect("encoded AVMR payload should decode")
    }

    #[test]
    fn wire_bricks_split_on_surface_phase_and_ship_max_dbz() {
        // Two adjacent cells, identical aloft phase and quantization bucket:
        // one rain-surface at 28.8 dBZ, one snow-surface at 31.2 dBZ. With the
        // old {phase, dbz} key these merged into a single brick that carried
        // the first cell's surface phase and the quantized 30.0 dBZ.
        let scan = merge_scan(
            vec![
                StoredVoxel {
                    row: 2,
                    col: 2,
                    level_idx: 0,
                    dbz_tenths: 288,
                    phase: 1,
                    surface_phase: 0,
                },
                StoredVoxel {
                    row: 2,
                    col: 3,
                    level_idx: 0,
                    dbz_tenths: 312,
                    phase: 1,
                    surface_phase: 2,
                },
            ],
            1,
        );

        let payload = build(&scan, 35.1, -109.85, 0.0, 40.0);
        let fb = decode_wire(&payload);

        assert_eq!(fb.source_voxel_count(), 2);
        assert_eq!(
            fb.brick_count(),
            2,
            "surface-phase boundary must split the run"
        );
        let dbz: Vec<i16> = fb.dbz_tenths().expect("dbz column").iter().collect();
        let surface: Vec<u8> = fb.surface_phase().expect("surface column").iter().collect();
        let mut pairs: Vec<(u8, i16)> = surface.into_iter().zip(dbz).collect();
        pairs.sort_unstable();
        assert_eq!(
            pairs,
            vec![(0, 288), (2, 312)],
            "each brick keeps its own surface phase and true (unquantized) dBZ"
        );
    }

    #[test]
    fn wire_bricks_report_max_dbz_across_vertical_merges() {
        // The same cell on two contiguous levels, both in the 30 dBZ bucket
        // but with different raw values: the merged brick must span both
        // levels and report the stronger return.
        let scan = merge_scan(
            vec![
                StoredVoxel {
                    row: 2,
                    col: 2,
                    level_idx: 0,
                    dbz_tenths: 291,
                    phase: 1,
                    surface_phase: 1,
                },
                StoredVoxel {
                    row: 2,
                    col: 2,
                    level_idx: 1,
                    dbz_tenths: 309,
                    phase: 1,
                    surface_phase: 1,
                },
            ],
            2,
        );

        let payload = build(&scan, 35.1, -109.85, 0.0, 40.0);
        let fb = decode_wire(&payload);

        assert_eq!(fb.source_voxel_count(), 2);
        assert_eq!(
            fb.brick_count(),
            1,
            "contiguous levels should merge vertically"
        );
        assert_eq!(fb.span_z().expect("span_z column").get(0), 2);
        assert_eq!(
            fb.dbz_tenths().expect("dbz column").get(0),
            309,
            "vertical merge must keep the true maximum"
        );
    }
}
