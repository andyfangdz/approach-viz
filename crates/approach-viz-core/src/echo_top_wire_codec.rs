// AVET binary wire-format decoder.
//
// Decodes the binary payload produced by `services/runtime-rs/src/api/wire.rs`
// into a `DecodedEchoTop` (SoA layout).

use crate::types::{
    DecodedEchoTop, ECHO_TOP_WIRE_CELL_BYTES, ECHO_TOP_WIRE_HEADER_BYTES, ECHO_TOP_WIRE_MAGIC,
    ECHO_TOP_WIRE_VERSION,
};
use crate::wire_helpers::{read_f32_le, read_i64_le, read_u16_le, read_u32_le};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EchoTopDecodeError {
    TooShort { needed: usize, got: usize },
    BadMagic([u8; 4]),
    UnsupportedVersion(u16),
    CellOverflow { claimed: u32, available: usize },
}

impl std::fmt::Display for EchoTopDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EchoTopDecodeError::TooShort { needed, got } => {
                write!(f, "AVET payload too short: need {needed} bytes, got {got}")
            }
            EchoTopDecodeError::BadMagic(magic) => {
                write!(
                    f,
                    "AVET payload bad magic: expected {:?}, got {:?}",
                    ECHO_TOP_WIRE_MAGIC, magic
                )
            }
            EchoTopDecodeError::UnsupportedVersion(v) => {
                write!(f, "AVET payload unsupported version: {v}")
            }
            EchoTopDecodeError::CellOverflow { claimed, available } => {
                write!(
                    f,
                    "AVET payload cell overflow: header claims {claimed} cells \
                     but only {available} bytes of cell data available"
                )
            }
        }
    }
}

