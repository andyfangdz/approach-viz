// AVMR binary wire-format decoder.
//
// Decodes the binary payload produced by `services/runtime-rs/src/api/wire.rs`
// into a `DecodedMrmsVolume` (SoA layout).

use crate::types::{
    DecodedMrmsVolume, MRMS_WIRE_HEADER_BYTES, MRMS_WIRE_MAGIC, MRMS_WIRE_RECORD_BYTES,
    MRMS_WIRE_V2_VERSION, MRMS_WIRE_V3_VERSION,
};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MrmsDecodeError {
    TooShort { needed: usize, got: usize },
    BadMagic([u8; 4]),
    UnsupportedVersion(u16),
    VoxelOverflow { claimed: u32, available: usize },
}

impl std::fmt::Display for MrmsDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MrmsDecodeError::TooShort { needed, got } => {
                write!(f, "MRMS payload too short: need {needed} bytes, got {got}")
            }
            MrmsDecodeError::BadMagic(magic) => {
                write!(
                    f,
                    "MRMS payload bad magic: expected {:?}, got {:?}",
                    MRMS_WIRE_MAGIC, magic
                )
            }
            MrmsDecodeError::UnsupportedVersion(v) => {
                write!(f, "MRMS payload unsupported version: {v}")
            }
            MrmsDecodeError::VoxelOverflow { claimed, available } => {
                write!(
                    f,
                    "MRMS payload voxel overflow: header claims {claimed} voxels \
                     but only {available} bytes of record data available"
                )
            }
        }
    }
}

impl std::error::Error for MrmsDecodeError {}

// ---------------------------------------------------------------------------
// Inline LE read helpers (no external dependency)
// ---------------------------------------------------------------------------

#[inline]
fn read_u16_le(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

#[inline]
fn read_i16_le(data: &[u8], offset: usize) -> i16 {
    i16::from_le_bytes([data[offset], data[offset + 1]])
}

#[inline]
fn read_u32_le(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]])
}

