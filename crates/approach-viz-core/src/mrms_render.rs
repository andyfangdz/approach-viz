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

/// Ceiling on the horizontal axes of the raymarch volume texture. A 120 NM
/// request lands near 440 source cells per axis, so the builder coarsens the
/// cell size by an integer footprint multiple until both axes fit.
const MAX_TEXTURE_AXIS_CELLS: usize = 256;

/// Ceiling on raymarch altitude bins.
const MAX_TEXTURE_ALTITUDE_BINS: usize = 96;

/// Preferred altitude-bin thickness. Finer than the lowest MRMS level spacing
/// (~820 ft), so no level is skipped while shallow fields get shallow bins.
const TARGET_ALTITUDE_BIN_FEET: f64 = 500.0;

/// Sanity ceiling on the reconstructed source-grid axis, mirroring
/// [`MAX_COMPOSITE_AXIS_CELLS`]: exceeding it means the index reconstruction
/// broke, not that the storm got big.
const MAX_TEXTURE_SOURCE_AXIS_CELLS: f64 = 4096.0;

/// Dense RG8 voxel grid for raymarched volume rendering.
///
/// Texels are laid out `x` fastest, then `z` (row), then altitude bin:
/// `index = ((bin * height + row) * width + col) * 2`. Each texel is two
/// bytes: `R` = dBZ rounded to whole dBZ (`0` = empty), `G` = phase code.
/// Altitudes are corrected feet (earth-curvature drop already subtracted when
/// requested), so the sampler needs no per-sample curvature work. Cell `(0,0)`
/// spans `origin_*_nm` to `origin_*_nm + cell_size_*_nm`; bin `0` spans
/// `base_feet` to `base_feet + bin_size_feet`.
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
    pub texels: Vec<u8>,
    pub filled_texel_count: u32,
    pub max_abs_x_nm: f32,
    pub max_abs_z_nm: f32,
    pub max_corrected_top_feet: f32,
}

