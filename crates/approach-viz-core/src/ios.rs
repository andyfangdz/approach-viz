use crate::{approach_path, coords};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct LocalPoint {
    pub x_nm: f64,
    pub z_nm: f64,
}

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct ProjectionScale {
    pub east_nm_per_lon_degree: f64,
    pub north_nm_per_lat_degree: f64,
}

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct ScenePoint {
    pub x_nm: f64,
    pub y_nm: f64,
    pub z_nm: f64,
}

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct TrafficSceneAirport {
    pub lat: f64,
    pub lon: f64,
    pub elevation_feet: f64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct TrafficMergeResult {
    pub track_count: u64,
    pub tracked_hexes: Vec<String>,
    pub returned_history_hexes: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct TrafficRenderTrack {
    pub hex: String,
    pub is_currently_present: bool,
    pub callsign_label: Option<String>,
    pub is_on_ground: bool,
    pub heading_deg: f64,
    pub marker_position: approach_path::Point3,
    pub trail_points: Vec<approach_path::Point3>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct TrafficRenderResult {
    pub track_count: u64,
    pub rendered_track_count: u64,
    pub history_point_count: u64,
    pub render_hash: u64,
    pub tracks: Vec<TrafficRenderTrack>,
}

#[derive(uniffi::Object)]
pub struct TrafficStateHandle {
    inner: Mutex<crate::traffic_merge::TrafficState>,
}

#[uniffi::export]
pub fn lat_lon_to_local(lat: f64, lon: f64, ref_lat: f64, ref_lon: f64) -> LocalPoint {
    let (x_nm, z_nm) = coords::lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    LocalPoint { x_nm, z_nm }
}

#[uniffi::export]
pub fn alt_to_y(alt_feet: f64, vertical_scale: f64) -> f64 {
    coords::alt_to_y(alt_feet, vertical_scale)
}

#[uniffi::export]
pub fn earth_curvature_drop_nm(x_nm: f64, z_nm: f64, ref_lat: f64) -> f64 {
    coords::earth_curvature_drop_nm(x_nm, z_nm, ref_lat)
}

#[uniffi::export]
pub fn geocentric_radius_nm(latitude_deg: f64) -> f64 {
    coords::geocentric_radius_nm(latitude_deg)
}

#[uniffi::export]
pub fn projection_scales_nm_per_degree(lat_deg: f64) -> ProjectionScale {
    let (east_nm_per_lon_degree, north_nm_per_lat_degree) =
        coords::projection_scales_nm_per_degree(lat_deg);
    ProjectionScale {
        east_nm_per_lon_degree,
        north_nm_per_lat_degree,
    }
}

#[uniffi::export]
pub fn scene_point_from_geodetic(
    lat: f64,
    lon: f64,
    altitude_feet: f64,
    ref_lat: f64,
    ref_lon: f64,
    ref_altitude_feet: f64,
    vertical_scale: f64,
) -> ScenePoint {
    let (x_nm, z_nm) = coords::lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    let relative_altitude_feet = altitude_feet - ref_altitude_feet;
    let y_nm = coords::alt_to_y(relative_altitude_feet, vertical_scale);
    ScenePoint { x_nm, y_nm, z_nm }
}

#[uniffi::export]
pub fn resolve_approach_altitudes(
    params: approach_path::ResolveApproachAltitudesParams,
) -> approach_path::ApproachAltitudeResult {
    approach_path::resolve_approach_altitudes(params)
}

#[uniffi::export]
pub fn build_approach_path_geometry(
    params: approach_path::BuildPathGeometryParams,
) -> approach_path::PathGeometryResult {
    approach_path::build_path_geometry(params)
}

#[uniffi::export]
pub fn build_approach_hold_geometry(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    hold_distance_nm: f64,
    altitude_feet: f64,
    turn_direction: String,
    vertical_scale: f64,
) -> Vec<approach_path::Point3> {
    approach_path::build_hold_geometry(
        center_x,
        center_z,
        heading_deg,
        hold_distance_nm,
        altitude_feet,
        &turn_direction,
        vertical_scale,
    )
}

#[uniffi::export]
impl TrafficStateHandle {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(crate::traffic_merge::TrafficState::new()),
        })
    }

    pub fn track_count(&self) -> u64 {
        self.inner
            .lock()
            .expect("traffic state mutex poisoned")
            .track_count() as u64
    }

    pub fn merge(
        &self,
        data: Vec<u8>,
        now_ms: i64,
        history_minutes: f64,
        hide_ground: bool,
        backfill_data: Vec<u8>,
    ) -> TrafficMergeResult {
        let fb = match flatbuffers::root::<crate::generated::TrafficPayload>(&data) {
            Ok(payload) => payload,
            Err(error) => {
                return TrafficMergeResult {
                    track_count: self.track_count(),
                    tracked_hexes: Vec::new(),
                    returned_history_hexes: Vec::new(),
                    error: Some(format!("AVTR payload invalid: {error}")),
                };
            }
        };

        let ac_view = crate::traffic_merge::FbAircraftView::new(&fb);
        let backfill_fb = if backfill_data.is_empty() {
            None
        } else {
            match flatbuffers::root::<crate::generated::TrafficPayload>(&backfill_data) {
                Ok(payload) => Some(payload),
                Err(error) => {
                    return TrafficMergeResult {
                        track_count: self.track_count(),
                        tracked_hexes: Vec::new(),
                        returned_history_hexes: Vec::new(),
                        error: Some(format!("backfill AVTR invalid: {error}")),
                    };
                }
            }
        };

        let backfill_history = match collect_fb_history(&fb, backfill_fb.as_ref()) {
            Ok(history) => history,
            Err(error) => {
                return TrafficMergeResult {
                    track_count: self.track_count(),
                    tracked_hexes: Vec::new(),
                    returned_history_hexes: Vec::new(),
                    error: Some(error),
                };
            }
        };

        let tracked_hexes = collect_tracked_hexes(&fb);
        let returned_history_hexes = collect_history_hexes(&fb, backfill_fb.as_ref());
        let payload_error = if fb.flags() & 1 != 0 {
            fb.error().map(|value| value.to_string())
        } else {
            None
        };

        self.inner
            .lock()
            .expect("traffic state mutex poisoned")
            .merge(
                &ac_view,
                now_ms,
                history_minutes,
                hide_ground,
                &backfill_history,
            );

        TrafficMergeResult {
            track_count: self.track_count(),
            tracked_hexes,
            returned_history_hexes,
            error: payload_error,
        }
    }

    pub fn recompute(&self, now_ms: i64, history_minutes: f64, hide_ground: bool) -> u64 {
        let mut state = self.inner.lock().expect("traffic state mutex poisoned");
        state.recompute(now_ms, history_minutes, hide_ground);
        state.track_count() as u64
    }

    pub fn prune_for_error(&self, now_ms: i64, history_minutes: f64) -> u64 {
        let mut state = self.inner.lock().expect("traffic state mutex poisoned");
        state.prune_for_error(now_ms, history_minutes);
        state.track_count() as u64
    }

    pub fn build_render_tracks(
        &self,
        ref_lat: f64,
        ref_lon: f64,
        airports: Vec<TrafficSceneAirport>,
        vertical_scale: f64,
        apply_earth_curvature: bool,
        show_departed_trails: bool,
    ) -> TrafficRenderResult {
        let airports = airports
            .into_iter()
            .map(|airport| crate::traffic_merge::SceneAirport {
                lat: airport.lat,
                lon: airport.lon,
                elevation_feet: airport.elevation_feet,
            })
            .collect::<Vec<_>>();
        let (tracks, render_hash) = self
            .inner
            .lock()
            .expect("traffic state mutex poisoned")
            .build_render_tracks(
                ref_lat,
                ref_lon,
                &airports,
                vertical_scale,
                apply_earth_curvature,
                show_departed_trails,
            );
        let history_point_count = tracks
            .iter()
            .map(|track| track.trail_points.len() as u64)
            .sum();
        let rendered_tracks = tracks
            .into_iter()
            .map(|track| TrafficRenderTrack {
                hex: track.hex,
                is_currently_present: track.is_currently_present,
                callsign_label: track.callsign_label,
                is_on_ground: track.is_on_ground,
                heading_deg: track.heading_deg,
                marker_position: point3(track.marker_position),
                trail_points: track.trail_points.into_iter().map(point3).collect(),
            })
            .collect::<Vec<_>>();

        TrafficRenderResult {
            track_count: self.track_count(),
            rendered_track_count: rendered_tracks.len() as u64,
            history_point_count,
            render_hash,
            tracks: rendered_tracks,
        }
    }
}

