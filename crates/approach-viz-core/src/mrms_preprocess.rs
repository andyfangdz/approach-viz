// MRMS volume preprocessing: filter, curvature correction, cross-section projection, echo-top surfaces.
//
// Ported from `app/scene/nexrad/nexrad-preprocess.ts` — must produce numerically identical results.

use crate::coords::{ALTITUDE_SCALE, earth_curvature_drop_nm};
use crate::generated::MrmsVolume;
use crate::types::{
    CROSS_SECTION_BINS_X, CROSS_SECTION_BINS_Y, CrossSectionData, DECLUTTER_LOW_MAX_FEET,
    DECLUTTER_MID_MAX_FEET, DeclutterMode, FEET_PER_NM, MIN_VOXEL_HEIGHT_NM, PHASE_RAIN, PhaseMode,
    PreparedVolume,
};

// ---------------------------------------------------------------------------
// VolumeSource trait — abstracts indexed voxel access for prepare/cross-section
// ---------------------------------------------------------------------------

/// Indexed access to MRMS volume voxel fields. Implemented for `FbVolumeView`
/// (zero-copy FlatBuffers view) and the test-only `TestVolume` fixture.
pub trait VolumeSource {
    fn voxel_count(&self) -> usize;
    fn x_nm(&self, i: usize) -> f32;
    fn z_nm(&self, i: usize) -> f32;
    fn bottom_feet(&self, i: usize) -> u16;
    fn top_feet(&self, i: usize) -> u16;
    fn dbz_tenths(&self, i: usize) -> i16;
    fn phase(&self, i: usize) -> u8;
    fn surface_phase(&self, i: usize) -> u8;
    fn footprint_x_span(&self, i: usize) -> u16;
    fn footprint_y_span(&self, i: usize) -> u16;
}

/// Owned SoA fixture for prepare/render unit tests. Production decode is
/// `FbVolumeView` over the AVMR FlatBuffers payload.
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct TestVolume {
    pub x_nm: Vec<f32>,
    pub z_nm: Vec<f32>,
    pub bottom_feet: Vec<u16>,
    pub top_feet: Vec<u16>,
    pub dbz_tenths: Vec<i16>,
    pub phase: Vec<u8>,
    pub surface_phase: Vec<u8>,
    pub footprint_x_span: Vec<u16>,
    pub footprint_y_span: Vec<u16>,
}

#[cfg(test)]
impl VolumeSource for TestVolume {
    #[inline]
    fn voxel_count(&self) -> usize {
        self.x_nm.len()
    }
    #[inline]
    fn x_nm(&self, i: usize) -> f32 {
        self.x_nm[i]
    }
    #[inline]
    fn z_nm(&self, i: usize) -> f32 {
        self.z_nm[i]
    }
    #[inline]
    fn bottom_feet(&self, i: usize) -> u16 {
        self.bottom_feet[i]
    }
    #[inline]
    fn top_feet(&self, i: usize) -> u16 {
        self.top_feet[i]
    }
    #[inline]
    fn dbz_tenths(&self, i: usize) -> i16 {
        self.dbz_tenths[i]
    }
    #[inline]
    fn phase(&self, i: usize) -> u8 {
        self.phase[i]
    }
    #[inline]
    fn surface_phase(&self, i: usize) -> u8 {
        self.surface_phase[i]
    }
    #[inline]
    fn footprint_x_span(&self, i: usize) -> u16 {
        self.footprint_x_span[i]
    }
    #[inline]
    fn footprint_y_span(&self, i: usize) -> u16 {
        self.footprint_y_span[i]
    }
}

// ---------------------------------------------------------------------------
// FbVolumeView — zero-copy view over FlatBuffers MrmsVolume SoA columns
// ---------------------------------------------------------------------------

/// Resolve a required FB scalar column once at view-construction time so the
/// per-element accessors used in the prepare/cross-section hot loops carry no
/// Option handling. A missing or length-mismatched column is a malformed
/// payload and fails loudly here instead of silently reading zeros.
#[allow(dead_code)] // used only by the wasm/ios bindings
fn require_column<'a, T: flatbuffers::Follow<'a>>(
    column: Option<flatbuffers::Vector<'a, T>>,
    expected_len: usize,
    payload: &str,
    label: &str,
) -> Result<flatbuffers::Vector<'a, T>, String> {
    let column =
        column.ok_or_else(|| format!("{payload} payload is missing the `{label}` column"))?;
    if column.len() != expected_len {
        return Err(format!(
            "{payload} `{label}` column length {} does not match the declared count {expected_len}",
            column.len()
        ));
    }
    Ok(column)
}

