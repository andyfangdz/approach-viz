//! ADS-B traffic query policy and wire encoding shared by the runtime and the
//! web proxy's direct fallback.
//!
//! The runtime ingests ADS-B Exchange binCraft snapshots continuously and
//! answers `/v1/traffic/adsbx` from memory. When the runtime is unreachable,
//! the web proxy fetches a binCraft snapshot for the request's own box and
//! answers from it through [`build_direct_traffic_payload`] (via the server
//! WASM crate). Both paths decode, filter, rank, and encode with the functions
//! here, so current aircraft are reported the same way; the fallback has no
//! history.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::generated::{TrafficPayload, TrafficPayloadArgs};

pub const DEFAULT_RADIUS_NM: f64 = 80.0;
pub const MIN_RADIUS_NM: f64 = 5.0;
pub const MAX_RADIUS_NM: f64 = 220.0;
pub const DEFAULT_LIMIT: usize = 250;
pub const MAX_LIMIT: usize = 800;
pub const MAX_HISTORY_MINUTES: f64 = 60.0;
pub const DEFAULT_HIDE_GROUND_TRAFFIC: bool = false;
pub const EARTH_RADIUS_NM: f64 = 3440.065;
/// A track not observed for this long is no longer current.
pub const CACHE_CURRENT_STALE_MS: i64 = 60_000;
pub const TRAFFIC_FB_CONTENT_TYPE: &str = "application/vnd.approach-viz.traffic.v4";

const TRAFFIC_FB_FLAG_HAS_ERROR: u32 = 1 << 0;
const BINCRAFT_MIN_STRIDE_BYTES: usize = 112;
const BINCRAFT_MAX_STRIDE_BYTES: usize = 256;
const BINCRAFT_S32_SEEN_VERSION: u32 = 20240218;

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TrafficAircraft {
    pub hex: String,
    pub flight: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub is_on_ground: bool,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub last_seen_seconds: Option<f64>,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TrafficHistoryPoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: f64,
    pub timestamp_ms: i64,
}

#[derive(Debug)]
pub struct TrafficBinaryPayload {
    pub source: Option<String>,
    pub fetched_at_ms: i64,
    pub snapshot_age_ms: i64,
    pub stale_current: bool,
    pub aircraft: Vec<TrafficAircraft>,
    pub history_by_hex: HashMap<String, Vec<TrafficHistoryPoint>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct BoundingBox {
    pub south: f64,
    pub north: f64,
    pub west: f64,
    pub east: f64,
    pub crosses_dateline: bool,
}

/// Validated, clamped `/v1/traffic/adsbx` query parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct TrafficQuery {
    pub lat: f64,
    pub lon: f64,
    pub radius_nm: f64,
    pub limit: usize,
    pub history_minutes: f64,
    pub hide_ground_traffic: bool,
    pub history_hexes: Vec<String>,
}

/// Raw query-string values, as received.
#[derive(Debug, Clone, Copy, Default)]
pub struct RawTrafficQuery<'a> {
    pub lat: Option<&'a str>,
    pub lon: Option<&'a str>,
    pub radius_nm: Option<&'a str>,
    pub limit: Option<&'a str>,
    pub history_minutes: Option<&'a str>,
    pub hide_ground: Option<&'a str>,
    pub history_hexes: Option<&'a str>,
}

