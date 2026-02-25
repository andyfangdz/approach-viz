// AVTR binary wire-format decoder.
//
// Decodes the binary payload produced by `services/runtime-rs/src/traffic_api.rs`
// into a `DecodedTrafficPayload`.

use crate::types::{
    DecodedTrafficAircraft, DecodedTrafficHistoryGroup, DecodedTrafficHistoryPoint,
    DecodedTrafficPayload, TRAFFIC_AIRCRAFT_RECORD_BYTES, TRAFFIC_HISTORY_GROUP_BYTES,
    TRAFFIC_HISTORY_POINT_BYTES, TRAFFIC_WIRE_HEADER_BYTES, TRAFFIC_WIRE_MAGIC,
    TRAFFIC_WIRE_VERSION,
};
use crate::wire_helpers::{read_f32_le, read_i64_le, read_u16_le, read_u32_le};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrafficDecodeError {
    TooShort { needed: usize, got: usize },
    BadMagic([u8; 4]),
    UnsupportedVersion(u16),
    InvalidStringRef { offset: u32, length: u32, table_size: usize },
    HistoryPointOverflow { point_start: u32, point_count: u32, total_points: u32 },
}

impl std::fmt::Display for TrafficDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrafficDecodeError::TooShort { needed, got } => {
                write!(f, "Traffic payload too short: need {needed} bytes, got {got}")
            }
            TrafficDecodeError::BadMagic(magic) => {
                write!(
                    f,
                    "Traffic payload bad magic: expected {:?}, got {:?}",
                    TRAFFIC_WIRE_MAGIC, magic
                )
            }
            TrafficDecodeError::UnsupportedVersion(v) => {
                write!(f, "Traffic payload unsupported version: {v}")
            }
            TrafficDecodeError::InvalidStringRef { offset, length, table_size } => {
                write!(
                    f,
                    "Traffic payload invalid string ref: offset={offset}, length={length}, \
                     table_size={table_size}"
                )
            }
            TrafficDecodeError::HistoryPointOverflow { point_start, point_count, total_points } => {
                write!(
                    f,
                    "Traffic payload history point overflow: point_start={point_start}, \
                     point_count={point_count}, total_points={total_points}"
                )
            }
        }
    }
}

impl std::error::Error for TrafficDecodeError {}

/// Convert NaN f32 to None; finite values become Some.
#[inline]
fn nan_to_option(v: f32) -> Option<f32> {
    if v.is_nan() { None } else { Some(v) }
}

const NONE_OFFSET: u32 = u32::MAX;

// ---------------------------------------------------------------------------
// String reading
// ---------------------------------------------------------------------------

/// Read a required string from the string table. `str_offset` and `str_length`
/// are relative to `strings_section_start` within `data`.
fn read_string(
    data: &[u8],
    strings_section_start: usize,
    str_offset: u32,
    str_length: u32,
) -> Result<String, TrafficDecodeError> {
    let table_size = data.len().saturating_sub(strings_section_start);
    let start = str_offset as usize;
    let len = str_length as usize;
    if start.checked_add(len).map_or(true, |end| end > table_size) {
        return Err(TrafficDecodeError::InvalidStringRef {
            offset: str_offset,
            length: str_length,
            table_size,
        });
    }
    let abs_start = strings_section_start + start;
    let abs_end = abs_start + len;
    Ok(String::from_utf8_lossy(&data[abs_start..abs_end]).into_owned())
}

