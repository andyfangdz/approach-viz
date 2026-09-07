// Render-ready MRMS voxel assembly.
//
// `prepare_volume` outputs two index spaces: full-length payload columns
// addressed by raw payload index, and compacted per-valid-voxel columns
// addressed via `valid_indices`, with `declutter_indices` selecting the
// rendered subset. Mixing those spaces caused the web ghost-layer bug, so the
// join is resolved here — once, in Rust — and clients receive flat per-voxel
// columns they can upload directly.

use crate::mrms_preprocess::VolumeSource;
use crate::types::{PHASE_RAIN, PhaseMode, PreparedVolume};

/// Flat per-rendered-voxel columns. All positions/sizes are local-frame
/// nautical miles without vertical exaggeration; renderers multiply the `y`
/// center and height by their vertical scale.
///
/// `max_abs_x_nm`/`max_abs_z_nm`/`max_corrected_top_feet` summarize the
/// rendered set for altitude-guide sizing (web `guideData` semantics).
#[derive(Debug, Clone, PartialEq)]
pub struct MrmsRenderVolumeData {
    pub center_x_nm: Vec<f32>,
    pub center_y_nm: Vec<f32>,
    pub center_z_nm: Vec<f32>,
    pub size_x_nm: Vec<f32>,
    pub size_y_nm: Vec<f32>,
    pub size_z_nm: Vec<f32>,
    pub dbz: Vec<f32>,
    pub phase_code: Vec<u8>,
    pub max_abs_x_nm: f32,
    pub max_abs_z_nm: f32,
    pub max_corrected_top_feet: f32,
}

/// Join `prepare_volume` outputs with payload columns into render-ready
/// voxel boxes ordered by `declutter_indices`.
pub fn build_render_volume(
    volume: &impl VolumeSource,
    footprint_base_x_nm: f32,
    footprint_base_y_nm: f32,
    prepared: &PreparedVolume,
) -> MrmsRenderVolumeData {
    let count = prepared.declutter_count;
    let mut data = MrmsRenderVolumeData {
        center_x_nm: Vec::with_capacity(count),
        center_y_nm: Vec::with_capacity(count),
        center_z_nm: Vec::with_capacity(count),
        size_x_nm: Vec::with_capacity(count),
        size_y_nm: Vec::with_capacity(count),
        size_z_nm: Vec::with_capacity(count),
        dbz: Vec::with_capacity(count),
        phase_code: Vec::with_capacity(count),
        max_abs_x_nm: 0.0,
        max_abs_z_nm: 0.0,
        max_corrected_top_feet: 0.0,
    };

    for i in 0..count {
        let valid_index = prepared.declutter_indices[i] as usize;
        let payload_index = prepared.valid_indices[valid_index] as usize;

        let x = volume.x_nm(payload_index);
        let z = volume.z_nm(payload_index);
        data.max_abs_x_nm = data.max_abs_x_nm.max(x.abs());
        data.max_abs_z_nm = data.max_abs_z_nm.max(z.abs());
        data.max_corrected_top_feet = data
            .max_corrected_top_feet
            .max(prepared.corrected_top_feet[valid_index]);

        data.center_x_nm.push(x);
        data.center_y_nm.push(prepared.y_base[valid_index]);
        data.center_z_nm.push(z);
        data.size_x_nm
            .push(footprint_base_x_nm * f32::from(volume.footprint_x_span(payload_index).max(1)));
        data.size_y_nm.push(prepared.height_base[valid_index]);
        data.size_z_nm
            .push(footprint_base_y_nm * f32::from(volume.footprint_y_span(payload_index).max(1)));
        data.dbz
            .push(f32::from(volume.dbz_tenths(payload_index)) / 10.0);
        data.phase_code
            .push(prepared.effective_phase_code[valid_index]);
    }

    data
}

/// Edge length of one volume brick in texels. A brick is the unit of
/// residency in the pool (the VDB "leaf node"): only bricks that hold at
/// least one echo texel are stored, everything else is a page-table zero.
pub const VOLUME_BRICK_TEXELS: usize = 8;

/// Edge length of a brick as stored in the pool: the 8 core texels plus a
/// one-texel apron on every side. The apron holds copies of the neighboring
/// logical texels so trilinear filtering at a brick face never reads across
/// into an unrelated brick.
pub const VOLUME_BRICK_STORED_TEXELS: usize = VOLUME_BRICK_TEXELS + 2;

/// Ceiling on resident bricks. Past it the horizontal grid coarsens by the
/// next whole footprint multiple and the selection is re-counted, so a
/// storm covering most of the box still fits in a bounded pool
/// (`8192 * 10^3 * 2 B` = 16.4 MB) instead of failing or growing without
/// limit. At full 0.54 NM resolution over a 120 NM request this is about a
/// quarter of the box; the dense grid it replaced coarsened every request.
pub const MAX_VOLUME_BRICKS: usize = 8192;

/// Bricks per pool row and per pool column. `25 * 10` texels keeps a pool
/// axis within the 256-texel 3D texture size WebGL2 guarantees; the pool
/// depth grows one brick layer at a time as bricks are added.
const POOL_BRICKS_PER_AXIS: usize = 25;

/// Ceiling on the logical horizontal axes, so the page table stays within
/// 256 cells per axis. A 120 NM request lands near 440 source cells per
/// axis, well under it; this only bites on a sanity-check failure.
const MAX_TEXTURE_AXIS_CELLS: usize = VOLUME_BRICK_TEXELS * 256;

/// Ceiling on raymarch altitude bins.
const MAX_TEXTURE_ALTITUDE_BINS: usize = 96;

/// Preferred altitude-bin thickness. Finer than the lowest MRMS level spacing
/// (~820 ft), so no level is skipped while shallow fields get shallow bins.
const TARGET_ALTITUDE_BIN_FEET: f64 = 500.0;

/// Sanity ceiling on the reconstructed source-grid axis, mirroring
/// [`MAX_COMPOSITE_AXIS_CELLS`]: exceeding it means the index reconstruction
/// broke, not that the storm got big.
const MAX_TEXTURE_SOURCE_AXIS_CELLS: f64 = 4096.0;

/// Sparse RG8 voxel grid for raymarched volume rendering, laid out as a page
/// table over a pool of bricks (the two-level VDB layout, one internal level).
///
/// The logical grid is `width x height x depth` texels: `x` (column) fastest,
/// then `z` (row), then altitude bin. Each texel is two bytes: `R` = dBZ
/// rounded to whole dBZ (`0` = empty), `G` = phase code. The grid is never
/// materialized; it is addressed through two textures:
///
/// - `page_table` (`page_width x page_height x page_depth`, RG8): one entry
///   per [`VOLUME_BRICK_TEXELS`]-cube of logical texels holding `slot + 1`
///   little-endian (`R` low byte, `G` high byte), or `0` when the cube holds
///   no echo. An empty page is the empty-space-skip signal for the ray.
/// - `pool` (`pool_bricks_* x` [`VOLUME_BRICK_STORED_TEXELS`] per axis, RG8):
///   resident bricks, slot `s` at brick coordinates
///   `(s % bx, (s / bx) % by, s / (bx * by))`. Each stored brick is the 8^3
///   core wrapped in a one-texel apron copied from the neighboring logical
///   texels (clamped to the grid edge), so a trilinear fetch at logical
///   position `p` inside page `c` reads pool position
///   `slot_origin + 1 + (p - c * 8)` and never leaves the brick.
///
/// Altitudes are corrected feet (earth-curvature drop already subtracted when
/// requested), so the sampler needs no per-sample curvature work. Cell `(0,0)`
/// spans `origin_*_nm` to `origin_*_nm + cell_size_*_nm`; bin `0` spans
/// `base_feet` to `base_feet + bin_size_feet`. `coarsen_x`/`coarsen_z` report
/// the whole footprint multiple each cell covers (`1` = full source
/// resolution).
///
/// `max_abs_x_nm`/`max_abs_z_nm`/`max_corrected_top_feet` summarize the
/// rendered voxel set for altitude-guide sizing, matching the semantics of
/// [`MrmsRenderVolumeData`].
#[derive(Debug, Clone, PartialEq)]
pub struct MrmsVolumeTexture {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub origin_x_nm: f32,
    pub origin_z_nm: f32,
    pub cell_size_x_nm: f32,
    pub cell_size_z_nm: f32,
    pub base_feet: f32,
    pub bin_size_feet: f32,
    pub coarsen_x: u32,
    pub coarsen_z: u32,
    pub page_width: u32,
    pub page_height: u32,
    pub page_depth: u32,
    pub page_table: Vec<u8>,
    pub brick_count: u32,
    pub pool_bricks_x: u32,
    pub pool_bricks_y: u32,
    pub pool_bricks_z: u32,
    pub pool: Vec<u8>,
    pub filled_texel_count: u32,
    pub max_abs_x_nm: f32,
    pub max_abs_z_nm: f32,
    pub max_corrected_top_feet: f32,
}