/// Parse and clamp a traffic query. The error is the message returned as a 400.
pub fn parse_traffic_query(raw: RawTrafficQuery<'_>) -> Result<TrafficQuery, String> {
    let (Some(lat), Some(lon)) = (normalize_lat(raw.lat), normalize_lon(raw.lon)) else {
        return Err("Valid lat/lon query params are required.".to_string());
    };
    // Reject present-but-malformed numeric params instead of silently
    // falling back to defaults (out-of-range finite values are still clamped).
    fn parse_optional_numeric(raw: Option<&str>, name: &str) -> Result<Option<f64>, String> {
        match raw.map(str::trim) {
            None | Some("") => Ok(None),
            Some(value) => to_finite_number(Some(value))
                .map(Some)
                .ok_or_else(|| format!("Invalid numeric query param '{name}'.")),
        }
    }
    let radius_nm = parse_optional_numeric(raw.radius_nm, "radiusNm")?;
    let limit = parse_optional_numeric(raw.limit, "limit")?;
    let history_minutes = parse_optional_numeric(raw.history_minutes, "historyMinutes")?;

    Ok(TrafficQuery {
        lat,
        lon,
        radius_nm: clamp(
            radius_nm.unwrap_or(DEFAULT_RADIUS_NM),
            MIN_RADIUS_NM,
            MAX_RADIUS_NM,
        ),
        limit: clamp_usize(
            limit
                .map(|value| value.floor() as i64)
                .unwrap_or(DEFAULT_LIMIT as i64),
            1,
            MAX_LIMIT,
        ),
        history_minutes: clamp(history_minutes.unwrap_or(0.0), 0.0, MAX_HISTORY_MINUTES),
        hide_ground_traffic: parse_boolean_query_param(
            raw.hide_ground,
            DEFAULT_HIDE_GROUND_TRAFFIC,
        ),
        history_hexes: parse_history_hexes(raw.history_hexes),
    })
}

pub fn to_radians(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

pub fn distance_nm(lat_a: f64, lon_a: f64, lat_b: f64, lon_b: f64) -> f64 {
    let lat_a_rad = to_radians(lat_a);
    let lat_b_rad = to_radians(lat_b);
    let d_lat = lat_b_rad - lat_a_rad;
    let d_lon = to_radians(lon_b - lon_a);
    let sin_lat = (d_lat / 2.0).sin();
    let sin_lon = (d_lon / 2.0).sin();
    let a = sin_lat * sin_lat + lat_a_rad.cos() * lat_b_rad.cos() * sin_lon * sin_lon;
    let c = 2.0 * a.sqrt().atan2((1.0 - a).max(0.0).sqrt());
    EARTH_RADIUS_NM * c
}

pub fn build_bounding_box(lat: f64, lon: f64, radius_nm: f64) -> BoundingBox {
    let lat_delta = radius_nm / 60.0;
    let lon_scale = lat.to_radians().cos().abs().max(0.01);
    let lon_delta = radius_nm / (60.0 * lon_scale);

    let south = clamp(lat - lat_delta, -90.0, 90.0);
    let north = clamp(lat + lat_delta, -90.0, 90.0);
    let mut west = lon - lon_delta;
    let mut east = lon + lon_delta;

    while west < -180.0 {
        west += 360.0;
    }
    while west > 180.0 {
        west -= 360.0;
    }
    while east < -180.0 {
        east += 360.0;
    }
    while east > 180.0 {
        east -= 360.0;
    }

    let crosses_dateline = west > east;
    BoundingBox {
        south,
        north,
        west,
        east,
        crosses_dateline,
    }
}

/// The `box=` value of a tar1090 `/re-api/` request.
pub fn box_param(bounds: BoundingBox) -> String {
    format!(
        "{:.6},{:.6},{:.6},{:.6}",
        bounds.south, bounds.north, bounds.west, bounds.east
    )
}

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

pub fn clamp_usize(value: i64, min: usize, max: usize) -> usize {
    (value.max(min as i64).min(max as i64)) as usize
}

pub fn to_finite_number(value: Option<&str>) -> Option<f64> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = trimmed.parse::<f64>().ok()?;
    if parsed.is_finite() {
        Some(parsed)
    } else {
        None
    }
}