fn point3(value: [f32; 3]) -> approach_path::Point3 {
    approach_path::Point3 {
        x: value[0] as f64,
        y: value[1] as f64,
        z: value[2] as f64,
    }
}

fn collect_tracked_hexes(payload: &crate::generated::TrafficPayload<'_>) -> Vec<String> {
    let mut tracked = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(hexes) = payload.ac_hex() {
        for index in 0..payload.aircraft_count() as usize {
            let hex = hexes.get(index);
            if !hex.is_empty() && seen.insert(hex) {
                tracked.push(hex.to_owned());
            }
        }
    }
    tracked
}

fn collect_history_hexes(
    primary: &crate::generated::TrafficPayload<'_>,
    backfill: Option<&crate::generated::TrafficPayload<'_>>,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut hexes = Vec::new();
    collect_history_hexes_from_payload(primary, &mut seen, &mut hexes);
    if let Some(payload) = backfill {
        collect_history_hexes_from_payload(payload, &mut seen, &mut hexes);
    }
    hexes
}

fn collect_history_hexes_from_payload(
    payload: &crate::generated::TrafficPayload<'_>,
    seen: &mut std::collections::HashSet<String>,
    out: &mut Vec<String>,
) {
    let group_count = payload.history_group_count() as usize;
    if let Some(hexes) = payload.hg_hex() {
        for index in 0..group_count {
            let hex = hexes.get(index);
            if hex.is_empty() {
                continue;
            }
            let owned = hex.to_owned();
            if seen.insert(owned.clone()) {
                out.push(owned);
            }
        }
    }
}

