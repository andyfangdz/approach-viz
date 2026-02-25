// MRMS volume preprocessing: filter, curvature correction, cross-section projection, echo-top surfaces.
//
// Ported from `app/scene/nexrad/nexrad-preprocess.ts` — must produce numerically identical results.

use crate::coords::{earth_curvature_drop_nm, ALTITUDE_SCALE};
use crate::types::{
    CrossSectionData, DecodedMrmsVolume, DeclutterMode, PhaseMode, PreparedVolume,
    CROSS_SECTION_BINS_X, CROSS_SECTION_BINS_Y, DECLUTTER_LOW_MAX_FEET, DECLUTTER_MID_MAX_FEET,
    FEET_PER_NM, MIN_VOXEL_HEIGHT_NM, PHASE_RAIN,
};

// ---------------------------------------------------------------------------
// Echo-top input/output types
// ---------------------------------------------------------------------------

/// Input echo-top data (SoA layout, mirroring the typed-array path in TS).
#[derive(Debug, Clone)]
pub struct EchoTopInput {
    pub x_nm: Vec<f32>,
    pub z_nm: Vec<f32>,
    pub top18_feet: Vec<f32>,
    pub top30_feet: Vec<f32>,
    pub top50_feet: Vec<f32>,
    pub footprint_x_nm: f32,
    pub footprint_y_nm: f32,
}

/// A single echo-top surface cell ready for rendering.
#[derive(Debug, Clone, PartialEq)]
pub struct EchoTopSurfaceCell {
    pub x: f32,
    pub z: f32,
    pub y_base: f32,
    pub footprint_x_nm: f32,
    pub footprint_y_nm: f32,
}

/// Prepared echo-top surfaces for the three dBZ thresholds.
#[derive(Debug, Clone)]
pub struct EchoTopSurfaces {
    pub top18: Vec<EchoTopSurfaceCell>,
    pub top30: Vec<EchoTopSurfaceCell>,
    pub top50: Vec<EchoTopSurfaceCell>,
}

// ---------------------------------------------------------------------------
// 1. prepare_volume
// ---------------------------------------------------------------------------

