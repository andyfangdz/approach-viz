// Traffic track merge/prune/projection + FNV-1a render hashing.
//
// Ported from `app/scene/traffic/traffic.worker.ts`.
// Maintains a stateful track map, merges incoming aircraft data,
// prunes stale entries, projects to scene coordinates, and computes
// FNV-1a hashes for render-diff change detection.

use std::collections::HashMap;
use std::f64::consts::PI;

use crate::coords::{alt_to_y, earth_curvature_drop_nm, lat_lon_to_local};
use crate::generated::TrafficPayload;

const DEG_TO_RAD: f64 = PI / 180.0;
const FEET_PER_NM: f64 = 6076.12;

const MIN_SAMPLE_DISTANCE_NM: f64 = 0.03;
const MIN_SAMPLE_ALTITUDE_DELTA_FEET: f64 = 100.0;
const STALE_GRACE_MS: i64 = 20_000;

// ---------------------------------------------------------------------------
// FNV-1a helpers (32-bit)
// ---------------------------------------------------------------------------

const FNV_OFFSET: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

fn fnv_hash_u32(hash: u32, value: u32) -> u32 {
    (hash ^ value).wrapping_mul(FNV_PRIME)
}

fn fnv_hash_f32(hash: u32, value: f32) -> u32 {
    if !value.is_finite() {
        return fnv_hash_u32(hash, 0);
    }
    fnv_hash_u32(hash, value.to_bits())
}

fn fnv_hash_str(mut hash: u32, s: &str) -> u32 {
    for b in s.bytes() {
        hash = fnv_hash_u32(hash, b as u32);
    }
    hash
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single history point in a track.
#[derive(Debug, Clone)]
pub struct TrafficHistoryPoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: f64,
    pub timestamp_ms: i64,
}

/// A tracked aircraft with history.
#[derive(Debug, Clone)]
pub struct TrafficTrack {
    pub hex: String,
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub flight: Option<String>,
    pub is_on_ground: bool,
    pub last_update_ms: i64,
    pub last_seen_ms: i64,
    pub history: Vec<TrafficHistoryPoint>,
}

/// Input aircraft for merge (from decoded payload).
pub struct MergeAircraft {
    pub hex: String,
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub flight: Option<String>,
    pub is_on_ground: bool,
    pub last_seen_seconds: Option<f64>,
}

/// Backfill history keyed by hex.
pub struct BackfillHistory {
    pub hex: String,
    pub points: Vec<TrafficHistoryPoint>,
}

/// A scene airport for ground-elevation lookup.
pub struct SceneAirport {
    pub lat: f64,
    pub lon: f64,
    pub elevation_feet: f64,
}

// ---------------------------------------------------------------------------
// AircraftSource trait — abstracts indexed aircraft access for merge()
// ---------------------------------------------------------------------------

/// Indexed access to aircraft fields. Implemented for `&[MergeAircraft]` (JSON
/// path) and `FbAircraftView` (binary FlatBuffers zero-copy path).
pub trait AircraftSource {
    fn len(&self) -> usize;
    fn hex(&self, i: usize) -> &str;
    fn lat(&self, i: usize) -> f64;
    fn lon(&self, i: usize) -> f64;
    fn altitude_feet(&self, i: usize) -> Option<f64>;
    fn is_on_ground(&self, i: usize) -> bool;
    fn ground_speed_kt(&self, i: usize) -> Option<f64>;
    fn track_deg(&self, i: usize) -> Option<f64>;
    fn flight(&self, i: usize) -> Option<&str>;
}

impl AircraftSource for [MergeAircraft] {
    #[inline]
    fn len(&self) -> usize {
        <[MergeAircraft]>::len(self)
    }
    #[inline]
    fn hex(&self, i: usize) -> &str {
        &self[i].hex
    }
    #[inline]
    fn lat(&self, i: usize) -> f64 {
        self[i].lat
    }
    #[inline]
    fn lon(&self, i: usize) -> f64 {
        self[i].lon
    }
    #[inline]
    fn altitude_feet(&self, i: usize) -> Option<f64> {
        self[i].altitude_feet
    }
    #[inline]
    fn is_on_ground(&self, i: usize) -> bool {
        self[i].is_on_ground
    }
    #[inline]
    fn ground_speed_kt(&self, i: usize) -> Option<f64> {
        self[i].ground_speed_kt
    }
    #[inline]
    fn track_deg(&self, i: usize) -> Option<f64> {
        self[i].track_deg
    }
    #[inline]
    fn flight(&self, i: usize) -> Option<&str> {
        self[i].flight.as_deref()
    }
}

// ---------------------------------------------------------------------------
// FbAircraftView — zero-copy view over FlatBuffers SoA aircraft columns
// ---------------------------------------------------------------------------

/// Convert NaN f32 to None; finite values become `Some(v as f64)`.
#[inline]
#[allow(dead_code)] // used only in wasm target
fn nan_f32_to_option_f64(v: f32) -> Option<f64> {
    if v.is_nan() { None } else { Some(v as f64) }
}

