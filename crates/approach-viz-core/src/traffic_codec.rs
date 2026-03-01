// AVTR FlatBuffers wire-format decoder.
//
// Decodes the FlatBuffers payload produced by
// `services/runtime-rs/src/traffic/encoding.rs` into a `DecodedTrafficPayload`.

use crate::types::{
    DecodedTrafficAircraft, DecodedTrafficHistoryGroup, DecodedTrafficHistoryPoint,
    DecodedTrafficPayload,
};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrafficDecodeError {
    InvalidPayload(String),
    HistoryPointOverflow { point_start: u32, point_count: u32, total_points: u32 },
}

impl std::fmt::Display for TrafficDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrafficDecodeError::InvalidPayload(msg) => {
                write!(f, "AVTR payload invalid: {msg}")
            }
            TrafficDecodeError::HistoryPointOverflow { point_start, point_count, total_points } => {
                write!(
                    f,
                    "AVTR history point overflow: start={point_start}, count={point_count}, \
                     total={total_points}"
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

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/// Decode an AVTR FlatBuffers payload into a `DecodedTrafficPayload`.
pub fn decode_traffic_fb(data: &[u8]) -> Result<DecodedTrafficPayload, TrafficDecodeError> {
    let fb = flatbuffers::root::<crate::generated::TrafficPayload>(data).map_err(|e| {
        TrafficDecodeError::InvalidPayload(format!("FlatBuffers verification failed: {e}"))
    })?;

    let flags = fb.flags();
    let fetched_at_ms = fb.fetched_at_ms();
    let source = fb.source().map(|s| s.to_string());
    let error = if flags & 1 != 0 {
        fb.error().map(|s| s.to_string())
    } else {
        None
    };

    // --- Aircraft ---
    let ac_count = fb.aircraft_count() as usize;
    let ac_hex = fb.ac_hex();
    let ac_flight = fb.ac_flight();
    let ac_lat = fb.ac_lat();
    let ac_lon = fb.ac_lon();
    let ac_altitude = fb.ac_altitude_feet();
    let ac_speed = fb.ac_ground_speed_kt();
    let ac_track = fb.ac_track_deg();
    let ac_last_seen = fb.ac_last_seen_seconds();
    let ac_flags = fb.ac_flags();

    let mut aircraft = Vec::with_capacity(ac_count);
    for i in 0..ac_count {
        let hex = ac_hex
            .as_ref()
            .map(|v| v.get(i))
            .unwrap_or("")
            .to_string();
        let flight_str = ac_flight
            .as_ref()
            .map(|v| v.get(i))
            .unwrap_or("");
        let flight = if flight_str.is_empty() {
            None
        } else {
            Some(flight_str.to_string())
        };
        let lat = ac_lat.as_ref().map(|v| v.get(i)).unwrap_or(0.0);
        let lon = ac_lon.as_ref().map(|v| v.get(i)).unwrap_or(0.0);
        let altitude_feet =
            nan_to_option(ac_altitude.as_ref().map(|v| v.get(i)).unwrap_or(f32::NAN));
        let ground_speed_kt =
            nan_to_option(ac_speed.as_ref().map(|v| v.get(i)).unwrap_or(f32::NAN));
        let track_deg =
            nan_to_option(ac_track.as_ref().map(|v| v.get(i)).unwrap_or(f32::NAN));
        let last_seen_seconds =
            nan_to_option(ac_last_seen.as_ref().map(|v| v.get(i)).unwrap_or(f32::NAN));
        let is_on_ground = ac_flags
            .as_ref()
            .map(|v| v.get(i) & 1 != 0)
            .unwrap_or(false);

        aircraft.push(DecodedTrafficAircraft {
            hex,
            flight,
            lat,
            lon,
            altitude_feet,
            ground_speed_kt,
            track_deg,
            last_seen_seconds,
            is_on_ground,
        });
    }

    // --- History groups ---
    let hg_count = fb.history_group_count() as usize;
    let total_hp = fb.history_point_count();
    let hg_hex = fb.hg_hex();
    let hg_point_start = fb.hg_point_start();
    let hg_point_count = fb.hg_point_count();
    let hp_ts = fb.hp_timestamp_ms();
    let hp_lat = fb.hp_lat();
    let hp_lon = fb.hp_lon();
    let hp_alt = fb.hp_altitude_feet();

    let mut history_groups = Vec::with_capacity(hg_count);
    for i in 0..hg_count {
        let hex = hg_hex
            .as_ref()
            .map(|v| v.get(i))
            .unwrap_or("")
            .to_string();
        let ps = hg_point_start.as_ref().map(|v| v.get(i)).unwrap_or(0);
        let pc = hg_point_count.as_ref().map(|v| v.get(i)).unwrap_or(0);

        if ps as u64 + pc as u64 > total_hp as u64 {
            return Err(TrafficDecodeError::HistoryPointOverflow {
                point_start: ps,
                point_count: pc,
                total_points: total_hp,
            });
        }

        let mut points = Vec::with_capacity(pc as usize);
        for j in 0..pc as usize {
            let idx = ps as usize + j;
            points.push(DecodedTrafficHistoryPoint {
                lat: hp_lat.as_ref().map(|v| v.get(idx)).unwrap_or(0.0),
                lon: hp_lon.as_ref().map(|v| v.get(idx)).unwrap_or(0.0),
                altitude_feet: hp_alt.as_ref().map(|v| v.get(idx)).unwrap_or(0.0),
                timestamp_ms: hp_ts.as_ref().map(|v| v.get(idx)).unwrap_or(0),
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

    // Use the runtime encoder to build test payloads for round-trip tests.
    // We build FlatBuffers payloads directly here.

    fn build_fb_payload(
        aircraft: &[DecodedTrafficAircraft],
        history_groups: &[DecodedTrafficHistoryGroup],
        fetched_at_ms: i64,
        source: Option<&str>,
        error: Option<&str>,
    ) -> Vec<u8> {
        use crate::generated::{TrafficPayload, TrafficPayloadArgs};

        let mut builder = flatbuffers::FlatBufferBuilder::with_capacity(512);

        let source_str = source.map(|s| builder.create_string(s));
        let error_str = error.map(|s| builder.create_string(s));

        let mut ac_hex_offsets = Vec::new();
        let mut ac_flight_offsets = Vec::new();
        let mut ac_lats = Vec::new();
        let mut ac_lons = Vec::new();
        let mut ac_altitudes = Vec::new();
        let mut ac_speeds = Vec::new();
        let mut ac_tracks = Vec::new();
        let mut ac_last_seen_v = Vec::new();
        let mut ac_flags_v = Vec::new();

        for ac in aircraft {
            ac_hex_offsets.push(builder.create_string(&ac.hex));
            ac_flight_offsets.push(
                builder.create_string(ac.flight.as_deref().unwrap_or("")),
            );
            ac_lats.push(ac.lat);
            ac_lons.push(ac.lon);
            ac_altitudes.push(ac.altitude_feet.unwrap_or(f32::NAN));
            ac_speeds.push(ac.ground_speed_kt.unwrap_or(f32::NAN));
            ac_tracks.push(ac.track_deg.unwrap_or(f32::NAN));
            ac_last_seen_v.push(ac.last_seen_seconds.unwrap_or(f32::NAN));
            ac_flags_v.push(if ac.is_on_ground { 1u16 } else { 0u16 });
        }

        let ac_hex_vec = builder.create_vector(&ac_hex_offsets);
        let ac_flight_vec = builder.create_vector(&ac_flight_offsets);
        let ac_lat_vec = builder.create_vector(&ac_lats);
        let ac_lon_vec = builder.create_vector(&ac_lons);
        let ac_altitude_vec = builder.create_vector(&ac_altitudes);
        let ac_speed_vec = builder.create_vector(&ac_speeds);
        let ac_track_vec = builder.create_vector(&ac_tracks);
        let ac_last_seen_vec = builder.create_vector(&ac_last_seen_v);
        let ac_flags_vec = builder.create_vector(&ac_flags_v);

        // History
        let mut hg_hex_offsets = Vec::new();
        let mut hg_starts = Vec::new();
        let mut hg_counts = Vec::new();
        let mut hp_ts = Vec::new();
        let mut hp_lats = Vec::new();
        let mut hp_lons = Vec::new();
        let mut hp_alts = Vec::new();
        let mut point_offset = 0u32;

        for hg in history_groups {
            hg_hex_offsets.push(builder.create_string(&hg.hex));
            hg_starts.push(point_offset);
            hg_counts.push(hg.points.len() as u32);
            point_offset += hg.points.len() as u32;
            for p in &hg.points {
                hp_ts.push(p.timestamp_ms);
                hp_lats.push(p.lat);
                hp_lons.push(p.lon);
                hp_alts.push(p.altitude_feet);
            }
        }

        let hg_hex_vec = builder.create_vector(&hg_hex_offsets);
        let hg_start_vec = builder.create_vector(&hg_starts);
        let hg_count_vec = builder.create_vector(&hg_counts);
        let hp_ts_vec = builder.create_vector(&hp_ts);
        let hp_lat_vec = builder.create_vector(&hp_lats);
        let hp_lon_vec = builder.create_vector(&hp_lons);
        let hp_alt_vec = builder.create_vector(&hp_alts);

        let mut flags = 0u32;
        if error.is_some() {
            flags |= 1;
        }

        let tp = TrafficPayload::create(
            &mut builder,
            &TrafficPayloadArgs {
                flags,
                fetched_at_ms,
                source: source_str,
                error: error_str,
                aircraft_count: aircraft.len() as u32,
                ac_hex: Some(ac_hex_vec),
                ac_flight: Some(ac_flight_vec),
                ac_lat: Some(ac_lat_vec),
                ac_lon: Some(ac_lon_vec),
                ac_altitude_feet: Some(ac_altitude_vec),
                ac_ground_speed_kt: Some(ac_speed_vec),
                ac_track_deg: Some(ac_track_vec),
                ac_last_seen_seconds: Some(ac_last_seen_vec),
                ac_flags: Some(ac_flags_vec),
                history_group_count: history_groups.len() as u32,
                hg_hex: Some(hg_hex_vec),
                hg_point_start: Some(hg_start_vec),
                hg_point_count: Some(hg_count_vec),
                history_point_count: point_offset,
                hp_timestamp_ms: Some(hp_ts_vec),
                hp_lat: Some(hp_lat_vec),
                hp_lon: Some(hp_lon_vec),
                hp_altitude_feet: Some(hp_alt_vec),
            },
        );
        builder.finish(tp, Some("AVTR"));
        builder.finished_data().to_vec()
    }

    #[test]
    fn decode_empty_payload() {
        let data = build_fb_payload(&[], &[], 1_700_000_000_000, None, None);
        let result = decode_traffic_fb(&data).unwrap();
        assert!(result.aircraft.is_empty());
        assert!(result.history_groups.is_empty());
        assert_eq!(result.fetched_at_ms, 1_700_000_000_000);
        assert_eq!(result.source, None);
        assert_eq!(result.error, None);
    }

    #[test]
    fn decode_single_aircraft() {
        let ac = DecodedTrafficAircraft {
            hex: "a1b2c3".into(),
            flight: Some("UAL123".into()),
            lat: 33.9425,
            lon: -118.4081,
            altitude_feet: Some(12500.0),
            ground_speed_kt: Some(450.0),
            track_deg: Some(270.0),
            last_seen_seconds: Some(2.5),
            is_on_ground: false,
        };
        let data = build_fb_payload(&[ac], &[], 1_700_000_000_000, None, None);
        let result = decode_traffic_fb(&data).unwrap();
        assert_eq!(result.aircraft.len(), 1);
        let a = &result.aircraft[0];
        assert_eq!(a.hex, "a1b2c3");
        assert_eq!(a.flight, Some("UAL123".into()));
        assert!((a.lat - 33.9425).abs() < 1e-4);
        assert!((a.lon - (-118.4081)).abs() < 1e-4);
        assert_eq!(a.altitude_feet, Some(12500.0));
        assert_eq!(a.ground_speed_kt, Some(450.0));
        assert_eq!(a.track_deg, Some(270.0));
        assert_eq!(a.last_seen_seconds, Some(2.5));
        assert!(!a.is_on_ground);
    }

    #[test]
    fn nan_altitude_becomes_none() {
        let ac = DecodedTrafficAircraft {
            hex: "abc123".into(),
            flight: None,
            lat: 40.0,
            lon: -74.0,
            altitude_feet: None,
            ground_speed_kt: Some(200.0),
            track_deg: Some(180.0),
            last_seen_seconds: Some(1.0),
            is_on_ground: false,
        };
        let data = build_fb_payload(&[ac], &[], 1_700_000_000_000, None, None);
        let result = decode_traffic_fb(&data).unwrap();
        let a = &result.aircraft[0];
        assert_eq!(a.altitude_feet, None);
        assert_eq!(a.ground_speed_kt, Some(200.0));
        assert_eq!(a.track_deg, Some(180.0));
    }

    #[test]
    fn is_on_ground_flag() {
        let ac = DecodedTrafficAircraft {
            hex: "abc123".into(),
            flight: None,
            lat: 40.0,
            lon: -74.0,
            altitude_feet: Some(0.0),
            ground_speed_kt: Some(5.0),
            track_deg: Some(90.0),
            last_seen_seconds: Some(0.0),
            is_on_ground: true,
        };
        let data = build_fb_payload(&[ac], &[], 1_700_000_000_000, None, None);
        let result = decode_traffic_fb(&data).unwrap();
        assert!(result.aircraft[0].is_on_ground);
    }

    #[test]
    fn decode_history_group() {
        let hg = DecodedTrafficHistoryGroup {
            hex: "abc123".into(),
            points: vec![
                DecodedTrafficHistoryPoint {
                    lat: 34.0,
                    lon: -118.0,
                    altitude_feet: 5000.0,
                    timestamp_ms: 1_700_000_000_000,
                },
                DecodedTrafficHistoryPoint {
                    lat: 34.1,
                    lon: -118.1,
                    altitude_feet: 5500.0,
                    timestamp_ms: 1_700_000_001_000,
                },
            ],
        };
        let data = build_fb_payload(&[], &[hg], 1_700_000_000_000, None, None);
        let result = decode_traffic_fb(&data).unwrap();
        assert_eq!(result.history_groups.len(), 1);
        let g = &result.history_groups[0];
        assert_eq!(g.hex, "abc123");
        assert_eq!(g.points.len(), 2);
        assert!((g.points[0].lat - 34.0).abs() < 1e-6);
        assert!((g.points[0].lon - (-118.0)).abs() < 1e-6);
        assert!((g.points[0].altitude_feet - 5000.0).abs() < 1e-6);
        assert_eq!(g.points[0].timestamp_ms, 1_700_000_000_000);
        assert!((g.points[1].lat - 34.1).abs() < 1e-4);
        assert_eq!(g.points[1].timestamp_ms, 1_700_000_001_000);
    }

    #[test]
    fn source_and_error_strings() {
        let data = build_fb_payload(
            &[], &[], 1_700_000_000_000,
            Some("adsb-exchange"),
            Some("timeout"),
        );
        let result = decode_traffic_fb(&data).unwrap();
        assert_eq!(result.source, Some("adsb-exchange".into()));
        assert_eq!(result.error, Some("timeout".into()));
    }

    #[test]
    fn absent_strings() {
        let ac = DecodedTrafficAircraft {
            hex: "abc123".into(),
            flight: None,
            lat: 40.0,
            lon: -74.0,
            altitude_feet: Some(10000.0),
            ground_speed_kt: Some(300.0),
            track_deg: Some(90.0),
            last_seen_seconds: Some(1.0),
            is_on_ground: false,
        };
        let data = build_fb_payload(&[ac], &[], 1_700_000_000_000, None, None);
        let result = decode_traffic_fb(&data).unwrap();
        assert_eq!(result.source, None);
        assert_eq!(result.error, None);
        assert_eq!(result.aircraft[0].flight, None);
    }

    #[test]
    fn reject_invalid_payload() {
        let data = vec![0xFFu8; 4];
        assert!(decode_traffic_fb(&data).is_err());
    }
}
