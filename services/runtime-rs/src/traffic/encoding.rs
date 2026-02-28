use super::types::{
    no_store_headers, no_store_headers_with_content_type, TrafficBinaryPayload,
};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

const TRAFFIC_BINARY_CONTENT_TYPE: &str = "application/vnd.approach-viz.traffic.v3";
const TRAFFIC_BINARY_MAGIC: &[u8; 4] = b"AVTR";
const TRAFFIC_BINARY_VERSION: u16 = 3;
const TRAFFIC_BINARY_HEADER_BYTES: u16 = 64;
const TRAFFIC_BINARY_FLAG_HAS_ERROR: u32 = 1 << 0;

pub(crate) fn traffic_binary_response(payload: TrafficBinaryPayload) -> Response {
    match encode_traffic_binary_payload(&payload) {
        Ok(bytes) => (
            StatusCode::OK,
            no_store_headers_with_content_type(TRAFFIC_BINARY_CONTENT_TYPE),
            bytes,
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            no_store_headers(),
            Json(serde_json::json!({
                "error": format!("Failed to encode traffic binary payload: {error}")
            })),
        )
            .into_response(),
    }
}

/// Round `offset` up to the next multiple of `align`.
fn align_up(offset: usize, align: usize) -> usize {
    (offset + align - 1) & !(align - 1)
}

