// AVMR binary wire-format decoder.
//
// Decodes the binary payload produced by `services/runtime-rs/src/api/wire.rs`
// into a `DecodedMrmsVolume` (SoA layout).

#[cfg(not(target_endian = "little"))]
compile_error!("Wire format decoders assume little-endian byte order");

use crate::types::{
    DecodedMrmsVolume, MRMS_WIRE_HEADER_BYTES, MRMS_WIRE_MAGIC,
    MRMS_WIRE_VERSION,
};
use crate::wire_helpers::{read_i16_le, read_i64_le, read_u16_le, read_u32_le};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MrmsDecodeError {
    TooShort { needed: usize, got: usize },
    BadMagic([u8; 4]),
    UnsupportedVersion(u16),
    VoxelOverflow { claimed: u32, available: usize },
    InvalidHeaderBytes { header_bytes: u16 },
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
            MrmsDecodeError::InvalidHeaderBytes { header_bytes } => {
                write!(
                    f,
                    "MRMS payload invalid header_bytes: {header_bytes} < minimum {MRMS_WIRE_HEADER_BYTES}"
                )
            }
        }
    }
}

impl std::error::Error for MrmsDecodeError {}

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
    if version != MRMS_WIRE_VERSION {
        return Err(MrmsDecodeError::UnsupportedVersion(version));
    }

    let header_bytes_raw = read_u16_le(data, 6);
    if (header_bytes_raw as usize) < MRMS_WIRE_HEADER_BYTES {
        return Err(MrmsDecodeError::InvalidHeaderBytes {
            header_bytes: header_bytes_raw,
        });
    }
    let header_bytes = header_bytes_raw as usize;
    // offset 8..12 = source voxel count (unused in decode)
    let voxel_count = read_u32_le(data, 12);
    let layer_count = read_u16_le(data, 16);
    // offset 18..20 = record_bytes (0 in v4 SoA layout, ignored)
    let generated_at_ms = read_i64_le(data, 20);
    let scan_time_ms = read_i64_le(data, 28);
    let footprint_x_thousandths = read_u16_le(data, 36);
    let footprint_y_thousandths = read_u16_le(data, 38);

    // --- Compute SoA offsets and validate size ---
    let n = voxel_count as usize;
    let layer_counts_offset = header_bytes;
    let records_offset = layer_counts_offset + (layer_count as usize) * 4;

    // SoA layout: i16[n] x, i16[n] z, u16[n] bottom, u16[n] top, i16[n] dbz,
    //             u8[n] phase, u8[n] surface_phase,
    //             u16[n] span_x, u16[n] span_y, u16[n] span_z
    // Per-brick: 2+2+2+2+2+1+1+2+2+2 = 18 bytes
    let soa_total_bytes = n * 18;
    let needed_bytes = records_offset + soa_total_bytes;

    if data.len() < records_offset {
        return Err(MrmsDecodeError::TooShort {
            needed: records_offset,
            got: data.len(),
        });
    }

    let available_record_bytes = data.len() - records_offset;
    if soa_total_bytes > available_record_bytes {
        return Err(MrmsDecodeError::VoxelOverflow {
            claimed: voxel_count,
            available: available_record_bytes,
        });
    }

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

    // --- SoA field offsets ---
    let off_x = records_offset;
    let off_z = off_x + n * 2;
    let off_bottom = off_z + n * 2;
    let off_top = off_bottom + n * 2;
    let off_dbz = off_top + n * 2;
    let off_phase = off_dbz + n * 2;
    let off_surface = off_phase + n;
    let off_sx = off_surface + n;
    let off_sy = off_sx + n * 2;
    let off_sz = off_sy + n * 2;
    // total_needed = off_sz + n * 2 == needed_bytes (already validated)
    debug_assert_eq!(off_sz + n * 2, needed_bytes);

    // --- Voxel records (SoA) ---
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
        x_nm.push(read_i16_le(data, off_x + i * 2) as f32 / 100.0);
    }
    for i in 0..n {
        z_nm.push(read_i16_le(data, off_z + i * 2) as f32 / 100.0);
    }
    for i in 0..n {
        bottom_feet.push(read_u16_le(data, off_bottom + i * 2));
    }
    for i in 0..n {
        top_feet.push(read_u16_le(data, off_top + i * 2));
    }
    for i in 0..n {
        dbz_tenths.push(read_i16_le(data, off_dbz + i * 2));
    }
    for i in 0..n {
        phase.push(data[off_phase + i]);
    }
    for i in 0..n {
        surface_phase.push(data[off_surface + i]);
    }
    for i in 0..n {
        footprint_x_span.push(read_u16_le(data, off_sx + i * 2).max(1));
    }
    for i in 0..n {
        footprint_y_span.push(read_u16_le(data, off_sy + i * 2).max(1));
    }
    // Note: span_z is written by the encoder but not consumed by the decoder's
    // output struct (DecodedMrmsVolume has no span_z field). The bytes are
    // validated by the size check above but intentionally skipped here.

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

    /// Append SoA-encoded bricks to a buffer (matches v4 wire layout).
    fn append_soa_bricks(buf: &mut Vec<u8>, bricks: &[TestBrick]) {
        for b in bricks { buf.extend_from_slice(&b.x_hundredths.to_le_bytes()); }
        for b in bricks { buf.extend_from_slice(&b.z_hundredths.to_le_bytes()); }
        for b in bricks { buf.extend_from_slice(&b.bottom_feet.to_le_bytes()); }
        for b in bricks { buf.extend_from_slice(&b.top_feet.to_le_bytes()); }
        for b in bricks { buf.extend_from_slice(&b.dbz_tenths.to_le_bytes()); }
        for b in bricks { buf.push(b.phase); }
        for b in bricks { buf.push(b.surface_phase); }
        for b in bricks { buf.extend_from_slice(&b.span_x.to_le_bytes()); }
        for b in bricks { buf.extend_from_slice(&b.span_y.to_le_bytes()); }
        for b in bricks { buf.extend_from_slice(&b.span_z.to_le_bytes()); }
    }

    /// Build a minimal valid AVMR v4 header + layer counts section.
    /// Caller appends SoA brick data via `append_soa_bricks`.
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
        let record_bytes: u16 = 0; // v4 SoA layout
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
        // Record bytes (0 for v4 SoA)
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

        // V3 is no longer supported
        let mut data_v3 = vec![0u8; 64];
        data_v3[0..4].copy_from_slice(&MRMS_WIRE_MAGIC);
        data_v3[4..6].copy_from_slice(&3u16.to_le_bytes());
        let err_v3 = decode_mrms_binary(&data_v3).unwrap_err();
        assert_eq!(err_v3, MrmsDecodeError::UnsupportedVersion(3));
    }

    #[test]
    fn decode_empty_volume() {
        let buf = build_test_header(
            MRMS_WIRE_VERSION,
            0,  // voxel_count
            1,  // layer_count
            1000000,
            2000000,
            500,  // footprint_x thousandths
            600,  // footprint_y thousandths
            &[0], // layer voxel counts
        );

        let vol = decode_mrms_binary(&buf).unwrap();
        assert_eq!(vol.version, MRMS_WIRE_VERSION);
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
    fn decode_single_voxel_v4() {
        let generated_at: i64 = 1_700_000_000_000;
        let scan_time: i64 = 1_699_999_990_000;
        let footprint_x_thousandths: u16 = 250; // 0.25 NM
        let footprint_y_thousandths: u16 = 300; // 0.30 NM

        let mut buf = build_test_header(
            MRMS_WIRE_VERSION,
            1,  // voxel_count
            1,  // layer_count
            generated_at,
            scan_time,
            footprint_x_thousandths,
            footprint_y_thousandths,
            &[1], // layer voxel counts
        );

        append_soa_bricks(&mut buf, &[TestBrick {
            x_hundredths: 500,     // -> 5.00 NM
            z_hundredths: -300,    // -> -3.00 NM
            bottom_feet: 3000,
            top_feet: 5000,
            dbz_tenths: 350,       // 35.0 dBZ
            phase: PHASE_RAIN,
            surface_phase: PHASE_SNOW,
            span_x: 2,
            span_y: 3,
            span_z: 1,
        }]);

        let vol = decode_mrms_binary(&buf).unwrap();

        assert_eq!(vol.version, MRMS_WIRE_VERSION);
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

        // Phase codes: separate surface_phase
        assert_eq!(vol.phase[0], PHASE_RAIN);
        assert_eq!(vol.surface_phase[0], PHASE_SNOW);

        // Spans
        assert_eq!(vol.footprint_x_span[0], 2);
        assert_eq!(vol.footprint_y_span[0], 3);

        // Layer voxel counts
        assert_eq!(vol.layer_voxel_counts, vec![1]);
    }

    #[test]
    fn voxel_overflow_detected() {
        // Header claims 1000 voxels but we only provide room for 1
        let mut buf = build_test_header(
            MRMS_WIRE_VERSION,
            1000,
            1,
            0,
            0,
            100,
            100,
            &[1000],
        );

        // Append only 1 brick (18 bytes in SoA) instead of 1000
        append_soa_bricks(&mut buf, &[TestBrick {
            x_hundredths: 0,
            z_hundredths: 0,
            bottom_feet: 0,
            top_feet: 0,
            dbz_tenths: 0,
            phase: 0,
            surface_phase: 0,
            span_x: 1,
            span_y: 1,
            span_z: 1,
        }]);

        let err = decode_mrms_binary(&buf).unwrap_err();
        match err {
            MrmsDecodeError::VoxelOverflow { claimed, available } => {
                assert_eq!(claimed, 1000);
                // Available = buf.len() - records_offset
                // records_offset = 64 + 1*4 = 68
                // buf.len() = 68 + 18 = 86
                // available = 86 - 68 = 18
                assert_eq!(available, 18);
            }
            other => panic!("Expected VoxelOverflow, got {other:?}"),
        }
    }
}