/// Rasterize the declutter-selected voxel bricks into a dense RG8 3D texture
/// for raymarched volume rendering.
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
    let footprint_x_nm = f64::from(footprint_base_x_nm);
    let footprint_z_nm = f64::from(footprint_base_y_nm);
    if !(footprint_x_nm > 0.0) || !(footprint_z_nm > 0.0) {
        return Err(format!(
            "MRMS volume texture needs positive grid footprints, got {footprint_base_x_nm} x {footprint_base_y_nm} NM"
        ));
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
        let half_sx = footprint_x_nm * f64::from(volume.footprint_x_span(payload_index).max(1)) * 0.5;
        let half_sz = footprint_z_nm * f64::from(volume.footprint_y_span(payload_index).max(1)) * 0.5;
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

    // Coarsen by an integer footprint multiple until each axis fits, so texture
    // cells stay aligned with whole source-grid cells.
    let coarsen_x = (source_cols / MAX_TEXTURE_AXIS_CELLS as f64).ceil().max(1.0);
    let coarsen_z = (source_rows / MAX_TEXTURE_AXIS_CELLS as f64).ceil().max(1.0);
    let cell_x_nm = footprint_x_nm * coarsen_x;
    let cell_z_nm = footprint_z_nm * coarsen_z;
    let width = ((max_x - min_x) / cell_x_nm - 1e-6).ceil().max(1.0) as usize;
    let height = ((max_z - min_z) / cell_z_nm - 1e-6).ceil().max(1.0) as usize;
    if width > MAX_TEXTURE_AXIS_CELLS + 1 || height > MAX_TEXTURE_AXIS_CELLS + 1 {
        return Err(format!(
            "MRMS volume texture grid {width} x {height} escaped the {MAX_TEXTURE_AXIS_CELLS}-cell cap"
        ));
    }

    let span_feet = (top_feet - base_feet).max(1.0);
    let depth = ((span_feet / TARGET_ALTITUDE_BIN_FEET).ceil() as usize)
        .clamp(1, MAX_TEXTURE_ALTITUDE_BINS);
    let bin_feet = span_feet / depth as f64;

    let mut texels = vec![0_u8; width * height * depth * 2];
    let mut filled_texel_count: u32 = 0;

    for i in 0..count {
        let valid_index = prepared.declutter_indices[i] as usize;
        let payload_index = prepared.valid_indices[valid_index] as usize;
        let x = f64::from(volume.x_nm(payload_index));
        let z = f64::from(volume.z_nm(payload_index));
        let half_sx = footprint_x_nm * f64::from(volume.footprint_x_span(payload_index).max(1)) * 0.5;
        let half_sz = footprint_z_nm * f64::from(volume.footprint_y_span(payload_index).max(1)) * 0.5;

        let col_start = (((x - half_sx - min_x) / cell_x_nm) + 1e-6).floor().max(0.0) as usize;
        let col_end = ((((x + half_sx - min_x) / cell_x_nm) - 1e-6).ceil() as usize).min(width);
        let row_start = (((z - half_sz - min_z) / cell_z_nm) + 1e-6).floor().max(0.0) as usize;
        let row_end = ((((z + half_sz - min_z) / cell_z_nm) - 1e-6).ceil() as usize).min(height);

        let bottom = f64::from(prepared.corrected_bottom_feet[valid_index]);
        let top = f64::from(prepared.corrected_top_feet[valid_index]);
        let bin_start = (((bottom - base_feet) / bin_feet) + 1e-6).floor().max(0.0) as usize;
        let mut bin_end = ((((top - base_feet) / bin_feet) - 1e-6).ceil() as usize).min(depth);
        if bin_end <= bin_start {
            bin_end = (bin_start + 1).min(depth);
        }

        let dbz_byte = ((f64::from(volume.dbz_tenths(payload_index)) / 10.0).round() as i64)
            .clamp(1, 255) as u8;
        let phase = prepared.effective_phase_code[valid_index];

        for bin in bin_start..bin_end {
            let bin_offset = bin * height;
            for row in row_start..row_end {
                let row_offset = (bin_offset + row) * width;
                for col in col_start..col_end {
                    let t = (row_offset + col) * 2;
                    if texels[t] == 0 {
                        filled_texel_count += 1;
                    } else if texels[t] >= dbz_byte {
                        continue;
                    }
                    texels[t] = dbz_byte;
                    texels[t + 1] = phase;
                }
            }
        }
    }

    // Bleed phase codes into empty texels bordering filled ones so trilinear
    // filtering interpolates toward the neighbor's phase instead of toward
    // rain (`phase == 0`), which would tint snow-echo edges. Safe in place:
    // adoption reads only neighbors' `R` (never written here).
    for bin in 0..depth {
        for row in 0..height {
            for col in 0..width {
                let t = ((bin * height + row) * width + col) * 2;
                if texels[t] != 0 {
                    continue;
                }
                let neighbors = [
                    (col > 0).then(|| t - 2),
                    (col + 1 < width).then(|| t + 2),
                    (row > 0).then(|| t - width * 2),
                    (row + 1 < height).then(|| t + width * 2),
                    (bin > 0).then(|| t - width * height * 2),
                    (bin + 1 < depth).then(|| t + width * height * 2),
                ];
                for neighbor in neighbors.into_iter().flatten() {
                    if texels[neighbor] != 0 {
                        texels[t + 1] = texels[neighbor + 1];
                        break;
                    }
                }
            }
        }
    }

    Ok(Some(MrmsVolumeTexture {
        width: width as u32,
        height: height as u32,
        depth: depth as u32,
        origin_x_nm: min_x as f32,
        origin_z_nm: min_z as f32,
        cell_size_x_nm: cell_x_nm as f32,
        cell_size_z_nm: cell_z_nm as f32,
        base_feet: base_feet as f32,
        bin_size_feet: bin_feet as f32,
        texels,
        filled_texel_count,
        max_abs_x_nm,
        max_abs_z_nm,
        max_corrected_top_feet,
    }))
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
        let width = texture.width as usize;
        let height = texture.height as usize;
        let t = ((bin * height + row) * width + col) * 2;
        (texture.texels[t], texture.texels[t + 1])
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

    #[test]
    fn volume_texture_coarsens_axes_by_integer_footprint_multiples() {
        // Two bricks 300 NM apart force > 256 source columns at a 0.5 NM
        // footprint, so the x axis must coarsen to a whole multiple.
        let volume = TestVolume {
            x_nm: vec![0.0, 300.0],
            z_nm: vec![0.0, 0.0],
            bottom_feet: vec![1_000, 1_000],
            top_feet: vec![2_000, 2_000],
            dbz_tenths: vec![300, 300],
            phase: vec![PHASE_RAIN, PHASE_RAIN],
            surface_phase: vec![PHASE_RAIN, PHASE_RAIN],
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

        let multiple = texture.cell_size_x_nm / 0.5;
        assert!((multiple - multiple.round()).abs() < 1e-4, "cell size must stay a footprint multiple");
        assert!(texture.width as usize <= MAX_TEXTURE_AXIS_CELLS + 1);
        // Both bricks still land in the raster.
        assert_eq!(texel_at(&texture, 0, 0, 0).0, 30);
        assert_eq!(
            texel_at(&texture, texture.width as usize - 1, 0, 0).0,
            30
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
