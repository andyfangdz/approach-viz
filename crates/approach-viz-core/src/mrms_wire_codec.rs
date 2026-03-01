// AVMR FlatBuffers wire-format decoder.
//
// Decodes the FlatBuffers payload produced by
// `services/runtime-rs/src/weather/encoding.rs` into a `DecodedMrmsVolume` (SoA layout).

use crate::types::DecodedMrmsVolume;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MrmsDecodeError {
    InvalidPayload(String),
    VoxelOverflow { claimed: u32, available: usize },
}

impl std::fmt::Display for MrmsDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MrmsDecodeError::InvalidPayload(msg) => {
                write!(f, "MRMS payload invalid: {msg}")
            }
            MrmsDecodeError::VoxelOverflow { claimed, available } => {
                write!(
                    f,
                    "MRMS payload voxel overflow: header claims {claimed} voxels \
                     but only {available} elements in arrays"
                )
            }
        }
    }
}

impl std::error::Error for MrmsDecodeError {}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/// Decode a FlatBuffers AVMR payload into a `DecodedMrmsVolume`.
///
/// The FlatBuffers schema uses i16 hundredths for x/z and stores all
/// SoA columns as separate vectors.
pub fn decode_mrms_fb(data: &[u8]) -> Result<DecodedMrmsVolume, MrmsDecodeError> {
    let vol = flatbuffers::root::<crate::generated::MrmsVolume>(data)
        .map_err(|e| MrmsDecodeError::InvalidPayload(format!("FlatBuffers verification failed: {e}")))?;

    let n = vol.brick_count() as usize;
    let layer_count = vol.layer_count();

    let layer_voxel_counts = vol
        .layer_voxel_counts()
        .map(|v| v.iter().collect())
        .unwrap_or_default();

    let footprint_x_nm = vol.footprint_x_milli() as f32 / 1000.0;
    let footprint_y_nm = vol.footprint_y_milli() as f32 / 1000.0;

    let x_nm: Vec<f32> = vol
        .x_hundredths()
        .map(|v| v.iter().map(|h| h as f32 / 100.0).collect())
        .unwrap_or_default();
    let z_nm: Vec<f32> = vol
        .z_hundredths()
        .map(|v| v.iter().map(|h| h as f32 / 100.0).collect())
        .unwrap_or_default();
    let bottom_feet: Vec<u16> = vol
        .bottom_feet()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    let top_feet: Vec<u16> = vol
        .top_feet()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    let dbz_tenths: Vec<i16> = vol
        .dbz_tenths()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    let phase: Vec<u8> = vol
        .phase()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    let surface_phase: Vec<u8> = vol
        .surface_phase()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    let mut footprint_x_span: Vec<u16> = vol
        .span_x()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    for v in &mut footprint_x_span {
        *v = (*v).max(1);
    }
    let mut footprint_y_span: Vec<u16> = vol
        .span_y()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    for v in &mut footprint_y_span {
        *v = (*v).max(1);
    }

    // Validate array lengths match brick_count
    if x_nm.len() != n
        || z_nm.len() != n
        || bottom_feet.len() != n
        || top_feet.len() != n
        || dbz_tenths.len() != n
        || phase.len() != n
        || surface_phase.len() != n
        || footprint_x_span.len() != n
        || footprint_y_span.len() != n
    {
        return Err(MrmsDecodeError::VoxelOverflow {
            claimed: n as u32,
            available: 0,
        });
    }

    Ok(DecodedMrmsVolume {
        voxel_count: n as u32,
        layer_count,
        generated_at_ms: vol.generated_at_ms(),
        scan_time_ms: vol.scan_time_ms(),
        footprint_x_nm,
        footprint_y_nm,
        layer_voxel_counts,
        x_nm,
        z_nm,
        bottom_feet,
        top_feet,
        dbz_tenths,
        phase,
        surface_phase,
        footprint_x_span,
        footprint_y_span,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PHASE_RAIN, PHASE_SNOW};

    struct TestBrick {
        x_hundredths: i16,
        z_hundredths: i16,
        bottom_feet: u16,
        top_feet: u16,
        dbz_tenths: i16,
        phase: u8,
        surface_phase: u8,
        span_x: u16,
        span_y: u16,
        span_z: u16,
    }

    fn build_fb_volume(
        brick_count: u32,
        layer_count: u16,
        generated_at_ms: i64,
        scan_time_ms: i64,
        footprint_x_milli: u16,
        footprint_y_milli: u16,
        layer_voxel_counts: &[u32],
        bricks: &[TestBrick],
    ) -> Vec<u8> {
        use crate::generated::{MrmsVolume, MrmsVolumeArgs};
        let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(256);

        let lvc = builder.create_vector(layer_voxel_counts);
        let x: Vec<i16> = bricks.iter().map(|b| b.x_hundredths).collect();
        let z: Vec<i16> = bricks.iter().map(|b| b.z_hundredths).collect();
        let bottom: Vec<u16> = bricks.iter().map(|b| b.bottom_feet).collect();
        let top: Vec<u16> = bricks.iter().map(|b| b.top_feet).collect();
        let dbz: Vec<i16> = bricks.iter().map(|b| b.dbz_tenths).collect();
        let ph: Vec<u8> = bricks.iter().map(|b| b.phase).collect();
        let sp: Vec<u8> = bricks.iter().map(|b| b.surface_phase).collect();
        let sx: Vec<u16> = bricks.iter().map(|b| b.span_x).collect();
        let sy: Vec<u16> = bricks.iter().map(|b| b.span_y).collect();
        let sz: Vec<u16> = bricks.iter().map(|b| b.span_z).collect();

        let x_vec = builder.create_vector(&x);
        let z_vec = builder.create_vector(&z);
        let bottom_vec = builder.create_vector(&bottom);
        let top_vec = builder.create_vector(&top);
        let dbz_vec = builder.create_vector(&dbz);
        let ph_vec = builder.create_vector(&ph);
        let sp_vec = builder.create_vector(&sp);
        let sx_vec = builder.create_vector(&sx);
        let sy_vec = builder.create_vector(&sy);
        let sz_vec = builder.create_vector(&sz);

        let vol = MrmsVolume::create(
            &mut builder,
            &MrmsVolumeArgs {
                source_voxel_count: brick_count,
                brick_count,
                layer_count,
                generated_at_ms,
                scan_time_ms,
                footprint_x_milli,
                footprint_y_milli,
                min_dbz_tenths: 50,
                max_range_tenths_nm: 1200,
                tile_size: 64,
                encoding_hint: 50,
                origin_lat_microdeg: 35_150_000,
                origin_lon_microdeg: -109_550_000,
                layer_voxel_counts: Some(lvc),
                x_hundredths: Some(x_vec),
                z_hundredths: Some(z_vec),
                bottom_feet: Some(bottom_vec),
                top_feet: Some(top_vec),
                dbz_tenths: Some(dbz_vec),
                phase: Some(ph_vec),
                surface_phase: Some(sp_vec),
                span_x: Some(sx_vec),
                span_y: Some(sy_vec),
                span_z: Some(sz_vec),
            },
        );
        builder.finish(vol, Some("AVMR"));
        builder.finished_data().to_vec()
    }

    #[test]
    fn fb_decode_empty_volume() {
        let data = build_fb_volume(0, 1, 1_000_000, 2_000_000, 500, 600, &[0], &[]);
        let vol = decode_mrms_fb(&data).unwrap();
        assert_eq!(vol.voxel_count, 0);
        assert_eq!(vol.layer_count, 1);
        assert_eq!(vol.generated_at_ms, 1_000_000);
        assert_eq!(vol.scan_time_ms, 2_000_000);
        assert!((vol.footprint_x_nm - 0.5).abs() < 1e-6);
        assert!((vol.footprint_y_nm - 0.6).abs() < 1e-6);
        assert_eq!(vol.layer_voxel_counts, vec![0]);
        assert!(vol.x_nm.is_empty());
    }

    #[test]
    fn fb_decode_single_brick() {
        let generated_at: i64 = 1_700_000_000_000;
        let scan_time: i64 = 1_699_999_990_000;
        let data = build_fb_volume(
            1, 1, generated_at, scan_time, 250, 300, &[1],
            &[TestBrick {
                x_hundredths: 500,
                z_hundredths: -300,
                bottom_feet: 3000,
                top_feet: 5000,
                dbz_tenths: 350,
                phase: PHASE_RAIN,
                surface_phase: PHASE_SNOW,
                span_x: 2,
                span_y: 3,
                span_z: 1,
            }],
        );

        let vol = decode_mrms_fb(&data).unwrap();
        assert_eq!(vol.voxel_count, 1);
        assert!((vol.x_nm[0] - 5.00).abs() < 1e-6);
        assert!((vol.z_nm[0] - (-3.00)).abs() < 1e-6);
        assert_eq!(vol.bottom_feet[0], 3000);
        assert_eq!(vol.top_feet[0], 5000);
        assert_eq!(vol.dbz_tenths[0], 350);
        assert_eq!(vol.phase[0], PHASE_RAIN);
        assert_eq!(vol.surface_phase[0], PHASE_SNOW);
        assert_eq!(vol.footprint_x_span[0], 2);
        assert_eq!(vol.footprint_y_span[0], 3);
        assert_eq!(vol.generated_at_ms, generated_at);
        assert_eq!(vol.scan_time_ms, scan_time);
        assert!((vol.footprint_x_nm - 0.25).abs() < 1e-6);
        assert!((vol.footprint_y_nm - 0.30).abs() < 1e-6);
    }

    #[test]
    fn fb_decode_multiple_bricks() {
        let data = build_fb_volume(
            2, 2, 0, 0, 1000, 1000, &[1, 1],
            &[
                TestBrick {
                    x_hundredths: 100,
                    z_hundredths: 200,
                    bottom_feet: 1000,
                    top_feet: 2000,
                    dbz_tenths: 200,
                    phase: PHASE_RAIN,
                    surface_phase: PHASE_RAIN,
                    span_x: 1,
                    span_y: 1,
                    span_z: 1,
                },
                TestBrick {
                    x_hundredths: -500,
                    z_hundredths: 700,
                    bottom_feet: 5000,
                    top_feet: 8000,
                    dbz_tenths: 450,
                    phase: PHASE_SNOW,
                    surface_phase: PHASE_SNOW,
                    span_x: 3,
                    span_y: 4,
                    span_z: 2,
                },
            ],
        );

        let vol = decode_mrms_fb(&data).unwrap();
        assert_eq!(vol.voxel_count, 2);
        assert!((vol.x_nm[0] - 1.0).abs() < 1e-6);
        assert!((vol.x_nm[1] - (-5.0)).abs() < 1e-6);
        assert_eq!(vol.dbz_tenths[0], 200);
        assert_eq!(vol.dbz_tenths[1], 450);
        assert_eq!(vol.footprint_x_span[1], 3);
        assert_eq!(vol.footprint_y_span[1], 4);
    }

    #[test]
    fn reject_invalid_payload() {
        // Too short for any valid FlatBuffers payload
        let data = vec![0xFFu8; 4];
        assert!(decode_mrms_fb(&data).is_err());
    }
}