/// Read an optional string (offset == u32::MAX or length == 0 means None).
fn read_optional_string(
    data: &[u8],
    strings_section_start: usize,
    str_offset: u32,
    str_length: u32,
) -> Result<Option<String>, TrafficDecodeError> {
    if str_offset == NONE_OFFSET {
        return Ok(None);
    }
    if str_length == 0 {
        return Ok(None);
    }
    read_string(data, strings_section_start, str_offset, str_length).map(Some)
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/// Decode an AVTR binary payload into a `DecodedTrafficPayload`.
///
/// The wire format is documented in the task spec and produced by
/// `services/runtime-rs/src/traffic_api.rs`.
pub fn decode_traffic_binary(data: &[u8]) -> Result<DecodedTrafficPayload, TrafficDecodeError> {
    // --- Header validation ---
    if data.len() < TRAFFIC_WIRE_HEADER_BYTES {
        return Err(TrafficDecodeError::TooShort {
            needed: TRAFFIC_WIRE_HEADER_BYTES,
            got: data.len(),
        });
    }

    let mut magic = [0u8; 4];
    magic.copy_from_slice(&data[0..4]);
    if magic != TRAFFIC_WIRE_MAGIC {
        return Err(TrafficDecodeError::BadMagic(magic));
    }

    let version = read_u16_le(data, 4);
    if version != TRAFFIC_WIRE_VERSION {
        return Err(TrafficDecodeError::UnsupportedVersion(version));
    }

    // Parse header fields
    // offset 6..8: header bytes (already validated as 64 implicitly by constant)
    // offset 8..12: flags
    let _flags = read_u32_le(data, 8);
    let aircraft_count = read_u32_le(data, 12) as usize;
    let history_group_count = read_u32_le(data, 16) as usize;
    let history_point_count = read_u32_le(data, 20) as usize;
    let fetched_at_ms = read_i64_le(data, 24);

    let source_offset = read_u32_le(data, 32);
    let error_offset = read_u32_le(data, 40);

    let aircraft_section_offset = read_u32_le(data, 48) as usize;
    let history_group_section_offset = read_u32_le(data, 52) as usize;
    let history_point_section_offset = read_u32_le(data, 56) as usize;
    let strings_section_offset = read_u32_le(data, 60) as usize;

    // --- Validate section bounds ---
    let aircraft_section_end =
        aircraft_section_offset + aircraft_count * TRAFFIC_AIRCRAFT_RECORD_BYTES;
    if aircraft_section_end > data.len() {
        return Err(TrafficDecodeError::TooShort {
            needed: aircraft_section_end,
            got: data.len(),
        });
    }

    let history_group_section_end =
        history_group_section_offset + history_group_count * TRAFFIC_HISTORY_GROUP_BYTES;
    if history_group_section_end > data.len() {
        return Err(TrafficDecodeError::TooShort {
            needed: history_group_section_end,
            got: data.len(),
        });
    }

    let history_point_section_end =
        history_point_section_offset + history_point_count * TRAFFIC_HISTORY_POINT_BYTES;
    if history_point_section_end > data.len() {
        return Err(TrafficDecodeError::TooShort {
            needed: history_point_section_end,
            got: data.len(),
        });
    }

    // --- Parse source and error strings ---
    // Source/error length fields are u32 in the header, read the full u32
    let source_length_u32 = read_u32_le(data, 36);
    let error_length_u32 = read_u32_le(data, 44);

    let source = read_optional_string(
        data,
        strings_section_offset,
        source_offset,
        source_length_u32,
    )?;

    let error = if _flags & 1 != 0 {
        read_optional_string(
            data,
            strings_section_offset,
            error_offset,
            error_length_u32,
        )?
    } else {
        None
    };

    // --- Parse aircraft records ---
    let mut aircraft = Vec::with_capacity(aircraft_count);
    for i in 0..aircraft_count {
        let offset = aircraft_section_offset + i * TRAFFIC_AIRCRAFT_RECORD_BYTES;

        let hex_str_offset = read_u32_le(data, offset);
        let hex_str_length = read_u16_le(data, offset + 4);
        let ac_flags = read_u16_le(data, offset + 6);
        let flight_str_offset = read_u32_le(data, offset + 8);
        let flight_str_length = read_u16_le(data, offset + 12);
        // offset + 14..16: reserved

        let lat = read_f32_le(data, offset + 16);
        let lon = read_f32_le(data, offset + 20);
        let altitude_feet_raw = read_f32_le(data, offset + 24);
        let ground_speed_kt_raw = read_f32_le(data, offset + 28);
        let track_deg_raw = read_f32_le(data, offset + 32);
        let last_seen_seconds_raw = read_f32_le(data, offset + 36);

        let hex = read_string(data, strings_section_offset, hex_str_offset, hex_str_length as u32)?;
        let flight = read_optional_string(
            data,
            strings_section_offset,
            flight_str_offset,
            flight_str_length as u32,
        )?;

        aircraft.push(DecodedTrafficAircraft {
            hex,
            flight,
            lat,
            lon,
            altitude_feet: nan_to_option(altitude_feet_raw),
            ground_speed_kt: nan_to_option(ground_speed_kt_raw),
            track_deg: nan_to_option(track_deg_raw),
            last_seen_seconds: nan_to_option(last_seen_seconds_raw),
            is_on_ground: (ac_flags & 1) != 0,
        });
    }

    // --- Parse history groups ---
    let mut history_groups = Vec::with_capacity(history_group_count);
    for i in 0..history_group_count {
        let offset = history_group_section_offset + i * TRAFFIC_HISTORY_GROUP_BYTES;

        let hex_str_offset = read_u32_le(data, offset);
        let hex_str_length = read_u16_le(data, offset + 4);
        // offset + 6..8: reserved
        let point_start = read_u32_le(data, offset + 8) as usize;
        let point_count = read_u32_le(data, offset + 12) as usize;

        let hex = read_string(data, strings_section_offset, hex_str_offset, hex_str_length as u32)?;

        // Bounds check: ensure point range is within the declared total
        if point_start as u64 + point_count as u64 > history_point_count as u64 {
            return Err(TrafficDecodeError::HistoryPointOverflow {
                point_start: point_start as u32,
                point_count: point_count as u32,
                total_points: history_point_count as u32,
            });
        }

        // Parse points for this group
        let mut points = Vec::with_capacity(point_count);
        for j in 0..point_count {
            let abs_point_index = point_start + j;
            let pt_offset =
                history_point_section_offset + abs_point_index * TRAFFIC_HISTORY_POINT_BYTES;

            points.push(DecodedTrafficHistoryPoint {
                lat: read_f32_le(data, pt_offset),
                lon: read_f32_le(data, pt_offset + 4),
                altitude_feet: read_f32_le(data, pt_offset + 8),
                timestamp_ms: read_i64_le(data, pt_offset + 12),
            });
        }

        history_groups.push(DecodedTrafficHistoryGroup { hex, points });
    }

    Ok(DecodedTrafficPayload {
        aircraft,
        history_groups,
        fetched_at_ms,
        source,
        error,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    // -- Test helpers --

    /// Write the AVTR header into the first 64 bytes of `buf`.
    fn write_header(
        buf: &mut Vec<u8>,
        aircraft_count: u32,
        history_group_count: u32,
        history_point_count: u32,
        fetched_at_ms: i64,
        flags: u32,
        source_offset: u32,
        source_length: u32,
        error_offset: u32,
        error_length: u32,
        aircraft_section_offset: u32,
        history_group_section_offset: u32,
        history_point_section_offset: u32,
        strings_section_offset: u32,
    ) {
        // Ensure buf is at least 64 bytes
        if buf.len() < TRAFFIC_WIRE_HEADER_BYTES {
            buf.resize(TRAFFIC_WIRE_HEADER_BYTES, 0);
        }
        buf[0..4].copy_from_slice(&TRAFFIC_WIRE_MAGIC);
        buf[4..6].copy_from_slice(&TRAFFIC_WIRE_VERSION.to_le_bytes());
        buf[6..8].copy_from_slice(&(TRAFFIC_WIRE_HEADER_BYTES as u16).to_le_bytes());
        buf[8..12].copy_from_slice(&flags.to_le_bytes());
        buf[12..16].copy_from_slice(&aircraft_count.to_le_bytes());
        buf[16..20].copy_from_slice(&history_group_count.to_le_bytes());
        buf[20..24].copy_from_slice(&history_point_count.to_le_bytes());
        buf[24..32].copy_from_slice(&fetched_at_ms.to_le_bytes());
        buf[32..36].copy_from_slice(&source_offset.to_le_bytes());
        buf[36..40].copy_from_slice(&source_length.to_le_bytes());
        buf[40..44].copy_from_slice(&error_offset.to_le_bytes());
        buf[44..48].copy_from_slice(&error_length.to_le_bytes());
        buf[48..52].copy_from_slice(&aircraft_section_offset.to_le_bytes());
        buf[52..56].copy_from_slice(&history_group_section_offset.to_le_bytes());
        buf[56..60].copy_from_slice(&history_point_section_offset.to_le_bytes());
        buf[60..64].copy_from_slice(&strings_section_offset.to_le_bytes());
    }

    /// Build an aircraft record (40 bytes).
    fn build_aircraft_record(
        hex_offset: u32,
        hex_length: u16,
        flags: u16,
        flight_offset: u32,
        flight_length: u16,
        lat: f32,
        lon: f32,
        altitude_feet: f32,
        ground_speed_kt: f32,
        track_deg: f32,
        last_seen_seconds: f32,
    ) -> [u8; 40] {
        let mut rec = [0u8; 40];
        rec[0..4].copy_from_slice(&hex_offset.to_le_bytes());
        rec[4..6].copy_from_slice(&hex_length.to_le_bytes());
        rec[6..8].copy_from_slice(&flags.to_le_bytes());
        rec[8..12].copy_from_slice(&flight_offset.to_le_bytes());
        rec[12..14].copy_from_slice(&flight_length.to_le_bytes());
        rec[14..16].copy_from_slice(&0u16.to_le_bytes()); // reserved
        rec[16..20].copy_from_slice(&lat.to_le_bytes());
        rec[20..24].copy_from_slice(&lon.to_le_bytes());
        rec[24..28].copy_from_slice(&altitude_feet.to_le_bytes());
        rec[28..32].copy_from_slice(&ground_speed_kt.to_le_bytes());
        rec[32..36].copy_from_slice(&track_deg.to_le_bytes());
        rec[36..40].copy_from_slice(&last_seen_seconds.to_le_bytes());
        rec
    }

    /// Build a history group record (16 bytes).
    fn build_history_group_record(
        hex_offset: u32,
        hex_length: u16,
        point_start: u32,
        point_count: u32,
    ) -> [u8; 16] {
        let mut rec = [0u8; 16];
        rec[0..4].copy_from_slice(&hex_offset.to_le_bytes());
        rec[4..6].copy_from_slice(&hex_length.to_le_bytes());
        rec[6..8].copy_from_slice(&0u16.to_le_bytes()); // reserved
        rec[8..12].copy_from_slice(&point_start.to_le_bytes());
        rec[12..16].copy_from_slice(&point_count.to_le_bytes());
        rec
    }

    /// Build a history point record (20 bytes).
    fn build_history_point_record(
        lat: f32,
        lon: f32,
        altitude_feet: f32,
        timestamp_ms: i64,
    ) -> [u8; 20] {
        let mut rec = [0u8; 20];
        rec[0..4].copy_from_slice(&lat.to_le_bytes());
        rec[4..8].copy_from_slice(&lon.to_le_bytes());
        rec[8..12].copy_from_slice(&altitude_feet.to_le_bytes());
        rec[12..20].copy_from_slice(&timestamp_ms.to_le_bytes());
        rec
    }

    /// Build a complete minimal payload with the given sections and strings.
    fn build_payload(
        aircraft_records: &[u8],
        history_group_records: &[u8],
        history_point_records: &[u8],
        string_table: &[u8],
        aircraft_count: u32,
        history_group_count: u32,
        history_point_count: u32,
        fetched_at_ms: i64,
        flags: u32,
        source_offset: u32,
        source_length: u32,
        error_offset: u32,
        error_length: u32,
    ) -> Vec<u8> {
        let ac_section_offset = TRAFFIC_WIRE_HEADER_BYTES;
        let hg_section_offset = ac_section_offset + aircraft_records.len();
        let hp_section_offset = hg_section_offset + history_group_records.len();
        let str_section_offset = hp_section_offset + history_point_records.len();

        let total = str_section_offset + string_table.len();
        let mut buf = vec![0u8; total];

        write_header(
            &mut buf,
            aircraft_count,
            history_group_count,
            history_point_count,
            fetched_at_ms,
            flags,
            source_offset,
            source_length,
            error_offset,
            error_length,
            ac_section_offset as u32,
            hg_section_offset as u32,
            hp_section_offset as u32,
            str_section_offset as u32,
        );

        buf[ac_section_offset..ac_section_offset + aircraft_records.len()]
            .copy_from_slice(aircraft_records);
        buf[hg_section_offset..hg_section_offset + history_group_records.len()]
            .copy_from_slice(history_group_records);
        buf[hp_section_offset..hp_section_offset + history_point_records.len()]
            .copy_from_slice(history_point_records);
        buf[str_section_offset..str_section_offset + string_table.len()]
            .copy_from_slice(string_table);

        buf
    }

    // -- Tests --

    #[test]
    fn reject_truncated() {
        let data = vec![0u8; 32]; // < 64 bytes
        let err = decode_traffic_binary(&data).unwrap_err();
        assert_eq!(
            err,
            TrafficDecodeError::TooShort {
                needed: 64,
                got: 32,
            }
        );
    }

    #[test]
    fn reject_bad_magic() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(b"NOPE");
        let err = decode_traffic_binary(&data).unwrap_err();
        assert_eq!(err, TrafficDecodeError::BadMagic(*b"NOPE"));
    }

    #[test]
    fn reject_unsupported_version() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(&TRAFFIC_WIRE_MAGIC);
        data[4..6].copy_from_slice(&99u16.to_le_bytes());
        let err = decode_traffic_binary(&data).unwrap_err();
        assert_eq!(err, TrafficDecodeError::UnsupportedVersion(99));
    }

    #[test]
    fn decode_empty_payload() {
        let buf = build_payload(
            &[],  // no aircraft
            &[],  // no history groups
            &[],  // no history points
            &[],  // no strings
            0,    // aircraft_count
            0,    // history_group_count
            0,    // history_point_count
            1_700_000_000_000, // fetched_at_ms
            0,    // flags
            NONE_OFFSET, // source_offset
            0,    // source_length
            NONE_OFFSET, // error_offset
            0,    // error_length
        );

        let result = decode_traffic_binary(&buf).unwrap();
        assert!(result.aircraft.is_empty());
        assert!(result.history_groups.is_empty());
        assert_eq!(result.fetched_at_ms, 1_700_000_000_000);
        assert_eq!(result.source, None);
        assert_eq!(result.error, None);
    }

    #[test]
    fn decode_single_aircraft() {
        // String table: "a1b2c3" at offset 0, "UAL123" at offset 6
        let string_table = b"a1b2c3UAL123";

        let ac_rec = build_aircraft_record(
            0,     // hex_offset -> "a1b2c3"
            6,     // hex_length
            0,     // flags (not on ground)
            6,     // flight_offset -> "UAL123"
            6,     // flight_length
            33.9425, // lat
            -118.4081, // lon
            12500.0,  // altitude_feet
            450.0,    // ground_speed_kt
            270.0,    // track_deg
            2.5,      // last_seen_seconds
        );

        let buf = build_payload(
            &ac_rec,
            &[],
            &[],
            string_table,
            1,
            0,
            0,
            1_700_000_000_000,
            0,
            NONE_OFFSET,
            0,
            NONE_OFFSET,
            0,
        );

        let result = decode_traffic_binary(&buf).unwrap();
        assert_eq!(result.aircraft.len(), 1);

        let ac = &result.aircraft[0];
        assert_eq!(ac.hex, "a1b2c3");
        assert_eq!(ac.flight, Some("UAL123".to_string()));
        assert!((ac.lat - 33.9425).abs() < 1e-4);
        assert!((ac.lon - (-118.4081)).abs() < 1e-4);
        assert_eq!(ac.altitude_feet, Some(12500.0));
        assert_eq!(ac.ground_speed_kt, Some(450.0));
        assert_eq!(ac.track_deg, Some(270.0));
        assert_eq!(ac.last_seen_seconds, Some(2.5));
        assert!(!ac.is_on_ground);
    }

    #[test]
    fn nan_altitude_becomes_none() {
        let string_table = b"abc123";
        let ac_rec = build_aircraft_record(
            0,
            6,
            0,
            NONE_OFFSET,
            0,
            40.0,
            -74.0,
            f32::NAN, // altitude absent
            200.0,
            180.0,
            1.0,
        );

        let buf = build_payload(
            &ac_rec,
            &[],
            &[],
            string_table,
            1,
            0,
            0,
            1_700_000_000_000,
            0,
            NONE_OFFSET,
            0,
            NONE_OFFSET,
            0,
        );

        let result = decode_traffic_binary(&buf).unwrap();
        let ac = &result.aircraft[0];
        assert_eq!(ac.altitude_feet, None);
        assert_eq!(ac.ground_speed_kt, Some(200.0));
        assert_eq!(ac.track_deg, Some(180.0));
        assert_eq!(ac.last_seen_seconds, Some(1.0));
    }

    #[test]
    fn is_on_ground_flag() {
        let string_table = b"abc123";
        let ac_rec = build_aircraft_record(
            0,
            6,
            1, // flags bit 0 = is_on_ground
            NONE_OFFSET,
            0,
            40.0,
            -74.0,
            0.0,
            5.0,
            90.0,
            0.0,
        );

        let buf = build_payload(
            &ac_rec,
            &[],
            &[],
            string_table,
            1,
            0,
            0,
            1_700_000_000_000,
            0,
            NONE_OFFSET,
            0,
            NONE_OFFSET,
            0,
        );

        let result = decode_traffic_binary(&buf).unwrap();
        assert!(result.aircraft[0].is_on_ground);
    }

    #[test]
    fn decode_history_group() {
        // String table: "abc123" at offset 0
        let string_table = b"abc123";

        // Two history points
        let pt1 = build_history_point_record(34.0, -118.0, 5000.0, 1_700_000_000_000);
        let pt2 = build_history_point_record(34.1, -118.1, 5500.0, 1_700_000_001_000);

        let mut history_points = Vec::new();
        history_points.extend_from_slice(&pt1);
        history_points.extend_from_slice(&pt2);

        // One history group referencing both points
        let hg_rec = build_history_group_record(
            0, // hex_offset -> "abc123"
            6, // hex_length
            0, // point_start
            2, // point_count
        );

        let buf = build_payload(
            &[],
            &hg_rec,
            &history_points,
            string_table,
            0,
            1,
            2,
            1_700_000_000_000,
            0,
            NONE_OFFSET,
            0,
            NONE_OFFSET,
            0,
        );

        let result = decode_traffic_binary(&buf).unwrap();
        assert_eq!(result.history_groups.len(), 1);

        let group = &result.history_groups[0];
        assert_eq!(group.hex, "abc123");
        assert_eq!(group.points.len(), 2);

        assert!((group.points[0].lat - 34.0).abs() < 1e-6);
        assert!((group.points[0].lon - (-118.0)).abs() < 1e-6);
        assert!((group.points[0].altitude_feet - 5000.0).abs() < 1e-6);
        assert_eq!(group.points[0].timestamp_ms, 1_700_000_000_000);

        assert!((group.points[1].lat - 34.1).abs() < 1e-4);
        assert!((group.points[1].lon - (-118.1)).abs() < 1e-4);
        assert!((group.points[1].altitude_feet - 5500.0).abs() < 1e-6);
        assert_eq!(group.points[1].timestamp_ms, 1_700_000_001_000);
    }

    #[test]
    fn source_and_error_strings() {
        // String table: "adsb-exchange" (13 bytes) at 0, "timeout" (7 bytes) at 13
        let string_table = b"adsb-exchangetimeout";

        let buf = build_payload(
            &[],
            &[],
            &[],
            string_table,
            0,
            0,
            0,
            1_700_000_000_000,
            TRAFFIC_FLAG_HAS_ERROR, // has-error flag
            0,                       // source_offset
            13,                      // source_length
            13,                      // error_offset
            7,                       // error_length
        );

        let result = decode_traffic_binary(&buf).unwrap();
        assert_eq!(result.source, Some("adsb-exchange".to_string()));
        assert_eq!(result.error, Some("timeout".to_string()));
    }

    #[test]
    fn absent_strings() {
        // All optional strings absent (u32::MAX offset)
        let string_table = b"abc123";
        let ac_rec = build_aircraft_record(
            0,
            6,
            0,
            NONE_OFFSET, // flight absent
            0,
            40.0,
            -74.0,
            10000.0,
            300.0,
            90.0,
            1.0,
        );

        let buf = build_payload(
            &ac_rec,
            &[],
            &[],
            string_table,
            1,
            0,
            0,
            1_700_000_000_000,
            0,            // no error flag
            NONE_OFFSET,  // source absent
            0,
            NONE_OFFSET,  // error absent
            0,
        );

        let result = decode_traffic_binary(&buf).unwrap();
        assert_eq!(result.source, None);
        assert_eq!(result.error, None);
        assert_eq!(result.aircraft[0].flight, None);
    }
}