/// Zero-copy view over a FlatBuffers `MrmsVolume`'s voxel columns.
/// Converts from wire encoding (hundredths, millis) to domain units (NM, etc.) inline.
/// All columns are presence/length-validated once in `new`, so indexed access
/// is branch-free apart from the slice bounds assert.
#[allow(dead_code)] // used only by the wasm/ios bindings
#[derive(Debug)]
pub(crate) struct FbVolumeView<'a> {
    count: usize,
    pub(crate) x_hundredths: flatbuffers::Vector<'a, i16>,
    pub(crate) z_hundredths: flatbuffers::Vector<'a, i16>,
    pub(crate) bottom_feet: flatbuffers::Vector<'a, u16>,
    pub(crate) top_feet: flatbuffers::Vector<'a, u16>,
    pub(crate) dbz_tenths: flatbuffers::Vector<'a, i16>,
    pub(crate) phase: flatbuffers::Vector<'a, u8>,
    pub(crate) surface_phase: flatbuffers::Vector<'a, u8>,
    pub(crate) span_x: flatbuffers::Vector<'a, u16>,
    pub(crate) span_y: flatbuffers::Vector<'a, u16>,
}

#[allow(dead_code)] // used only by the wasm/ios bindings
impl<'a> FbVolumeView<'a> {
    pub(crate) fn new(fb: &MrmsVolume<'a>) -> Result<Self, String> {
        let count = fb.brick_count() as usize;
        Ok(Self {
            count,
            x_hundredths: require_column(fb.x_hundredths(), count, "AVMR", "x_hundredths")?,
            z_hundredths: require_column(fb.z_hundredths(), count, "AVMR", "z_hundredths")?,
            bottom_feet: require_column(fb.bottom_feet(), count, "AVMR", "bottom_feet")?,
            top_feet: require_column(fb.top_feet(), count, "AVMR", "top_feet")?,
            dbz_tenths: require_column(fb.dbz_tenths(), count, "AVMR", "dbz_tenths")?,
            phase: require_column(fb.phase(), count, "AVMR", "phase")?,
            surface_phase: require_column(fb.surface_phase(), count, "AVMR", "surface_phase")?,
            span_x: require_column(fb.span_x(), count, "AVMR", "span_x")?,
            span_y: require_column(fb.span_y(), count, "AVMR", "span_y")?,
        })
    }
}

impl VolumeSource for FbVolumeView<'_> {
    #[inline]
    fn voxel_count(&self) -> usize {
        self.count
    }
    #[inline]
    fn x_nm(&self, i: usize) -> f32 {
        self.x_hundredths.get(i) as f32 / 100.0
    }
    #[inline]
    fn z_nm(&self, i: usize) -> f32 {
        self.z_hundredths.get(i) as f32 / 100.0
    }
    #[inline]
    fn bottom_feet(&self, i: usize) -> u16 {
        self.bottom_feet.get(i)
    }
    #[inline]
    fn top_feet(&self, i: usize) -> u16 {
        self.top_feet.get(i)
    }
    #[inline]
    fn dbz_tenths(&self, i: usize) -> i16 {
        self.dbz_tenths.get(i)
    }
    #[inline]
    fn phase(&self, i: usize) -> u8 {
        self.phase.get(i)
    }
    #[inline]
    fn surface_phase(&self, i: usize) -> u8 {
        self.surface_phase.get(i)
    }
    #[inline]
    fn footprint_x_span(&self, i: usize) -> u16 {
        self.span_x.get(i).max(1)
    }
    #[inline]
    fn footprint_y_span(&self, i: usize) -> u16 {
        self.span_y.get(i).max(1)
    }
}

// ---------------------------------------------------------------------------
// EchoTopSource trait — abstracts indexed cell access for prepare
// ---------------------------------------------------------------------------

