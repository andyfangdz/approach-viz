// Wire-format and prepare/render constants shared across the MRMS and traffic
// pipelines. Wire constants must match the runtime-rs encoder exactly.
// Production decode is the zero-copy FlatBuffers views in `mrms_preprocess`
// and `traffic_merge`; there is no owned SoA decode path.

// ---------------------------------------------------------------------------
// MRMS encoding constant (used by brick merge pipeline)
// ---------------------------------------------------------------------------

pub const MRMS_WIRE_DBZ_QUANT_STEP_TENTHS: i16 = 50;

// ---------------------------------------------------------------------------
// Phase codes
// ---------------------------------------------------------------------------

pub const PHASE_RAIN: u8 = 0;
pub const PHASE_MIXED: u8 = 1;
pub const PHASE_SNOW: u8 = 2;

// ---------------------------------------------------------------------------
// Rendering constants
// ---------------------------------------------------------------------------

pub use crate::coords::{ALTITUDE_SCALE, FEET_PER_NM};

// ---------------------------------------------------------------------------
// MRMS preprocess constants (Rust prepare pass)
// ---------------------------------------------------------------------------

pub const DECLUTTER_LOW_MAX_FEET: f64 = 10_000.0;
pub const DECLUTTER_MID_MAX_FEET: f64 = 25_000.0;
pub const CROSS_SECTION_BINS_X: usize = 120;
pub const CROSS_SECTION_BINS_Y: usize = 56;
pub const MIN_VOXEL_HEIGHT_NM: f64 = 0.04;

/// Phase selection mode (mirrors TS NexradPhaseMode).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhaseMode {
    Altitude,
    Surface,
}

/// Declutter mode (mirrors TS NexradDeclutterMode).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeclutterMode {
    All,
    Low,
    Mid,
    High,
}

/// Prepared volume output (mirrors TS NexradPreparedVolumeData).
#[derive(Debug, Clone)]
pub struct PreparedVolume {
    pub valid_count: usize,
    pub valid_indices: Vec<i32>,
    pub y_base: Vec<f32>,
    pub height_base: Vec<f32>,
    pub corrected_bottom_feet: Vec<f32>,
    pub corrected_top_feet: Vec<f32>,
    pub effective_phase_code: Vec<u8>,
    pub declutter_indices: Vec<i32>,
    pub declutter_count: usize,
}

/// Cross-section 2D grid (mirrors TS CrossSectionData).
#[derive(Debug, Clone)]
pub struct CrossSectionData {
    pub bins_x: usize,
    pub bins_y: usize,
    pub grid: Vec<f32>,
    pub phase_grid: Vec<i8>,
    pub top_envelope_feet: Vec<f32>,
    pub max_top_feet: f32,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn altitude_scale_consistent() {
        assert!((ALTITUDE_SCALE - 1.0 / 6076.12).abs() < 1e-12);
        assert!((FEET_PER_NM * ALTITUDE_SCALE - 1.0).abs() < 1e-10);
    }
}