impl MrmsVolumeTexture {
    /// Page-table slot (`0` = empty, else `slot + 1`) for the page holding
    /// logical texel `(col, row, bin)`.
    fn page_entry(&self, col: usize, row: usize, bin: usize) -> usize {
        let b = VOLUME_BRICK_TEXELS;
        let (pw, ph) = (self.page_width as usize, self.page_height as usize);
        let index = (((bin / b) * ph + row / b) * pw + col / b) * 2;
        usize::from(self.page_table[index]) | (usize::from(self.page_table[index + 1]) << 8)
    }

    /// Byte offset of stored texel `(sx, sy, sz)` (each `0..10`) of pool slot
    /// `slot` in `pool`.
    pub fn pool_index(&self, slot: usize, sx: usize, sy: usize, sz: usize) -> usize {
        let s = VOLUME_BRICK_STORED_TEXELS;
        let (bx, by) = (self.pool_bricks_x as usize, self.pool_bricks_y as usize);
        let brick = (slot % bx, (slot / bx) % by, slot / (bx * by));
        let pool_w = bx * s;
        let pool_h = by * s;
        let px = brick.0 * s + sx;
        let py = brick.1 * s + sy;
        let pz = brick.2 * s + sz;
        ((pz * pool_h + py) * pool_w + px) * 2
    }

    /// `(R, G)` of logical texel `(col, row, bin)`, read from its own brick's
    /// core; `(0, 0)` when the page is empty.
    pub fn texel(&self, col: usize, row: usize, bin: usize) -> (u8, u8) {
        let entry = self.page_entry(col, row, bin);
        if entry == 0 {
            return (0, 0);
        }
        let b = VOLUME_BRICK_TEXELS;
        let index = self.pool_index(entry - 1, col % b + 1, row % b + 1, bin % b + 1);
        (self.pool[index], self.pool[index + 1])
    }
}

/// Rasterization frame for one coarsening attempt: the logical grid the
/// bricks are placed on.
struct RasterFrame {
    width: usize,
    height: usize,
    depth: usize,
    min_x: f64,
    min_z: f64,
    cell_x_nm: f64,
    cell_z_nm: f64,
    base_feet: f64,
    bin_feet: f64,
}

/// Half-open logical texel ranges covered by one source brick.
struct TexelRanges {
    cols: (usize, usize),
    rows: (usize, usize),
    bins: (usize, usize),
}

impl RasterFrame {
    fn page_dims(&self) -> (usize, usize, usize) {
        let b = VOLUME_BRICK_TEXELS;
        (
            self.width.div_ceil(b),
            self.height.div_ceil(b),
            self.depth.div_ceil(b),
        )
    }

    fn ranges(
        &self,
        volume: &impl VolumeSource,
        prepared: &PreparedVolume,
        footprint_x_nm: f64,
        footprint_z_nm: f64,
        selection_index: usize,
    ) -> TexelRanges {
        let valid_index = prepared.declutter_indices[selection_index] as usize;
        let payload_index = prepared.valid_indices[valid_index] as usize;
        let x = f64::from(volume.x_nm(payload_index));
        let z = f64::from(volume.z_nm(payload_index));
        let half_sx =
            footprint_x_nm * f64::from(volume.footprint_x_span(payload_index).max(1)) * 0.5;
        let half_sz =
            footprint_z_nm * f64::from(volume.footprint_y_span(payload_index).max(1)) * 0.5;

        let col_start = (((x - half_sx - self.min_x) / self.cell_x_nm) + 1e-6)
            .floor()
            .max(0.0) as usize;
        let col_end = ((((x + half_sx - self.min_x) / self.cell_x_nm) - 1e-6).ceil() as usize)
            .min(self.width);
        let row_start = (((z - half_sz - self.min_z) / self.cell_z_nm) + 1e-6)
            .floor()
            .max(0.0) as usize;
        let row_end = ((((z + half_sz - self.min_z) / self.cell_z_nm) - 1e-6).ceil() as usize)
            .min(self.height);

        let bottom = f64::from(prepared.corrected_bottom_feet[valid_index]);
        let top = f64::from(prepared.corrected_top_feet[valid_index]);
        let bin_start = (((bottom - self.base_feet) / self.bin_feet) + 1e-6)
            .floor()
            .max(0.0) as usize;
        let mut bin_end =
            ((((top - self.base_feet) / self.bin_feet) - 1e-6).ceil() as usize).min(self.depth);
        if bin_end <= bin_start {
            bin_end = (bin_start + 1).min(self.depth);
        }

        TexelRanges {
            cols: (col_start, col_end),
            rows: (row_start, row_end),
            bins: (bin_start, bin_end),
        }
    }
}

/// Rasterize the declutter-selected voxel bricks into the sparse page-table +
/// brick-pool volume for raymarched rendering.
///
/// Consumes the same `prepare_volume` selection as [`build_render_volume`]
/// (threshold, phase mode, curvature, declutter), so a raymarched frame shows
/// exactly the voxel set the instanced path would have drawn. Overlapping
/// bricks resolve strongest-return-wins so intensity is never understated.
/// Returns `Ok(None)` when the selection is empty.
pub fn build_volume_texture(
    volume: &impl VolumeSource,
    footprint_base_x_nm: f32,
    footprint_base_y_nm: f32,
    prepared: &PreparedVolume,
) -> Result<Option<MrmsVolumeTexture>, String> {
    build_volume_texture_with_budget(
        volume,
        footprint_base_x_nm,
        footprint_base_y_nm,
        prepared,
        MAX_VOLUME_BRICKS,
    )
}