/// Filter, curvature-correct, and declutter an MRMS decoded volume.
///
/// Mirrors `prepareVolumeData()` from `nexrad-preprocess.ts:59-181`.
pub fn prepare_volume(
    volume: &DecodedMrmsVolume,
    min_dbz_tenths: i16,
    phase_mode: PhaseMode,
    declutter_mode: DeclutterMode,
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> PreparedVolume {
    let count = volume.voxel_count as usize;
    if count == 0 {
        return PreparedVolume {
            valid_count: 0,
            valid_indices: Vec::new(),
            y_base: Vec::new(),
            height_base: Vec::new(),
            corrected_bottom_feet: Vec::new(),
            corrected_top_feet: Vec::new(),
            effective_phase_code: Vec::new(),
            declutter_indices: Vec::new(),
            declutter_count: 0,
        };
    }

    let mut valid_indices = Vec::with_capacity(count);
    let mut y_base = Vec::with_capacity(count);
    let mut height_base = Vec::with_capacity(count);
    let mut corrected_bottom_feet = Vec::with_capacity(count);
    let mut corrected_top_feet = Vec::with_capacity(count);
    let mut effective_phase_code = Vec::with_capacity(count);

    for i in 0..count {
        // Skip below minimum reflectivity
        let d = volume.dbz_tenths[i];
        if d < min_dbz_tenths {
            continue;
        }

        let x = volume.x_nm[i];
        let z = volume.z_nm[i];
        let fp_x = volume.footprint_x_span[i];
        let fp_y = volume.footprint_y_span[i];

        // Validate: position must be finite, footprint spans > 0
        if !x.is_finite() || !z.is_finite() || fp_x == 0 || fp_y == 0 {
            continue;
        }

        let curvature_drop_feet = if apply_earth_curvature {
            earth_curvature_drop_nm(x as f64, z as f64, ref_lat) * FEET_PER_NM
        } else {
            0.0
        };

        let c_bottom = f64::from(volume.bottom_feet[i]) - curvature_drop_feet;
        let c_top = f64::from(volume.top_feet[i]) - curvature_drop_feet;
        let c_center = (c_bottom + c_top) * 0.5;
        let yb = c_center * ALTITUDE_SCALE;
        let hb = ((c_top - c_bottom) * ALTITUDE_SCALE).max(MIN_VOXEL_HEIGHT_NM);

        // Validate computed values
        if !yb.is_finite() || !c_bottom.is_finite() || !c_top.is_finite() {
            continue;
        }

        valid_indices.push(i as i32);
        y_base.push(yb as f32);
        height_base.push(hb as f32);
        corrected_bottom_feet.push(c_bottom as f32);
        corrected_top_feet.push(c_top as f32);

        // Phase selection
        let selected = match phase_mode {
            PhaseMode::Surface => volume.surface_phase[i],
            PhaseMode::Altitude => volume.phase[i],
        };
        effective_phase_code.push(selected);
    }

    let valid_count = valid_indices.len();

    // Build declutter indices
    let (declutter_indices, declutter_count) = if declutter_mode == DeclutterMode::All {
        let indices: Vec<i32> = (0..valid_count as i32).collect();
        let count = valid_count;
        (indices, count)
    } else {
        let mut indices = Vec::with_capacity(valid_count);
        for i in 0..valid_count {
            if keep_voxel_for_declutter(
                declutter_mode,
                corrected_bottom_feet[i] as f64,
                corrected_top_feet[i] as f64,
            ) {
                indices.push(i as i32);
            }
        }
        let count = indices.len();
        (indices, count)
    };

    PreparedVolume {
        valid_count,
        valid_indices,
        y_base,
        height_base,
        corrected_bottom_feet,
        corrected_top_feet,
        effective_phase_code,
        declutter_indices,
        declutter_count,
    }
}

/// Declutter filter matching `keepVoxelForDeclutter` in TS.
fn keep_voxel_for_declutter(mode: DeclutterMode, bottom_feet: f64, top_feet: f64) -> bool {
    match mode {
        DeclutterMode::All => true,
        DeclutterMode::Low => {
            let center_feet = (bottom_feet + top_feet) * 0.5;
            center_feet <= DECLUTTER_LOW_MAX_FEET
        }
        DeclutterMode::Mid => {
            let center_feet = (bottom_feet + top_feet) * 0.5;
            center_feet > DECLUTTER_LOW_MAX_FEET && center_feet <= DECLUTTER_MID_MAX_FEET
        }
        DeclutterMode::High => {
            let center_feet = (bottom_feet + top_feet) * 0.5;
            center_feet > DECLUTTER_MID_MAX_FEET
        }
    }
}

// ---------------------------------------------------------------------------
// 2. build_cross_section
// ---------------------------------------------------------------------------

/// Build a 2D cross-section grid from a prepared volume along a given slice axis.
///
/// Mirrors `buildCrossSectionData()` from `nexrad-preprocess.ts:183-253`.
pub fn build_cross_section(
    volume: &DecodedMrmsVolume,
    prepared: &PreparedVolume,
    slice_axis: (f64, f64),
    slice_perp_axis: (f64, f64),
    normalized_range: f64,
    half_width_nm: f64,
) -> Option<CrossSectionData> {
    if prepared.valid_count == 0 {
        return None;
    }

    // Find max corrected top
    let mut max_top_feet: f64 = 0.0;
    for i in 0..prepared.valid_count {
        let t = prepared.corrected_top_feet[i] as f64;
        if t > max_top_feet {
            max_top_feet = t;
        }
    }
    if !max_top_feet.is_finite() || max_top_feet <= 0.0 {
        return None;
    }
    // Clamp to at least 10_000, round up to nearest 1000
    max_top_feet = f64::max(10_000.0, (max_top_feet / 1000.0).ceil() * 1000.0);

    let grid_size = CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y;
    let mut grid = vec![-1.0_f32; grid_size];
    let mut phase_grid = vec![PHASE_RAIN as i8; grid_size];
    let mut top_envelope_feet = vec![0.0_f32; CROSS_SECTION_BINS_X];

    for i in 0..prepared.valid_count {
        let idx = prepared.valid_indices[i] as usize;
        let vx = volume.x_nm[idx] as f64;
        let vz = volume.z_nm[idx] as f64;

        let along_nm = vx * slice_axis.0 + vz * slice_axis.1;
        if along_nm < -normalized_range || along_nm > normalized_range {
            continue;
        }

        let cross_nm = (vx * slice_perp_axis.0 + vz * slice_perp_axis.1).abs();
        if cross_nm > half_width_nm {
            continue;
        }

        let x01 = (along_nm + normalized_range) / (normalized_range * 2.0);
        let bin_x = (x01 * CROSS_SECTION_BINS_X as f64)
            .floor()
            .max(0.0)
            .min((CROSS_SECTION_BINS_X - 1) as f64) as usize;

        let bottom = f64::max(0.0, prepared.corrected_bottom_feet[i] as f64);
        let top = f64::max(0.0, prepared.corrected_top_feet[i] as f64);

        let y0 = ((bottom / max_top_feet) * CROSS_SECTION_BINS_Y as f64)
            .floor()
            .max(0.0)
            .min((CROSS_SECTION_BINS_Y - 1) as f64) as usize;
        let y1 = ((top / max_top_feet) * CROSS_SECTION_BINS_Y as f64)
            .ceil()
            .max(0.0)
            .min((CROSS_SECTION_BINS_Y - 1) as f64) as usize;

        if top > top_envelope_feet[bin_x] as f64 {
            top_envelope_feet[bin_x] = top as f32;
        }

        let phase_code = prepared.effective_phase_code[i];
        let v_dbz = volume.dbz_tenths[idx] as f32;

        for y in y0..=y1 {
            let grid_idx = y * CROSS_SECTION_BINS_X + bin_x;
            if v_dbz > grid[grid_idx] {
                grid[grid_idx] = v_dbz;
                phase_grid[grid_idx] = phase_code as i8;
            }
        }
    }

    Some(CrossSectionData {
        bins_x: CROSS_SECTION_BINS_X,
        bins_y: CROSS_SECTION_BINS_Y,
        grid,
        phase_grid,
        top_envelope_feet,
        max_top_feet: max_top_feet as f32,
    })
}

// ---------------------------------------------------------------------------
// 3. prepare_echo_top_surfaces
// ---------------------------------------------------------------------------

/// Build renderable echo-top surface cells from typed echo-top input.
///
/// Mirrors `prepareEchoTopSurfaces()` from `nexrad-preprocess.ts:255-369`
/// (typed-array path only; legacy `cells` array path is not needed in Rust).
pub fn prepare_echo_top_surfaces(
    input: &EchoTopInput,
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> EchoTopSurfaces {
    let count = input
        .x_nm
        .len()
        .min(input.z_nm.len())
        .min(input.top18_feet.len())
        .min(input.top30_feet.len())
        .min(input.top50_feet.len());

    let mut top18 = Vec::new();
    let mut top30 = Vec::new();
    let mut top50 = Vec::new();

    for i in 0..count {
        let x = input.x_nm[i];
        let z = input.z_nm[i];
        if !x.is_finite() || !z.is_finite() {
            continue;
        }

        let curvature_drop_feet = if apply_earth_curvature {
            earth_curvature_drop_nm(x as f64, z as f64, ref_lat) * FEET_PER_NM
        } else {
            0.0
        };

        let t18 = f64::max(0.0, f64::from(input.top18_feet[i]) - curvature_drop_feet);
        let t30 = f64::max(0.0, f64::from(input.top30_feet[i]) - curvature_drop_feet);
        let t50 = f64::max(0.0, f64::from(input.top50_feet[i]) - curvature_drop_feet);

        if t18 > 0.0 {
            top18.push(EchoTopSurfaceCell {
                x,
                z,
                y_base: (t18 * ALTITUDE_SCALE) as f32,
                footprint_x_nm: input.footprint_x_nm,
                footprint_y_nm: input.footprint_y_nm,
            });
        }
        if t30 > 0.0 {
            top30.push(EchoTopSurfaceCell {
                x,
                z,
                y_base: (t30 * ALTITUDE_SCALE) as f32,
                footprint_x_nm: input.footprint_x_nm,
                footprint_y_nm: input.footprint_y_nm,
            });
        }
        if t50 > 0.0 {
            top50.push(EchoTopSurfaceCell {
                x,
                z,
                y_base: (t50 * ALTITUDE_SCALE) as f32,
                footprint_x_nm: input.footprint_x_nm,
                footprint_y_nm: input.footprint_y_nm,
            });
        }
    }

    EchoTopSurfaces { top18, top30, top50 }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PHASE_RAIN, PHASE_SNOW};

    /// Helper: build a minimal `DecodedMrmsVolume` with n voxels using provided field closures.
    fn make_volume(
        n: usize,
        x_nm: impl Fn(usize) -> f32,
        z_nm: impl Fn(usize) -> f32,
        bottom_feet: impl Fn(usize) -> u16,
        top_feet: impl Fn(usize) -> u16,
        dbz_tenths: impl Fn(usize) -> i16,
        phase: impl Fn(usize) -> u8,
        surface_phase: impl Fn(usize) -> u8,
    ) -> DecodedMrmsVolume {
        DecodedMrmsVolume {
            version: 3,
            voxel_count: n as u32,
            layer_count: 1,
            generated_at_ms: 0,
            scan_time_ms: 0,
            footprint_x_nm: 1.0,
            footprint_y_nm: 1.0,
            layer_voxel_counts: vec![n as u32],
            x_nm: (0..n).map(&x_nm).collect(),
            z_nm: (0..n).map(&z_nm).collect(),
            bottom_feet: (0..n).map(&bottom_feet).collect(),
            top_feet: (0..n).map(&top_feet).collect(),
            dbz_tenths: (0..n).map(&dbz_tenths).collect(),
            phase: (0..n).map(&phase).collect(),
            surface_phase: (0..n).map(&surface_phase).collect(),
            footprint_x_span: vec![100; n], // nonzero
            footprint_y_span: vec![100; n],
        }
    }

    // -----------------------------------------------------------------------
    // prepare_volume tests
    // -----------------------------------------------------------------------

    #[test]
    fn prepare_empty_volume() {
        let vol = make_volume(0, |_| 0.0, |_| 0.0, |_| 0, |_| 0, |_| 0, |_| 0, |_| 0);
        let result = prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 0);
        assert!(result.valid_indices.is_empty());
        assert!(result.y_base.is_empty());
        assert!(result.declutter_indices.is_empty());
    }

    #[test]
    fn prepare_filters_below_min_dbz() {
        // Voxel with 20 dBZ-tenths, min=50 → filtered out
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 5000,
            |_| 6000,
            |_| 20,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result = prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 0);
    }

    #[test]
    fn prepare_keeps_above_min_dbz() {
        // Voxel with 350 tenths, min=50 → kept
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 5000,
            |_| 6000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result = prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 1);
        assert_eq!(result.valid_indices[0], 0);
        // center = (5000 + 6000)/2 = 5500, y_base = 5500 * ALTITUDE_SCALE
        let expected_y = 5500.0 * ALTITUDE_SCALE;
        assert!(
            (f64::from(result.y_base[0]) - expected_y).abs() < 1e-4,
            "y_base {} != expected {}",
            result.y_base[0],
            expected_y
        );
    }

    #[test]
    fn prepare_earth_curvature_lowers_altitude() {
        // Voxel at 60 NM range → curvature should lower corrected bottom
        let vol = make_volume(
            1,
            |_| 60.0,
            |_| 0.0,
            |_| 10000,
            |_| 12000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result = prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, true, 40.0);
        assert_eq!(result.valid_count, 1);
        // Raw bottom = 10000, curvature drop at 60 NM ≈ 0.52 NM × 6076.12 ≈ 3160 feet
        assert!(
            (result.corrected_bottom_feet[0]) < 10000.0,
            "corrected bottom {} should be < 10000",
            result.corrected_bottom_feet[0]
        );
        // More specifically, drop should be around 3100-3200 feet
        let drop = 10000.0 - result.corrected_bottom_feet[0];
        assert!(
            drop > 2500.0 && drop < 4000.0,
            "curvature drop {} feet at 60 NM not in expected range",
            drop
        );
    }

    #[test]
    fn prepare_no_curvature_when_disabled() {
        let vol = make_volume(
            1,
            |_| 60.0,
            |_| 0.0,
            |_| 10000,
            |_| 12000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 1);
        assert!(
            (result.corrected_bottom_feet[0] - 10000.0).abs() < 0.01,
            "without curvature, corrected bottom {} should be ~10000",
            result.corrected_bottom_feet[0]
        );
        assert!(
            (result.corrected_top_feet[0] - 12000.0).abs() < 0.01,
            "without curvature, corrected top {} should be ~12000",
            result.corrected_top_feet[0]
        );
    }

    #[test]
    fn prepare_phase_mode_surface() {
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 5000,
            |_| 6000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_SNOW,
        );
        let result =
            prepare_volume(&vol, 50, PhaseMode::Surface, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 1);
        assert_eq!(
            result.effective_phase_code[0], PHASE_SNOW,
            "surface mode should use surface_phase"
        );
    }

    #[test]
    fn prepare_phase_mode_altitude() {
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 5000,
            |_| 6000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_SNOW,
        );
        let result =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 1);
        assert_eq!(
            result.effective_phase_code[0], PHASE_RAIN,
            "altitude mode should use phase"
        );
    }

    #[test]
    fn prepare_declutter_low() {
        // Voxel at center 15,000 ft → excluded by Low mode (keeps <= 10,000)
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 14000,
            |_| 16000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::Low, false, 40.0);
        assert_eq!(result.valid_count, 1, "voxel should still be valid");
        assert_eq!(
            result.declutter_count, 0,
            "voxel at center 15k ft should be excluded by Low declutter"
        );
    }

    #[test]
    fn prepare_declutter_all() {
        // Multiple voxels at different altitudes: all pass through in All mode
        let vol = make_volume(
            3,
            |_| 10.0,
            |_| 5.0,
            |i| (i as u16 * 10000) + 1000,
            |i| (i as u16 * 10000) + 3000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 3);
        assert_eq!(result.declutter_count, 3);
        assert_eq!(result.declutter_indices, vec![0, 1, 2]);
    }

    // -----------------------------------------------------------------------
    // build_cross_section tests
    // -----------------------------------------------------------------------

    #[test]
    fn cross_section_empty() {
        let vol = make_volume(0, |_| 0.0, |_| 0.0, |_| 0, |_| 0, |_| 0, |_| 0, |_| 0);
        let prepared =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        let result =
            build_cross_section(&vol, &prepared, (1.0, 0.0), (0.0, 1.0), 60.0, 5.0);
        assert!(result.is_none());
    }

    #[test]
    fn cross_section_single_voxel() {
        // Voxel at x=10, z=0 with slice along x-axis, range=60
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 0.0,
            |_| 5000,
            |_| 8000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let prepared =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(prepared.valid_count, 1);

        let result =
            build_cross_section(&vol, &prepared, (1.0, 0.0), (0.0, 1.0), 60.0, 5.0);
        assert!(result.is_some());
        let cs = result.unwrap();
        assert_eq!(cs.bins_x, CROSS_SECTION_BINS_X);
        assert_eq!(cs.bins_y, CROSS_SECTION_BINS_Y);
        // max_top_feet: max(10000, ceil(8000/1000)*1000) = 10000
        assert!((cs.max_top_feet - 10000.0).abs() < 0.01);

        // along_nm = 10.0 (dot with (1,0))
        // x01 = (10 + 60) / 120 = 70/120 ≈ 0.5833
        // bin_x = floor(0.5833 * 120) = floor(70) = 70
        let bin_x = 70_usize;
        // bottom=5000, top=8000, max_top=10000
        // y0 = floor(5000/10000 * 56) = floor(28) = 28
        // y1 = ceil(8000/10000 * 56) = ceil(44.8) = 45
        let y0 = 28_usize;
        let y1 = 45_usize;

        // The grid should have 350.0 at these bins
        for y in y0..=y1 {
            let grid_idx = y * CROSS_SECTION_BINS_X + bin_x;
            assert!(
                (cs.grid[grid_idx] - 350.0).abs() < 0.01,
                "grid[{y}][{bin_x}] = {}, expected 350",
                cs.grid[grid_idx]
            );
        }

        // Bins outside should still be -1.0
        assert!(
            (cs.grid[0 * CROSS_SECTION_BINS_X + 0] - (-1.0)).abs() < 0.01,
            "grid[0][0] should be -1"
        );

        // top_envelope at bin 70 should be 8000
        assert!(
            (cs.top_envelope_feet[bin_x] - 8000.0).abs() < 0.01,
            "top envelope at bin {} = {}, expected 8000",
            bin_x,
            cs.top_envelope_feet[bin_x]
        );
    }

    #[test]
    fn cross_section_perpendicular_filtered() {
        // Voxel at x=0, z=50 with slice along x-axis → perpendicular distance = 50 > half_width=5
        let vol = make_volume(
            1,
            |_| 0.0,
            |_| 50.0,
            |_| 5000,
            |_| 8000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let prepared =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);

        let result =
            build_cross_section(&vol, &prepared, (1.0, 0.0), (0.0, 1.0), 60.0, 5.0);
        // The voxel is valid, so cross_section should return Some, but grid should be empty
        assert!(result.is_some());
        let cs = result.unwrap();
        // All grid cells should be -1 since the voxel is filtered by perpendicular distance
        for val in &cs.grid {
            assert!(
                (*val - (-1.0)).abs() < 0.01,
                "all grid cells should be -1 when voxel is filtered, got {}",
                val
            );
        }
    }

    // -----------------------------------------------------------------------
    // prepare_echo_top_surfaces tests
    // -----------------------------------------------------------------------

    #[test]
    fn echo_tops_basic() {
        let input = EchoTopInput {
            x_nm: vec![1.0, 2.0, 3.0],
            z_nm: vec![0.0, 0.0, 0.0],
            top18_feet: vec![5000.0, 10000.0, 15000.0],
            top30_feet: vec![3000.0, 7000.0, 12000.0],
            top50_feet: vec![1000.0, 4000.0, 8000.0],
            footprint_x_nm: 0.05,
            footprint_y_nm: 0.05,
        };
        let result = prepare_echo_top_surfaces(&input, false, 40.0);

        assert_eq!(result.top18.len(), 3);
        assert_eq!(result.top30.len(), 3);
        assert_eq!(result.top50.len(), 3);

        // Verify y_base = top_feet * ALTITUDE_SCALE for the first cell
        let expected_y18 = 5000.0 * ALTITUDE_SCALE;
        assert!(
            (f64::from(result.top18[0].y_base) - expected_y18).abs() < 1e-4,
            "top18[0].y_base {} != expected {}",
            result.top18[0].y_base,
            expected_y18
        );

        let expected_y30 = 3000.0 * ALTITUDE_SCALE;
        assert!(
            (f64::from(result.top30[0].y_base) - expected_y30).abs() < 1e-4,
            "top30[0].y_base {} != expected {}",
            result.top30[0].y_base,
            expected_y30
        );

        let expected_y50 = 1000.0 * ALTITUDE_SCALE;
        assert!(
            (f64::from(result.top50[0].y_base) - expected_y50).abs() < 1e-4,
            "top50[0].y_base {} != expected {}",
            result.top50[0].y_base,
            expected_y50
        );
    }

    #[test]
    fn echo_tops_curvature() {
        // Cell at 60 NM → top should be reduced by curvature
        let raw_top = 15000.0_f32;
        let input = EchoTopInput {
            x_nm: vec![60.0],
            z_nm: vec![0.0],
            top18_feet: vec![raw_top],
            top30_feet: vec![raw_top],
            top50_feet: vec![raw_top],
            footprint_x_nm: 0.05,
            footprint_y_nm: 0.05,
        };
        let result = prepare_echo_top_surfaces(&input, true, 40.0);
        assert_eq!(result.top18.len(), 1);

        // Curvature drop at 60 NM ≈ 0.52 NM * 6076.12 ≈ 3160 feet
        let raw_y = raw_top as f64 * ALTITUDE_SCALE;
        let corrected_y = f64::from(result.top18[0].y_base);
        assert!(
            corrected_y < raw_y,
            "with curvature, y_base {} should be < raw {}",
            corrected_y,
            raw_y
        );

        // The curvature drop in feet should be ~3100-3200
        let drop_feet = raw_top as f64 - (corrected_y / ALTITUDE_SCALE);
        assert!(
            drop_feet > 2500.0 && drop_feet < 4000.0,
            "curvature drop {} feet at 60 NM not in expected range",
            drop_feet
        );
    }

    #[test]
    fn echo_tops_zero_top_excluded() {
        // Cell with 0 feet top → should not produce any cells
        let input = EchoTopInput {
            x_nm: vec![1.0],
            z_nm: vec![0.0],
            top18_feet: vec![0.0],
            top30_feet: vec![0.0],
            top50_feet: vec![0.0],
            footprint_x_nm: 0.05,
            footprint_y_nm: 0.05,
        };
        let result = prepare_echo_top_surfaces(&input, false, 40.0);
        assert!(result.top18.is_empty());
        assert!(result.top30.is_empty());
        assert!(result.top50.is_empty());
    }

    #[test]
    fn echo_tops_nan_position_skipped() {
        let input = EchoTopInput {
            x_nm: vec![f32::NAN],
            z_nm: vec![0.0],
            top18_feet: vec![5000.0],
            top30_feet: vec![5000.0],
            top50_feet: vec![5000.0],
            footprint_x_nm: 0.05,
            footprint_y_nm: 0.05,
        };
        let result = prepare_echo_top_surfaces(&input, false, 40.0);
        assert!(result.top18.is_empty());
    }

    // -----------------------------------------------------------------------
    // Additional edge-case tests
    // -----------------------------------------------------------------------

    #[test]
    fn prepare_nan_position_skipped() {
        let mut vol = make_volume(
            1,
            |_| f32::NAN,
            |_| 5.0,
            |_| 5000,
            |_| 6000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        vol.footprint_x_span = vec![100];
        vol.footprint_y_span = vec![100];
        let result = prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 0);
    }

    #[test]
    fn prepare_zero_footprint_span_skipped() {
        let mut vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 5000,
            |_| 6000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        vol.footprint_x_span = vec![0]; // zero → skip
        vol.footprint_y_span = vec![100];
        let result = prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 0);
    }

    #[test]
    fn prepare_min_voxel_height_enforced() {
        // Voxel where top - bottom is tiny (1 foot difference)
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 5000,
            |_| 5001,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result = prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::All, false, 40.0);
        assert_eq!(result.valid_count, 1);
        // height_base should be at least MIN_VOXEL_HEIGHT_NM
        assert!(
            f64::from(result.height_base[0]) >= MIN_VOXEL_HEIGHT_NM - 1e-9,
            "height_base {} should be >= MIN_VOXEL_HEIGHT_NM {}",
            result.height_base[0],
            MIN_VOXEL_HEIGHT_NM
        );
    }

    #[test]
    fn prepare_declutter_mid() {
        // Voxel center at 15,000 ft (between 10k and 25k) → kept by Mid
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 14000,
            |_| 16000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::Mid, false, 40.0);
        assert_eq!(result.valid_count, 1);
        assert_eq!(result.declutter_count, 1, "center 15k ft should pass Mid filter");
    }

    #[test]
    fn prepare_declutter_high() {
        // Voxel center at 30,000 ft (> 25k) → kept by High
        let vol = make_volume(
            1,
            |_| 10.0,
            |_| 5.0,
            |_| 28000,
            |_| 32000,
            |_| 350,
            |_| PHASE_RAIN,
            |_| PHASE_RAIN,
        );
        let result =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::High, false, 40.0);
        assert_eq!(result.valid_count, 1);
        assert_eq!(result.declutter_count, 1, "center 30k ft should pass High filter");

        // Same voxel with Low mode → excluded
        let result2 =
            prepare_volume(&vol, 50, PhaseMode::Altitude, DeclutterMode::Low, false, 40.0);
        assert_eq!(result2.declutter_count, 0, "center 30k ft should NOT pass Low filter");
    }
}