/// Zero-copy view over a FlatBuffers `TrafficPayload`'s aircraft columns.
/// All `&str` borrows point directly into the FlatBuffers buffer — no String
/// allocations until the merge loop actually needs to insert a new track.
#[allow(dead_code)] // used only in wasm target
pub(crate) struct FbAircraftView<'a> {
    count: usize,
    ac_hex: Option<flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<&'a str>>>,
    ac_flight: Option<flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<&'a str>>>,
    ac_lat: Option<flatbuffers::Vector<'a, f32>>,
    ac_lon: Option<flatbuffers::Vector<'a, f32>>,
    ac_altitude_feet: Option<flatbuffers::Vector<'a, f32>>,
    ac_ground_speed_kt: Option<flatbuffers::Vector<'a, f32>>,
    ac_track_deg: Option<flatbuffers::Vector<'a, f32>>,
    ac_flags: Option<flatbuffers::Vector<'a, u16>>,
}

#[allow(dead_code)] // used only in wasm target
impl<'a> FbAircraftView<'a> {
    pub(crate) fn new(fb: &TrafficPayload<'a>) -> Self {
        Self {
            count: fb.aircraft_count() as usize,
            ac_hex: fb.ac_hex(),
            ac_flight: fb.ac_flight(),
            ac_lat: fb.ac_lat(),
            ac_lon: fb.ac_lon(),
            ac_altitude_feet: fb.ac_altitude_feet(),
            ac_ground_speed_kt: fb.ac_ground_speed_kt(),
            ac_track_deg: fb.ac_track_deg(),
            ac_flags: fb.ac_flags(),
        }
    }
}

impl AircraftSource for FbAircraftView<'_> {
    #[inline]
    fn len(&self) -> usize {
        self.count
    }
    #[inline]
    fn hex(&self, i: usize) -> &str {
        self.ac_hex.as_ref().map(|v| v.get(i)).unwrap_or("")
    }
    #[inline]
    fn lat(&self, i: usize) -> f64 {
        self.ac_lat.as_ref().map(|v| v.get(i)).unwrap_or(0.0) as f64
    }
    #[inline]
    fn lon(&self, i: usize) -> f64 {
        self.ac_lon.as_ref().map(|v| v.get(i)).unwrap_or(0.0) as f64
    }
    #[inline]
    fn altitude_feet(&self, i: usize) -> Option<f64> {
        nan_f32_to_option_f64(self.ac_altitude_feet.as_ref().map(|v| v.get(i)).unwrap_or(f32::NAN))
    }
    #[inline]
    fn is_on_ground(&self, i: usize) -> bool {
        self.ac_flags.as_ref().map(|v| v.get(i) & 1 != 0).unwrap_or(false)
    }
    #[inline]
    fn ground_speed_kt(&self, i: usize) -> Option<f64> {
        nan_f32_to_option_f64(self.ac_ground_speed_kt.as_ref().map(|v| v.get(i)).unwrap_or(f32::NAN))
    }
    #[inline]
    fn track_deg(&self, i: usize) -> Option<f64> {
        nan_f32_to_option_f64(self.ac_track_deg.as_ref().map(|v| v.get(i)).unwrap_or(f32::NAN))
    }
    #[inline]
    fn flight(&self, i: usize) -> Option<&str> {
        let s = self.ac_flight.as_ref().map(|v| v.get(i)).unwrap_or("");
        if s.is_empty() { None } else { Some(s) }
    }
}

/// Render-ready track output.
#[derive(Debug, Clone)]
pub struct RenderTrack {
    pub hex: String,
    pub is_currently_present: bool,
    pub callsign_label: Option<String>,
    pub is_on_ground: bool,
    pub heading_deg: f64,
    pub marker_position: [f32; 3],
    pub trail_points: Vec<[f32; 3]>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Simple equirectangular distance estimate in NM (from traffic.worker.ts).
pub fn estimate_distance_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat2 - lat1) * 60.0;
    let dlon = (lon2 - lon1) * 60.0 * ((lat1 * DEG_TO_RAD).cos());
    (dlat * dlat + dlon * dlon).sqrt()
}

/// Convert a geodetic position + altitude to scene `[x, y, z]`.
pub fn to_scene_point(
    lat: f64,
    lon: f64,
    alt_feet: f64,
    ref_lat: f64,
    ref_lon: f64,
    vertical_scale: f64,
    earth_curvature: bool,
) -> [f32; 3] {
    let (x, z) = lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    let y = if earth_curvature {
        let drop = earth_curvature_drop_nm(x, z, ref_lat) * FEET_PER_NM;
        alt_to_y(alt_feet - drop, vertical_scale)
    } else {
        alt_to_y(alt_feet, vertical_scale)
    };
    [x as f32, y as f32, z as f32]
}