/// [`build_volume_texture`] with an explicit brick budget, so tests can drive
/// the budget-coarsening path with small inputs.
fn build_volume_texture_with_budget(
    volume: &impl VolumeSource,
    footprint_base_x_nm: f32,
    footprint_base_y_nm: f32,
    prepared: &PreparedVolume,
    max_bricks: usize,
) -> Result<Option<MrmsVolumeTexture>, String> {
    let footprint_x_nm = f64::from(footprint_base_x_nm);
    let footprint_z_nm = f64::from(footprint_base_y_nm);
    if !(footprint_x_nm > 0.0) || !(footprint_z_nm > 0.0) {
        return Err(format!(
            "MRMS volume texture needs positive grid footprints, got {footprint_base_x_nm} x {footprint_base_y_nm} NM"
        ));
    }
    if max_bricks == 0 {
        return Err("MRMS volume texture needs a positive brick budget".to_string());
    }

    let count = prepared.declutter_count;
    if count == 0 {
        return Ok(None);
    }

    // --- Bounds over the selected bricks ---
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_z = f64::INFINITY;
    let mut max_z = f64::NEG_INFINITY;
    let mut base_feet = f64::INFINITY;
    let mut top_feet = f64::NEG_INFINITY;
    let mut max_abs_x_nm = 0.0_f32;
    let mut max_abs_z_nm = 0.0_f32;
    let mut max_corrected_top_feet = 0.0_f32;

    for i in 0..count {
        let valid_index = prepared.declutter_indices[i] as usize;
        let payload_index = prepared.valid_indices[valid_index] as usize;
        let x = f64::from(volume.x_nm(payload_index));
        let z = f64::from(volume.z_nm(payload_index));
        let half_sx =
            footprint_x_nm * f64::from(volume.footprint_x_span(payload_index).max(1)) * 0.5;
        let half_sz =
            footprint_z_nm * f64::from(volume.footprint_y_span(payload_index).max(1)) * 0.5;
        min_x = min_x.min(x - half_sx);
        max_x = max_x.max(x + half_sx);
        min_z = min_z.min(z - half_sz);
        max_z = max_z.max(z + half_sz);
        let bottom = f64::from(prepared.corrected_bottom_feet[valid_index]);
        let top = f64::from(prepared.corrected_top_feet[valid_index]);
        base_feet = base_feet.min(bottom);
        top_feet = top_feet.max(top);
        max_abs_x_nm = max_abs_x_nm.max(volume.x_nm(payload_index).abs());
        max_abs_z_nm = max_abs_z_nm.max(volume.z_nm(payload_index).abs());
        max_corrected_top_feet =
            max_corrected_top_feet.max(prepared.corrected_top_feet[valid_index]);
    }

    if !min_x.is_finite() || !min_z.is_finite() || !base_feet.is_finite() || !top_feet.is_finite() {
        return Ok(None);
    }

    let source_cols = (max_x - min_x) / footprint_x_nm;
    let source_rows = (max_z - min_z) / footprint_z_nm;
    if source_cols > MAX_TEXTURE_SOURCE_AXIS_CELLS || source_rows > MAX_TEXTURE_SOURCE_AXIS_CELLS {
        return Err(format!(
            "MRMS volume texture source grid {source_cols:.0} x {source_rows:.0} exceeds the {MAX_TEXTURE_SOURCE_AXIS_CELLS}-cell axis limit"
        ));
    }

    let span_feet = (top_feet - base_feet).max(1.0);
    let depth = ((span_feet / TARGET_ALTITUDE_BIN_FEET).ceil() as usize)
        .clamp(1, MAX_TEXTURE_ALTITUDE_BINS);
    let bin_feet = span_feet / depth as f64;

    // Coarsen by an integer footprint multiple so texture cells stay aligned
    // with whole source-grid cells: first to respect the page-table axis cap,
    // then, if the selection needs more resident bricks than the budget
    // allows, by successive whole multiples until it fits. Each attempt
    // counts the pages the selection touches before anything is allocated.
    let base_coarsen_x = (source_cols / MAX_TEXTURE_AXIS_CELLS as f64)
        .ceil()
        .max(1.0) as usize;
    let base_coarsen_z = (source_rows / MAX_TEXTURE_AXIS_CELLS as f64)
        .ceil()
        .max(1.0) as usize;
    let mut budget_multiple = 1_usize;
    let (frame, coarsen_x, coarsen_z, page_table, brick_count) = loop {
        let coarsen_x = base_coarsen_x * budget_multiple;
        let coarsen_z = base_coarsen_z * budget_multiple;
        let cell_x_nm = footprint_x_nm * coarsen_x as f64;
        let cell_z_nm = footprint_z_nm * coarsen_z as f64;
        let width = ((max_x - min_x) / cell_x_nm - 1e-6).ceil().max(1.0) as usize;
        let height = ((max_z - min_z) / cell_z_nm - 1e-6).ceil().max(1.0) as usize;
        if width > MAX_TEXTURE_AXIS_CELLS + 1 || height > MAX_TEXTURE_AXIS_CELLS + 1 {
            return Err(format!(
                "MRMS volume texture grid {width} x {height} escaped the {MAX_TEXTURE_AXIS_CELLS}-cell cap"
            ));
        }
        let frame = RasterFrame {
            width,
            height,
            depth,
            min_x,
            min_z,
            cell_x_nm,
            cell_z_nm,
            base_feet,
            bin_feet,
        };

        // Occupancy pass: which pages hold at least one core texel.
        let (pw, ph, pd) = frame.page_dims();
        let mut occupied = vec![false; pw * ph * pd];
        let mut brick_count = 0_usize;
        let b = VOLUME_BRICK_TEXELS;
        for i in 0..count {
            let ranges = frame.ranges(volume, prepared, footprint_x_nm, footprint_z_nm, i);
            for page_bin in ranges.bins.0 / b..ranges.bins.1.div_ceil(b) {
                for page_row in ranges.rows.0 / b..ranges.rows.1.div_ceil(b) {
                    for page_col in ranges.cols.0 / b..ranges.cols.1.div_ceil(b) {
                        let page = (page_bin * ph + page_row) * pw + page_col;
                        if !occupied[page] {
                            occupied[page] = true;
                            brick_count += 1;
                        }
                    }
                }
            }
        }

        if brick_count <= max_bricks {
            // Assign pool slots in page order and encode `slot + 1`.
            let mut page_table = vec![0_u8; pw * ph * pd * 2];
            let mut next_slot = 0_usize;
            for (page, is_occupied) in occupied.iter().enumerate() {
                if *is_occupied {
                    let entry = next_slot + 1;
                    page_table[page * 2] = (entry & 0xff) as u8;
                    page_table[page * 2 + 1] = (entry >> 8) as u8;
                    next_slot += 1;
                }
            }
            break (frame, coarsen_x, coarsen_z, page_table, brick_count);
        }
        if width <= b && height <= b {
            // One brick column cannot coarsen further; the altitude axis
            // alone exceeds the budget, which no budget in use permits.
            return Err(format!(
                "MRMS volume texture needs {brick_count} bricks for a single column, over the {max_bricks}-brick budget"
            ));
        }
        budget_multiple += 1;
    };

    let (pw, ph, pd) = frame.page_dims();
    let RasterFrame { width, height, .. } = frame;
    let b = VOLUME_BRICK_TEXELS;
    let s = VOLUME_BRICK_STORED_TEXELS;

    let pool_bricks_x = brick_count.min(POOL_BRICKS_PER_AXIS);
    let pool_bricks_y = brick_count
        .div_ceil(POOL_BRICKS_PER_AXIS)
        .min(POOL_BRICKS_PER_AXIS);
    let pool_bricks_z = brick_count.div_ceil(POOL_BRICKS_PER_AXIS * POOL_BRICKS_PER_AXIS);

    let mut texture = MrmsVolumeTexture {
        width: width as u32,
        height: height as u32,
        depth: depth as u32,
        origin_x_nm: min_x as f32,
        origin_z_nm: min_z as f32,
        cell_size_x_nm: frame.cell_x_nm as f32,
        cell_size_z_nm: frame.cell_z_nm as f32,
        base_feet: base_feet as f32,
        bin_size_feet: bin_feet as f32,
        coarsen_x: coarsen_x as u32,
        coarsen_z: coarsen_z as u32,
        page_width: pw as u32,
        page_height: ph as u32,
        page_depth: pd as u32,
        page_table,
        brick_count: brick_count as u32,
        pool_bricks_x: pool_bricks_x as u32,
        pool_bricks_y: pool_bricks_y as u32,
        pool_bricks_z: pool_bricks_z as u32,
        pool: vec![0_u8; pool_bricks_x * pool_bricks_y * pool_bricks_z * s * s * s * 2],
        filled_texel_count: 0,
        max_abs_x_nm,
        max_abs_z_nm,
        max_corrected_top_feet,
    };

    // Page lookup by page coordinates: `Some(slot)` when resident.
    let page_slot = |page_col: usize, page_row: usize, page_bin: usize| -> Option<usize> {
        let index = ((page_bin * ph + page_row) * pw + page_col) * 2;
        let entry = usize::from(texture.page_table[index])
            | (usize::from(texture.page_table[index + 1]) << 8);
        (entry != 0).then(|| entry - 1)
    };
    // Byte offset of each slot's stored-region origin, and of a stored texel
    // within a region, so the hot loops below index the pool with adds only.
    let pool_w = pool_bricks_x * s;
    let pool_h = pool_bricks_y * s;
    let slot_base: Vec<usize> = (0..brick_count)
        .map(|slot| texture.pool_index(slot, 0, 0, 0))
        .collect();
    let stored_offset = |sx: usize, sy: usize, sz: usize| ((sz * pool_h + sy) * pool_w + sx) * 2;

    // Rasterize: every logical texel a brick covers is written to its own
    // page's core and to the apron of each neighboring resident page whose
    // stored region also contains it (a texel on a page face belongs to up
    // to eight stored regions). All copies see the same strongest-wins
    // sequence, so they end identical.
    let mut filled_texel_count: u32 = 0;
    for i in 0..count {
        let ranges = frame.ranges(volume, prepared, footprint_x_nm, footprint_z_nm, i);
        let valid_index = prepared.declutter_indices[i] as usize;
        let payload_index = prepared.valid_indices[valid_index] as usize;
        let dbz_byte = ((f64::from(volume.dbz_tenths(payload_index)) / 10.0).round() as i64)
            .clamp(1, 255) as u8;
        let phase = prepared.effective_phase_code[valid_index];

        for bin in ranges.bins.0..ranges.bins.1 {
            let bin_offsets = neighbor_page_offsets(bin, pd);
            for row in ranges.rows.0..ranges.rows.1 {
                let row_offsets = neighbor_page_offsets(row, ph);
                for col in ranges.cols.0..ranges.cols.1 {
                    let col_offsets = neighbor_page_offsets(col, pw);
                    for &d_bin in bin_offsets.iter().flatten() {
                        for &d_row in row_offsets.iter().flatten() {
                            for &d_col in col_offsets.iter().flatten() {
                                let page_col = (col / b) as isize + d_col;
                                let page_row = (row / b) as isize + d_row;
                                let page_bin = (bin / b) as isize + d_bin;
                                let Some(slot) = page_slot(
                                    page_col as usize,
                                    page_row as usize,
                                    page_bin as usize,
                                ) else {
                                    continue;
                                };
                                let sx = (col as isize - page_col * b as isize + 1) as usize;
                                let sy = (row as isize - page_row * b as isize + 1) as usize;
                                let sz = (bin as isize - page_bin * b as isize + 1) as usize;
                                let t = slot_base[slot] + stored_offset(sx, sy, sz);
                                let is_core = d_col == 0 && d_row == 0 && d_bin == 0;
                                if texture.pool[t] == 0 {
                                    if is_core {
                                        filled_texel_count += 1;
                                    }
                                } else if texture.pool[t] >= dbz_byte {
                                    continue;
                                }
                                texture.pool[t] = dbz_byte;
                                texture.pool[t + 1] = phase;
                            }
                        }
                    }
                }
            }
        }
    }
    texture.filled_texel_count = filled_texel_count;

    let in_grid = |col: isize, row: isize, bin: isize| -> bool {
        (0..width as isize).contains(&col)
            && (0..height as isize).contains(&row)
            && (0..depth as isize).contains(&bin)
    };

    // Bleed phase codes into empty texels bordering filled ones so trilinear
    // filtering interpolates toward the neighbor's phase instead of toward
    // rain (`phase == 0`), which would tint snow-echo edges. Every stored
    // copy of a logical texel (core and aprons) is visited. A neighbor inside
    // the same stored region is read there (all copies agree on `R`, and on
    // the `G` of filled texels, which this pass never writes); a neighbor
    // past the region edge is read from its own page's core, so an
    // unresident page reads as empty. Safe in place: only `R` is read.
    const NEIGHBOR_STEPS: [(isize, isize, isize); 6] = [
        (-1, 0, 0),
        (1, 0, 0),
        (0, -1, 0),
        (0, 1, 0),
        (0, 0, -1),
        (0, 0, 1),
    ];
    for page_bin in 0..pd {
        for page_row in 0..ph {
            for page_col in 0..pw {
                let Some(slot) = page_slot(page_col, page_row, page_bin) else {
                    continue;
                };
                let base = slot_base[slot];
                let origin_col = (page_col * b) as isize - 1;
                let origin_row = (page_row * b) as isize - 1;
                let origin_bin = (page_bin * b) as isize - 1;
                for sz in 0..s {
                    for sy in 0..s {
                        for sx in 0..s {
                            let t = base + stored_offset(sx, sy, sz);
                            if texture.pool[t] != 0 {
                                continue;
                            }
                            let col = origin_col + sx as isize;
                            let row = origin_row + sy as isize;
                            let bin = origin_bin + sz as isize;
                            if !in_grid(col, row, bin) {
                                continue; // Filled by the clamp pass below.
                            }
                            for (d_col, d_row, d_bin) in NEIGHBOR_STEPS {
                                let nx = sx as isize + d_col;
                                let ny = sy as isize + d_row;
                                let nz = sz as isize + d_bin;
                                let stored_span = 0..s as isize;
                                let (n_r, n_g) = if stored_span.contains(&nx)
                                    && stored_span.contains(&ny)
                                    && stored_span.contains(&nz)
                                {
                                    let n =
                                        base + stored_offset(nx as usize, ny as usize, nz as usize);
                                    (texture.pool[n], texture.pool[n + 1])
                                } else if in_grid(col + d_col, row + d_row, bin + d_bin) {
                                    texture.texel(
                                        (col + d_col) as usize,
                                        (row + d_row) as usize,
                                        (bin + d_bin) as usize,
                                    )
                                } else {
                                    (0, 0)
                                };
                                if n_r != 0 {
                                    texture.pool[t + 1] = n_g;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Apron texels that fall outside the logical grid take the value of the
    // nearest in-grid texel (after bleed), reproducing clamp-to-edge sampling
    // at the box boundary.
    for page_bin in 0..pd {
        for page_row in 0..ph {
            for page_col in 0..pw {
                let Some(slot) = page_slot(page_col, page_row, page_bin) else {
                    continue;
                };
                let base = slot_base[slot];
                let origin_col = (page_col * b) as isize - 1;
                let origin_row = (page_row * b) as isize - 1;
                let origin_bin = (page_bin * b) as isize - 1;
                for sz in 0..s {
                    for sy in 0..s {
                        for sx in 0..s {
                            let col = origin_col + sx as isize;
                            let row = origin_row + sy as isize;
                            let bin = origin_bin + sz as isize;
                            if in_grid(col, row, bin) {
                                continue;
                            }
                            let clamped = texture.texel(
                                col.clamp(0, width as isize - 1) as usize,
                                row.clamp(0, height as isize - 1) as usize,
                                bin.clamp(0, depth as isize - 1) as usize,
                            );
                            let t = base + stored_offset(sx, sy, sz);
                            texture.pool[t] = clamped.0;
                            texture.pool[t + 1] = clamped.1;
                        }
                    }
                }
            }
        }
    }

    Ok(Some(texture))
}

/// Page offsets (`-1`, `0`, `+1`) along one axis whose stored region contains
/// logical texel `index`: its own page always, the previous page when the
/// texel is on the page's low face, the next when on its high face and that
/// page exists.
fn neighbor_page_offsets(index: usize, page_count: usize) -> [Option<isize>; 3] {
    let b = VOLUME_BRICK_TEXELS;
    let local = index % b;
    let page = index / b;
    [
        (local == 0 && page > 0).then_some(-1),
        Some(0),
        (local == b - 1 && page + 1 < page_count).then_some(1),
    ]
}

/// Sentinel for a composite raster cell with no echo at or above the
/// threshold. Renderers treat it as fully transparent.
pub const COMPOSITE_EMPTY_DBZ_TENTHS: i16 = i16::MIN;

/// Ceiling on either composite raster axis. A 120 NM request over the ~0.01°
/// MRMS grid lands near 530 x 400 cells, so anything past this means the
/// grid-index reconstruction below broke — not that the storm got big.
const MAX_COMPOSITE_AXIS_CELLS: usize = 4096;

/// Which vertical reduction the ground mosaic applies to each column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MosaicProduct {
    /// Column maximum over every level — standard composite reflectivity.
    /// Shows the strongest echo anywhere in the column, including aloft.
    Composite,
    /// Lowest-altitude echo in each column — the analogue of base
    /// reflectivity, and closer to what actually reaches the surface.
    ///
    /// MRMS levels are altitude-based (0.50 km MSL and up), so in high terrain
    /// the lowest levels are underground and simply absent. This takes the
    /// lowest level that *has* data rather than a fixed level index, which is
    /// what a hybrid-scan base product does.
    Base,
}

/// Ground-level reflectivity raster reduced from the 3D volume, on the source
/// grid, for draping under the 3D volume.
///
/// The raster is row-major with `x` (east) varying fastest. Cell `(col, row)`
/// spans `origin_x_nm + col * cell_size_x_nm` to the next cell edge, and the
/// same in `z` (south) for `row` — so row 0 is the `-z` edge, matching a
/// texture whose first data row sits at the near edge of a `+X`-rotated plane.
#[derive(Debug, Clone, PartialEq)]
pub struct MrmsCompositeSurface {
    pub width: u32,
    pub height: u32,
    /// Local-frame NM position of the outer edge of cell `(0, 0)`.
    pub origin_x_nm: f32,
    pub origin_z_nm: f32,
    pub cell_size_x_nm: f32,
    pub cell_size_z_nm: f32,
    /// Reduced dBZ tenths per cell, or [`COMPOSITE_EMPTY_DBZ_TENTHS`].
    pub dbz_tenths: Vec<i16>,
    /// Phase of the voxel that won each cell; rain in empty cells (never
    /// sampled, because alpha is zero there).
    pub phase_code: Vec<u8>,
    pub filled_cell_count: u32,
    pub max_dbz_tenths: i16,
}

/// Grid-cell footprint of one brick, as `[col_start, col_end)` /
/// `[row_start, row_end)` in fractional source-grid index units.
///
/// The runtime projects a regular lat/lon grid through constant per-degree
/// scales, so `x_nm` is exactly linear in column with slope `footprint_x_nm`
/// (`z_nm` likewise in row). That makes `x_nm / footprint_x_nm` a grid index
/// up to an unknown constant offset, which cancels once every brick is
/// measured against the same minimum.
fn brick_cell_span(
    volume: &impl VolumeSource,
    i: usize,
    footprint_x_nm: f64,
    footprint_y_nm: f64,
) -> (f64, f64, f64, f64) {
    let span_x = f64::from(volume.footprint_x_span(i).max(1));
    let span_y = f64::from(volume.footprint_y_span(i).max(1));
    let col_start = f64::from(volume.x_nm(i)) / footprint_x_nm - span_x * 0.5;
    let row_start = f64::from(volume.z_nm(i)) / footprint_y_nm - span_y * 0.5;
    (col_start, col_start + span_x, row_start, row_start + span_y)
}

/// Build the ground reflectivity raster by reducing each column of the
/// decoded volume with `product`.
///
/// Independent of declutter selection on purpose: declutter hides altitude
/// bands in the 3D volume, while the surface mosaic is a plan view of the
/// whole column. Returns `Ok(None)` when no voxel reaches `min_dbz_tenths`.
///
/// The raster footprint does not depend on `product`: a column with any
/// qualifying echo has both a composite and a base value.
pub fn build_composite_surface(
    volume: &impl VolumeSource,
    footprint_base_x_nm: f32,
    footprint_base_y_nm: f32,
    min_dbz_tenths: i16,
    phase_mode: PhaseMode,
    product: MosaicProduct,
) -> Result<Option<MrmsCompositeSurface>, String> {
    let footprint_x_nm = f64::from(footprint_base_x_nm);
    let footprint_y_nm = f64::from(footprint_base_y_nm);
    if !(footprint_x_nm > 0.0) || !(footprint_y_nm > 0.0) {
        return Err(format!(
            "MRMS composite surface needs positive grid footprints, got {footprint_base_x_nm} x {footprint_base_y_nm} NM"
        ));
    }

    let voxel_count = volume.voxel_count();
    let mut min_col = f64::INFINITY;
    let mut max_col = f64::NEG_INFINITY;
    let mut min_row = f64::INFINITY;
    let mut max_row = f64::NEG_INFINITY;

    for i in 0..voxel_count {
        if volume.dbz_tenths(i) < min_dbz_tenths {
            continue;
        }
        let (col_start, col_end, row_start, row_end) =
            brick_cell_span(volume, i, footprint_x_nm, footprint_y_nm);
        min_col = min_col.min(col_start);
        max_col = max_col.max(col_end);
        min_row = min_row.min(row_start);
        max_row = max_row.max(row_end);
    }

    if !min_col.is_finite() || !min_row.is_finite() {
        return Ok(None);
    }

    let width = (max_col - min_col).round() as i64;
    let height = (max_row - min_row).round() as i64;
    if width <= 0 || height <= 0 {
        return Ok(None);
    }
    if width > MAX_COMPOSITE_AXIS_CELLS as i64 || height > MAX_COMPOSITE_AXIS_CELLS as i64 {
        return Err(format!(
            "MRMS composite surface grid {width} x {height} exceeds the {MAX_COMPOSITE_AXIS_CELLS}-cell axis limit"
        ));
    }
    let width = width as usize;
    let height = height as usize;

    let cell_count = width * height;
    let mut dbz_tenths = vec![COMPOSITE_EMPTY_DBZ_TENTHS; cell_count];
    let mut phase_code = vec![PHASE_RAIN; cell_count];
    // Base mode needs the altitude that currently owns each cell; composite
    // mode compares on dBZ alone and never allocates this.
    let mut selected_bottom_feet: Vec<u16> = match product {
        MosaicProduct::Base => vec![u16::MAX; cell_count],
        MosaicProduct::Composite => Vec::new(),
    };
    let mut filled_cell_count: u32 = 0;

    for i in 0..voxel_count {
        let voxel_dbz = volume.dbz_tenths(i);
        if voxel_dbz < min_dbz_tenths {
            continue;
        }
        let (col_start, _, row_start, _) =
            brick_cell_span(volume, i, footprint_x_nm, footprint_y_nm);
        let col0 = (col_start - min_col).round() as i64;
        let row0 = (row_start - min_row).round() as i64;
        let span_x = i64::from(volume.footprint_x_span(i).max(1));
        let span_y = i64::from(volume.footprint_y_span(i).max(1));
        let voxel_phase = match phase_mode {
            PhaseMode::Surface => volume.surface_phase(i),
            PhaseMode::Altitude => volume.phase(i),
        };
        let voxel_bottom = volume.bottom_feet(i);

        for row in row0.max(0)..(row0 + span_y).min(height as i64) {
            let row_offset = row as usize * width;
            for col in col0.max(0)..(col0 + span_x).min(width as i64) {
                let cell = row_offset + col as usize;
                if dbz_tenths[cell] == COMPOSITE_EMPTY_DBZ_TENTHS {
                    filled_cell_count += 1;
                } else {
                    let keep_existing = match product {
                        MosaicProduct::Composite => dbz_tenths[cell] >= voxel_dbz,
                        MosaicProduct::Base => {
                            let owner_bottom = selected_bottom_feet[cell];
                            voxel_bottom > owner_bottom
                                // Same level: fall back to the stronger return.
                                || (voxel_bottom == owner_bottom && dbz_tenths[cell] >= voxel_dbz)
                        }
                    };
                    if keep_existing {
                        continue;
                    }
                }
                dbz_tenths[cell] = voxel_dbz;
                phase_code[cell] = voxel_phase;
                if product == MosaicProduct::Base {
                    selected_bottom_feet[cell] = voxel_bottom;
                }
            }
        }
    }

    // Taken over the finished raster rather than over qualifying voxels, so it
    // reports what the mosaic actually shows — base mode discards stronger
    // echoes aloft.
    let max_dbz_tenths = dbz_tenths
        .iter()
        .copied()
        .filter(|value| *value != COMPOSITE_EMPTY_DBZ_TENTHS)
        .max()
        .unwrap_or(COMPOSITE_EMPTY_DBZ_TENTHS);

    Ok(Some(MrmsCompositeSurface {
        width: width as u32,
        height: height as u32,
        origin_x_nm: (min_col * footprint_x_nm) as f32,
        origin_z_nm: (min_row * footprint_y_nm) as f32,
        cell_size_x_nm: footprint_base_x_nm,
        cell_size_z_nm: footprint_base_y_nm,
        dbz_tenths,
        phase_code,
        filled_cell_count,
        max_dbz_tenths,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrms_preprocess::TestVolume;
    use crate::mrms_preprocess::prepare_volume;
    use crate::types::{
        ALTITUDE_SCALE, DeclutterMode, PHASE_MIXED, PHASE_RAIN, PHASE_SNOW, PhaseMode,
    };

    fn test_volume() -> TestVolume {
        TestVolume {
            x_nm: vec![1.0, -2.0, 3.0],
            z_nm: vec![4.0, 5.0, -6.0],
            bottom_feet: vec![1_000, 2_000, 30_000],
            top_feet: vec![3_000, 4_000, 34_000],
            dbz_tenths: vec![150, 50, 455],
            phase: vec![PHASE_RAIN, PHASE_MIXED, PHASE_SNOW],
            surface_phase: vec![PHASE_SNOW, PHASE_RAIN, PHASE_MIXED],
            footprint_x_span: vec![1, 2, 3],
            footprint_y_span: vec![1, 4, 1],
        }
    }

    #[test]
    fn joins_declutter_and_valid_indices_to_payload_columns() {
        let volume = test_volume();
        // min 10 dBZ drops the middle voxel, so valid voxels map to payload
        // indices [0, 2] and the index spaces genuinely diverge.
        let prepared = prepare_volume(
            &volume,
            100,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        assert_eq!(prepared.valid_count, 2);
        assert_eq!(prepared.valid_indices, vec![0, 2]);

        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        assert_eq!(data.center_x_nm, vec![1.0, 3.0]);
        assert_eq!(data.center_z_nm, vec![4.0, -6.0]);
        // Voxel 1 (payload index 2): center 32k ft, height 4k ft.
        let expected_y = (32_000.0 * ALTITUDE_SCALE) as f32;
        let expected_h = (4_000.0 * ALTITUDE_SCALE) as f32;
        assert!((data.center_y_nm[1] - expected_y).abs() < 1e-5);
        assert!((data.size_y_nm[1] - expected_h).abs() < 1e-5);
        // Footprint spans multiply the scalar base footprint.
        assert!((data.size_x_nm[0] - 0.5).abs() < 1e-6);
        assert!((data.size_z_nm[0] - 0.6).abs() < 1e-6);
        assert!((data.size_x_nm[1] - 1.5).abs() < 1e-6);
        assert!((data.size_z_nm[1] - 0.6).abs() < 1e-6);
        assert_eq!(data.dbz, vec![15.0, 45.5]);
        assert_eq!(data.phase_code, vec![PHASE_RAIN, PHASE_SNOW]);
        // Guide summary covers the rendered set: |x| max 3, |z| max 6,
        // top max 34k ft (no curvature correction applied).
        assert!((data.max_abs_x_nm - 3.0).abs() < 1e-6);
        assert!((data.max_abs_z_nm - 6.0).abs() < 1e-6);
        assert!((data.max_corrected_top_feet - 34_000.0).abs() < 1e-3);
    }

    #[test]
    fn surface_phase_mode_selects_surface_column() {
        let volume = test_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Surface,
            DeclutterMode::All,
            false,
            40.0,
        );
        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        assert_eq!(data.phase_code, vec![PHASE_SNOW, PHASE_RAIN, PHASE_MIXED]);
    }

    #[test]
    fn declutter_low_renders_only_low_voxels() {
        let volume = test_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::Low,
            false,
            40.0,
        );
        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        // The 30k-34k ft voxel is excluded by the low band.
        assert_eq!(data.center_x_nm, vec![1.0, -2.0]);
        assert_eq!(data.phase_code, vec![PHASE_RAIN, PHASE_MIXED]);
    }

    /// Grid-aligned bricks over a 3-column x 2-row patch of the source grid
    /// (footprint 0.5 x 0.6 NM). Brick positions are the projected centers the
    /// runtime encodes, so this exercises the real index reconstruction.
    ///
    /// | brick | cols | rows | dBZ  | phase | surface phase |
    /// |-------|------|------|------|-------|---------------|
    /// | A     | 0    | 0    | 20.0 | rain  | mixed         |
    /// | B     | 1-2  | 0    | 35.0 | snow  | rain          |
    /// | C     | 0-2  | 1    | 10.0 | mixed | rain          |
    /// | D     | 0    | 0    | 40.0 | snow  | mixed         |
    ///
    /// D sits above A in the same column, so the column max at cell (0, 0)
    /// must come from D.
    fn composite_volume() -> TestVolume {
        TestVolume {
            x_nm: vec![0.0, 0.75, 0.5, 0.0],
            z_nm: vec![0.0, 0.0, 0.6, 0.0],
            bottom_feet: vec![1_000, 1_000, 1_000, 9_000],
            top_feet: vec![3_000, 3_000, 3_000, 11_000],
            dbz_tenths: vec![200, 350, 100, 400],
            phase: vec![PHASE_RAIN, PHASE_SNOW, PHASE_MIXED, PHASE_SNOW],
            surface_phase: vec![PHASE_MIXED, PHASE_RAIN, PHASE_RAIN, PHASE_MIXED],
            footprint_x_span: vec![1, 2, 3, 1],
            footprint_y_span: vec![1, 1, 1, 1],
        }
    }

    #[test]
    fn composite_takes_column_max_over_the_reconstructed_grid() {
        let volume = composite_volume();
        let surface = build_composite_surface(
            &volume,
            0.5,
            0.6,
            50,
            PhaseMode::Altitude,
            MosaicProduct::Composite,
        )
        .expect("composite build should succeed")
        .expect("composite should be present");

        assert_eq!((surface.width, surface.height), (3, 2));
        // Cell (0,0) resolves to D (40 dBZ) rather than A (20 dBZ) beneath it.
        assert_eq!(surface.dbz_tenths, vec![400, 350, 350, 100, 100, 100]);
        assert_eq!(
            surface.phase_code,
            vec![
                PHASE_SNOW,
                PHASE_SNOW,
                PHASE_SNOW,
                PHASE_MIXED,
                PHASE_MIXED,
                PHASE_MIXED
            ]
        );
        assert_eq!(surface.filled_cell_count, 6);
        assert_eq!(surface.max_dbz_tenths, 400);
        // Origin is the outer edge of cell (0,0), a half cell out from the
        // first brick center.
        assert!((surface.origin_x_nm - -0.25).abs() < 1e-6);
        assert!((surface.origin_z_nm - -0.3).abs() < 1e-6);
        assert!((surface.cell_size_x_nm - 0.5).abs() < 1e-6);
        assert!((surface.cell_size_z_nm - 0.6).abs() < 1e-6);
    }

    #[test]
    fn composite_threshold_shrinks_the_raster_to_qualifying_cells() {
        let volume = composite_volume();
        // 15 dBZ drops brick C, which is the only occupant of row 1.
        let surface = build_composite_surface(
            &volume,
            0.5,
            0.6,
            150,
            PhaseMode::Altitude,
            MosaicProduct::Composite,
        )
        .expect("composite build should succeed")
        .expect("composite should be present");

        assert_eq!((surface.width, surface.height), (3, 1));
        assert_eq!(surface.dbz_tenths, vec![400, 350, 350]);
        assert_eq!(surface.filled_cell_count, 3);
    }

    #[test]
    fn composite_surface_phase_mode_uses_the_surface_column() {
        let volume = composite_volume();
        let surface = build_composite_surface(
            &volume,
            0.5,
            0.6,
            50,
            PhaseMode::Surface,
            MosaicProduct::Composite,
        )
        .expect("composite build should succeed")
        .expect("composite should be present");

        assert_eq!(
            surface.phase_code,
            vec![
                PHASE_MIXED,
                PHASE_RAIN,
                PHASE_RAIN,
                PHASE_RAIN,
                PHASE_RAIN,
                PHASE_RAIN
            ]
        );
    }

    #[test]
    fn base_product_takes_the_lowest_echo_in_each_column() {
        let volume = composite_volume();
        let surface = build_composite_surface(
            &volume,
            0.5,
            0.6,
            50,
            PhaseMode::Altitude,
            MosaicProduct::Base,
        )
        .expect("base build should succeed")
        .expect("base raster should be present");

        // Cell (0,0) has A at 1-3 kft (20 dBZ rain) under D at 9-11 kft
        // (40 dBZ snow). Base takes the low one; composite took D.
        assert_eq!(surface.dbz_tenths, vec![200, 350, 350, 100, 100, 100]);
        assert_eq!(
            surface.phase_code,
            vec![
                PHASE_RAIN,
                PHASE_SNOW,
                PHASE_SNOW,
                PHASE_MIXED,
                PHASE_MIXED,
                PHASE_MIXED
            ]
        );
        // The raster footprint is product-independent.
        assert_eq!((surface.width, surface.height), (3, 2));
        assert_eq!(surface.filled_cell_count, 6);
        // Reported max reflects what is drawn, not the 40 dBZ echo aloft.
        assert_eq!(surface.max_dbz_tenths, 350);
    }

    #[test]
    fn base_and_composite_agree_where_a_column_has_one_level() {
        let volume = composite_volume();
        let composite = build_composite_surface(
            &volume,
            0.5,
            0.6,
            50,
            PhaseMode::Altitude,
            MosaicProduct::Composite,
        )
        .expect("composite build should succeed")
        .expect("composite raster should be present");
        let base = build_composite_surface(
            &volume,
            0.5,
            0.6,
            50,
            PhaseMode::Altitude,
            MosaicProduct::Base,
        )
        .expect("base build should succeed")
        .expect("base raster should be present");

        // Only cell (0,0) is stacked, so every other cell must match exactly.
        assert_eq!(composite.dbz_tenths[1..], base.dbz_tenths[1..]);
        assert_eq!(composite.phase_code[1..], base.phase_code[1..]);
        assert_ne!(composite.dbz_tenths[0], base.dbz_tenths[0]);
        // Same geometry either way, so the drape mesh is unaffected.
        assert_eq!(
            (composite.width, composite.height, composite.origin_x_nm),
            (base.width, base.height, base.origin_x_nm)
        );
    }

    #[test]
    fn composite_is_absent_when_nothing_reaches_the_threshold() {
        let volume = composite_volume();
        let surface = build_composite_surface(
            &volume,
            0.5,
            0.6,
            1_000,
            PhaseMode::Altitude,
            MosaicProduct::Composite,
        )
        .expect("composite build should succeed");
        assert!(surface.is_none());
    }

    #[test]
    fn composite_rejects_a_non_positive_footprint() {
        let volume = composite_volume();
        let error = build_composite_surface(
            &volume,
            0.0,
            0.6,
            50,
            PhaseMode::Altitude,
            MosaicProduct::Composite,
        )
        .expect_err("a zero footprint must fail loudly");
        assert!(error.contains("positive grid footprints"), "{error}");
    }

    fn texel_at(texture: &MrmsVolumeTexture, col: usize, row: usize, bin: usize) -> (u8, u8) {
        texture.texel(col, row, bin)
    }

    /// Stored `(R, G)` at apron/core position `(sx, sy, sz)` of the brick
    /// resident for the page holding logical texel `(col, row, bin)`.
    fn stored_at(
        texture: &MrmsVolumeTexture,
        col: usize,
        row: usize,
        bin: usize,
        sx: usize,
        sy: usize,
        sz: usize,
    ) -> (u8, u8) {
        let b = VOLUME_BRICK_TEXELS;
        let page = ((bin / b) * texture.page_height as usize + row / b)
            * texture.page_width as usize
            + col / b;
        let entry = usize::from(texture.page_table[page * 2])
            | (usize::from(texture.page_table[page * 2 + 1]) << 8);
        assert!(
            entry != 0,
            "page for ({col}, {row}, {bin}) must be resident"
        );
        let t = texture.pool_index(entry - 1, sx, sy, sz);
        (texture.pool[t], texture.pool[t + 1])
    }

    #[test]
    fn volume_texture_rasterizes_bricks_into_grid_cells_and_bins() {
        let volume = composite_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        // 3 source columns x 2 rows, altitude span 1k-11k ft.
        assert_eq!((texture.width, texture.height), (3, 2));
        assert!((texture.origin_x_nm - -0.25).abs() < 1e-6);
        assert!((texture.origin_z_nm - -0.3).abs() < 1e-6);
        assert!((texture.cell_size_x_nm - 0.5).abs() < 1e-6);
        assert!((texture.cell_size_z_nm - 0.6).abs() < 1e-6);
        assert!((texture.base_feet - 1_000.0).abs() < 1e-3);
        assert_eq!(texture.depth, 20);
        assert!((texture.bin_size_feet - 500.0).abs() < 1e-3);

        // Brick A (20 dBZ rain, 1k-3k ft) fills cell (0,0) bins 0-3.
        assert_eq!(texel_at(&texture, 0, 0, 0), (20, PHASE_RAIN));
        assert_eq!(texel_at(&texture, 0, 0, 3), (20, PHASE_RAIN));
        // Brick D (40 dBZ snow, 9k-11k ft) sits above it: bins 16-19.
        assert_eq!(texel_at(&texture, 0, 0, 16), (40, PHASE_SNOW));
        assert_eq!(texel_at(&texture, 0, 0, 19), (40, PHASE_SNOW));
        // Between them the column is empty.
        assert_eq!(texel_at(&texture, 0, 0, 8).0, 0);
        // Brick B (35 dBZ snow) covers cells (1,0) and (2,0) at bins 0-3.
        assert_eq!(texel_at(&texture, 1, 0, 0), (35, PHASE_SNOW));
        assert_eq!(texel_at(&texture, 2, 0, 3), (35, PHASE_SNOW));
        // Brick C (10 dBZ mixed) covers the full second row.
        assert_eq!(texel_at(&texture, 0, 1, 0), (10, PHASE_MIXED));
        assert_eq!(texel_at(&texture, 2, 1, 3), (10, PHASE_MIXED));
        // Row 1 has no echo above 3k ft.
        assert_eq!(texel_at(&texture, 0, 1, 16).0, 0);

        // A(4 bins) + D(4) + B(2 cells x 4) + C(3 cells x 4) = 28 filled.
        assert_eq!(texture.filled_texel_count, 28);
        assert!((texture.max_corrected_top_feet - 11_000.0).abs() < 1e-3);
        assert!((texture.max_abs_x_nm - 0.75).abs() < 1e-6);
        assert!((texture.max_abs_z_nm - 0.6).abs() < 1e-6);
    }

    #[test]
    fn volume_texture_overlaps_resolve_to_the_strongest_return() {
        // Two bricks over the same cell and altitude range.
        let volume = TestVolume {
            x_nm: vec![0.0, 0.0],
            z_nm: vec![0.0, 0.0],
            bottom_feet: vec![1_000, 1_000],
            top_feet: vec![2_000, 2_000],
            dbz_tenths: vec![250, 415],
            phase: vec![PHASE_RAIN, PHASE_SNOW],
            surface_phase: vec![PHASE_RAIN, PHASE_SNOW],
            footprint_x_span: vec![1, 1],
            footprint_y_span: vec![1, 1],
        };
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        assert_eq!((texture.width, texture.height), (1, 1));
        // 41.5 dBZ rounds to 42 and wins over 25; the winner's phase rides along.
        assert_eq!(texel_at(&texture, 0, 0, 0), (42, PHASE_SNOW));
        assert_eq!(texture.filled_texel_count as usize, texture.depth as usize);
    }

    #[test]
    fn volume_texture_honors_the_declutter_selection() {
        let volume = test_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::Low,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        // The 30k-34k ft voxel is excluded, so the altitude span covers only
        // the low band and its top never reaches the excluded voxel.
        assert!(texture.base_feet >= 999.0);
        assert!(
            texture.base_feet as f64 + f64::from(texture.depth) * f64::from(texture.bin_size_feet)
                < 5_000.0
        );
        assert!((texture.max_corrected_top_feet - 4_000.0).abs() < 1e-3);
    }

    #[test]
    fn volume_texture_bleeds_phase_into_adjacent_empty_texels() {
        // A single snow brick: its empty neighbors must adopt the snow phase
        // so trilinear filtering does not tint edges toward rain.
        let volume = TestVolume {
            x_nm: vec![0.5, 2.0],
            z_nm: vec![0.0, 0.0],
            bottom_feet: vec![1_000, 1_000],
            top_feet: vec![2_000, 2_000],
            dbz_tenths: vec![300, 100],
            phase: vec![PHASE_SNOW, PHASE_SNOW],
            surface_phase: vec![PHASE_SNOW, PHASE_SNOW],
            footprint_x_span: vec![1, 1],
            footprint_y_span: vec![1, 1],
        };
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        assert_eq!((texture.width, texture.height), (4, 1));
        // Cells 1 and 2 are empty; both border a filled snow cell.
        assert_eq!(texel_at(&texture, 1, 0, 0), (0, PHASE_SNOW));
        assert_eq!(texel_at(&texture, 2, 0, 0), (0, PHASE_SNOW));
    }

    fn two_bricks_300_nm_apart() -> TestVolume {
        TestVolume {
            x_nm: vec![0.0, 300.0],
            z_nm: vec![0.0, 0.0],
            bottom_feet: vec![1_000, 1_000],
            top_feet: vec![2_000, 2_000],
            dbz_tenths: vec![300, 300],
            phase: vec![PHASE_RAIN, PHASE_RAIN],
            surface_phase: vec![PHASE_RAIN, PHASE_RAIN],
            footprint_x_span: vec![1, 1],
            footprint_y_span: vec![1, 1],
        }
    }

    #[test]
    fn volume_texture_keeps_full_source_resolution_within_the_brick_budget() {
        // Two bricks 300 NM apart span 601 source columns at a 0.5 NM
        // footprint. The dense grid coarsened this; the sparse layout keeps
        // full resolution and stores just the two resident bricks.
        let volume = two_bricks_300_nm_apart();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        assert_eq!((texture.coarsen_x, texture.coarsen_z), (1, 1));
        assert!((texture.cell_size_x_nm - 0.5).abs() < 1e-6);
        assert_eq!(texture.width, 601);
        assert_eq!(texture.page_width, 76);
        assert_eq!(texture.brick_count, 2);
        assert_eq!(texel_at(&texture, 0, 0, 0).0, 30);
        assert_eq!(texel_at(&texture, 600, 0, 0).0, 30);
        // Pages between the two bricks are empty, so a ray skips them.
        assert_eq!(texel_at(&texture, 300, 0, 0), (0, 0));
        assert_eq!(texture.page_table.len(), 76 * 2);
        assert_eq!(
            texture.page_table.iter().filter(|byte| **byte != 0).count(),
            2
        );
    }

    #[test]
    fn volume_texture_coarsens_by_footprint_multiples_when_over_the_brick_budget() {
        let volume = two_bricks_300_nm_apart();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        // A one-brick budget forces both echoes into a single page.
        let texture = build_volume_texture_with_budget(&volume, 0.5, 0.6, &prepared, 1)
            .expect("texture build should succeed")
            .expect("texture should be present");

        assert_eq!(texture.brick_count, 1);
        assert!(texture.width as usize <= VOLUME_BRICK_TEXELS);
        let multiple = texture.cell_size_x_nm / 0.5;
        assert!(
            (multiple - multiple.round()).abs() < 1e-4,
            "cell size must stay a footprint multiple"
        );
        assert_eq!(texture.coarsen_x as f32, multiple.round());
        assert_eq!(texture.coarsen_z, texture.coarsen_x);
        // Both bricks still land in the raster.
        assert_eq!(texel_at(&texture, 0, 0, 0).0, 30);
        assert_eq!(texel_at(&texture, texture.width as usize - 1, 0, 0).0, 30);
    }

    #[test]
    fn volume_texture_fails_loudly_on_a_zero_brick_budget() {
        let volume = two_bricks_300_nm_apart();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let error = build_volume_texture_with_budget(&volume, 0.5, 0.6, &prepared, 0)
            .expect_err("a zero budget must fail loudly");
        assert!(error.contains("positive brick budget"), "{error}");
    }

    #[test]
    fn volume_texture_leaves_pages_without_echo_unresident() {
        let volume = composite_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        // 3 x 2 x 20 logical texels -> 1 x 1 x 3 pages; echo sits in bins
        // 0-3 and 16-19, so the middle page (bins 8-15) holds nothing.
        assert_eq!(
            (texture.page_width, texture.page_height, texture.page_depth),
            (1, 1, 3)
        );
        assert_eq!(texture.brick_count, 2);
        assert_eq!(&texture.page_table[2..4], &[0, 0]);
        assert_eq!(texel_at(&texture, 0, 0, 8), (0, 0));
        // Two bricks: a 2 x 1 x 1 pool of 10^3 stored texels each.
        assert_eq!(
            (
                texture.pool_bricks_x,
                texture.pool_bricks_y,
                texture.pool_bricks_z
            ),
            (2, 1, 1)
        );
        let stored = VOLUME_BRICK_STORED_TEXELS;
        assert_eq!(texture.pool.len(), 2 * stored * stored * stored * 2);
    }

    #[test]
    fn volume_texture_aprons_copy_neighboring_bricks_and_clamp_at_the_grid_edge() {
        // Bricks in logical columns 0 and 8: two pages along x.
        let volume = TestVolume {
            x_nm: vec![0.0, 4.0],
            z_nm: vec![0.0, 0.0],
            bottom_feet: vec![1_000, 1_000],
            top_feet: vec![2_000, 2_000],
            dbz_tenths: vec![300, 400],
            phase: vec![PHASE_RAIN, PHASE_SNOW],
            surface_phase: vec![PHASE_RAIN, PHASE_SNOW],
            footprint_x_span: vec![1, 1],
            footprint_y_span: vec![1, 1],
        };
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        assert_eq!((texture.width, texture.page_width), (9, 2));
        assert_eq!(texture.brick_count, 2);
        assert_eq!(texel_at(&texture, 0, 0, 0), (30, PHASE_RAIN));
        assert_eq!(texel_at(&texture, 8, 0, 0), (40, PHASE_SNOW));

        // Page 0's high-x apron (sx = 9) is logical column 8: the snow brick.
        assert_eq!(stored_at(&texture, 0, 0, 0, 9, 1, 1), (40, PHASE_SNOW));
        // Page 1's low-x apron (sx = 0) is logical column 7: empty, but it
        // borders the snow brick so it carries the snow phase bleed.
        assert_eq!(stored_at(&texture, 8, 0, 0, 0, 1, 1), (0, PHASE_SNOW));
        // The core copy of column 7 in page 0 agrees with that apron copy.
        assert_eq!(texel_at(&texture, 7, 0, 0), (0, PHASE_SNOW));
        // Column 1 borders the rain brick, so it bleeds rain.
        assert_eq!(texel_at(&texture, 1, 0, 0), (0, PHASE_RAIN));

        // Aprons outside the grid clamp to the edge texel: page 0's low-x
        // apron (logical column -1) repeats column 0, and the row/bin aprons
        // below the first row/bin repeat the edge as well.
        assert_eq!(stored_at(&texture, 0, 0, 0, 0, 1, 1), (30, PHASE_RAIN));
        assert_eq!(stored_at(&texture, 0, 0, 0, 1, 0, 1), (30, PHASE_RAIN));
        assert_eq!(stored_at(&texture, 0, 0, 0, 1, 1, 0), (30, PHASE_RAIN));
        // Page 1's high-x apron (logical column 9, past the 9-wide grid)
        // repeats column 8.
        assert_eq!(stored_at(&texture, 8, 0, 0, 2, 1, 1), (40, PHASE_SNOW));
    }

    #[test]
    fn volume_texture_writes_every_stored_copy_of_a_face_texel() {
        // A brick spanning columns 7 and 8 straddles the page boundary, so
        // its texels appear in both pages' stored regions; a second brick at
        // column 0 anchors the grid origin.
        let volume = TestVolume {
            x_nm: vec![0.0, 3.75],
            z_nm: vec![0.0, 0.0],
            bottom_feet: vec![1_000, 1_000],
            top_feet: vec![2_000, 2_000],
            dbz_tenths: vec![100, 350],
            phase: vec![PHASE_RAIN, PHASE_MIXED],
            surface_phase: vec![PHASE_RAIN, PHASE_MIXED],
            footprint_x_span: vec![1, 2],
            footprint_y_span: vec![1, 1],
        };
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed")
            .expect("texture should be present");

        assert_eq!((texture.width, texture.page_width), (9, 2));
        assert_eq!(texel_at(&texture, 7, 0, 0), (35, PHASE_MIXED));
        assert_eq!(texel_at(&texture, 8, 0, 0), (35, PHASE_MIXED));
        // Column 7 as page 1's apron and column 8 as page 0's apron.
        assert_eq!(stored_at(&texture, 8, 0, 0, 0, 1, 1), (35, PHASE_MIXED));
        assert_eq!(stored_at(&texture, 0, 0, 0, 9, 1, 1), (35, PHASE_MIXED));
        // Filled texels are counted once each, not once per copy.
        assert_eq!(
            texture.filled_texel_count as usize,
            3 * texture.depth as usize
        );
    }

    #[test]
    fn volume_texture_rejects_a_non_positive_footprint() {
        let volume = composite_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let error = build_volume_texture(&volume, 0.0, 0.6, &prepared)
            .expect_err("a zero footprint must fail loudly");
        assert!(error.contains("positive grid footprints"), "{error}");
    }

    #[test]
    fn volume_texture_is_absent_for_an_empty_selection() {
        let volume = composite_volume();
        let prepared = prepare_volume(
            &volume,
            1_000,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let texture = build_volume_texture(&volume, 0.5, 0.6, &prepared)
            .expect("texture build should succeed");
        assert!(texture.is_none());
    }

    #[test]
    fn empty_prepared_volume_yields_empty_columns() {
        let volume = test_volume();
        let prepared = prepare_volume(
            &volume,
            1_000,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        assert!(data.center_x_nm.is_empty());
        assert!(data.phase_code.is_empty());
    }
}