/// Indexed access to echo-top SoA columns. Implemented for `EchoTopInput`
/// (test fixture) and `FbEchoTopView` (zero-copy FlatBuffers path).
pub trait EchoTopSource {
    fn len(&self) -> usize;
    fn x_nm(&self, i: usize) -> f32;
    fn z_nm(&self, i: usize) -> f32;
    /// Echo-top height as f64 feet (u16→f64 widening for the curvature subtract).
    fn top18_feet(&self, i: usize) -> f64;
    fn top30_feet(&self, i: usize) -> f64;
    fn top50_feet(&self, i: usize) -> f64;
    fn footprint_x_nm(&self) -> f32;
    fn footprint_y_nm(&self) -> f32;
}

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

impl EchoTopSource for EchoTopInput {
    #[inline]
    fn len(&self) -> usize {
        self.x_nm
            .len()
            .min(self.z_nm.len())
            .min(self.top18_feet.len())
            .min(self.top30_feet.len())
            .min(self.top50_feet.len())
    }
    #[inline]
    fn x_nm(&self, i: usize) -> f32 {
        self.x_nm[i]
    }
    #[inline]
    fn z_nm(&self, i: usize) -> f32 {
        self.z_nm[i]
    }
    #[inline]
    fn top18_feet(&self, i: usize) -> f64 {
        f64::from(self.top18_feet[i])
    }
    #[inline]
    fn top30_feet(&self, i: usize) -> f64 {
        f64::from(self.top30_feet[i])
    }
    #[inline]
    fn top50_feet(&self, i: usize) -> f64 {
        f64::from(self.top50_feet[i])
    }
    #[inline]
    fn footprint_x_nm(&self) -> f32 {
        self.footprint_x_nm
    }
    #[inline]
    fn footprint_y_nm(&self) -> f32 {
        self.footprint_y_nm
    }
}

// ---------------------------------------------------------------------------
// FbEchoTopView — zero-copy view over FlatBuffers EchoTops SoA columns
// ---------------------------------------------------------------------------

/// Zero-copy view over a FlatBuffers `EchoTops` payload's SoA columns.
/// Top heights are u16 in the buffer — widened to f64 inline at access time.
/// All columns are presence/length-validated once in `new`, so indexed access
/// is branch-free apart from the slice bounds assert.
#[allow(dead_code)] // used only in wasm target
#[derive(Debug)]
pub(crate) struct FbEchoTopView<'a> {
    count: usize,
    et_x_nm: flatbuffers::Vector<'a, f32>,
    et_z_nm: flatbuffers::Vector<'a, f32>,
    top18: flatbuffers::Vector<'a, u16>,
    top30: flatbuffers::Vector<'a, u16>,
    top50: flatbuffers::Vector<'a, u16>,
    fp_x: f32,
    fp_y: f32,
}

#[allow(dead_code)] // used only in wasm target
impl<'a> FbEchoTopView<'a> {
    pub(crate) fn new(fb: &crate::generated::EchoTops<'a>) -> Result<Self, String> {
        let count = fb.cell_count() as usize;
        Ok(Self {
            count,
            et_x_nm: require_column(fb.x_nm(), count, "AVET", "x_nm")?,
            et_z_nm: require_column(fb.z_nm(), count, "AVET", "z_nm")?,
            top18: require_column(fb.top18_feet(), count, "AVET", "top18_feet")?,
            top30: require_column(fb.top30_feet(), count, "AVET", "top30_feet")?,
            top50: require_column(fb.top50_feet(), count, "AVET", "top50_feet")?,
            fp_x: fb.footprint_x_milli() as f32 / 1000.0,
            fp_y: fb.footprint_y_milli() as f32 / 1000.0,
        })
    }
}

impl EchoTopSource for FbEchoTopView<'_> {
    #[inline]
    fn len(&self) -> usize {
        self.count
    }
    #[inline]
    fn x_nm(&self, i: usize) -> f32 {
        self.et_x_nm.get(i)
    }
    #[inline]
    fn z_nm(&self, i: usize) -> f32 {
        self.et_z_nm.get(i)
    }
    #[inline]
    fn top18_feet(&self, i: usize) -> f64 {
        self.top18.get(i) as f64
    }
    #[inline]
    fn top30_feet(&self, i: usize) -> f64 {
        self.top30.get(i) as f64
    }
    #[inline]
    fn top50_feet(&self, i: usize) -> f64 {
        self.top50.get(i) as f64
    }
    #[inline]
    fn footprint_x_nm(&self) -> f32 {
        self.fp_x
    }
    #[inline]
    fn footprint_y_nm(&self) -> f32 {
        self.fp_y
    }
}

