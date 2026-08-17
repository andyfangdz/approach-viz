// Wire format constants and decoded types shared between decoders.
//
// These are the *decoded* (client-side) types, not server storage types.
// Wire constants must match the runtime-rs encoder exactly.

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

// ---------------------------------------------------------------------------
// Decoded types
// ---------------------------------------------------------------------------

/// Decoded MRMS volume from AVMR FlatBuffers payload (SoA layout).
#[derive(Debug, Clone)]
pub struct DecodedMrmsVolume {
    pub voxel_count: u32,
    pub layer_count: u16,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub footprint_x_nm: f32,
    pub footprint_y_nm: f32,
    pub layer_voxel_counts: Vec<u32>,
    // SoA parallel arrays
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

/// Decoded traffic aircraft from AVTR wire format.
#[derive(Debug, Clone)]
pub struct DecodedTrafficAircraft {
    pub hex: String,
    pub flight: Option<String>,
    pub lat: f32,
    pub lon: f32,
    pub altitude_feet: Option<f32>,
    pub ground_speed_kt: Option<f32>,
    pub track_deg: Option<f32>,
    pub last_seen_seconds: Option<f32>,
    pub is_on_ground: bool,
}

#[derive(Debug, Clone)]
pub struct DecodedTrafficHistoryPoint {
    pub lat: f32,
    pub lon: f32,
    pub altitude_feet: f32,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone)]
pub struct DecodedTrafficHistoryGroup {
    pub hex: String,
    pub points: Vec<DecodedTrafficHistoryPoint>,
}

#[derive(Debug, Clone)]
pub struct DecodedTrafficPayload {
    pub aircraft: Vec<DecodedTrafficAircraft>,
    pub history_groups: Vec<DecodedTrafficHistoryGroup>,
    pub fetched_at_ms: i64,
    pub source: Option<String>,
    pub error: Option<String>,
}

/// Decoded echo-top from AVET wire format (SoA layout).
#[derive(Debug, Clone)]
pub struct DecodedEchoTop {
    pub cell_count: u32,
    pub source_cell_count: u32,
    pub footprint_x_nm: f32,
    pub footprint_y_nm: f32,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub max_top18_feet: u16,
    pub max_top30_feet: u16,
    pub max_top50_feet: u16,
    pub max_top60_feet: u16,
    // SoA parallel arrays
    pub x_nm: Vec<f32>,
    pub z_nm: Vec<f32>,
    pub top18_feet: Vec<u16>,
    pub top30_feet: Vec<u16>,
    pub top50_feet: Vec<u16>,
    pub top60_feet: Vec<u16>,
}

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
