use super::types::{
    add_traffic_snapshot_headers, no_store_headers_with_content_type, TrafficBinaryPayload,
};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

const TRAFFIC_FB_CONTENT_TYPE: &str = "application/vnd.approach-viz.traffic.v4";
const TRAFFIC_FB_FLAG_HAS_ERROR: u32 = 1 << 0;

pub(crate) fn traffic_binary_response(payload: TrafficBinaryPayload) -> Response {
    let bytes = encode_traffic_fb(&payload);
    let mut headers = no_store_headers_with_content_type(TRAFFIC_FB_CONTENT_TYPE);
    add_traffic_snapshot_headers(
        &mut headers,
        payload.stale_current,
        payload.snapshot_age_ms,
    );
    (StatusCode::OK, headers, bytes).into_response()
}

/// Encode a traffic payload into a FlatBuffers AVTR payload.
pub fn encode_traffic_fb(payload: &TrafficBinaryPayload) -> Vec<u8> {
    use approach_viz_core::generated::{TrafficPayload, TrafficPayloadArgs};

    let ac_count = payload.aircraft.len();
    let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(
        256 + ac_count * 48, // rough estimate
    );

    // --- Strings (must be created before the table) ---
    let source_str = payload.source.as_deref().map(|s| builder.create_string(s));
    let error_str = payload.error.as_deref().map(|s| builder.create_string(s));

    // --- Aircraft SoA columns ---
    let mut ac_lats: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_lons: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_altitudes: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_speeds: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_tracks: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_last_seen: Vec<f32> = Vec::with_capacity(ac_count);
    let mut ac_flags: Vec<u16> = Vec::with_capacity(ac_count);

    // String vectors need special handling — create WIPOffsets first
    let mut ac_hex_offsets = Vec::with_capacity(ac_count);
    let mut ac_flight_offsets = Vec::with_capacity(ac_count);

    for aircraft in &payload.aircraft {
        ac_hex_offsets.push(builder.create_string(&aircraft.hex));
        ac_flight_offsets.push(
            builder.create_string(aircraft.flight.as_deref().unwrap_or("")),
        );
        ac_lats.push(aircraft.lat as f32);
        ac_lons.push(aircraft.lon as f32);
        ac_altitudes.push(
            aircraft
                .altitude_feet
                .map(|v| v as f32)
                .unwrap_or(f32::NAN),
        );
        ac_speeds.push(
            aircraft
                .ground_speed_kt
                .map(|v| v as f32)
                .unwrap_or(f32::NAN),
        );
        ac_tracks.push(
            aircraft
                .track_deg
                .map(|v| v as f32)
                .unwrap_or(f32::NAN),
        );
        ac_last_seen.push(
            aircraft
                .last_seen_seconds
                .map(|v| v as f32)
                .unwrap_or(f32::NAN),
        );
        ac_flags.push(if aircraft.is_on_ground { 1 } else { 0 });
    }

    let ac_hex_vec = builder.create_vector(&ac_hex_offsets);
    let ac_flight_vec = builder.create_vector(&ac_flight_offsets);
    let ac_lat_vec = builder.create_vector(&ac_lats);
    let ac_lon_vec = builder.create_vector(&ac_lons);
    let ac_altitude_vec = builder.create_vector(&ac_altitudes);
    let ac_speed_vec = builder.create_vector(&ac_speeds);
    let ac_track_vec = builder.create_vector(&ac_tracks);
    let ac_last_seen_vec = builder.create_vector(&ac_last_seen);
    let ac_flags_vec = builder.create_vector(&ac_flags);

    // --- History groups SoA ---
    let mut history_entries = payload.history_by_hex.iter().collect::<Vec<_>>();
    history_entries.sort_by(|(a, _), (b, _)| a.cmp(b));

    let hg_count = history_entries.len();
    let mut hg_hex_offsets = Vec::with_capacity(hg_count);
    let mut hg_point_starts: Vec<u32> = Vec::with_capacity(hg_count);
    let mut hg_point_counts: Vec<u32> = Vec::with_capacity(hg_count);

    let total_points: usize = payload
        .history_by_hex
        .values()
        .map(|v| v.len())
        .sum();

    let mut hp_lats: Vec<f32> = Vec::with_capacity(total_points);
    let mut hp_lons: Vec<f32> = Vec::with_capacity(total_points);
    let mut hp_altitudes: Vec<f32> = Vec::with_capacity(total_points);
    let mut hp_timestamps: Vec<i64> = Vec::with_capacity(total_points);

    let mut point_offset = 0_u32;
    for (hex, points) in &history_entries {
        hg_hex_offsets.push(builder.create_string(hex));
        hg_point_starts.push(point_offset);
        hg_point_counts.push(points.len() as u32);
        point_offset += points.len() as u32;

        for point in *points {
            hp_lats.push(point.lat as f32);
            hp_lons.push(point.lon as f32);
            hp_altitudes.push(point.altitude_feet as f32);
            hp_timestamps.push(point.timestamp_ms);
        }
    }

    let hg_hex_vec = builder.create_vector(&hg_hex_offsets);
    let hg_point_start_vec = builder.create_vector(&hg_point_starts);
    let hg_point_count_vec = builder.create_vector(&hg_point_counts);

    let hp_timestamp_vec = builder.create_vector(&hp_timestamps);
    let hp_lat_vec = builder.create_vector(&hp_lats);
    let hp_lon_vec = builder.create_vector(&hp_lons);
    let hp_altitude_vec = builder.create_vector(&hp_altitudes);

    // --- Build table ---
    let mut flags = 0_u32;
    if payload.error.is_some() {
        flags |= TRAFFIC_FB_FLAG_HAS_ERROR;
    }

    let tp = TrafficPayload::create(
        &mut builder,
        &TrafficPayloadArgs {
            flags,
            fetched_at_ms: payload.fetched_at_ms,
            source: source_str,
            error: error_str,
            aircraft_count: ac_count as u32,
            ac_hex: Some(ac_hex_vec),
            ac_flight: Some(ac_flight_vec),
            ac_lat: Some(ac_lat_vec),
            ac_lon: Some(ac_lon_vec),
            ac_altitude_feet: Some(ac_altitude_vec),
            ac_ground_speed_kt: Some(ac_speed_vec),
            ac_track_deg: Some(ac_track_vec),
            ac_last_seen_seconds: Some(ac_last_seen_vec),
            ac_flags: Some(ac_flags_vec),
            history_group_count: hg_count as u32,
            hg_hex: Some(hg_hex_vec),
            hg_point_start: Some(hg_point_start_vec),
            hg_point_count: Some(hg_point_count_vec),
            history_point_count: total_points as u32,
            hp_timestamp_ms: Some(hp_timestamp_vec),
            hp_lat: Some(hp_lat_vec),
            hp_lon: Some(hp_lon_vec),
            hp_altitude_feet: Some(hp_altitude_vec),
        },
    );
    builder.finish(tp, Some("AVTR"));
    builder.finished_data().to_vec()
}