pub fn parse_boolean_query_param(value: Option<&str>, fallback: bool) -> bool {
    let Some(value) = value else {
        return fallback;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

pub fn parse_history_hexes(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut parsed = Vec::new();
    let mut seen = HashSet::new();
    for candidate in value.split(',') {
        let hex = candidate.trim();
        if hex.is_empty() {
            continue;
        }
        let normalized = hex.to_ascii_lowercase();
        if !seen.insert(normalized.clone()) {
            continue;
        }
        parsed.push(normalized);
    }
    parsed
}

pub fn normalize_lat(raw: Option<&str>) -> Option<f64> {
    let parsed = to_finite_number(raw)?;
    normalize_lat_value(parsed)
}

pub fn normalize_lon(raw: Option<&str>) -> Option<f64> {
    let parsed = to_finite_number(raw)?;
    normalize_lon_value(parsed)
}

pub fn normalize_lat_value(parsed: f64) -> Option<f64> {
    if (-90.0..=90.0).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

pub fn normalize_lon_value(parsed: f64) -> Option<f64> {
    if (-180.0..=180.0).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

pub fn normalize_heading_value(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    let wrapped = value % 360.0;
    Some(if wrapped < 0.0 {
        wrapped + 360.0
    } else {
        wrapped
    })
}

pub fn normalize_callsign(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn normalize_speed_kt(value: f64) -> Option<f64> {
    if !value.is_finite() || !(0.0..=1800.0).contains(&value) {
        return None;
    }
    Some(value)
}

pub fn normalize_seen_seconds_value(value: f64) -> Option<f64> {
    if !value.is_finite() || !(0.0..=86_400.0).contains(&value) {
        return None;
    }
    Some(value)
}

pub fn normalize_altitude_feet_value(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    Some(clamp(value, -2000.0, 70_000.0))
}

/// When a polled aircraft was last observed: the poll time minus its reported
/// age, clamped to `[cutoff_ms, polled_at_ms]`.
pub fn observed_at_ms(aircraft: &TrafficAircraft, polled_at_ms: i64, cutoff_ms: i64) -> i64 {
    aircraft
        .last_seen_seconds
        .map(|seconds| (polled_at_ms as f64 - seconds * 1000.0).round() as i64)
        .unwrap_or(polled_at_ms)
        .clamp(cutoff_ms, polled_at_ms)
}

/// Keep the fresher of two reports of the same aircraft.
pub fn merge_aircraft_candidate(
    by_hex: &mut HashMap<String, TrafficAircraft>,
    candidate: TrafficAircraft,
) {
    match by_hex.get(&candidate.hex) {
        Some(current) => {
            let current_seen = current.last_seen_seconds.unwrap_or(f64::INFINITY);
            let candidate_seen = candidate.last_seen_seconds.unwrap_or(f64::INFINITY);
            if candidate_seen < current_seen {
                by_hex.insert(candidate.hex.clone(), candidate);
            }
        }
        None => {
            by_hex.insert(candidate.hex.clone(), candidate);
        }
    }
}

/// Restrict current aircraft to the query radius, most recently seen first
/// (ties by distance), and keep at most `limit`.
pub fn rank_current_aircraft(
    aircraft: &mut Vec<TrafficAircraft>,
    lat: f64,
    lon: f64,
    radius_nm: f64,
    limit: usize,
) {
    aircraft.retain(|ac| distance_nm(lat, lon, ac.lat, ac.lon) <= radius_nm);
    aircraft.sort_by(|left, right| {
        let left_seen = left.last_seen_seconds.unwrap_or(f64::INFINITY);
        let right_seen = right.last_seen_seconds.unwrap_or(f64::INFINITY);
        left_seen
            .partial_cmp(&right_seen)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                let ld = distance_nm(lat, lon, left.lat, left.lon);
                let rd = distance_nm(lat, lon, right.lat, right.lon);
                ld.partial_cmp(&rd).unwrap_or(Ordering::Equal)
            })
    });
    aircraft.truncate(limit);
}

/// Decode a (zstd-decompressed) tar1090 binCraft snapshot. Aircraft without a
/// valid position are skipped; duplicate hexes keep the fresher report.
pub fn decode_bincraft_records(decoded: &[u8]) -> Result<Vec<TrafficAircraft>, String> {
    if decoded.len() < 44 {
        return Err("binCraft payload is too small.".to_string());
    }

    let stride = read_u32_le(decoded, 8).unwrap_or(0) as usize;
    if !(BINCRAFT_MIN_STRIDE_BYTES..=BINCRAFT_MAX_STRIDE_BYTES).contains(&stride) || !stride.is_multiple_of(4)
    {
        return Err(format!("Unexpected binCraft stride: {stride}"));
    }

    let version = read_u32_le(decoded, 40).unwrap_or_default();
    let max_offset = decoded.len() - (decoded.len() % stride);

    let mut by_hex: HashMap<String, TrafficAircraft> = HashMap::new();

    let mut offset = stride;
    while offset + stride <= max_offset {
        let u8 = &decoded[offset..offset + stride];
        let validity73 = u8[73];
        if (validity73 & 64) == 0 {
            offset += stride;
            continue;
        }

        let lat =
            read_i32_le(u8, 12).and_then(|value| normalize_lat_value(value as f64 / 1_000_000.0));
        let lon =
            read_i32_le(u8, 8).and_then(|value| normalize_lon_value(value as f64 / 1_000_000.0));
        let (lat, lon) = match (lat, lon) {
            (Some(lat), Some(lon)) => (lat, lon),
            _ => {
                offset += stride;
                continue;
            }
        };

        let raw_hex = read_i32_le(u8, 0).unwrap_or_default() as u32;
        let hex_base = raw_hex & 0x00ff_ffff;
        if hex_base == 0 {
            offset += stride;
            continue;
        }
        let is_temporary = (raw_hex & (1 << 24)) != 0;
        let hex = if is_temporary {
            format!("~{hex_base:06x}")
        } else {
            format!("{hex_base:06x}")
        };

        let altitude_feet = if (validity73 & 32) != 0 {
            normalize_altitude_feet_value(
                (25_i32 * read_i16_le(u8, 22).unwrap_or_default() as i32) as f64,
            )
        } else if (validity73 & 16) != 0 {
            normalize_altitude_feet_value(
                (25_i32 * read_i16_le(u8, 20).unwrap_or_default() as i32) as f64,
            )
        } else {
            None
        };

        let ground_speed_kt = if (validity73 & 128) != 0 {
            normalize_speed_kt(
                read_i16_le(u8, 34)
                    .map(|value| value as f64 / 10.0)
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        let track_deg = if (u8[74] & 8) != 0 {
            normalize_heading_value(
                read_i16_le(u8, 40)
                    .map(|value| value as f64 / 90.0)
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        let flight = if (validity73 & 8) != 0 {
            decode_flight(u8)
        } else {
            None
        };
        let airground = u8[68] & 15;
        let is_on_ground = airground == 1;

        let seen_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(u8, 4).map(|value| value as f64 / 10.0)
        } else {
            read_u16_le(u8, 6).map(|value| value as f64 / 10.0)
        };
        let seen_pos_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(u8, 108).map(|value| value as f64 / 10.0)
        } else {
            read_u16_le(u8, 4).map(|value| value as f64 / 10.0)
        };

        let last_seen_seconds = seen_pos_seconds
            .and_then(normalize_seen_seconds_value)
            .or_else(|| seen_seconds.and_then(normalize_seen_seconds_value));

        let aircraft = TrafficAircraft {
            hex: hex.clone(),
            flight,
            lat,
            lon,
            is_on_ground,
            altitude_feet,
            ground_speed_kt,
            track_deg,
            last_seen_seconds,
        };

        merge_aircraft_candidate(&mut by_hex, aircraft);
        offset += stride;
    }

    Ok(by_hex.into_values().collect())
}

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    data.get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_i16_le(data: &[u8], offset: usize) -> Option<i16> {
    data.get(offset..offset + 2)
        .map(|slice| i16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32_le(data: &[u8], offset: usize) -> Option<i32> {
    data.get(offset..offset + 4)
        .map(|slice| i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn decode_flight(u8: &[u8]) -> Option<String> {
    let mut bytes = Vec::new();
    for index in 78..86 {
        let code = *u8.get(index)?;
        if code == 0 {
            break;
        }
        bytes.push(code);
    }

    let text = String::from_utf8_lossy(&bytes);
    normalize_callsign(Some(text.trim()))
}

/// The current aircraft the runtime would report for `query` if its store
/// held only this one poll (taken at `polled_at_ms`): stale and, when asked,
/// ground reports dropped, ages measured from the poll, then ranked.
pub fn select_direct_aircraft(
    aircraft: Vec<TrafficAircraft>,
    query: &TrafficQuery,
    polled_at_ms: i64,
) -> Vec<TrafficAircraft> {
    let stale_cutoff_ms = polled_at_ms - CACHE_CURRENT_STALE_MS;
    let mut selected: Vec<TrafficAircraft> = aircraft
        .into_iter()
        .filter_map(|mut aircraft| {
            // No lower clamp: a report older than the stale window must stay
            // outside it, as it does in the runtime's store (clamped only to
            // the retention hour).
            let observed = observed_at_ms(&aircraft, polled_at_ms, i64::MIN);
            if observed < stale_cutoff_ms || (query.hide_ground_traffic && aircraft.is_on_ground) {
                return None;
            }
            aircraft.last_seen_seconds = Some(((polled_at_ms - observed).max(0) as f64) / 1000.0);
            Some(aircraft)
        })
        .collect();
    rank_current_aircraft(
        &mut selected,
        query.lat,
        query.lon,
        query.radius_nm,
        query.limit,
    );
    selected
}

/// Answer a traffic query directly from one (zstd-decompressed) binCraft
/// snapshot of the query's box: [`select_direct_aircraft`] with no history,
/// as an AVTR v4 payload.
pub fn build_direct_traffic_payload(
    decoded_bincraft: &[u8],
    query: &TrafficQuery,
    polled_at_ms: i64,
    source: &str,
) -> Result<Vec<u8>, String> {
    let aircraft = select_direct_aircraft(
        decode_bincraft_records(decoded_bincraft)?,
        query,
        polled_at_ms,
    );
    Ok(encode_traffic_fb(&TrafficBinaryPayload {
        source: Some(source.to_string()),
        fetched_at_ms: polled_at_ms,
        snapshot_age_ms: 0,
        stale_current: false,
        aircraft,
        history_by_hex: HashMap::new(),
        error: None,
    }))
}

/// Encode a traffic payload into a FlatBuffers AVTR payload.
pub fn encode_traffic_fb(payload: &TrafficBinaryPayload) -> Vec<u8> {
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
        ac_flight_offsets.push(builder.create_string(aircraft.flight.as_deref().unwrap_or("")));
        ac_lats.push(aircraft.lat as f32);
        ac_lons.push(aircraft.lon as f32);
        ac_altitudes.push(aircraft.altitude_feet.map(|v| v as f32).unwrap_or(f32::NAN));
        ac_speeds.push(
            aircraft
                .ground_speed_kt
                .map(|v| v as f32)
                .unwrap_or(f32::NAN),
        );
        ac_tracks.push(aircraft.track_deg.map(|v| v as f32).unwrap_or(f32::NAN));
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
    history_entries.sort_by_key(|(hex, _)| *hex);

    let hg_count = history_entries.len();
    let mut hg_hex_offsets = Vec::with_capacity(hg_count);
    let mut hg_point_starts: Vec<u32> = Vec::with_capacity(hg_count);
    let mut hg_point_counts: Vec<u32> = Vec::with_capacity(hg_count);

    let total_points: usize = payload.history_by_hex.values().map(|v| v.len()).sum();

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

#[cfg(test)]
mod tests {
    use super::*;

    const STRIDE: usize = 112;
    const POLLED_AT_MS: i64 = 1_700_000_000_000;

    struct Record {
        hex: u32,
        lat: f64,
        lon: f64,
        altitude_feet: i32,
        ground_speed_kt: f64,
        track_deg: f64,
        callsign: &'static str,
        on_ground: bool,
        seen_seconds: f64,
    }

    /// A tar1090 binCraft snapshot (uncompressed, s32 "seen" layout).
    fn bincraft(records: &[Record]) -> Vec<u8> {
        let mut out = vec![0_u8; STRIDE * (records.len() + 1)];
        out[8..12].copy_from_slice(&(STRIDE as u32).to_le_bytes());
        out[40..44].copy_from_slice(&BINCRAFT_S32_SEEN_VERSION.to_le_bytes());
        for (i, r) in records.iter().enumerate() {
            let rec = &mut out[STRIDE * (i + 1)..STRIDE * (i + 2)];
            rec[0..4].copy_from_slice(&r.hex.to_le_bytes());
            let seen = ((r.seen_seconds * 10.0).round() as i32).to_le_bytes();
            rec[4..8].copy_from_slice(&seen);
            rec[108..112].copy_from_slice(&seen);
            rec[8..12].copy_from_slice(&((r.lon * 1e6).round() as i32).to_le_bytes());
            rec[12..16].copy_from_slice(&((r.lat * 1e6).round() as i32).to_le_bytes());
            rec[22..24].copy_from_slice(&((r.altitude_feet / 25) as i16).to_le_bytes());
            rec[34..36].copy_from_slice(&((r.ground_speed_kt * 10.0) as i16).to_le_bytes());
            rec[40..42].copy_from_slice(&((r.track_deg * 90.0) as i16).to_le_bytes());
            rec[68] = if r.on_ground { 1 } else { 0 };
            // position, geometric altitude, callsign, and ground speed valid
            rec[73] = 64 | 32 | 8 | 128;
            rec[74] = 8; // track valid
            rec[78..78 + r.callsign.len()].copy_from_slice(r.callsign.as_bytes());
        }
        out
    }

    fn sample_records() -> Vec<Record> {
        let base = |hex, lat, lon, seen_seconds| Record {
            hex,
            lat,
            lon,
            altitude_feet: 12_000,
            ground_speed_kt: 250.0,
            track_deg: 90.0,
            callsign: "AAL123",
            on_ground: false,
            seen_seconds,
        };
        vec![
            base(0xa00001, 40.70, -74.10, 0.5),
            base(0xa00002, 40.90, -73.80, 12.0),
            Record {
                on_ground: true,
                altitude_feet: 0,
                callsign: "GND1",
                ..base(0xa00003, 40.64, -73.78, 2.0)
            },
            // Far outside an 80 nm query.
            base(0xa00004, 43.00, -74.10, 1.0),
            // Stale: older than the current window.
            base(0xa00005, 40.75, -74.00, 90.0),
            // Temporary (non-ICAO) address.
            base(0x01a00006, 40.60, -74.20, 3.0),
        ]
    }

    #[test]
    fn decodes_bincraft_records() {
        let mut aircraft = decode_bincraft_records(&bincraft(&sample_records())).unwrap();
        aircraft.sort_by(|a, b| a.hex.cmp(&b.hex));
        assert_eq!(aircraft.len(), 6);
        let first = &aircraft[0];
        assert_eq!(first.hex, "a00001");
        assert_eq!(first.flight.as_deref(), Some("AAL123"));
        assert!((first.lat - 40.70).abs() < 1e-6 && (first.lon + 74.10).abs() < 1e-6);
        assert_eq!(first.altitude_feet, Some(12_000.0));
        assert_eq!(first.ground_speed_kt, Some(250.0));
        assert_eq!(first.track_deg, Some(90.0));
        assert_eq!(first.last_seen_seconds, Some(0.5));
        assert!(aircraft.iter().any(|a| a.hex == "~a00006"));
        assert!(aircraft.iter().any(|a| a.hex == "a00003" && a.is_on_ground));
    }

    #[test]
    fn rejects_malformed_bincraft() {
        assert!(decode_bincraft_records(&[0_u8; 20]).is_err());
        let mut bad_stride = bincraft(&sample_records());
        bad_stride[8..12].copy_from_slice(&7_u32.to_le_bytes());
        assert!(decode_bincraft_records(&bad_stride).is_err());
    }

    #[test]
    fn parses_queries_with_the_runtime_rules() {
        let query = parse_traffic_query(RawTrafficQuery {
            lat: Some("40.7"),
            lon: Some("-74.1"),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(query.radius_nm, DEFAULT_RADIUS_NM);
        assert_eq!(query.limit, DEFAULT_LIMIT);
        assert_eq!(query.history_minutes, 0.0);
        assert!(!query.hide_ground_traffic);

        let clamped = parse_traffic_query(RawTrafficQuery {
            lat: Some("40.7"),
            lon: Some("-74.1"),
            radius_nm: Some("9999"),
            limit: Some("0.5"),
            history_minutes: Some("120"),
            hide_ground: Some("yes"),
            history_hexes: Some("ABC123,abc123, def456"),
        })
        .unwrap();
        assert_eq!(clamped.radius_nm, MAX_RADIUS_NM);
        assert_eq!(clamped.limit, 1);
        assert_eq!(clamped.history_minutes, MAX_HISTORY_MINUTES);
        assert!(clamped.hide_ground_traffic);
        assert_eq!(clamped.history_hexes, vec!["abc123", "def456"]);

        let missing = parse_traffic_query(RawTrafficQuery {
            lat: Some("95"),
            lon: Some("-74.1"),
            ..Default::default()
        });
        assert_eq!(
            missing.unwrap_err(),
            "Valid lat/lon query params are required."
        );
        let malformed = parse_traffic_query(RawTrafficQuery {
            lat: Some("40.7"),
            lon: Some("-74.1"),
            limit: Some("Infinity"),
            ..Default::default()
        });
        assert_eq!(
            malformed.unwrap_err(),
            "Invalid numeric query param 'limit'."
        );
    }

    #[test]
    fn direct_selection_drops_stale_far_and_optionally_ground_aircraft() {
        let aircraft = decode_bincraft_records(&bincraft(&sample_records())).unwrap();
        let mut query = parse_traffic_query(RawTrafficQuery {
            lat: Some("40.7"),
            lon: Some("-74.1"),
            ..Default::default()
        })
        .unwrap();
        let hexes = |selected: Vec<TrafficAircraft>| {
            selected.into_iter().map(|a| a.hex).collect::<Vec<_>>()
        };
        // Freshest first.
        assert_eq!(
            hexes(select_direct_aircraft(
                aircraft.clone(),
                &query,
                POLLED_AT_MS
            )),
            vec!["a00001", "a00003", "~a00006", "a00002"]
        );
        query.hide_ground_traffic = true;
        assert_eq!(
            hexes(select_direct_aircraft(aircraft, &query, POLLED_AT_MS)),
            vec!["a00001", "~a00006", "a00002"]
        );
    }

    /// The traffic route test (app/api/traffic/adsbx/route.test.ts) serves
    /// `sample.bincraft` zstd-compressed from a mocked upstream and expects
    /// exactly `sample-traffic.avtr`. Regenerate with `UPDATE_SERVER_FIXTURES=1`.
    #[test]
    fn traffic_route_fixture_is_current() {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/server-wasm");
        let snapshot = bincraft(&sample_records());
        let query = parse_traffic_query(RawTrafficQuery {
            lat: Some("40.7"),
            lon: Some("-74.1"),
            radius_nm: Some("80"),
            limit: Some("250"),
            ..Default::default()
        })
        .unwrap();
        let payload = build_direct_traffic_payload(
            &snapshot,
            &query,
            POLLED_AT_MS,
            "https://globe.adsbexchange.com (direct fallback)",
        )
        .unwrap();
        let files = [
            ("sample.bincraft", snapshot),
            ("sample-traffic.avtr", payload),
        ];
        let update = std::env::var_os("UPDATE_SERVER_FIXTURES").is_some();
        for (name, bytes) in files {
            let path = dir.join(name);
            if update {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(&path, &bytes).unwrap();
            } else {
                let committed = std::fs::read(&path)
                    .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
                assert!(
                    committed == bytes,
                    "{name} is stale; rerun with UPDATE_SERVER_FIXTURES=1"
                );
            }
        }
    }
}