impl std::error::Error for EchoTopDecodeError {}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/// Decode an AVET binary payload into a `DecodedEchoTop`.
///
/// Wire format (all little-endian):
///   Header (64 bytes):
///     [0..4]   magic "AVET"
///     [4..6]   version (u16) = 1
///     [6..8]   header_bytes (u16) = 64
///     [8..12]  cell_count (u32)
///     [12..16] source_cell_count (u32)
///     [16..18] footprint_x_milli (u16) — NM * 1000
///     [18..20] footprint_y_milli (u16)
///     [20..28] generated_at_ms (i64)
///     [28..36] scan_time_ms (i64)
///     [36..38] max_top18_feet (u16)
///     [38..40] max_top30_feet (u16)
///     [40..42] max_top50_feet (u16)
///     [42..44] max_top60_feet (u16)
///     [44..64] reserved (zero)
///   Cell records (16 bytes each):
///     [0..4]   x_nm (f32)
///     [4..8]   z_nm (f32)
///     [8..10]  top18_feet (u16)
///     [10..12] top30_feet (u16)
///     [12..14] top50_feet (u16)
///     [14..16] top60_feet (u16)
pub fn decode_echo_top_binary(data: &[u8]) -> Result<DecodedEchoTop, EchoTopDecodeError> {
    if data.len() < ECHO_TOP_WIRE_HEADER_BYTES {
        return Err(EchoTopDecodeError::TooShort {
            needed: ECHO_TOP_WIRE_HEADER_BYTES,
            got: data.len(),
        });
    }

    let mut magic = [0u8; 4];
    magic.copy_from_slice(&data[0..4]);
    if magic != ECHO_TOP_WIRE_MAGIC {
        return Err(EchoTopDecodeError::BadMagic(magic));
    }

    let version = read_u16_le(data, 4);
    if version != ECHO_TOP_WIRE_VERSION {
        return Err(EchoTopDecodeError::UnsupportedVersion(version));
    }

    let header_bytes = read_u16_le(data, 6) as usize;
    let cell_count = read_u32_le(data, 8);
    let source_cell_count = read_u32_le(data, 12);
    let footprint_x_milli = read_u16_le(data, 16);
    let footprint_y_milli = read_u16_le(data, 18);
    let generated_at_ms = read_i64_le(data, 20);
    let scan_time_ms = read_i64_le(data, 28);
    let max_top18_feet = read_u16_le(data, 36);
    let max_top30_feet = read_u16_le(data, 38);
    let max_top50_feet = read_u16_le(data, 40);
    let max_top60_feet = read_u16_le(data, 42);

    let records_offset = header_bytes.max(ECHO_TOP_WIRE_HEADER_BYTES);
    let needed_bytes = records_offset + (cell_count as usize) * ECHO_TOP_WIRE_CELL_BYTES;

    if data.len() < records_offset {
        return Err(EchoTopDecodeError::TooShort {
            needed: records_offset,
            got: data.len(),
        });
    }

    let available = data.len() - records_offset;
    if (cell_count as usize) * ECHO_TOP_WIRE_CELL_BYTES > available {
        return Err(EchoTopDecodeError::CellOverflow {
            claimed: cell_count,
            available,
        });
    }

    if data.len() < needed_bytes {
        return Err(EchoTopDecodeError::TooShort {
            needed: needed_bytes,
            got: data.len(),
        });
    }

    let n = cell_count as usize;
    let mut x_nm = Vec::with_capacity(n);
    let mut z_nm = Vec::with_capacity(n);
    let mut top18_feet = Vec::with_capacity(n);
    let mut top30_feet = Vec::with_capacity(n);
    let mut top50_feet = Vec::with_capacity(n);
    let mut top60_feet = Vec::with_capacity(n);

    for i in 0..n {
        let offset = records_offset + i * ECHO_TOP_WIRE_CELL_BYTES;
        x_nm.push(read_f32_le(data, offset));
        z_nm.push(read_f32_le(data, offset + 4));
        top18_feet.push(read_u16_le(data, offset + 8));
        top30_feet.push(read_u16_le(data, offset + 10));
        top50_feet.push(read_u16_le(data, offset + 12));
        top60_feet.push(read_u16_le(data, offset + 14));
    }

    Ok(DecodedEchoTop {
        cell_count,
        source_cell_count,
        footprint_x_nm: footprint_x_milli as f32 / 1000.0,
        footprint_y_nm: footprint_y_milli as f32 / 1000.0,
        generated_at_ms,
        scan_time_ms,
        max_top18_feet,
        max_top30_feet,
        max_top50_feet,
        max_top60_feet,
        x_nm,
        z_nm,
        top18_feet,
        top30_feet,
        top50_feet,
        top60_feet,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid AVET header. Caller appends cell records.
    fn build_test_header(
        cell_count: u32,
        source_cell_count: u32,
        footprint_x_milli: u16,
        footprint_y_milli: u16,
        generated_at_ms: i64,
        scan_time_ms: i64,
        max_top18: u16,
        max_top30: u16,
        max_top50: u16,
        max_top60: u16,
    ) -> Vec<u8> {
        let mut buf = vec![0u8; ECHO_TOP_WIRE_HEADER_BYTES];
        buf[0..4].copy_from_slice(&ECHO_TOP_WIRE_MAGIC);
        buf[4..6].copy_from_slice(&ECHO_TOP_WIRE_VERSION.to_le_bytes());
        buf[6..8].copy_from_slice(&(ECHO_TOP_WIRE_HEADER_BYTES as u16).to_le_bytes());
        buf[8..12].copy_from_slice(&cell_count.to_le_bytes());
        buf[12..16].copy_from_slice(&source_cell_count.to_le_bytes());
        buf[16..18].copy_from_slice(&footprint_x_milli.to_le_bytes());
        buf[18..20].copy_from_slice(&footprint_y_milli.to_le_bytes());
        buf[20..28].copy_from_slice(&generated_at_ms.to_le_bytes());
        buf[28..36].copy_from_slice(&scan_time_ms.to_le_bytes());
        buf[36..38].copy_from_slice(&max_top18.to_le_bytes());
        buf[38..40].copy_from_slice(&max_top30.to_le_bytes());
        buf[40..42].copy_from_slice(&max_top50.to_le_bytes());
        buf[42..44].copy_from_slice(&max_top60.to_le_bytes());
        buf
    }

    /// Build a single 16-byte cell record.
    fn build_cell_record(
        x_nm: f32,
        z_nm: f32,
        top18: u16,
        top30: u16,
        top50: u16,
        top60: u16,
    ) -> [u8; 16] {
        let mut rec = [0u8; 16];
        rec[0..4].copy_from_slice(&x_nm.to_le_bytes());
        rec[4..8].copy_from_slice(&z_nm.to_le_bytes());
        rec[8..10].copy_from_slice(&top18.to_le_bytes());
        rec[10..12].copy_from_slice(&top30.to_le_bytes());
        rec[12..14].copy_from_slice(&top50.to_le_bytes());
        rec[14..16].copy_from_slice(&top60.to_le_bytes());
        rec
    }

    #[test]
    fn reject_truncated() {
        let data = vec![0u8; 32];
        let err = decode_echo_top_binary(&data).unwrap_err();
        assert_eq!(
            err,
            EchoTopDecodeError::TooShort {
                needed: 64,
                got: 32
            }
        );
    }

    #[test]
    fn reject_bad_magic() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(b"NOPE");
        let err = decode_echo_top_binary(&data).unwrap_err();
        assert_eq!(err, EchoTopDecodeError::BadMagic(*b"NOPE"));
    }

    #[test]
    fn reject_unsupported_version() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(&ECHO_TOP_WIRE_MAGIC);
        data[4..6].copy_from_slice(&99u16.to_le_bytes());
        let err = decode_echo_top_binary(&data).unwrap_err();
        assert_eq!(err, EchoTopDecodeError::UnsupportedVersion(99));
    }

    #[test]
    fn decode_empty() {
        let buf = build_test_header(0, 0, 50, 50, 1000000, 2000000, 0, 0, 0, 0);
        let et = decode_echo_top_binary(&buf).unwrap();
        assert_eq!(et.cell_count, 0);
        assert_eq!(et.source_cell_count, 0);
        assert!((et.footprint_x_nm - 0.05).abs() < 1e-6);
        assert!((et.footprint_y_nm - 0.05).abs() < 1e-6);
        assert_eq!(et.generated_at_ms, 1000000);
        assert_eq!(et.scan_time_ms, 2000000);
        assert!(et.x_nm.is_empty());
    }

    #[test]
    fn decode_single_cell() {
        let gen_at: i64 = 1_700_000_000_000;
        let scan_time: i64 = 1_699_999_990_000;
        let mut buf = build_test_header(1, 100, 50, 60, gen_at, scan_time, 45000, 40000, 35000, 30000);
        let rec = build_cell_record(5.5, -3.2, 12000, 10000, 8000, 6000);
        buf.extend_from_slice(&rec);

        let et = decode_echo_top_binary(&buf).unwrap();
        assert_eq!(et.cell_count, 1);
        assert_eq!(et.source_cell_count, 100);
        assert!((et.footprint_x_nm - 0.05).abs() < 1e-6);
        assert!((et.footprint_y_nm - 0.06).abs() < 1e-6);
        assert_eq!(et.generated_at_ms, gen_at);
        assert_eq!(et.scan_time_ms, scan_time);
        assert_eq!(et.max_top18_feet, 45000);
        assert_eq!(et.max_top30_feet, 40000);
        assert_eq!(et.max_top50_feet, 35000);
        assert_eq!(et.max_top60_feet, 30000);

        assert!((et.x_nm[0] - 5.5).abs() < 1e-6);
        assert!((et.z_nm[0] - (-3.2)).abs() < 1e-5);
        assert_eq!(et.top18_feet[0], 12000);
        assert_eq!(et.top30_feet[0], 10000);
        assert_eq!(et.top50_feet[0], 8000);
        assert_eq!(et.top60_feet[0], 6000);
    }

    #[test]
    fn decode_multiple_cells() {
        let mut buf = build_test_header(3, 300, 100, 100, 0, 0, 50000, 45000, 40000, 35000);
        for i in 0..3 {
            let rec = build_cell_record(
                i as f32 * 10.0,
                i as f32 * -5.0,
                (i + 1) * 5000,
                (i + 1) * 4000,
                (i + 1) * 3000,
                (i + 1) * 2000,
            );
            buf.extend_from_slice(&rec);
        }

        let et = decode_echo_top_binary(&buf).unwrap();
        assert_eq!(et.cell_count, 3);
        assert_eq!(et.x_nm.len(), 3);
        assert!((et.x_nm[2] - 20.0).abs() < 1e-6);
        assert_eq!(et.top18_feet[2], 15000);
    }

    #[test]
    fn cell_overflow_detected() {
        let mut buf = build_test_header(1000, 1000, 50, 50, 0, 0, 0, 0, 0, 0);
        // Only append 1 cell record instead of 1000
        let rec = build_cell_record(1.0, 2.0, 100, 200, 300, 400);
        buf.extend_from_slice(&rec);

        let err = decode_echo_top_binary(&buf).unwrap_err();
        match err {
            EchoTopDecodeError::CellOverflow { claimed, available } => {
                assert_eq!(claimed, 1000);
                assert_eq!(available, 16); // 1 cell = 16 bytes
            }
            other => panic!("Expected CellOverflow, got {other:?}"),
        }
    }
}