/// Normalize a heading to `[0, 360)`, treating `None`/non-finite as 0.
fn normalize_heading(track_deg: Option<f64>) -> f64 {
    match track_deg {
        Some(v) if v.is_finite() => {
            let wrapped = v % 360.0;
            if wrapped < 0.0 {
                wrapped + 360.0
            } else {
                wrapped
            }
        }
        _ => 0.0,
    }
}

/// Normalize a callsign string — trim whitespace, return `None` if empty.
fn normalize_callsign(flight: &Option<String>) -> Option<String> {
    match flight {
        Some(f) => {
            let trimmed = f.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    }
}

/// Find the nearest scene airport's elevation for ground-target altitude.
fn nearest_airport_elevation(airports: &[SceneAirport], lat: f64, lon: f64) -> f64 {
    if airports.is_empty() {
        return 0.0;
    }
    let cos_lat = (lat * DEG_TO_RAD).cos();
    let mut best_dist_sq = f64::INFINITY;
    let mut best_elev = 0.0;
    for ap in airports {
        let d_lat = ap.lat - lat;
        let d_lon = (ap.lon - lon) * cos_lat;
        let dist_sq = d_lat * d_lat + d_lon * d_lon;
        if dist_sq < best_dist_sq {
            best_dist_sq = dist_sq;
            best_elev = ap.elevation_feet;
        }
    }
    best_elev
}

/// Trim history points older than `cutoff_ms`.
fn trim_history(history: &mut Vec<TrafficHistoryPoint>, cutoff_ms: i64) {
    if let Some(pos) = history.iter().position(|p| p.timestamp_ms >= cutoff_ms) {
        if pos > 0 {
            history.drain(..pos);
        }
    } else {
        history.clear();
    }
}

/// Merge backfill points into existing history: concat, sort, dedup by timestamp.
fn merge_history_samples(
    existing: &[TrafficHistoryPoint],
    backfill: &[TrafficHistoryPoint],
) -> Vec<TrafficHistoryPoint> {
    if existing.is_empty() && backfill.is_empty() {
        return Vec::new();
    }
    let mut merged: Vec<TrafficHistoryPoint> = Vec::with_capacity(existing.len() + backfill.len());
    merged.extend_from_slice(existing);
    merged.extend_from_slice(backfill);
    merged.sort_by_key(|p| p.timestamp_ms);

    // Dedup: consecutive same-timestamp → keep last
    let mut deduped: Vec<TrafficHistoryPoint> = Vec::with_capacity(merged.len());
    for point in merged {
        if let Some(last) = deduped.last() {
            if point.timestamp_ms == last.timestamp_ms {
                // Replace last with this newer one
                let len = deduped.len();
                deduped[len - 1] = point;
                continue;
            }
        }
        deduped.push(point);
    }
    deduped
}

/// Hash all render tracks for change detection (FNV-1a, 32-bit → zero-extended to u64).
fn hash_render_tracks(render_tracks: &[RenderTrack]) -> u64 {
    let mut hash = FNV_OFFSET;
    for track in render_tracks {
        hash = fnv_hash_str(hash, &track.hex);
        hash = fnv_hash_u32(hash, if track.is_currently_present { 1 } else { 0 });
        hash = fnv_hash_str(hash, track.callsign_label.as_deref().unwrap_or(""));
        hash = fnv_hash_u32(hash, if track.is_on_ground { 1 } else { 0 });
        hash = fnv_hash_f32(hash, track.heading_deg as f32);
        hash = fnv_hash_f32(hash, track.marker_position[0]);
        hash = fnv_hash_f32(hash, track.marker_position[1]);
        hash = fnv_hash_f32(hash, track.marker_position[2]);
        hash = fnv_hash_u32(hash, track.trail_points.len() as u32);
        for point in &track.trail_points {
            hash = fnv_hash_f32(hash, point[0]);
            hash = fnv_hash_f32(hash, point[1]);
            hash = fnv_hash_f32(hash, point[2]);
        }
    }
    hash as u64
}

// ---------------------------------------------------------------------------
// TrafficState
// ---------------------------------------------------------------------------

/// Manages the stateful track map for traffic merge/prune/projection.
pub struct TrafficState {
    tracks: HashMap<String, TrafficTrack>,
}

impl TrafficState {
    /// Create an empty state.
    pub fn new() -> Self {
        Self {
            tracks: HashMap::new(),
        }
    }

    /// Number of active tracks.
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// Merge incoming aircraft into the track map.
    ///
    /// For each aircraft:
    /// 1. Merge backfill history (if any).
    /// 2. Add current position as history point (if moved enough).
    /// 3. Trim history older than cutoff.
    /// 4. If `hide_ground` and aircraft is on ground: skip track.
    ///
    /// After processing, prune stale tracks whose last update is too old
    /// and whose history is empty after trimming.
    ///
    /// Generic over `AircraftSource` so the binary path can pass an
    /// `FbAircraftView` that reads directly from the FlatBuffers buffer
    /// (zero String allocations for existing tracks).
    pub fn merge(
        &mut self,
        aircraft: &(impl AircraftSource + ?Sized),
        now_ms: i64,
        history_minutes: f64,
        hide_ground: bool,
        backfill: &[BackfillHistory],
    ) {
        let cutoff_ms = now_ms - (history_minutes * 60_000.0) as i64;

        // Index backfill by hex for O(1) lookup.
        let backfill_map: HashMap<&str, &[TrafficHistoryPoint]> = backfill
            .iter()
            .map(|b| (b.hex.as_str(), b.points.as_slice()))
            .collect();

        for idx in 0..aircraft.len() {
            let hex = aircraft.hex(idx);
            if hex.is_empty() {
                continue;
            }
            let is_on_ground = aircraft.is_on_ground(idx);
            if hide_ground && is_on_ground {
                self.tracks.remove(hex);
                continue;
            }

            let ac_lat = aircraft.lat(idx);
            let ac_lon = aircraft.lon(idx);
            let ac_altitude_feet = aircraft.altitude_feet(idx);

            let bf_points = backfill_map.get(hex).copied().unwrap_or(&[]);

            let existing_history: Vec<TrafficHistoryPoint> = self
                .tracks
                .get_mut(hex)
                .map(|t| std::mem::take(&mut t.history))
                .unwrap_or_default();

            let mut history = merge_history_samples(&existing_history, bf_points);

            // Current position as a candidate history point.
            let current_alt = ac_altitude_feet.unwrap_or(0.0);
            let current_point = TrafficHistoryPoint {
                lat: ac_lat,
                lon: ac_lon,
                altitude_feet: current_alt,
                timestamp_ms: now_ms,
            };

            if let Some(last) = history.last_mut() {
                let dist = estimate_distance_nm(last.lat, last.lon, ac_lat, ac_lon);
                let alt_delta = match ac_altitude_feet {
                    Some(alt) => (last.altitude_feet - alt).abs(),
                    None => 0.0,
                };
                if dist >= MIN_SAMPLE_DISTANCE_NM
                    || alt_delta >= MIN_SAMPLE_ALTITUDE_DELTA_FEET
                {
                    history.push(current_point);
                } else {
                    // Update timestamp of last point to keep it fresh.
                    last.timestamp_ms = now_ms;
                }
            } else {
                history.push(current_point);
            }

            // Trim old history.
            trim_history(&mut history, cutoff_ms);

            // Update-in-place for existing tracks (0 String allocs);
            // only allocate hex/flight Strings for genuinely new tracks.
            if let Some(track) = self.tracks.get_mut(hex) {
                track.lat = ac_lat;
                track.lon = ac_lon;
                track.altitude_feet = ac_altitude_feet;
                track.ground_speed_kt = aircraft.ground_speed_kt(idx);
                track.track_deg = aircraft.track_deg(idx);
                track.flight = aircraft.flight(idx).map(|s| s.to_owned());
                track.is_on_ground = is_on_ground;
                track.last_update_ms = now_ms;
                track.last_seen_ms = now_ms;
                track.history = history;
            } else {
                let track = TrafficTrack {
                    hex: hex.to_owned(),
                    lat: ac_lat,
                    lon: ac_lon,
                    altitude_feet: ac_altitude_feet,
                    ground_speed_kt: aircraft.ground_speed_kt(idx),
                    track_deg: aircraft.track_deg(idx),
                    flight: aircraft.flight(idx).map(|s| s.to_owned()),
                    is_on_ground,
                    last_update_ms: now_ms,
                    last_seen_ms: now_ms,
                    history,
                };
                self.tracks.insert(hex.to_owned(), track);
            }
        }

        // Prune stale tracks not in the current aircraft batch.
        let stale_cutoff = now_ms - STALE_GRACE_MS;
        self.tracks.retain(|_hex, track| {
            // Trim history on retained tracks too.
            trim_history(&mut track.history, cutoff_ms);
            // Keep if recently updated or has remaining history.
            if track.last_update_ms >= stale_cutoff {
                return true;
            }
            !track.history.is_empty()
        });
    }

    /// Prune tracks after an error — trim histories, remove empty/stale tracks.
    pub fn prune_for_error(&mut self, now_ms: i64, history_minutes: f64) {
        let cutoff_ms = now_ms - (history_minutes * 60_000.0) as i64;
        self.tracks.retain(|_hex, track| {
            trim_history(&mut track.history, cutoff_ms);
            if track.history.is_empty() {
                return false;
            }
            let latest_ts = track.history.last().map(|p| p.timestamp_ms).unwrap_or(0);
            let latest_update = track.last_update_ms.max(latest_ts);
            latest_update >= cutoff_ms
        });
    }

    /// Recompute — trim histories, remove ground tracks if flagged, refresh timestamps.
    pub fn recompute(
        &mut self,
        now_ms: i64,
        history_minutes: f64,
        hide_ground: bool,
    ) {
        let cutoff_ms = now_ms - (history_minutes * 60_000.0) as i64;
        self.tracks.retain(|_hex, track| {
            if hide_ground && track.is_on_ground {
                return false;
            }
            trim_history(&mut track.history, cutoff_ms);
            if track.history.is_empty() {
                return false;
            }
            let latest_ts = track.history.last().map(|p| p.timestamp_ms).unwrap_or(0);
            track.last_update_ms = track.last_update_ms.max(latest_ts);
            true
        });
    }

    /// Build render-ready tracks and compute FNV-1a hash for change detection.
    ///
    /// Returns `(render_tracks, hash)`.
    pub fn build_render_tracks(
        &self,
        ref_lat: f64,
        ref_lon: f64,
        airports: &[SceneAirport],
        vertical_scale: f64,
        earth_curvature: bool,
        show_departed_trails: bool,
    ) -> (Vec<RenderTrack>, u64) {
        let mut render_tracks: Vec<RenderTrack> = Vec::new();

        // Determine the latest last_update_ms across all tracks for "currently present" check.
        // In the TS code, `isCurrentlyPresent` is set during merge; here we approximate
        // using `last_update_ms + STALE_GRACE_MS` vs the latest track time.
        // However, the TS code stores isCurrentlyPresent per track during merge. We track
        // this implicitly: a track is "currently present" if its last_update_ms is recent
        // relative to the global latest.
        let global_latest = self
            .tracks
            .values()
            .map(|t| t.last_update_ms)
            .max()
            .unwrap_or(0);

        for track in self.tracks.values() {
            let is_present =
                track.last_update_ms + STALE_GRACE_MS >= global_latest;

            if !show_departed_trails && !is_present {
                continue;
            }

            // Resolve marker altitude.
            let marker_alt = resolve_altitude(
                track.lat,
                track.lon,
                track.altitude_feet,
                track.is_on_ground,
                airports,
            );

            let marker_position = to_scene_point(
                track.lat,
                track.lon,
                marker_alt,
                ref_lat,
                ref_lon,
                vertical_scale,
                earth_curvature,
            );

            // Skip if non-finite x or z.
            if !marker_position[0].is_finite() || !marker_position[2].is_finite() {
                continue;
            }

            // Project trail points.
            let trail_points: Vec<[f32; 3]> = track
                .history
                .iter()
                .map(|p| {
                    let alt =
                        resolve_altitude(p.lat, p.lon, Some(p.altitude_feet), false, airports);
                    to_scene_point(
                        p.lat,
                        p.lon,
                        alt,
                        ref_lat,
                        ref_lon,
                        vertical_scale,
                        earth_curvature,
                    )
                })
                .collect();

            render_tracks.push(RenderTrack {
                hex: track.hex.clone(),
                is_currently_present: is_present,
                callsign_label: normalize_callsign(&track.flight),
                is_on_ground: track.is_on_ground,
                heading_deg: normalize_heading(track.track_deg),
                marker_position,
                trail_points,
            });
        }

        // Sort by hex for deterministic ordering (matches TS `.sort` by hex).
        render_tracks.sort_by(|a, b| a.hex.cmp(&b.hex));

        let hash = hash_render_tracks(&render_tracks);
        (render_tracks, hash)
    }
}

impl Default for TrafficState {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve altitude for rendering: use track altitude, or nearest airport
/// elevation if on ground / altitude is `None`.
fn resolve_altitude(
    lat: f64,
    lon: f64,
    altitude_feet: Option<f64>,
    is_on_ground: bool,
    airports: &[SceneAirport],
) -> f64 {
    if is_on_ground || altitude_feet.is_none() {
        nearest_airport_elevation(airports, lat, lon)
    } else {
        altitude_feet.unwrap()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_aircraft(hex: &str, lat: f64, lon: f64, alt: Option<f64>) -> MergeAircraft {
        MergeAircraft {
            hex: hex.to_string(),
            lat,
            lon,
            altitude_feet: alt,
            ground_speed_kt: Some(250.0),
            track_deg: Some(90.0),
            flight: Some("TEST123".to_string()),
            is_on_ground: false,
            last_seen_seconds: None,
        }
    }

    fn make_ground_aircraft(hex: &str, lat: f64, lon: f64) -> MergeAircraft {
        MergeAircraft {
            hex: hex.to_string(),
            lat,
            lon,
            altitude_feet: None,
            ground_speed_kt: Some(0.0),
            track_deg: None,
            flight: Some("GND456".to_string()),
            is_on_ground: true,
            last_seen_seconds: None,
        }
    }

    fn default_airports() -> Vec<SceneAirport> {
        vec![SceneAirport {
            lat: 40.0,
            lon: -74.0,
            elevation_feet: 13.0,
        }]
    }

    // -----------------------------------------------------------------------
    // 1. new_state_is_empty
    // -----------------------------------------------------------------------
    #[test]
    fn new_state_is_empty() {
        let state = TrafficState::new();
        assert_eq!(state.track_count(), 0);
    }

    // -----------------------------------------------------------------------
    // 2. merge_single_aircraft
    // -----------------------------------------------------------------------
    #[test]
    fn merge_single_aircraft() {
        let mut state = TrafficState::new();
        let ac = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac].as_slice(),1_000_000, 5.0, false, &[]);
        assert_eq!(state.track_count(), 1);
        let track = state.tracks.get("abc123").unwrap();
        assert_eq!(track.hex, "abc123");
        assert!(!track.history.is_empty(), "should have at least one history point");
    }

    // -----------------------------------------------------------------------
    // 3. merge_updates_existing
    // -----------------------------------------------------------------------
    #[test]
    fn merge_updates_existing() {
        let mut state = TrafficState::new();
        let ac1 = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac1].as_slice(),1_000_000, 5.0, false, &[]);

        // Move far enough to create new history point.
        let ac2 = make_aircraft("abc123", 40.1, -74.0, Some(5500.0));
        state.merge([ac2].as_slice(),1_010_000, 5.0, false, &[]);

        assert_eq!(state.track_count(), 1);
        let track = state.tracks.get("abc123").unwrap();
        assert!(
            (track.lat - 40.1).abs() < 1e-6,
            "lat should be updated to 40.1"
        );
        assert_eq!(track.last_update_ms, 1_010_000);
    }

    // -----------------------------------------------------------------------
    // 4. merge_adds_history_point
    // -----------------------------------------------------------------------
    #[test]
    fn merge_adds_history_point() {
        let mut state = TrafficState::new();
        let ac1 = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac1].as_slice(),1_000_000, 5.0, false, &[]);

        // Move > 0.03 NM (~0.0005 deg at lat 40).
        let ac2 = make_aircraft("abc123", 40.01, -74.0, Some(5000.0));
        state.merge([ac2].as_slice(),1_010_000, 5.0, false, &[]);

        let track = state.tracks.get("abc123").unwrap();
        assert!(
            track.history.len() >= 2,
            "should have at least 2 history points, got {}",
            track.history.len()
        );
    }

    // -----------------------------------------------------------------------
    // 5. merge_skips_close_point
    // -----------------------------------------------------------------------
    #[test]
    fn merge_skips_close_point() {
        let mut state = TrafficState::new();
        let ac1 = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac1].as_slice(),1_000_000, 5.0, false, &[]);

        let initial_len = state.tracks.get("abc123").unwrap().history.len();

        // Tiny move: < 0.03 NM and < 100ft altitude delta.
        let ac2 = make_aircraft("abc123", 40.000001, -74.0, Some(5010.0));
        state.merge([ac2].as_slice(),1_010_000, 5.0, false, &[]);

        let final_len = state.tracks.get("abc123").unwrap().history.len();
        assert_eq!(
            initial_len, final_len,
            "should NOT add new history point for tiny move"
        );
    }

    // -----------------------------------------------------------------------
    // 6. merge_altitude_delta_adds_point
    // -----------------------------------------------------------------------
    #[test]
    fn merge_altitude_delta_adds_point() {
        let mut state = TrafficState::new();
        let ac1 = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac1].as_slice(),1_000_000, 5.0, false, &[]);

        let initial_len = state.tracks.get("abc123").unwrap().history.len();

        // Same position but 200ft altitude change (>= 100ft threshold).
        let ac2 = make_aircraft("abc123", 40.0, -74.0, Some(5200.0));
        state.merge([ac2].as_slice(),1_010_000, 5.0, false, &[]);

        let final_len = state.tracks.get("abc123").unwrap().history.len();
        assert_eq!(
            final_len,
            initial_len + 1,
            "should add history point for 200ft altitude change"
        );
    }

    // -----------------------------------------------------------------------
    // 7. merge_trims_stale_history
    // -----------------------------------------------------------------------
    #[test]
    fn merge_trims_stale_history() {
        let mut state = TrafficState::new();

        // Insert with early timestamp.
        let ac1 = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac1].as_slice(),100_000, 5.0, false, &[]);

        // Now advance time so the first point is beyond the 5-minute cutoff.
        // cutoff = 600_000 - 300_000 = 300_000
        let ac2 = make_aircraft("abc123", 40.01, -74.0, Some(5000.0));
        state.merge([ac2].as_slice(),600_000, 5.0, false, &[]);

        let track = state.tracks.get("abc123").unwrap();
        for point in &track.history {
            assert!(
                point.timestamp_ms >= 300_000,
                "history point at {} should be >= cutoff 300_000",
                point.timestamp_ms
            );
        }
    }

    // -----------------------------------------------------------------------
    // 8. merge_removes_stale_tracks
    // -----------------------------------------------------------------------
    #[test]
    fn merge_removes_stale_tracks() {
        let mut state = TrafficState::new();

        // Insert track at t=100_000.
        let ac1 = make_aircraft("stale", 40.0, -74.0, Some(5000.0));
        state.merge([ac1].as_slice(),100_000, 5.0, false, &[]);

        // Much later, merge a *different* aircraft. "stale" should be pruned
        // because last_update_ms(100_000) + STALE_GRACE_MS(20_000) = 120_000 < 1_000_000
        // and history will be trimmed (cutoff = 1_000_000 - 300_000 = 700_000, point at 100_000 < 700_000).
        let ac2 = make_aircraft("fresh", 40.0, -74.0, Some(5000.0));
        state.merge([ac2].as_slice(),1_000_000, 5.0, false, &[]);

        assert!(
            state.tracks.get("stale").is_none(),
            "stale track should be pruned"
        );
        assert_eq!(state.track_count(), 1);
    }

    // -----------------------------------------------------------------------
    // 9. merge_backfill_history
    // -----------------------------------------------------------------------
    #[test]
    fn merge_backfill_history() {
        let mut state = TrafficState::new();

        let backfill = vec![BackfillHistory {
            hex: "abc123".to_string(),
            points: vec![
                TrafficHistoryPoint {
                    lat: 40.0,
                    lon: -74.0,
                    altitude_feet: 4000.0,
                    timestamp_ms: 500_000,
                },
                TrafficHistoryPoint {
                    lat: 40.001,
                    lon: -74.0,
                    altitude_feet: 4200.0,
                    timestamp_ms: 510_000,
                },
                // Duplicate timestamp — should be deduplicated.
                TrafficHistoryPoint {
                    lat: 40.002,
                    lon: -74.0,
                    altitude_feet: 4300.0,
                    timestamp_ms: 510_000,
                },
            ],
        }];

        let ac = make_aircraft("abc123", 40.01, -74.0, Some(5000.0));
        state.merge([ac].as_slice(),600_000, 5.0, false, &backfill);

        let track = state.tracks.get("abc123").unwrap();
        // Check dedup: timestamp 510_000 should appear only once.
        let count_510 = track
            .history
            .iter()
            .filter(|p| p.timestamp_ms == 510_000)
            .count();
        assert_eq!(
            count_510, 1,
            "duplicate timestamps should be deduplicated"
        );
        // History should be sorted.
        for w in track.history.windows(2) {
            assert!(
                w[0].timestamp_ms <= w[1].timestamp_ms,
                "history should be sorted by timestamp"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 10. merge_hide_ground
    // -----------------------------------------------------------------------
    #[test]
    fn merge_hide_ground() {
        let mut state = TrafficState::new();
        let ac = make_ground_aircraft("gnd1", 40.0, -74.0);
        state.merge([ac].as_slice(),1_000_000, 5.0, true, &[]);
        assert_eq!(
            state.track_count(),
            0,
            "ground aircraft should be removed when hide_ground=true"
        );
    }

    // -----------------------------------------------------------------------
    // 11. prune_for_error_trims
    // -----------------------------------------------------------------------
    #[test]
    fn prune_for_error_trims() {
        let mut state = TrafficState::new();

        // Insert at t=100_000 with a far-off position to create history.
        let ac = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac].as_slice(),100_000, 60.0, false, &[]);

        // Add another point at t=200_000.
        let ac2 = make_aircraft("abc123", 40.01, -74.0, Some(5100.0));
        state.merge([ac2].as_slice(),200_000, 60.0, false, &[]);

        // Prune with history_minutes=1.0, now=500_000.
        // cutoff = 500_000 - 60_000 = 440_000.
        // Both points (100_000, 200_000) are < 440_000, so history becomes empty => track removed.
        state.prune_for_error(500_000, 1.0);
        assert_eq!(
            state.track_count(),
            0,
            "old points should be pruned and empty track removed"
        );
    }

    // -----------------------------------------------------------------------
    // 12. recompute_trims_and_hides
    // -----------------------------------------------------------------------
    #[test]
    fn recompute_trims_and_hides() {
        let mut state = TrafficState::new();

        // Insert a ground track.
        let ac_gnd = make_ground_aircraft("gnd1", 40.0, -74.0);
        state.merge([ac_gnd].as_slice(),1_000_000, 5.0, false, &[]);

        // Insert an airborne track.
        let ac_air = make_aircraft("air1", 40.01, -74.0, Some(5000.0));
        state.merge([ac_air].as_slice(),1_000_000, 5.0, false, &[]);

        assert_eq!(state.track_count(), 2);

        // Recompute with hide_ground=true.
        state.recompute(1_000_000, 5.0, true);
        assert!(
            state.tracks.get("gnd1").is_none(),
            "ground track should be removed by recompute"
        );
        assert!(
            state.tracks.get("air1").is_some(),
            "airborne track should remain"
        );
    }

    // -----------------------------------------------------------------------
    // 13. to_scene_point_basic
    // -----------------------------------------------------------------------
    #[test]
    fn to_scene_point_basic() {
        let ref_lat = 40.0;
        let ref_lon = -74.0;
        let p = to_scene_point(40.0, -74.0, 1000.0, ref_lat, ref_lon, 1.0, false);
        // At ref point, x and z should be ~0.
        assert!(
            p[0].abs() < 1e-4,
            "x at ref should be ~0, got {}",
            p[0]
        );
        assert!(
            p[2].abs() < 1e-4,
            "z at ref should be ~0, got {}",
            p[2]
        );
        // y = alt_to_y(1000, 1.0) = 1000 / 6076.12 ≈ 0.1646
        assert!(
            (p[1] - 0.1646).abs() < 0.001,
            "y should be ~0.1646, got {}",
            p[1]
        );
    }

    // -----------------------------------------------------------------------
    // 14. to_scene_point_with_curvature
    // -----------------------------------------------------------------------
    #[test]
    fn to_scene_point_with_curvature() {
        let ref_lat = 40.0;
        let ref_lon = -74.0;
        // Place 1 degree east (~46.6 NM) so curvature has meaningful effect.
        let p_flat = to_scene_point(40.0, -73.0, 5000.0, ref_lat, ref_lon, 1.0, false);
        let p_curve = to_scene_point(40.0, -73.0, 5000.0, ref_lat, ref_lon, 1.0, true);

        assert!(
            p_curve[1] < p_flat[1],
            "curvature should lower y: flat={}, curved={}",
            p_flat[1],
            p_curve[1]
        );
    }

    // -----------------------------------------------------------------------
    // 15. render_hash_deterministic
    // -----------------------------------------------------------------------
    #[test]
    fn render_hash_deterministic() {
        let mut state = TrafficState::new();
        let ac = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac].as_slice(),1_000_000, 5.0, false, &[]);

        let airports = default_airports();
        let (_, hash1) = state.build_render_tracks(40.0, -74.0, &airports, 1.0, false, true);
        let (_, hash2) = state.build_render_tracks(40.0, -74.0, &airports, 1.0, false, true);
        assert_eq!(hash1, hash2, "same state should produce same hash");
    }

    // -----------------------------------------------------------------------
    // 16. render_hash_changes
    // -----------------------------------------------------------------------
    #[test]
    fn render_hash_changes() {
        let airports = default_airports();

        let mut state1 = TrafficState::new();
        let ac1 = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state1.merge([ac1].as_slice(),1_000_000, 5.0, false, &[]);
        let (_, hash1) = state1.build_render_tracks(40.0, -74.0, &airports, 1.0, false, true);

        let mut state2 = TrafficState::new();
        let ac2 = make_aircraft("abc123", 41.0, -73.0, Some(8000.0));
        state2.merge([ac2].as_slice(),1_000_000, 5.0, false, &[]);
        let (_, hash2) = state2.build_render_tracks(40.0, -74.0, &airports, 1.0, false, true);

        assert_ne!(hash1, hash2, "different positions should produce different hashes");
    }

    // -----------------------------------------------------------------------
    // 17. build_render_tracks_basic
    // -----------------------------------------------------------------------
    #[test]
    fn build_render_tracks_basic() {
        let mut state = TrafficState::new();

        // Insert and then move to create history.
        let ac1 = make_aircraft("abc123", 40.0, -74.0, Some(5000.0));
        state.merge([ac1].as_slice(),1_000_000, 5.0, false, &[]);

        let ac2 = make_aircraft("abc123", 40.01, -74.0, Some(5100.0));
        state.merge([ac2].as_slice(),1_010_000, 5.0, false, &[]);

        let airports = default_airports();
        let (render_tracks, hash) =
            state.build_render_tracks(40.0, -74.0, &airports, 1.0, false, true);

        assert_eq!(render_tracks.len(), 1, "should have 1 render track");
        let rt = &render_tracks[0];
        assert_eq!(rt.hex, "abc123");
        assert!(rt.is_currently_present);
        assert!(!rt.trail_points.is_empty(), "should have trail points");
        assert_ne!(hash, 0, "hash should be non-zero");

        // Heading should be normalized from track_deg=90.
        assert!(
            (rt.heading_deg - 90.0).abs() < 1e-6,
            "heading should be 90.0"
        );
    }

    // -----------------------------------------------------------------------
    // Additional: estimate_distance_nm sanity
    // -----------------------------------------------------------------------
    #[test]
    fn estimate_distance_basic() {
        // Same point => 0.
        let d = estimate_distance_nm(40.0, -74.0, 40.0, -74.0);
        assert!(d.abs() < 1e-10, "same point distance should be ~0");

        // 1 degree lat at equator ≈ 60 NM.
        let d2 = estimate_distance_nm(0.0, 0.0, 1.0, 0.0);
        assert!(
            (d2 - 60.0).abs() < 1.0,
            "1 deg lat at equator should be ~60 NM, got {}",
            d2
        );
    }

    // -----------------------------------------------------------------------
    // FNV hash helpers
    // -----------------------------------------------------------------------
    #[test]
    fn fnv_hash_str_deterministic() {
        let h1 = fnv_hash_str(FNV_OFFSET, "hello");
        let h2 = fnv_hash_str(FNV_OFFSET, "hello");
        assert_eq!(h1, h2, "same string should produce same hash");
        let h3 = fnv_hash_str(FNV_OFFSET, "world");
        assert_ne!(h1, h3, "different strings should produce different hashes");
    }
}
