// AVET FlatBuffers wire-format decoder.
//
// Decodes the FlatBuffers payload produced by
// `services/runtime-rs/src/weather/encoding.rs` into a `DecodedEchoTop` (SoA layout).

use crate::types::DecodedEchoTop;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EchoTopDecodeError {
    InvalidPayload(String),
    CellOverflow { claimed: u32, available: usize },
}

impl std::fmt::Display for EchoTopDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EchoTopDecodeError::InvalidPayload(msg) => {
                write!(f, "AVET payload invalid: {msg}")
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

/// Decode an AVET FlatBuffers payload into a `DecodedEchoTop`.
pub fn decode_echo_top_fb(data: &[u8]) -> Result<DecodedEchoTop, EchoTopDecodeError> {
    let fb = flatbuffers::root::<crate::generated::EchoTops>(data).map_err(|e| {
        EchoTopDecodeError::InvalidPayload(format!("FlatBuffers verification failed: {e}"))
    })?;

    let cell_count = fb.cell_count();
    let n = cell_count as usize;

    let x_nm_slice = fb.x_nm().ok_or(EchoTopDecodeError::CellOverflow {
        claimed: cell_count,
        available: 0,
    })?;
    let z_nm_slice = fb.z_nm().ok_or(EchoTopDecodeError::CellOverflow {
        claimed: cell_count,
        available: 0,
    })?;
    let top18_slice = fb.top18_feet().ok_or(EchoTopDecodeError::CellOverflow {
        claimed: cell_count,
        available: 0,
    })?;
    let top30_slice = fb.top30_feet().ok_or(EchoTopDecodeError::CellOverflow {
        claimed: cell_count,
        available: 0,
    })?;
    let top50_slice = fb.top50_feet().ok_or(EchoTopDecodeError::CellOverflow {
        claimed: cell_count,
        available: 0,
    })?;
    let top60_slice = fb.top60_feet().ok_or(EchoTopDecodeError::CellOverflow {
        claimed: cell_count,
        available: 0,
    })?;

    if x_nm_slice.len() != n
        || z_nm_slice.len() != n
        || top18_slice.len() != n
        || top30_slice.len() != n
        || top50_slice.len() != n
        || top60_slice.len() != n
    {
        return Err(EchoTopDecodeError::CellOverflow {
            claimed: cell_count,
            available: x_nm_slice.len(),
        });
    }

    let footprint_x_milli = fb.footprint_x_milli();
    let footprint_y_milli = fb.footprint_y_milli();

    Ok(DecodedEchoTop {
        cell_count,
        source_cell_count: fb.source_cell_count(),
        footprint_x_nm: footprint_x_milli as f32 / 1000.0,
        footprint_y_nm: footprint_y_milli as f32 / 1000.0,
        generated_at_ms: fb.generated_at_ms(),
        scan_time_ms: fb.scan_time_ms(),
        max_top18_feet: fb.max_top18_feet(),
        max_top30_feet: fb.max_top30_feet(),
        max_top50_feet: fb.max_top50_feet(),
        max_top60_feet: fb.max_top60_feet(),
        x_nm: x_nm_slice.iter().collect(),
        z_nm: z_nm_slice.iter().collect(),
        top18_feet: top18_slice.iter().collect(),
        top30_feet: top30_slice.iter().collect(),
        top50_feet: top50_slice.iter().collect(),
        top60_feet: top60_slice.iter().collect(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct TestCell {
        x_nm: f32,
        z_nm: f32,
        top18: u16,
        top30: u16,
        top50: u16,
        top60: u16,
    }

    fn build_fb_payload(
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
        cells: &[TestCell],
    ) -> Vec<u8> {
        use crate::generated::{EchoTops, EchoTopsArgs};

        let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(256);

        let x_nm: Vec<f32> = cells.iter().map(|c| c.x_nm).collect();
        let z_nm: Vec<f32> = cells.iter().map(|c| c.z_nm).collect();
        let top18: Vec<u16> = cells.iter().map(|c| c.top18).collect();
        let top30: Vec<u16> = cells.iter().map(|c| c.top30).collect();
        let top50: Vec<u16> = cells.iter().map(|c| c.top50).collect();
        let top60: Vec<u16> = cells.iter().map(|c| c.top60).collect();

        let x_nm_vec = builder.create_vector(&x_nm);
        let z_nm_vec = builder.create_vector(&z_nm);
        let top18_vec = builder.create_vector(&top18);
        let top30_vec = builder.create_vector(&top30);
        let top50_vec = builder.create_vector(&top50);
        let top60_vec = builder.create_vector(&top60);

        let echo_tops = EchoTops::create(
            &mut builder,
            &EchoTopsArgs {
                cell_count,
                source_cell_count,
                footprint_x_milli,
                footprint_y_milli,
                generated_at_ms,
                scan_time_ms,
                max_top18_feet: max_top18,
                max_top30_feet: max_top30,
                max_top50_feet: max_top50,
                max_top60_feet: max_top60,
                x_nm: Some(x_nm_vec),
                z_nm: Some(z_nm_vec),
                top18_feet: Some(top18_vec),
                top30_feet: Some(top30_vec),
                top50_feet: Some(top50_vec),
                top60_feet: Some(top60_vec),
            },
        );

        builder.finish(echo_tops, Some("AVET"));
        builder.finished_data().to_vec()
    }

    #[test]
    fn fb_decode_empty() {
        let buf = build_fb_payload(0, 0, 50, 50, 1000000, 2000000, 0, 0, 0, 0, &[]);
        let et = decode_echo_top_fb(&buf).unwrap();
        assert_eq!(et.cell_count, 0);
        assert_eq!(et.source_cell_count, 0);
        assert!((et.footprint_x_nm - 0.05).abs() < 1e-6);
        assert!((et.footprint_y_nm - 0.05).abs() < 1e-6);
        assert_eq!(et.generated_at_ms, 1000000);
        assert_eq!(et.scan_time_ms, 2000000);
        assert!(et.x_nm.is_empty());
    }

    #[test]
    fn fb_decode_single_cell() {
        let gen_at: i64 = 1_700_000_000_000;
        let scan_time: i64 = 1_699_999_990_000;
        let buf = build_fb_payload(
            1, 100, 50, 60, gen_at, scan_time, 45000, 40000, 35000, 30000,
            &[TestCell { x_nm: 5.5, z_nm: -3.2, top18: 12000, top30: 10000, top50: 8000, top60: 6000 }],
        );

        let et = decode_echo_top_fb(&buf).unwrap();
        assert_eq!(et.cell_count, 1);
        assert_eq!(et.source_cell_count, 100);
        assert!((et.footprint_x_nm - 0.05).abs() < 1e-6);
        assert!((et.footprint_y_nm - 0.06).abs() < 1e-6);
        assert_eq!(et.generated_at_ms, gen_at);
        assert_eq!(et.scan_time_ms, scan_time);
        assert_eq!(et.max_top18_feet, 45000);
        assert!((et.x_nm[0] - 5.5).abs() < 1e-6);
        assert_eq!(et.top18_feet[0], 12000);
    }

    #[test]
    fn fb_decode_multiple_cells() {
        let cells: Vec<TestCell> = (0..3u16).map(|i| TestCell {
            x_nm: i as f32 * 10.0,
            z_nm: i as f32 * -5.0,
            top18: (i + 1) * 5000,
            top30: (i + 1) * 4000,
            top50: (i + 1) * 3000,
            top60: (i + 1) * 2000,
        }).collect();
        let buf = build_fb_payload(3, 300, 100, 100, 0, 0, 50000, 45000, 40000, 35000, &cells);

        let et = decode_echo_top_fb(&buf).unwrap();
        assert_eq!(et.cell_count, 3);
        assert_eq!(et.x_nm.len(), 3);
        assert!((et.x_nm[2] - 20.0).abs() < 1e-6);
        assert_eq!(et.top18_feet[2], 15000);
    }

    #[test]
    fn reject_invalid_payload() {
        let data = vec![0u8; 32];
        assert!(decode_echo_top_fb(&data).is_err());
    }
}
