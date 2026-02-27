use super::types::{
    no_store_headers, no_store_headers_with_content_type, TrafficBinaryPayload,
};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

const TRAFFIC_BINARY_CONTENT_TYPE: &str = "application/vnd.approach-viz.traffic.v1";
const TRAFFIC_BINARY_MAGIC: &[u8; 4] = b"AVTR";
const TRAFFIC_BINARY_VERSION: u16 = 1;
const TRAFFIC_BINARY_HEADER_BYTES: u16 = 64;
const TRAFFIC_BINARY_FLAG_HAS_ERROR: u32 = 1 << 0;
const TRAFFIC_BINARY_AIRCRAFT_RECORD_BYTES: usize = 40;
const TRAFFIC_BINARY_HISTORY_GROUP_RECORD_BYTES: usize = 16;
const TRAFFIC_BINARY_HISTORY_POINT_RECORD_BYTES: usize = 20;

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

fn encode_traffic_binary_payload(payload: &TrafficBinaryPayload) -> Result<Vec<u8>, String> {
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

    let aircraft_count = u32::try_from(payload.aircraft.len())
        .map_err(|_| "Traffic aircraft count exceeds binary format limit".to_string())?;
    let mut aircraft_records =
        Vec::<u8>::with_capacity(payload.aircraft.len() * TRAFFIC_BINARY_AIRCRAFT_RECORD_BYTES);
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
        push_u32_le(&mut aircraft_records, hex_offset);
        push_u16_le(&mut aircraft_records, hex_len);
        push_u16_le(&mut aircraft_records, flags);
        push_u32_le(&mut aircraft_records, flight_offset);
        push_u16_le(&mut aircraft_records, flight_len);
        push_u16_le(&mut aircraft_records, 0);
        push_f32_le(&mut aircraft_records, aircraft.lat as f32);
        push_f32_le(&mut aircraft_records, aircraft.lon as f32);
        push_f32_le(
            &mut aircraft_records,
            aircraft.altitude_feet.map(|value| value as f32).unwrap_or(f32::NAN),
        );
        push_f32_le(
            &mut aircraft_records,
            aircraft
                .ground_speed_kt
                .map(|value| value as f32)
                .unwrap_or(f32::NAN),
        );
        push_f32_le(
            &mut aircraft_records,
            aircraft.track_deg.map(|value| value as f32).unwrap_or(f32::NAN),
        );
        push_f32_le(
            &mut aircraft_records,
            aircraft
                .last_seen_seconds
                .map(|value| value as f32)
                .unwrap_or(f32::NAN),
        );
    }

    let mut history_entries = payload.history_by_hex.iter().collect::<Vec<_>>();
    history_entries.sort_by(|(left_hex, _), (right_hex, _)| left_hex.cmp(right_hex));
    let history_group_count = u32::try_from(history_entries.len())
        .map_err(|_| "Traffic history group count exceeds binary format limit".to_string())?;
    let mut history_group_records = Vec::<u8>::with_capacity(
        history_entries.len() * TRAFFIC_BINARY_HISTORY_GROUP_RECORD_BYTES,
    );
    let total_history_points = payload
        .history_by_hex
        .values()
        .map(std::vec::Vec::len)
        .sum::<usize>();
    let mut history_point_records =
        Vec::<u8>::with_capacity(total_history_points * TRAFFIC_BINARY_HISTORY_POINT_RECORD_BYTES);
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

        push_u32_le(&mut history_group_records, hex_offset);
        push_u16_le(&mut history_group_records, hex_len);
        push_u16_le(&mut history_group_records, 0);
        push_u32_le(&mut history_group_records, point_start);
        push_u32_le(&mut history_group_records, point_count);

        for point in points {
            push_f32_le(&mut history_point_records, point.lat as f32);
            push_f32_le(&mut history_point_records, point.lon as f32);
            push_f32_le(&mut history_point_records, point.altitude_feet as f32);
            push_i64_le(&mut history_point_records, point.timestamp_ms);
        }
    }

    let aircraft_offset = usize::from(TRAFFIC_BINARY_HEADER_BYTES);
    let history_group_offset = aircraft_offset
        .checked_add(aircraft_records.len())
        .ok_or_else(|| "Traffic binary section offset overflow (history groups)".to_string())?;
    let history_point_offset = history_group_offset
        .checked_add(history_group_records.len())
        .ok_or_else(|| "Traffic binary section offset overflow (history points)".to_string())?;
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

    let mut bytes = Vec::<u8>::with_capacity(total_len);
    bytes.extend_from_slice(TRAFFIC_BINARY_MAGIC);
    push_u16_le(&mut bytes, TRAFFIC_BINARY_VERSION);
    push_u16_le(&mut bytes, TRAFFIC_BINARY_HEADER_BYTES);
    push_u32_le(&mut bytes, flags);
    push_u32_le(&mut bytes, aircraft_count);
    push_u32_le(&mut bytes, history_group_count);
    push_u32_le(&mut bytes, history_point_count);
    push_i64_le(&mut bytes, payload.fetched_at_ms);
    push_u32_le(&mut bytes, source_meta.map(|(offset, _)| offset).unwrap_or(u32::MAX));
    push_u32_le(&mut bytes, source_meta.map(|(_, len)| len).unwrap_or(0));
    push_u32_le(&mut bytes, error_meta.map(|(offset, _)| offset).unwrap_or(u32::MAX));
    push_u32_le(&mut bytes, error_meta.map(|(_, len)| len).unwrap_or(0));
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
    bytes.extend_from_slice(&history_group_records);
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

fn push_f32_le(buffer: &mut Vec<u8>, value: f32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}