pub fn encode_traffic_binary_payload(payload: &TrafficBinaryPayload) -> Result<Vec<u8>, String> {
    let mut strings = Vec::<u8>::new();
    let source_meta = payload
        .source
        .as_deref()
        .map(|source| append_traffic_string(&mut strings, source))
        .transpose()?;
    let error_meta = payload
        .error
        .as_deref()
        .map(|error| append_traffic_string(&mut strings, error))
        .transpose()?;

    // --- Aircraft SoA ---
    let ac_count = payload.aircraft.len();
    let aircraft_count = u32::try_from(ac_count)
        .map_err(|_| "Traffic aircraft count exceeds binary format limit".to_string())?;

    let mut ac_hex_offsets: Vec<u32> = Vec::with_capacity(ac_count);
    let mut ac_hex_lengths: Vec<u16> = Vec::with_capacity(ac_count);
    let mut ac_flight_offsets: Vec<u32> = Vec::with_capacity(ac_count);
    let mut ac_flight_lengths: Vec<u16> = Vec::with_capacity(ac_count);
    let mut ac_flags: Vec<u16> = Vec::with_capacity(ac_count);
    let mut ac_lats: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_lons: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_altitudes: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_speeds: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_tracks: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_last_seen: Vec<f32> = Vec::with_capacity(ac_count);

    for aircraft in &payload.aircraft {
        let (hex_offset, hex_len_u32) = append_traffic_string(&mut strings, &aircraft.hex)?;
        let hex_len = u16::try_from(hex_len_u32).map_err(|_| {
            format!(
                "Traffic aircraft hex exceeds binary record limit: {}",
                aircraft.hex
            )
        })?;
        let (flight_offset, flight_len) = match aircraft.flight.as_deref() {
            Some(flight) => {
                let (offset, len_u32) = append_traffic_string(&mut strings, flight)?;
                let len = u16::try_from(len_u32).map_err(|_| {
                    format!("Traffic flight string exceeds binary record limit: {}", flight)
                })?;
                (offset, len)
            }
            None => (u32::MAX, 0),
        };
        let flags = if aircraft.is_on_ground { 1_u16 } else { 0_u16 };

        ac_hex_offsets.push(hex_offset);
        ac_hex_lengths.push(hex_len);
        ac_flight_offsets.push(flight_offset);
        ac_flight_lengths.push(flight_len);
        ac_flags.push(flags);
        ac_lats.push(aircraft.lat as f32);
        ac_lons.push(aircraft.lon as f32);
        ac_altitudes.push(
            aircraft
                .altitude_feet
                .map(|value| value as f32)
                .unwrap_or(f32::NAN),
        );
        ac_speeds.push(
            aircraft
                .ground_speed_kt
                .map(|value| value as f32)
                .unwrap_or(f32::NAN),
        );
        ac_tracks.push(
            aircraft
                .track_deg
                .map(|value| value as f32)
                .unwrap_or(f32::NAN),
        );
        ac_last_seen.push(
            aircraft
                .last_seen_seconds
                .map(|value| value as f32)
                .unwrap_or(f32::NAN),
        );
    }

    // Write SoA aircraft section: 38 bytes per aircraft (bytemuck zero-copy on LE platforms)
    let ac_soa_bytes = ac_count * 38;
    let mut aircraft_records = Vec::<u8>::with_capacity(ac_soa_bytes);
    // v3: widest-first column order for aligned zero-copy decoding
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_hex_offsets));    // u32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_flight_offsets)); // u32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_lats));           // f32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_lons));           // f32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_altitudes));      // f32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_speeds));         // f32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_tracks));         // f32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_last_seen));      // f32
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_hex_lengths));    // u16
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_flight_lengths)); // u16
    aircraft_records.extend_from_slice(bytemuck::cast_slice(&ac_flags));          // u16

    // --- History groups SoA ---
    let mut history_entries = payload.history_by_hex.iter().collect::<Vec<_>>();
    history_entries.sort_by(|(left_hex, _), (right_hex, _)| left_hex.cmp(right_hex));
    let hg_count = history_entries.len();
    let history_group_count = u32::try_from(hg_count)
        .map_err(|_| "Traffic history group count exceeds binary format limit".to_string())?;

    let mut hg_hex_offsets: Vec<u32> = Vec::with_capacity(hg_count);
    let mut hg_hex_lengths: Vec<u16> = Vec::with_capacity(hg_count);
    let mut hg_point_starts: Vec<u32> = Vec::with_capacity(hg_count);
    let mut hg_point_counts: Vec<u32> = Vec::with_capacity(hg_count);

    let total_history_points = payload
        .history_by_hex
        .values()
        .map(std::vec::Vec::len)
        .sum::<usize>();

    let mut hp_lats: Vec<f32> = Vec::with_capacity(total_history_points);
    let mut hp_lons: Vec<f32> = Vec::with_capacity(total_history_points);
    let mut hp_altitudes: Vec<f32> = Vec::with_capacity(total_history_points);
    let mut hp_timestamps: Vec<i64> = Vec::with_capacity(total_history_points);

    let mut history_point_count = 0_u32;

    for (hex, points) in history_entries {
        let (hex_offset, hex_len_u32) = append_traffic_string(&mut strings, hex)?;
        let hex_len = u16::try_from(hex_len_u32)
            .map_err(|_| format!("Traffic history hex exceeds binary record limit: {hex}"))?;
        let point_count = u32::try_from(points.len())
            .map_err(|_| format!("Traffic history point count exceeds binary limit for {hex}"))?;
        let point_start = history_point_count;
        history_point_count = history_point_count
            .checked_add(point_count)
            .ok_or_else(|| "Traffic history point count overflow".to_string())?;

        hg_hex_offsets.push(hex_offset);
        hg_hex_lengths.push(hex_len);
        hg_point_starts.push(point_start);
        hg_point_counts.push(point_count);

        for point in points {
            hp_lats.push(point.lat as f32);
            hp_lons.push(point.lon as f32);
            hp_altitudes.push(point.altitude_feet as f32);
            hp_timestamps.push(point.timestamp_ms);
        }
    }

    // Write SoA history group section: 14 bytes per group (bytemuck zero-copy on LE platforms)
    let hg_soa_bytes = hg_count * 14;
    let mut history_group_records = Vec::<u8>::with_capacity(hg_soa_bytes);
    // v3: widest-first column order
    history_group_records.extend_from_slice(bytemuck::cast_slice(&hg_hex_offsets));   // u32
    history_group_records.extend_from_slice(bytemuck::cast_slice(&hg_point_starts));  // u32
    history_group_records.extend_from_slice(bytemuck::cast_slice(&hg_point_counts));  // u32
    history_group_records.extend_from_slice(bytemuck::cast_slice(&hg_hex_lengths));   // u16

    // Write SoA history point section: 20 bytes per point (bytemuck zero-copy on LE platforms)
    let hp_count = history_point_count as usize;
    let hp_soa_bytes = hp_count * 20;
    let mut history_point_records = Vec::<u8>::with_capacity(hp_soa_bytes);
    // v3: widest-first column order (i64 before f32)
    history_point_records.extend_from_slice(bytemuck::cast_slice(&hp_timestamps)); // i64
    history_point_records.extend_from_slice(bytemuck::cast_slice(&hp_lats));       // f32
    history_point_records.extend_from_slice(bytemuck::cast_slice(&hp_lons));       // f32
    history_point_records.extend_from_slice(bytemuck::cast_slice(&hp_altitudes));  // f32

    // --- Compute section offsets (aligned for zero-copy decoding) ---
    let aircraft_offset = usize::from(TRAFFIC_BINARY_HEADER_BYTES); // 64, 8-aligned
    let history_group_offset = align_up(
        aircraft_offset
            .checked_add(aircraft_records.len())
            .ok_or_else(|| "Traffic binary section offset overflow (history groups)".to_string())?,
        4,
    );
    let history_point_offset = align_up(
        history_group_offset
            .checked_add(history_group_records.len())
            .ok_or_else(|| "Traffic binary section offset overflow (history points)".to_string())?,
        8,
    );
    let strings_offset = history_point_offset
        .checked_add(history_point_records.len())
        .ok_or_else(|| "Traffic binary section offset overflow (strings)".to_string())?;
    let total_len = strings_offset
        .checked_add(strings.len())
        .ok_or_else(|| "Traffic binary payload size overflow".to_string())?;

    let history_group_offset_u32 = u32::try_from(history_group_offset)
        .map_err(|_| "Traffic binary payload exceeds u32 offset limits".to_string())?;
    let history_point_offset_u32 = u32::try_from(history_point_offset)
        .map_err(|_| "Traffic binary payload exceeds u32 offset limits".to_string())?;
    let strings_offset_u32 = u32::try_from(strings_offset)
        .map_err(|_| "Traffic binary payload exceeds u32 offset limits".to_string())?;
    if total_len > u32::MAX as usize {
        return Err("Traffic binary payload exceeds format size limit".to_string());
    }

    let mut flags = 0_u32;
    if payload.error.is_some() {
        flags |= TRAFFIC_BINARY_FLAG_HAS_ERROR;
    }

    // --- Write final payload ---
    let mut bytes = Vec::<u8>::with_capacity(total_len);
    bytes.extend_from_slice(TRAFFIC_BINARY_MAGIC);
    push_u16_le(&mut bytes, TRAFFIC_BINARY_VERSION);
    push_u16_le(&mut bytes, TRAFFIC_BINARY_HEADER_BYTES);
    push_u32_le(&mut bytes, flags);
    push_u32_le(&mut bytes, aircraft_count);
    push_u32_le(&mut bytes, history_group_count);
    push_u32_le(&mut bytes, history_point_count);
    push_i64_le(&mut bytes, payload.fetched_at_ms);
    push_u32_le(
        &mut bytes,
        source_meta.map(|(offset, _)| offset).unwrap_or(u32::MAX),
    );
    push_u32_le(
        &mut bytes,
        source_meta.map(|(_, len)| len).unwrap_or(0),
    );
    push_u32_le(
        &mut bytes,
        error_meta.map(|(offset, _)| offset).unwrap_or(u32::MAX),
    );
    push_u32_le(
        &mut bytes,
        error_meta.map(|(_, len)| len).unwrap_or(0),
    );
    push_u32_le(
        &mut bytes,
        u32::try_from(aircraft_offset)
            .map_err(|_| "Traffic binary aircraft offset exceeds format limit".to_string())?,
    );
    push_u32_le(&mut bytes, history_group_offset_u32);
    push_u32_le(&mut bytes, history_point_offset_u32);
    push_u32_le(&mut bytes, strings_offset_u32);
    if bytes.len() != usize::from(TRAFFIC_BINARY_HEADER_BYTES) {
        return Err("Traffic binary header size mismatch".to_string());
    }

    bytes.extend_from_slice(&aircraft_records);
    // Padding to align history group section
    let pad_before_hg = history_group_offset - (aircraft_offset + aircraft_records.len());
    bytes.extend(std::iter::repeat(0u8).take(pad_before_hg));
    bytes.extend_from_slice(&history_group_records);
    // Padding to align history point section
    let pad_before_hp = history_point_offset - (history_group_offset + history_group_records.len());
    bytes.extend(std::iter::repeat(0u8).take(pad_before_hp));
    bytes.extend_from_slice(&history_point_records);
    bytes.extend_from_slice(&strings);
    Ok(bytes)
}

fn append_traffic_string(strings: &mut Vec<u8>, value: &str) -> Result<(u32, u32), String> {
    let offset = u32::try_from(strings.len())
        .map_err(|_| "Traffic binary string table offset exceeds format limits".to_string())?;
    strings.extend_from_slice(value.as_bytes());
    let length = u32::try_from(value.len())
        .map_err(|_| "Traffic binary string length exceeds format limits".to_string())?;
    Ok((offset, length))
}

fn push_u16_le(buffer: &mut Vec<u8>, value: u16) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_u32_le(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_i64_le(buffer: &mut Vec<u8>, value: i64) {
    buffer.extend_from_slice(&value.to_le_bytes());
}
