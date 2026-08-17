use crate::{approach_path, coords};
use std::sync::{Arc, Mutex};

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

/// Cross-section grid built along the requested slice axis (web
/// `CrossSectionData` semantics): row-major `bins_x * bins_y` grid of max dBZ
/// per cell (`-1` marks empty cells), the winning phase per cell, and the
/// per-column echo-top envelope in feet.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MrmsCrossSection {
    pub bins_x: u32,
    pub bins_y: u32,
    pub grid_dbz: Vec<f32>,
    pub grid_phase: Vec<u8>,
    pub top_envelope_feet: Vec<f32>,
    pub max_top_feet: f32,
}

/// Render-ready MRMS voxel columns for the native Metal renderer.
///
/// Positions/sizes are local-frame nautical miles without vertical
/// exaggeration; Swift multiplies the `y` center and height by the current
/// vertical scale. Decode/prepare failures are reported through `error`
/// (same pattern as `TrafficMergeResult`) with empty columns.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MrmsRenderVolume {
    pub voxel_count: u32,
    pub source_voxel_count: u32,
    pub valid_count: u32,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub center_x_nm: Vec<f32>,
    pub center_y_nm: Vec<f32>,
    pub center_z_nm: Vec<f32>,
    pub size_x_nm: Vec<f32>,
    pub size_y_nm: Vec<f32>,
    pub size_z_nm: Vec<f32>,
    pub dbz: Vec<f32>,
    pub phase_code: Vec<u8>,
    pub max_abs_x_nm: f32,
    pub max_abs_z_nm: f32,
    pub max_corrected_top_feet: f32,
    pub cross_section: Option<MrmsCrossSection>,
    pub error: Option<String>,
}

impl MrmsRenderVolume {
    fn failed(error: String) -> Self {
        Self {
            voxel_count: 0,
            source_voxel_count: 0,
            valid_count: 0,
            generated_at_ms: 0,
            scan_time_ms: 0,
            center_x_nm: Vec::new(),
            center_y_nm: Vec::new(),
            center_z_nm: Vec::new(),
            size_x_nm: Vec::new(),
            size_y_nm: Vec::new(),
            size_z_nm: Vec::new(),
            dbz: Vec::new(),
            phase_code: Vec::new(),
            max_abs_x_nm: 0.0,
            max_abs_z_nm: 0.0,
            max_corrected_top_feet: 0.0,
            cross_section: None,
            error: Some(error),
        }
    }
}

/// One echo-top threshold surface: cell centers in local-frame NM with the
/// echo-top altitude as an unscaled-NM `y` (web `EchoTopSoA` semantics).
#[derive(Debug, Clone, uniffi::Record)]
pub struct EchoTopSurface {
    pub x_nm: Vec<f32>,
    pub z_nm: Vec<f32>,
    pub y_nm: Vec<f32>,
}

/// Render-ready echo-top surfaces plus payload summary for the native
/// renderer. Decode failures are reported through `error` with empty columns.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EchoTopsRenderResult {
    pub source_cell_count: u32,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub footprint_x_nm: f32,
    pub footprint_y_nm: f32,
    pub max_top18_feet: f32,
    pub max_top30_feet: f32,
    pub max_top50_feet: f32,
    pub max_top60_feet: f32,
    pub top18: EchoTopSurface,
    pub top30: EchoTopSurface,
    pub top50: EchoTopSurface,
    pub error: Option<String>,
}

impl EchoTopsRenderResult {
    fn failed(error: String) -> Self {
        let empty = || EchoTopSurface {
            x_nm: Vec::new(),
            z_nm: Vec::new(),
            y_nm: Vec::new(),
        };
        Self {
            source_cell_count: 0,
            generated_at_ms: 0,
            scan_time_ms: 0,
            footprint_x_nm: 0.0,
            footprint_y_nm: 0.0,
            max_top18_feet: 0.0,
            max_top30_feet: 0.0,
            max_top50_feet: 0.0,
            max_top60_feet: 0.0,
            top18: empty(),
            top30: empty(),
            top50: empty(),
            error: Some(error),
        }
    }
}

#[derive(uniffi::Object)]
pub struct TrafficStateHandle {
    inner: Mutex<crate::traffic_merge::TrafficState>,
}