fn collect_fb_history(
    primary: &crate::generated::TrafficPayload<'_>,
    backfill: Option<&crate::generated::TrafficPayload<'_>>,
) -> Result<Vec<crate::traffic_merge::BackfillHistory>, String> {
    let mut result = Vec::new();
    collect_fb_history_from_payload(primary, &mut result)?;
    if let Some(payload) = backfill {
        collect_fb_history_from_payload(payload, &mut result)?;
    }
    Ok(result)
}

fn collect_fb_history_from_payload(
    payload: &crate::generated::TrafficPayload<'_>,
    out: &mut Vec<crate::traffic_merge::BackfillHistory>,
) -> Result<(), String> {
    let group_count = payload.history_group_count() as usize;
    if group_count == 0 {
        return Ok(());
    }

    let total_points = payload.history_point_count();
    let group_hex = payload.hg_hex();
    let group_start = payload.hg_point_start();
    let group_count_vec = payload.hg_point_count();
    let point_timestamp = payload.hp_timestamp_ms();
    let point_lat = payload.hp_lat();
    let point_lon = payload.hp_lon();
    let point_altitude = payload.hp_altitude_feet();

    for index in 0..group_count {
        let hex = group_hex
            .as_ref()
            .map(|value| value.get(index))
            .unwrap_or("");
        let point_start = group_start
            .as_ref()
            .map(|value| value.get(index))
            .unwrap_or(0);
        let point_count = group_count_vec
            .as_ref()
            .map(|value| value.get(index))
            .unwrap_or(0);

        if point_start as u64 + point_count as u64 > total_points as u64 {
            return Err(format!(
                "AVTR history overflow: start={point_start}, count={point_count}, total={total_points}"
            ));
        }

        let mut points = Vec::with_capacity(point_count as usize);
        for point_index in 0..point_count as usize {
            let absolute_index = point_start as usize + point_index;
            points.push(crate::traffic_merge::TrafficHistoryPoint {
                lat: point_lat
                    .as_ref()
                    .map(|value| value.get(absolute_index))
                    .unwrap_or(0.0) as f64,
                lon: point_lon
                    .as_ref()
                    .map(|value| value.get(absolute_index))
                    .unwrap_or(0.0) as f64,
                altitude_feet: point_altitude
                    .as_ref()
                    .map(|value| value.get(absolute_index))
                    .unwrap_or(0.0) as f64,
                timestamp_ms: point_timestamp
                    .as_ref()
                    .map(|value| value.get(absolute_index))
                    .unwrap_or(0),
            });
        }

        out.push(crate::traffic_merge::BackfillHistory {
            hex: hex.to_owned(),
            points,
        });
    }
    Ok(())
}