#[inline]
fn read_i64_le(data: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    ])
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/// Decode an AVMR binary payload into a `DecodedMrmsVolume`.
///
/// The wire format is documented in the task spec and produced by
/// `services/runtime-rs/src/api/wire.rs`.
pub fn decode_mrms_binary(data: &[u8]) -> Result<DecodedMrmsVolume, MrmsDecodeError> {
    // --- Header validation ---
    if data.len() < MRMS_WIRE_HEADER_BYTES {
        return Err(MrmsDecodeError::TooShort {
            needed: MRMS_WIRE_HEADER_BYTES,
            got: data.len(),
        });
    }

    let mut magic = [0u8; 4];
    magic.copy_from_slice(&data[0..4]);
    if magic != MRMS_WIRE_MAGIC {
        return Err(MrmsDecodeError::BadMagic(magic));
    }

    let version = read_u16_le(data, 4);
    if version != MRMS_WIRE_V2_VERSION && version != MRMS_WIRE_V3_VERSION {
        return Err(MrmsDecodeError::UnsupportedVersion(version));
    }

    let header_bytes = read_u16_le(data, 6) as usize;
    // offset 8..12 = source voxel count (unused in decode)
    let voxel_count = read_u32_le(data, 12);
    let layer_count = read_u16_le(data, 16);
    let record_bytes_from_header = read_u16_le(data, 18) as usize;
    let generated_at_ms = read_i64_le(data, 20);
    let scan_time_ms = read_i64_le(data, 28);
    let footprint_x_thousandths = read_u16_le(data, 36);
    let footprint_y_thousandths = read_u16_le(data, 38);

    let record_bytes = if record_bytes_from_header > 0 {
        record_bytes_from_header
    } else {
        MRMS_WIRE_RECORD_BYTES
    };

    // --- Compute offsets and validate size ---
    let layer_counts_offset = header_bytes;
    let records_offset = layer_counts_offset + (layer_count as usize) * 4;
    let needed_bytes = records_offset + (voxel_count as usize) * record_bytes;

    if data.len() < records_offset {
        return Err(MrmsDecodeError::TooShort {
            needed: records_offset,
            got: data.len(),
        });
    }

    let available_record_bytes = data.len() - records_offset;
    if (voxel_count as usize) * record_bytes > available_record_bytes {
        return Err(MrmsDecodeError::VoxelOverflow {
            claimed: voxel_count,
            available: available_record_bytes,
        });
    }

    // This is technically redundant after the overflow check but keeps
    // the error messages consistent with the TS decoder.
    if data.len() < needed_bytes {
        return Err(MrmsDecodeError::TooShort {
            needed: needed_bytes,
            got: data.len(),
        });
    }

    // --- Layer counts ---
    let mut layer_voxel_counts = Vec::with_capacity(layer_count as usize);
    for i in 0..layer_count as usize {
        layer_voxel_counts.push(read_u32_le(data, layer_counts_offset + i * 4));
    }

    // --- Voxel records (SoA) ---
    let n = voxel_count as usize;
    let mut x_nm = Vec::with_capacity(n);
    let mut z_nm = Vec::with_capacity(n);
    let mut bottom_feet = Vec::with_capacity(n);
    let mut top_feet = Vec::with_capacity(n);
    let mut dbz_tenths = Vec::with_capacity(n);
    let mut phase = Vec::with_capacity(n);
    let mut surface_phase = Vec::with_capacity(n);
    let mut footprint_x_span = Vec::with_capacity(n);
    let mut footprint_y_span = Vec::with_capacity(n);

    let footprint_x_nm = footprint_x_thousandths as f32 / 1000.0;
    let footprint_y_nm = footprint_y_thousandths as f32 / 1000.0;

    for i in 0..n {
        let offset = records_offset + i * record_bytes;

        // x, z: i16 LE scaled /100 -> NM
        x_nm.push(read_i16_le(data, offset) as f32 / 100.0);
        z_nm.push(read_i16_le(data, offset + 2) as f32 / 100.0);

        // bottom/top feet: u16 LE direct
        bottom_feet.push(read_u16_le(data, offset + 4));
        top_feet.push(read_u16_le(data, offset + 6));

        // dBZ tenths: i16 LE direct
        dbz_tenths.push(read_i16_le(data, offset + 8));

        // Phase code
        let p_code = data[offset + 10];
        phase.push(p_code);

        // Span X, Y
        let span_x = read_u16_le(data, offset + 12).max(1);
        let span_y = read_u16_le(data, offset + 14).max(1);
        footprint_x_span.push(span_x);
        footprint_y_span.push(span_y);

        // Surface phase: V3 reads from offset 18, V2 copies from phase
        let s_phase = if version >= MRMS_WIRE_V3_VERSION {
            data[offset + 18]
        } else {
            p_code
        };
        surface_phase.push(s_phase);
    }

    Ok(DecodedMrmsVolume {
        version,
        voxel_count,
        layer_count,
        generated_at_ms,
        scan_time_ms,
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

    /// Build a minimal valid AVMR header + layer counts section.
    /// Caller appends voxel records.
    fn build_test_header(
        version: u16,
        voxel_count: u32,
        layer_count: u16,
        generated_at_ms: i64,
        scan_time_ms: i64,
        footprint_x_thousandths: u16,
        footprint_y_thousandths: u16,
        layer_voxel_counts: &[u32],
    ) -> Vec<u8> {
        let header_bytes = MRMS_WIRE_HEADER_BYTES as u16;
        let record_bytes = MRMS_WIRE_RECORD_BYTES as u16;
        let mut buf = vec![0u8; MRMS_WIRE_HEADER_BYTES + layer_count as usize * 4];

        // Magic
        buf[0..4].copy_from_slice(&MRMS_WIRE_MAGIC);
        // Version
        buf[4..6].copy_from_slice(&version.to_le_bytes());
        // Header bytes
        buf[6..8].copy_from_slice(&header_bytes.to_le_bytes());
        // Source voxel count (unused)
        buf[8..12].copy_from_slice(&0u32.to_le_bytes());
        // Brick/voxel count
        buf[12..16].copy_from_slice(&voxel_count.to_le_bytes());
        // Layer count
        buf[16..18].copy_from_slice(&layer_count.to_le_bytes());
        // Record bytes
        buf[18..20].copy_from_slice(&record_bytes.to_le_bytes());
        // Generated at ms
        buf[20..28].copy_from_slice(&generated_at_ms.to_le_bytes());
        // Scan time ms
        buf[28..36].copy_from_slice(&scan_time_ms.to_le_bytes());
        // Footprint X (thousandths)
        buf[36..38].copy_from_slice(&footprint_x_thousandths.to_le_bytes());
        // Footprint Y (thousandths)
        buf[38..40].copy_from_slice(&footprint_y_thousandths.to_le_bytes());
        // Reserved bytes 40-63 are already zero

        // Layer counts section
        let layer_counts_offset = MRMS_WIRE_HEADER_BYTES;
        for (i, &count) in layer_voxel_counts.iter().enumerate() {
            let offset = layer_counts_offset + i * 4;
            buf[offset..offset + 4].copy_from_slice(&count.to_le_bytes());
        }

        buf
    }

    /// Build a single 20-byte voxel record.
    fn build_voxel_record(
        x_hundredths: i16,
        z_hundredths: i16,
        bottom_feet: u16,
        top_feet: u16,
        dbz_tenths: i16,
        phase: u8,
        level_start: u8,
        span_x: u16,
        span_y: u16,
        span_z: u16,
        surface_phase: u8,
    ) -> [u8; 20] {
        let mut rec = [0u8; 20];
        rec[0..2].copy_from_slice(&x_hundredths.to_le_bytes());
        rec[2..4].copy_from_slice(&z_hundredths.to_le_bytes());
        rec[4..6].copy_from_slice(&bottom_feet.to_le_bytes());
        rec[6..8].copy_from_slice(&top_feet.to_le_bytes());
        rec[8..10].copy_from_slice(&dbz_tenths.to_le_bytes());
        rec[10] = phase;
        rec[11] = level_start;
        rec[12..14].copy_from_slice(&span_x.to_le_bytes());
        rec[14..16].copy_from_slice(&span_y.to_le_bytes());
        rec[16..18].copy_from_slice(&span_z.to_le_bytes());
        rec[18] = surface_phase;
        rec[19] = 0; // reserved
        rec
    }

    #[test]
    fn reject_truncated() {
        let data = vec![0u8; 32]; // < 64 bytes
        let err = decode_mrms_binary(&data).unwrap_err();
        assert_eq!(
            err,
            MrmsDecodeError::TooShort {
                needed: 64,
                got: 32
            }
        );
    }

    #[test]
    fn reject_bad_magic() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(b"NOPE");
        let err = decode_mrms_binary(&data).unwrap_err();
        assert_eq!(err, MrmsDecodeError::BadMagic(*b"NOPE"));
    }

    #[test]
    fn reject_unsupported_version() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(&MRMS_WIRE_MAGIC);
        data[4..6].copy_from_slice(&99u16.to_le_bytes());
        let err = decode_mrms_binary(&data).unwrap_err();
        assert_eq!(err, MrmsDecodeError::UnsupportedVersion(99));
    }

    #[test]
    fn decode_empty_volume() {
        let buf = build_test_header(
            MRMS_WIRE_V3_VERSION,
            0,  // voxel_count
            1,  // layer_count
            1000000,
            2000000,
            500,  // footprint_x thousandths
            600,  // footprint_y thousandths
            &[0], // layer voxel counts
        );

        let vol = decode_mrms_binary(&buf).unwrap();
        assert_eq!(vol.version, MRMS_WIRE_V3_VERSION);
        assert_eq!(vol.voxel_count, 0);
        assert_eq!(vol.layer_count, 1);
        assert_eq!(vol.generated_at_ms, 1000000);
        assert_eq!(vol.scan_time_ms, 2000000);
        assert!((vol.footprint_x_nm - 0.5).abs() < 1e-6);
        assert!((vol.footprint_y_nm - 0.6).abs() < 1e-6);
        assert_eq!(vol.layer_voxel_counts, vec![0]);
        assert!(vol.x_nm.is_empty());
        assert!(vol.z_nm.is_empty());
        assert!(vol.bottom_feet.is_empty());
        assert!(vol.top_feet.is_empty());
        assert!(vol.dbz_tenths.is_empty());
        assert!(vol.phase.is_empty());
        assert!(vol.surface_phase.is_empty());
        assert!(vol.footprint_x_span.is_empty());
        assert!(vol.footprint_y_span.is_empty());
    }

    #[test]
    fn decode_single_voxel_v3() {
        let generated_at: i64 = 1_700_000_000_000;
        let scan_time: i64 = 1_699_999_990_000;
        let footprint_x_thousandths: u16 = 250; // 0.25 NM
        let footprint_y_thousandths: u16 = 300; // 0.30 NM

        let mut buf = build_test_header(
            MRMS_WIRE_V3_VERSION,
            1,  // voxel_count
            1,  // layer_count
            generated_at,
            scan_time,
            footprint_x_thousandths,
            footprint_y_thousandths,
            &[1], // layer voxel counts
        );

        // Build a voxel: x=500 hundredths (5.00 NM), z=-300 hundredths (-3.00 NM)
        let rec = build_voxel_record(
            500,    // x_hundredths -> 5.00 NM
            -300,   // z_hundredths -> -3.00 NM
            3000,   // bottom_feet
            5000,   // top_feet
            350,    // dbz_tenths (35.0 dBZ)
            PHASE_RAIN,
            0,      // level_start
            2,      // span_x
            3,      // span_y
            1,      // span_z
            PHASE_SNOW, // surface_phase (V3: different from phase)
        );
        buf.extend_from_slice(&rec);

        let vol = decode_mrms_binary(&buf).unwrap();

        assert_eq!(vol.version, MRMS_WIRE_V3_VERSION);
        assert_eq!(vol.voxel_count, 1);
        assert_eq!(vol.layer_count, 1);
        assert_eq!(vol.generated_at_ms, generated_at);
        assert_eq!(vol.scan_time_ms, scan_time);

        // Footprint from header
        assert!((vol.footprint_x_nm - 0.25).abs() < 1e-6);
        assert!((vol.footprint_y_nm - 0.30).abs() < 1e-6);

        // x_nm round-trip: 500 / 100 = 5.00
        assert!((vol.x_nm[0] - 5.00).abs() < 1e-6);
        // z_nm round-trip: -300 / 100 = -3.00
        assert!((vol.z_nm[0] - (-3.00)).abs() < 1e-6);

        // bottom/top feet exact
        assert_eq!(vol.bottom_feet[0], 3000);
        assert_eq!(vol.top_feet[0], 5000);

        // dBZ tenths exact
        assert_eq!(vol.dbz_tenths[0], 350);

        // Phase codes: V3 has separate surface_phase
        assert_eq!(vol.phase[0], PHASE_RAIN);
        assert_eq!(vol.surface_phase[0], PHASE_SNOW);

        // Spans
        assert_eq!(vol.footprint_x_span[0], 2);
        assert_eq!(vol.footprint_y_span[0], 3);

        // Layer voxel counts
        assert_eq!(vol.layer_voxel_counts, vec![1]);
    }

    #[test]
    fn decode_v2_copies_phase_to_surface() {
        let mut buf = build_test_header(
            MRMS_WIRE_V2_VERSION,
            1,
            1,
            0,
            0,
            100,
            100,
            &[1],
        );

        let rec = build_voxel_record(
            100,   // x
            200,   // z
            1000,  // bottom
            2000,  // top
            250,   // dbz_tenths
            PHASE_SNOW,
            0,
            1,
            1,
            1,
            PHASE_RAIN, // surface_phase field in record (ignored for V2)
        );
        buf.extend_from_slice(&rec);

        let vol = decode_mrms_binary(&buf).unwrap();

        // V2 should copy phase to surface_phase (ignoring offset 18)
        assert_eq!(vol.phase[0], PHASE_SNOW);
        assert_eq!(vol.surface_phase[0], PHASE_SNOW);
        assert_eq!(vol.version, MRMS_WIRE_V2_VERSION);
    }

    #[test]
    fn voxel_overflow_detected() {
        // Header claims 1000 voxels but we only provide room for 1
        let mut buf = build_test_header(
            MRMS_WIRE_V3_VERSION,
            1000,
            1,
            0,
            0,
            100,
            100,
            &[1000],
        );

        // Append only 1 voxel record (20 bytes) instead of 1000
        let rec = build_voxel_record(0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0);
        buf.extend_from_slice(&rec);

        let err = decode_mrms_binary(&buf).unwrap_err();
        match err {
            MrmsDecodeError::VoxelOverflow { claimed, available } => {
                assert_eq!(claimed, 1000);
                // Available = buf.len() - records_offset
                // records_offset = 64 + 1*4 = 68
                // buf.len() = 68 + 20 = 88
                // available = 88 - 68 = 20
                assert_eq!(available, 20);
            }
            other => panic!("Expected VoxelOverflow, got {other:?}"),
        }
    }
}