#[uniffi::export]
pub fn alt_to_y(alt_feet: f64, vertical_scale: f64) -> f64 {
    coords::alt_to_y(alt_feet, vertical_scale)
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
pub fn build_approach_hold_protected_area(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    leg_length_nm: f64,
    altitude_feet: f64,
    turn_direction: String,
    vertical_scale: f64,
) -> approach_path::HoldProtectedArea {
    approach_path::build_hold_protected_area(
        center_x,
        center_z,
        heading_deg,
        leg_length_nm,
        altitude_feet,
        &turn_direction,
        vertical_scale,
    )
}

#[uniffi::export]
pub fn resolve_approach_hold_leg_length_nm(
    hold_distance_nm: Option<f64>,
    hold_time_minutes: Option<f64>,
    altitude_feet: f64,
) -> f64 {
    approach_path::resolve_hold_leg_length_nm(hold_distance_nm, hold_time_minutes, altitude_feet)
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

/// Decode an AVMR v5 FlatBuffers volume payload and assemble render-ready
/// voxel columns via the shared `prepare_volume` + `build_render_volume`
/// pipeline (the same engine the web worker uses through WASM), optionally
/// building a cross-section grid along the requested slice axis.
///
/// `phase_mode`: 0 = altitude/thermodynamic, 1 = surface.
/// `declutter_mode`: 0 = all, 1 = low, 2 = mid, 3 = high.
#[uniffi::export]
#[allow(clippy::too_many_arguments)]
pub fn decode_and_prepare_mrms_volume(
    data: Vec<u8>,
    min_dbz_tenths: i16,
    phase_mode: u8,
    declutter_mode: u8,
    apply_earth_curvature: bool,
    ref_lat: f64,
    include_cross_section: bool,
    slice_axis_x: f64,
    slice_axis_z: f64,
    slice_perp_x: f64,
    slice_perp_z: f64,
    normalized_range: f64,
    half_width_nm: f64,
) -> MrmsRenderVolume {
    let fb = match flatbuffers::root::<crate::generated::MrmsVolume>(&data) {
        Ok(volume) => volume,
        Err(error) => return MrmsRenderVolume::failed(format!("AVMR payload invalid: {error}")),
    };

    let vol_view = match crate::mrms_preprocess::FbVolumeView::new(&fb) {
        Ok(view) => view,
        Err(error) => return MrmsRenderVolume::failed(error),
    };

    let phase_mode = match phase_mode {
        1 => crate::types::PhaseMode::Surface,
        _ => crate::types::PhaseMode::Altitude,
    };
    let declutter_mode = match declutter_mode {
        1 => crate::types::DeclutterMode::Low,
        2 => crate::types::DeclutterMode::Mid,
        3 => crate::types::DeclutterMode::High,
        _ => crate::types::DeclutterMode::All,
    };

    let prepared = crate::mrms_preprocess::prepare_volume(
        &vol_view,
        min_dbz_tenths,
        phase_mode,
        declutter_mode,
        apply_earth_curvature,
        ref_lat,
    );

    let cross_section = if include_cross_section {
        crate::mrms_preprocess::build_cross_section(
            &vol_view,
            &prepared,
            (slice_axis_x, slice_axis_z),
            (slice_perp_x, slice_perp_z),
            normalized_range,
            half_width_nm,
        )
        .map(|cs| MrmsCrossSection {
            bins_x: cs.bins_x as u32,
            bins_y: cs.bins_y as u32,
            grid_dbz: cs.grid,
            grid_phase: cs.phase_grid.into_iter().map(|p| p.max(0) as u8).collect(),
            top_envelope_feet: cs.top_envelope_feet,
            max_top_feet: cs.max_top_feet,
        })
    } else {
        None
    };

    let render = crate::mrms_render::build_render_volume(
        &vol_view,
        fb.footprint_x_milli() as f32 / 1000.0,
        fb.footprint_y_milli() as f32 / 1000.0,
        &prepared,
    );

    MrmsRenderVolume {
        voxel_count: render.center_x_nm.len() as u32,
        source_voxel_count: fb.brick_count(),
        valid_count: prepared.valid_count as u32,
        generated_at_ms: fb.generated_at_ms(),
        scan_time_ms: fb.scan_time_ms(),
        center_x_nm: render.center_x_nm,
        center_y_nm: render.center_y_nm,
        center_z_nm: render.center_z_nm,
        size_x_nm: render.size_x_nm,
        size_y_nm: render.size_y_nm,
        size_z_nm: render.size_z_nm,
        dbz: render.dbz,
        phase_code: render.phase_code,
        max_abs_x_nm: render.max_abs_x_nm,
        max_abs_z_nm: render.max_abs_z_nm,
        max_corrected_top_feet: render.max_corrected_top_feet,
        cross_section,
        error: None,
    }
}

/// Decode an AVET v3 FlatBuffers echo-tops payload and prepare the 18/30/50
/// dBZ threshold surfaces through the shared `prepare_echo_top_surfaces`
/// engine (the same path the web worker uses through WASM).
#[uniffi::export]
pub fn decode_and_prepare_echo_tops(
    data: Vec<u8>,
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> EchoTopsRenderResult {
    let fb = match flatbuffers::root::<crate::generated::EchoTops>(&data) {
        Ok(payload) => payload,
        Err(error) => {
            return EchoTopsRenderResult::failed(format!("AVET payload invalid: {error}"))
        }
    };

    let view = match crate::mrms_preprocess::FbEchoTopView::new(&fb) {
        Ok(view) => view,
        Err(error) => return EchoTopsRenderResult::failed(error),
    };

    let surfaces =
        crate::mrms_preprocess::prepare_echo_top_surfaces(&view, apply_earth_curvature, ref_lat);

    EchoTopsRenderResult {
        source_cell_count: fb.source_cell_count(),
        generated_at_ms: fb.generated_at_ms(),
        scan_time_ms: fb.scan_time_ms(),
        footprint_x_nm: surfaces.footprint_x_nm,
        footprint_y_nm: surfaces.footprint_y_nm,
        max_top18_feet: f32::from(fb.max_top18_feet()),
        max_top30_feet: f32::from(fb.max_top30_feet()),
        max_top50_feet: f32::from(fb.max_top50_feet()),
        max_top60_feet: f32::from(fb.max_top60_feet()),
        top18: EchoTopSurface {
            x_nm: surfaces.x18,
            z_nm: surfaces.z18,
            y_nm: surfaces.y_base18,
        },
        top30: EchoTopSurface {
            x_nm: surfaces.x30,
            z_nm: surfaces.z30,
            y_nm: surfaces.y_base30,
        },
        top50: EchoTopSurface {
            x_nm: surfaces.x50,
            z_nm: surfaces.z50,
            y_nm: surfaces.y_base50,
        },
        error: None,
    }
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

        let backfill_history = match crate::traffic_merge::collect_fb_history(&fb, backfill_fb.as_ref()) {
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