/// Prepared echo-top surfaces in SoA layout, ready for direct JS Float32Array handoff.
#[derive(Debug, Clone)]
pub struct EchoTopSurfacesSoA {
    pub count18: usize,
    pub count30: usize,
    pub count50: usize,
    pub x18: Vec<f32>,
    pub z18: Vec<f32>,
    pub y_base18: Vec<f32>,
    pub x30: Vec<f32>,
    pub z30: Vec<f32>,
    pub y_base30: Vec<f32>,
    pub x50: Vec<f32>,
    pub z50: Vec<f32>,
    pub y_base50: Vec<f32>,
    pub footprint_x_nm: f32,
    pub footprint_y_nm: f32,
}

// ---------------------------------------------------------------------------
// 1. prepare_volume
// ---------------------------------------------------------------------------

/// Filter, curvature-correct, and declutter an MRMS decoded volume.
///
/// Mirrors `prepareVolumeData()` from `nexrad-preprocess.ts:59-181`.
///
/// Generic over `VolumeSource` so the binary path can pass an `FbVolumeView`
/// that reads directly from the FlatBuffers buffer (zero allocation).
pub fn prepare_volume(
    volume: &impl VolumeSource,
    min_dbz_tenths: i16,
    phase_mode: PhaseMode,
    declutter_mode: DeclutterMode,
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> PreparedVolume {
    let count = volume.voxel_count();
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
        let d = volume.dbz_tenths(i);
        if d < min_dbz_tenths {
            continue;
        }

        let x = volume.x_nm(i);
        let z = volume.z_nm(i);
        let fp_x = volume.footprint_x_span(i);
        let fp_y = volume.footprint_y_span(i);

        // Validate: position must be finite, footprint spans > 0
        if !x.is_finite() || !z.is_finite() || fp_x == 0 || fp_y == 0 {
            continue;
        }

        let curvature_drop_feet = if apply_earth_curvature {
            earth_curvature_drop_nm(x as f64, z as f64, ref_lat) * FEET_PER_NM
        } else {
            0.0
        };

        let c_bottom = f64::from(volume.bottom_feet(i)) - curvature_drop_feet;
        let c_top = f64::from(volume.top_feet(i)) - curvature_drop_feet;
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
            PhaseMode::Surface => volume.surface_phase(i),
            PhaseMode::Altitude => volume.phase(i),
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

/// Declutter filter matching the web client's All/Low/Mid/High bands.
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
///
/// Generic over `VolumeSource` for zero-copy FlatBuffers reads.
pub fn build_cross_section(
    volume: &impl VolumeSource,
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
        let vx = volume.x_nm(idx) as f64;
        let vz = volume.z_nm(idx) as f64;

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
        let v_dbz = volume.dbz_tenths(idx) as f32 / 10.0;

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

/// Build renderable echo-top surfaces in SoA layout from echo-top data.
///
/// Generic over `EchoTopSource` so the binary path can use `FbEchoTopView`
/// for zero-copy reads. Applies curvature correction and outputs SoA Vecs
/// ready for direct Float32Array handoff to JS.
pub fn prepare_echo_top_surfaces(
    input: &impl EchoTopSource,
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> EchoTopSurfacesSoA {
    let count = input.len();

    let mut x18 = Vec::new();
    let mut z18 = Vec::new();
    let mut y18 = Vec::new();
    let mut x30 = Vec::new();
    let mut z30 = Vec::new();
    let mut y30 = Vec::new();
    let mut x50 = Vec::new();
    let mut z50 = Vec::new();
    let mut y50 = Vec::new();

    for i in 0..count {
        let x = input.x_nm(i);
        let z = input.z_nm(i);
        if !x.is_finite() || !z.is_finite() {
            continue;
        }

        let curvature_drop_feet = if apply_earth_curvature {
            earth_curvature_drop_nm(x as f64, z as f64, ref_lat) * FEET_PER_NM
        } else {
            0.0
        };

        let t18 = f64::max(0.0, input.top18_feet(i) - curvature_drop_feet);
        let t30 = f64::max(0.0, input.top30_feet(i) - curvature_drop_feet);
        let t50 = f64::max(0.0, input.top50_feet(i) - curvature_drop_feet);

        if t18 > 0.0 {
            x18.push(x);
            z18.push(z);
            y18.push((t18 * ALTITUDE_SCALE) as f32);
        }
        if t30 > 0.0 {
            x30.push(x);
            z30.push(z);
            y30.push((t30 * ALTITUDE_SCALE) as f32);
        }
        if t50 > 0.0 {
            x50.push(x);
            z50.push(z);
            y50.push((t50 * ALTITUDE_SCALE) as f32);
        }
    }

    EchoTopSurfacesSoA {
        count18: x18.len(),
        count30: x30.len(),
        count50: x50.len(),
        x18,
        z18,
        y_base18: y18,
        x30,
        z30,
        y_base30: y30,
        x50,
        z50,
        y_base50: y50,
        footprint_x_nm: input.footprint_x_nm(),
        footprint_y_nm: input.footprint_y_nm(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PHASE_RAIN, PHASE_SNOW};

    /// Helper: build a minimal `TestVolume` with n voxels using provided field closures.
    fn make_volume(
        n: usize,
        x_nm: impl Fn(usize) -> f32,
        z_nm: impl Fn(usize) -> f32,
        bottom_feet: impl Fn(usize) -> u16,
        top_feet: impl Fn(usize) -> u16,
        dbz_tenths: impl Fn(usize) -> i16,
        phase: impl Fn(usize) -> u8,
        surface_phase: impl Fn(usize) -> u8,
    ) -> TestVolume {
        TestVolume {
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            true,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Surface,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::Low,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let prepared = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let result = build_cross_section(&vol, &prepared, (1.0, 0.0), (0.0, 1.0), 60.0, 5.0);
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
        let prepared = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        assert_eq!(prepared.valid_count, 1);

        let result = build_cross_section(&vol, &prepared, (1.0, 0.0), (0.0, 1.0), 60.0, 5.0);
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

        // The grid should have 35.0 dBZ at these bins (350 tenths / 10)
        for y in y0..=y1 {
            let grid_idx = y * CROSS_SECTION_BINS_X + bin_x;
            assert!(
                (cs.grid[grid_idx] - 35.0).abs() < 0.01,
                "grid[{y}][{bin_x}] = {}, expected 35.0",
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
        let prepared = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );

        let result = build_cross_section(&vol, &prepared, (1.0, 0.0), (0.0, 1.0), 60.0, 5.0);
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

        assert_eq!(result.count18, 3);
        assert_eq!(result.count30, 3);
        assert_eq!(result.count50, 3);

        // Verify y_base = top_feet * ALTITUDE_SCALE for the first cell
        let expected_y18 = 5000.0 * ALTITUDE_SCALE;
        assert!(
            (f64::from(result.y_base18[0]) - expected_y18).abs() < 1e-4,
            "y_base18[0] {} != expected {}",
            result.y_base18[0],
            expected_y18
        );

        let expected_y30 = 3000.0 * ALTITUDE_SCALE;
        assert!(
            (f64::from(result.y_base30[0]) - expected_y30).abs() < 1e-4,
            "y_base30[0] {} != expected {}",
            result.y_base30[0],
            expected_y30
        );

        let expected_y50 = 1000.0 * ALTITUDE_SCALE;
        assert!(
            (f64::from(result.y_base50[0]) - expected_y50).abs() < 1e-4,
            "y_base50[0] {} != expected {}",
            result.y_base50[0],
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
        assert_eq!(result.count18, 1);

        // Curvature drop at 60 NM ≈ 0.52 NM * 6076.12 ≈ 3160 feet
        let raw_y = raw_top as f64 * ALTITUDE_SCALE;
        let corrected_y = f64::from(result.y_base18[0]);
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
        assert_eq!(result.count18, 0);
        assert_eq!(result.count30, 0);
        assert_eq!(result.count50, 0);
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
        assert_eq!(result.count18, 0);
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::Mid,
            false,
            40.0,
        );
        assert_eq!(result.valid_count, 1);
        assert_eq!(
            result.declutter_count, 1,
            "center 15k ft should pass Mid filter"
        );
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
        let result = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::High,
            false,
            40.0,
        );
        assert_eq!(result.valid_count, 1);
        assert_eq!(
            result.declutter_count, 1,
            "center 30k ft should pass High filter"
        );

        // Same voxel with Low mode → excluded
        let result2 = prepare_volume(
            &vol,
            50,
            PhaseMode::Altitude,
            DeclutterMode::Low,
            false,
            40.0,
        );
        assert_eq!(
            result2.declutter_count, 0,
            "center 30k ft should NOT pass Low filter"
        );
    }

    // -----------------------------------------------------------------------
    // FbVolumeView / FbEchoTopView construction-time validation tests
    // -----------------------------------------------------------------------

    /// Build an AVMR FB payload with `declared_count` bricks whose columns
    /// have `columns_len` entries; `include_phase` controls column presence.
    fn build_volume_payload(
        declared_count: u32,
        columns_len: usize,
        include_phase: bool,
    ) -> Vec<u8> {
        use crate::generated::{MrmsVolume as FbMrmsVolume, MrmsVolumeArgs};
        let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(256);
        let n = columns_len;
        let x: Vec<i16> = (0..n).map(|i| (i as i16 + 1) * 100).collect();
        let z: Vec<i16> = (0..n).map(|i| -((i as i16 + 1) * 50)).collect();
        let bottom: Vec<u16> = vec![3000; n];
        let top: Vec<u16> = vec![5000; n];
        let dbz: Vec<i16> = vec![350; n];
        let phase: Vec<u8> = vec![PHASE_RAIN; n];
        let surface: Vec<u8> = vec![PHASE_SNOW; n];
        let span_x: Vec<u16> = vec![0; n]; // exercises the max(1) clamp
        let span_y: Vec<u16> = vec![2; n];

        let x_vec = builder.create_vector(&x);
        let z_vec = builder.create_vector(&z);
        let bottom_vec = builder.create_vector(&bottom);
        let top_vec = builder.create_vector(&top);
        let dbz_vec = builder.create_vector(&dbz);
        let phase_vec = if include_phase {
            Some(builder.create_vector(&phase))
        } else {
            None
        };
        let surface_vec = builder.create_vector(&surface);
        let span_x_vec = builder.create_vector(&span_x);
        let span_y_vec = builder.create_vector(&span_y);

        let vol = FbMrmsVolume::create(
            &mut builder,
            &MrmsVolumeArgs {
                brick_count: declared_count,
                x_hundredths: Some(x_vec),
                z_hundredths: Some(z_vec),
                bottom_feet: Some(bottom_vec),
                top_feet: Some(top_vec),
                dbz_tenths: Some(dbz_vec),
                phase: phase_vec,
                surface_phase: Some(surface_vec),
                span_x: Some(span_x_vec),
                span_y: Some(span_y_vec),
                ..Default::default()
            },
        );
        builder.finish(vol, Some("AVMR"));
        builder.finished_data().to_vec()
    }

    fn build_echo_top_payload(
        declared_count: u32,
        columns_len: usize,
        include_top50: bool,
    ) -> Vec<u8> {
        use crate::generated::{EchoTops as FbEchoTops, EchoTopsArgs};
        let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(256);
        let n = columns_len;
        let x: Vec<f32> = (0..n).map(|i| i as f32 + 1.0).collect();
        let z: Vec<f32> = vec![0.0; n];
        let tops: Vec<u16> = vec![9000; n];

        let x_vec = builder.create_vector(&x);
        let z_vec = builder.create_vector(&z);
        let top18_vec = builder.create_vector(&tops);
        let top30_vec = builder.create_vector(&tops);
        let top50_vec = if include_top50 {
            Some(builder.create_vector(&tops))
        } else {
            None
        };

        let et = FbEchoTops::create(
            &mut builder,
            &EchoTopsArgs {
                cell_count: declared_count,
                footprint_x_milli: 50,
                footprint_y_milli: 60,
                x_nm: Some(x_vec),
                z_nm: Some(z_vec),
                top18_feet: Some(top18_vec),
                top30_feet: Some(top30_vec),
                top50_feet: top50_vec,
                ..Default::default()
            },
        );
        builder.finish(et, Some("AVET"));
        builder.finished_data().to_vec()
    }

    #[test]
    fn fb_volume_view_validates_and_reads_columns() {
        let data = build_volume_payload(2, 2, true);
        let fb = flatbuffers::root::<crate::generated::MrmsVolume>(&data).unwrap();
        let view = FbVolumeView::new(&fb).expect("valid payload should build a view");

        assert_eq!(view.voxel_count(), 2);
        assert!((view.x_nm(0) - 1.0).abs() < 1e-6);
        assert!((view.x_nm(1) - 2.0).abs() < 1e-6);
        assert!((view.z_nm(0) - (-0.5)).abs() < 1e-6);
        assert_eq!(view.bottom_feet(1), 3000);
        assert_eq!(view.top_feet(1), 5000);
        assert_eq!(view.dbz_tenths(0), 350);
        assert_eq!(view.phase(0), PHASE_RAIN);
        assert_eq!(view.surface_phase(0), PHASE_SNOW);
        assert_eq!(view.footprint_x_span(0), 1, "zero span clamps to 1");
        assert_eq!(view.footprint_y_span(0), 2);
    }

    #[test]
    fn fb_volume_view_rejects_length_mismatch() {
        let data = build_volume_payload(3, 2, true);
        let fb = flatbuffers::root::<crate::generated::MrmsVolume>(&data).unwrap();
        let error = FbVolumeView::new(&fb).expect_err("length mismatch must fail");
        assert!(error.contains("x_hundredths"), "unexpected error: {error}");
    }

    #[test]
    fn fb_volume_view_rejects_missing_column() {
        let data = build_volume_payload(2, 2, false);
        let fb = flatbuffers::root::<crate::generated::MrmsVolume>(&data).unwrap();
        let error = FbVolumeView::new(&fb).expect_err("missing phase column must fail");
        assert!(error.contains("phase"), "unexpected error: {error}");
    }

    #[test]
    fn fb_echo_top_view_validates_and_reads_columns() {
        let data = build_echo_top_payload(2, 2, true);
        let fb = flatbuffers::root::<crate::generated::EchoTops>(&data).unwrap();
        let view = FbEchoTopView::new(&fb).expect("valid payload should build a view");

        assert_eq!(view.len(), 2);
        assert!((view.x_nm(1) - 2.0).abs() < 1e-6);
        assert!((view.top18_feet(0) - 9000.0).abs() < 1e-9);
        assert!((view.footprint_x_nm() - 0.05).abs() < 1e-6);
        assert!((view.footprint_y_nm() - 0.06).abs() < 1e-6);
    }

    #[test]
    fn fb_echo_top_view_rejects_missing_column() {
        let data = build_echo_top_payload(2, 2, false);
        let fb = flatbuffers::root::<crate::generated::EchoTops>(&data).unwrap();
        let error = FbEchoTopView::new(&fb).expect_err("missing top50 column must fail");
        assert!(error.contains("top50_feet"), "unexpected error: {error}");
    }

    #[test]
    fn fb_echo_top_view_rejects_length_mismatch() {
        let data = build_echo_top_payload(5, 2, true);
        let fb = flatbuffers::root::<crate::generated::EchoTops>(&data).unwrap();
        let error = FbEchoTopView::new(&fb).expect_err("length mismatch must fail");
        assert!(error.contains("x_nm"), "unexpected error: {error}");
    }

    #[test]
    fn fb_volume_view_empty_payload() {
        let data = build_volume_payload(0, 0, true);
        let fb = flatbuffers::root::<crate::generated::MrmsVolume>(&data).unwrap();
        let view = FbVolumeView::new(&fb).expect("empty volume should build a view");
        assert_eq!(view.voxel_count(), 0);
    }

    #[test]
    fn fb_volume_view_rejects_invalid_buffer() {
        let data = vec![0xFFu8; 4];
        assert!(flatbuffers::root::<crate::generated::MrmsVolume>(&data).is_err());
    }

    #[test]
    fn fb_echo_top_view_empty_payload() {
        let data = build_echo_top_payload(0, 0, true);
        let fb = flatbuffers::root::<crate::generated::EchoTops>(&data).unwrap();
        let view = FbEchoTopView::new(&fb).expect("empty echo-tops should build a view");
        assert_eq!(view.len(), 0);
    }

    #[test]
    fn fb_echo_top_view_rejects_invalid_buffer() {
        let data = vec![0xFFu8; 4];
        assert!(flatbuffers::root::<crate::generated::EchoTops>(&data).is_err());
    }
}
