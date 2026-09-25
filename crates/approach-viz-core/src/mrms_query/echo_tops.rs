use super::{QueryProjection, QueryWindow, ScanMeta, StoredEchoTop};
use crate::generated::{EchoTops, EchoTopsArgs};

/// One echo-top grid cell inside a query window, in the window's local frame.
struct EchoTopCellRecord {
    x_nm: f32,
    z_nm: f32,
    top18_feet: u16,
    top30_feet: u16,
    top50_feet: u16,
    top60_feet: u16,
}

fn build_echo_top_cells(
    scan: &impl ScanMeta,
    window: &QueryWindow,
    records: &[StoredEchoTop],
) -> Vec<EchoTopCellRecord> {
    let projection = QueryProjection::new(scan.grid(), window);
    let mut cells = Vec::new();
    for record in records {
        let row = record.row as u32;
        let col = record.col as u32;
        if row < window.row_start || row > window.row_end {
            continue;
        }
        if !window.lon_wrapped && (col < window.col_start || col > window.col_end) {
            continue;
        }

        let (x_nm, z_nm) = projection.project_cell_nm(row, col);
        if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
            continue;
        }

        cells.push(EchoTopCellRecord {
            x_nm: x_nm as f32,
            z_nm: z_nm as f32,
            top18_feet: record.top18_feet,
            top30_feet: record.top30_feet,
            top50_feet: record.top50_feet,
            top60_feet: record.top60_feet,
        });
    }
    cells
}

/// Build an AVET FlatBuffers payload for the echo-top cells inside `window`.
/// `records` are in stored (row-major) order and must include every record
/// whose row lies in the window; records outside it are filtered out.
pub fn build_echo_top_wire_fb(
    scan: &impl ScanMeta,
    window: &QueryWindow,
    records: &[StoredEchoTop],
) -> Vec<u8> {
    let summary = scan.echo_top_summary();
    let cells = build_echo_top_cells(scan, window, records);
    let n = cells.len();
    let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(64 + n * 16);

    // Collect SoA columns
    let x_nm: Vec<f32> = cells.iter().map(|c| c.x_nm).collect();
    let z_nm: Vec<f32> = cells.iter().map(|c| c.z_nm).collect();
    let top18: Vec<u16> = cells.iter().map(|c| c.top18_feet).collect();
    let top30: Vec<u16> = cells.iter().map(|c| c.top30_feet).collect();
    let top50: Vec<u16> = cells.iter().map(|c| c.top50_feet).collect();
    let top60: Vec<u16> = cells.iter().map(|c| c.top60_feet).collect();

    // Create FlatBuffers vectors (must be done before creating the table)
    let x_nm_vec = builder.create_vector(&x_nm);
    let z_nm_vec = builder.create_vector(&z_nm);
    let top18_vec = builder.create_vector(&top18);
    let top30_vec = builder.create_vector(&top30);
    let top50_vec = builder.create_vector(&top50);
    let top60_vec = builder.create_vector(&top60);

    let echo_tops = EchoTops::create(
        &mut builder,
        &EchoTopsArgs {
            cell_count: n as u32,
            source_cell_count: summary.source_cell_count,
            footprint_x_milli: window.footprint_x_milli,
            footprint_y_milli: window.footprint_y_milli,
            generated_at_ms: scan.generated_at_ms(),
            scan_time_ms: scan.scan_time_ms(),
            max_top18_feet: summary.max_top18_feet,
            max_top30_feet: summary.max_top30_feet,
            max_top50_feet: summary.max_top50_feet,
            max_top60_feet: summary.max_top60_feet,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrms_query::testkit::sample_scan;
    use crate::mrms_query::{build_query_window, StoredEchoTop, DEFAULT_MIN_DBZ};

    #[test]
    fn echo_top_payload_is_avet_and_holds_only_cells_inside_the_window() {
        let mut scan = sample_scan();
        scan.generated_at_ms = 1_700_000_000_123;
        scan.scan_time_ms = 1_700_000_000_000;
        scan.echo_top_summary.max_top18_feet = 41_000;
        // Row 3, column 4 sits under the query origin; row 0, column 0 is ~11 NM away.
        scan.echo_top_summary.source_cell_count = 2;
        scan.echo_tops = vec![
            StoredEchoTop {
                row: 3,
                col: 4,
                top18_feet: 20_000,
                top30_feet: 15_000,
                top50_feet: 0,
                top60_feet: 0,
            },
            StoredEchoTop {
                row: 0,
                col: 0,
                top18_feet: 41_000,
                top30_feet: 0,
                top50_feet: 0,
                top60_feet: 0,
            },
        ];
        let window = build_query_window(&scan, 35.15, -109.80, DEFAULT_MIN_DBZ, 2.0);

        let bytes = build_echo_top_wire_fb(&scan, &window, &scan.echo_tops);

        // FlatBuffers file identifier sits at bytes 4..8.
        assert_eq!(&bytes[4..8], b"AVET");
        let payload = flatbuffers::root::<EchoTops>(&bytes).expect("valid AVET payload");
        assert_eq!(payload.cell_count(), 1);
        assert_eq!(payload.source_cell_count(), 2);
        assert_eq!(payload.max_top18_feet(), 41_000);
        assert_eq!(payload.scan_time_ms(), 1_700_000_000_000);
        assert_eq!(payload.generated_at_ms(), 1_700_000_000_123);
        assert_eq!(
            payload.top18_feet().unwrap().iter().collect::<Vec<_>>(),
            vec![20_000]
        );
        assert_eq!(
            payload.top30_feet().unwrap().iter().collect::<Vec<_>>(),
            vec![15_000]
        );
        let (x, z) = (
            payload.x_nm().unwrap().get(0),
            payload.z_nm().unwrap().get(0),
        );
        assert!(
            x.abs() < 2.0 && z.abs() < 2.0,
            "cell should sit near the origin: ({x}, {z})"
        );
    }

    #[test]
    fn echo_top_payload_for_an_empty_window_is_a_valid_empty_payload() {
        let scan = sample_scan();
        let window = build_query_window(&scan, 35.15, -109.80, DEFAULT_MIN_DBZ, 2.0);
        let bytes = build_echo_top_wire_fb(&scan, &window, &scan.echo_tops);
        let payload = flatbuffers::root::<EchoTops>(&bytes).expect("valid AVET payload");
        assert_eq!(payload.cell_count(), 0);
        assert_eq!(payload.x_nm().map_or(0, |column| column.len()), 0);
    }
}
