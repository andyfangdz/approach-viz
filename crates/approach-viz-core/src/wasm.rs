// wasm-bindgen bindings for approach-viz-core.
//
// Thin wrappers exposing core decode/preprocess/merge functions to JS workers
// via wasm-bindgen. The goal is to minimize JS<->WASM boundary crossings by
// accepting raw bytes / typed-array slices and returning structured JS objects.
//
// All functions in this module are feature-gated behind `#[cfg(feature = "wasm")]`
// at the module level (see lib.rs).

use wasm_bindgen::prelude::*;

fn js_err<E: std::fmt::Display>(context: &str, error: E) -> JsValue {
    JsValue::from_str(&format!("{context}: {error}"))
}

// ---------------------------------------------------------------------------
// MRMS Decode + Prepare + Cross-Section (single boundary crossing)
// ---------------------------------------------------------------------------

/// Decode, filter, curvature-correct, declutter, and join into render-ready
/// voxel columns from a raw AVMR binary payload — all in one WASM call,
/// optionally building a cross-section grid.
///
/// Returns a JS object with three top-level keys:
///   `renderVolume` — flat per-rendered-voxel columns + altitude-guide
///       extents from `build_render_volume` (the `prepare_volume` dual index
///       space is resolved here in Rust; JS never pairs
///       `declutterIndices`/`validIndices` with payload columns)
///   `crossSection` — CrossSectionData | null
///   `composite` — ground reflectivity raster (composite or base) | null
///   `volumePayload` — volume metadata + full-payload phase codes (debug tally)
///
/// This eliminates all intermediate JS<->WASM boundary crossings for the
/// `poll-and-prepare` hot path.
#[wasm_bindgen]
pub fn decode_and_prepare_mrms(
    data: &[u8],
    // prepare params
    min_dbz_tenths: i16,
    phase_mode: u8,
    declutter_mode: u8,
    apply_earth_curvature: bool,
    ref_lat: f64,
    // cross-section params (pass include_cross_section=false to skip)
    include_cross_section: bool,
    slice_axis_x: f64,
    slice_axis_z: f64,
    slice_perp_x: f64,
    slice_perp_z: f64,
    normalized_range: f64,
    half_width_nm: f64,
    // ground reflectivity raster (pass include_composite=false to skip)
    include_composite: bool,
    // 0 = composite (column max), 1 = base (lowest echo)
    mosaic_product: u8,
) -> Result<JsValue, JsValue> {
    // 1. Verify FB root — no decode/copy
    let fb = flatbuffers::root::<crate::generated::MrmsVolume>(data)
        .map_err(|e| JsValue::from_str(&format!("AVMR payload invalid: {e}")))?;

    // Zero-copy volume view — reads directly from the FB buffer. Column
    // presence/length is validated once here so every per-voxel loop below
    // (prepare, cross-section, render-volume join) is free of Option checks.
    let vol_view =
        crate::mrms_preprocess::FbVolumeView::new(&fb).map_err(|e| JsValue::from_str(&e))?;

    // 2. Prepare (generic — uses FbVolumeView for zero-copy reads)
    let pm = match phase_mode {
        1 => crate::types::PhaseMode::Surface,
        _ => crate::types::PhaseMode::Altitude,
    };
    let dm = match declutter_mode {
        1 => crate::types::DeclutterMode::Low,
        2 => crate::types::DeclutterMode::Mid,
        3 => crate::types::DeclutterMode::High,
        _ => crate::types::DeclutterMode::All,
    };

    let prepared = crate::mrms_preprocess::prepare_volume(
        &vol_view, min_dbz_tenths, pm, dm, apply_earth_curvature, ref_lat,
    );

    // 3. Cross-section (optional — also reads from FbVolumeView)
    let cross_section = if include_cross_section {
        crate::mrms_preprocess::build_cross_section(
            &vol_view,
            &prepared,
            (slice_axis_x, slice_axis_z),
            (slice_perp_x, slice_perp_z),
            normalized_range,
            half_width_nm,
        )
    } else {
        None
    };

    // 4. Join prepare outputs with payload columns into flat render columns
    //    (the same `build_render_volume` path the native iOS/macOS app uses).
    let render = crate::mrms_render::build_render_volume(
        &vol_view,
        fb.footprint_x_milli() as f32 / 1000.0,
        fb.footprint_y_milli() as f32 / 1000.0,
        &prepared,
    );

    // 5. Build result object
    let root = js_sys::Object::new();

    // -- render volume (flat per-rendered-voxel columns + guide extents) --
    let render_obj = js_sys::Object::new();
    set_prop(&render_obj, "count", &JsValue::from(render.center_x_nm.len() as u32))?;
    set_prop(&render_obj, "centerXNm", &js_sys::Float32Array::from(&render.center_x_nm[..]).into())?;
    set_prop(&render_obj, "centerYNm", &js_sys::Float32Array::from(&render.center_y_nm[..]).into())?;
    set_prop(&render_obj, "centerZNm", &js_sys::Float32Array::from(&render.center_z_nm[..]).into())?;
    set_prop(&render_obj, "sizeXNm", &js_sys::Float32Array::from(&render.size_x_nm[..]).into())?;
    set_prop(&render_obj, "sizeYNm", &js_sys::Float32Array::from(&render.size_y_nm[..]).into())?;
    set_prop(&render_obj, "sizeZNm", &js_sys::Float32Array::from(&render.size_z_nm[..]).into())?;
    set_prop(&render_obj, "dbz", &js_sys::Float32Array::from(&render.dbz[..]).into())?;
    set_prop(&render_obj, "phaseCode", &js_sys::Uint8Array::from(&render.phase_code[..]).into())?;
    set_prop(&render_obj, "maxAbsXNm", &JsValue::from(render.max_abs_x_nm))?;
    set_prop(&render_obj, "maxAbsZNm", &JsValue::from(render.max_abs_z_nm))?;
    set_prop(&render_obj, "maxCorrectedTopFeet", &JsValue::from(render.max_corrected_top_feet))?;
    set_prop(&root, "renderVolume", &render_obj.into())?;

    // -- cross-section --
    match &cross_section {
        None => {
            set_prop(&root, "crossSection", &JsValue::NULL)?;
        }
        Some(cs) => {
            let cs_obj = js_sys::Object::new();
            set_prop(&cs_obj, "binsX", &JsValue::from(cs.bins_x as u32))?;
            set_prop(&cs_obj, "binsY", &JsValue::from(cs.bins_y as u32))?;
            set_prop(&cs_obj, "grid", &js_sys::Float32Array::from(&cs.grid[..]).into())?;
            set_prop(&cs_obj, "phaseGrid", &js_sys::Int8Array::from(&cs.phase_grid[..]).into())?;
            set_prop(&cs_obj, "topEnvelopeFeet", &js_sys::Float32Array::from(&cs.top_envelope_feet[..]).into())?;
            set_prop(&cs_obj, "maxTopFeet", &JsValue::from(cs.max_top_feet))?;
            set_prop(&root, "crossSection", &cs_obj.into())?;
        }
    }

    // -- ground reflectivity raster (column max, or lowest echo) --
    let composite = if include_composite {
        let mosaic = match mosaic_product {
            1 => crate::mrms_render::MosaicProduct::Base,
            _ => crate::mrms_render::MosaicProduct::Composite,
        };
        crate::mrms_render::build_composite_surface(
            &vol_view,
            fb.footprint_x_milli() as f32 / 1000.0,
            fb.footprint_y_milli() as f32 / 1000.0,
            min_dbz_tenths,
            pm,
            mosaic,
        )
        .map_err(|e| JsValue::from_str(&e))?
    } else {
        None
    };
    match &composite {
        None => {
            set_prop(&root, "composite", &JsValue::NULL)?;
        }
        Some(surface) => {
            let obj = js_sys::Object::new();
            set_prop(&obj, "width", &JsValue::from(surface.width))?;
            set_prop(&obj, "height", &JsValue::from(surface.height))?;
            set_prop(&obj, "originXNm", &JsValue::from(surface.origin_x_nm))?;
            set_prop(&obj, "originZNm", &JsValue::from(surface.origin_z_nm))?;
            set_prop(&obj, "cellSizeXNm", &JsValue::from(surface.cell_size_x_nm))?;
            set_prop(&obj, "cellSizeZNm", &JsValue::from(surface.cell_size_z_nm))?;
            set_prop(&obj, "dbzTenths", &js_sys::Int16Array::from(&surface.dbz_tenths[..]).into())?;
            set_prop(&obj, "phaseCode", &js_sys::Uint8Array::from(&surface.phase_code[..]).into())?;
            set_prop(&obj, "filledCellCount", &JsValue::from(surface.filled_cell_count))?;
            set_prop(&obj, "maxDbzTenths", &JsValue::from(surface.max_dbz_tenths))?;
            set_prop(&root, "composite", &obj.into())?;
        }
    }

    // -- volume payload — metadata read directly from the FB root. The raw
    //    positional/size columns are not emitted: rendering consumes the
    //    joined `renderVolume` columns instead.
    let vp_obj = js_sys::Object::new();
    let brick_count = fb.brick_count() as usize;

    set_prop(&vp_obj, "voxelCount", &JsValue::from(brick_count as u32))?;
    set_prop(&vp_obj, "generatedAtMs", &JsValue::from(fb.generated_at_ms() as f64))?;
    set_prop(&vp_obj, "scanTimeMs", &JsValue::from(fb.scan_time_ms() as f64))?;
    set_prop(&vp_obj, "layerCount", &JsValue::from(fb.layer_count()))?;

    // layer_voxel_counts — small array, collect from FB vector
    let lvc: Vec<u32> = fb.layer_voxel_counts()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    set_prop(&vp_obj, "layerVoxelCounts", &js_sys::Uint32Array::from(&lvc[..]).into())?;

    // Phase code — u8 column maps straight onto the FB buffer bytes. Kept at
    // full payload length so the worker's debug phase tally covers every
    // voxel, not just the rendered subset.
    set_prop(
        &vp_obj,
        "phaseCode",
        &js_sys::Uint8Array::from(vol_view.phase.bytes()).into(),
    )?;

    set_prop(&root, "volumePayload", &vp_obj.into())?;

    Ok(root.into())
}


/// Convert SoA echo-top column Vecs into a JS object with Float32Array views.
///
/// The footprint values are uniform (same for every cell), so we create
/// single-element arrays and let the JS side broadcast.
fn echo_top_soa_to_js(
    count: usize,
    x: &[f32],
    z: &[f32],
    y_base: &[f32],
    footprint_x_nm: f32,
    footprint_y_nm: f32,
) -> Result<JsValue, JsValue> {
    let obj = js_sys::Object::new();
    set_prop(&obj, "count", &JsValue::from(count as u32))?;
    set_prop(&obj, "x", &js_sys::Float32Array::from(x).into())?;
    set_prop(&obj, "z", &js_sys::Float32Array::from(z).into())?;
    set_prop(&obj, "yBase", &js_sys::Float32Array::from(y_base).into())?;
    set_prop(
        &obj,
        "footprintXNm",
        &JsValue::from_f64(footprint_x_nm as f64),
    )?;
    set_prop(
        &obj,
        "footprintYNm",
        &JsValue::from_f64(footprint_y_nm as f64),
    )?;

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// MRMS Echo-Top — binary decode + prepare (single boundary crossing)
// ---------------------------------------------------------------------------

/// Decode an AVET binary echo-top payload and build prepared surfaces in one WASM call.
///
/// Returns `{ top18, top30, top50, summary }` where each top is an SoA object
/// with Float32Array x/z/yBase columns and scalar footprint values.
#[wasm_bindgen]
pub fn decode_and_prepare_echo_top(
    data: &[u8],
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> Result<JsValue, JsValue> {
    // Verify FB root — no decode/copy for the prepare path
    let fb = flatbuffers::root::<crate::generated::EchoTops>(data)
        .map_err(|e| JsValue::from_str(&format!("AVET payload invalid: {e}")))?;

    // Zero-copy echo-top view for prepare. Column presence/length is
    // validated once here so the prepare loop is free of Option checks.
    let et_view =
        crate::mrms_preprocess::FbEchoTopView::new(&fb).map_err(|e| JsValue::from_str(&e))?;

    let s =
        crate::mrms_preprocess::prepare_echo_top_surfaces(&et_view, apply_earth_curvature, ref_lat);

    let root = js_sys::Object::new();
    set_prop(
        &root,
        "top18",
        &echo_top_soa_to_js(s.count18, &s.x18, &s.z18, &s.y_base18, s.footprint_x_nm, s.footprint_y_nm)?,
    )?;
    set_prop(
        &root,
        "top30",
        &echo_top_soa_to_js(s.count30, &s.x30, &s.z30, &s.y_base30, s.footprint_x_nm, s.footprint_y_nm)?,
    )?;
    set_prop(
        &root,
        "top50",
        &echo_top_soa_to_js(s.count50, &s.x50, &s.z50, &s.y_base50, s.footprint_x_nm, s.footprint_y_nm)?,
    )?;

    // Summary metadata — read directly from FB root (no owned decode).
    let summary_obj = js_sys::Object::new();
    set_prop(&summary_obj, "sourceCellCount", &JsValue::from(fb.source_cell_count()))?;
    set_prop(&summary_obj, "maxTop18Feet", &option_u16_to_js(fb.max_top18_feet()))?;
    set_prop(&summary_obj, "maxTop30Feet", &option_u16_to_js(fb.max_top30_feet()))?;
    set_prop(&summary_obj, "maxTop50Feet", &option_u16_to_js(fb.max_top50_feet()))?;
    set_prop(&summary_obj, "maxTop60Feet", &option_u16_to_js(fb.max_top60_feet()))?;
    set_prop(&root, "summary", &summary_obj.into())?;

    Ok(root.into())
}

// ---------------------------------------------------------------------------
// Traffic Merge State (stateful)
// ---------------------------------------------------------------------------

/// Stateful traffic merge state held in WASM memory.
///
/// JS creates one instance and calls methods on it. The inner `TrafficState`
/// maintains the track map across calls.
#[wasm_bindgen]
pub struct WasmTrafficState {
    inner: crate::traffic_merge::TrafficState,
}

#[wasm_bindgen]
impl WasmTrafficState {
    /// Create a new empty traffic state.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: crate::traffic_merge::TrafficState::new(),
        }
    }

    /// Number of active tracks.
    #[wasm_bindgen(getter)]
    pub fn track_count(&self) -> usize {
        self.inner.track_count()
    }

    /// Merge incoming traffic binary data + optional backfill history into the state.
    ///
    /// `data`: raw AVTR binary payload (current poll).
    /// `backfill_data`: raw AVTR binary payload (backfill history), or empty slice if none.
    /// `now_ms`: current timestamp in milliseconds.
    /// `history_minutes`: how many minutes of history to keep.
    /// `hide_ground`: whether to exclude ground aircraft.
    ///
    /// Returns a JS object with `{ trackCount, fetchedAtMs, source, error, trackedHexes, returnedHistoryHexes }`.
    pub fn merge(
        &mut self,
        data: &[u8],
        now_ms: f64,
        history_minutes: f64,
        hide_ground: bool,
        backfill_data: &[u8],
    ) -> Result<JsValue, JsValue> {
        let now_ms_i64 = now_ms as i64;

        // Verify and get a reference to the FB root — no decode/copy.
        let fb = flatbuffers::root::<crate::generated::TrafficPayload>(data)
            .map_err(|e| JsValue::from_str(&format!("AVTR payload invalid: {e}")))?;

        // Zero-copy aircraft view — reads directly from the FB buffer.
        let ac_view = crate::traffic_merge::FbAircraftView::new(&fb);

        // Backfill FB (if present).
        let backfill_fb = if !backfill_data.is_empty() {
            Some(
                flatbuffers::root::<crate::generated::TrafficPayload>(backfill_data)
                    .map_err(|e| JsValue::from_str(&format!("backfill AVTR invalid: {e}")))?,
            )
        } else {
            None
        };

        // History still needs owned Vecs for sort/dedup — collect from FB accessors.
        let backfill_history = crate::traffic_merge::collect_fb_history(&fb, backfill_fb.as_ref())
            .map_err(|error| JsValue::from_str(&error))?;

        // Collect tracked hexes directly from FB string vector (zero-copy &str).
        let mut tracked_set = std::collections::HashSet::new();
        let tracked_hexes = js_sys::Array::new();
        if let Some(hex_vec) = fb.ac_hex() {
            for i in 0..fb.aircraft_count() as usize {
                let hex = hex_vec.get(i);
                if !hex.is_empty() && tracked_set.insert(hex) {
                    tracked_hexes.push(&JsValue::from_str(hex));
                }
            }
        }

        // Collect returned history hexes from FB string vectors.
        let mut history_set = std::collections::HashSet::new();
        let returned_history_hexes = js_sys::Array::new();
        collect_fb_history_hexes(&fb, &mut history_set, &returned_history_hexes);
        if let Some(bfb) = backfill_fb.as_ref() {
            collect_fb_history_hexes(bfb, &mut history_set, &returned_history_hexes);
        }

        self.inner
            .merge(&ac_view, now_ms_i64, history_minutes, hide_ground, &backfill_history);

        // Read metadata directly from FB.
        let obj = js_sys::Object::new();
        set_prop(&obj, "trackCount", &JsValue::from(self.inner.track_count() as u32))?;
        set_prop(&obj, "fetchedAtMs", &JsValue::from(fb.fetched_at_ms() as f64))?;
        set_prop(
            &obj,
            "source",
            &match fb.source() {
                Some(s) => JsValue::from_str(s),
                None => JsValue::NULL,
            },
        )?;
        let error_val = if fb.flags() & 1 != 0 {
            fb.error().map(|s| JsValue::from_str(s)).unwrap_or(JsValue::NULL)
        } else {
            JsValue::NULL
        };
        set_prop(&obj, "error", &error_val)?;
        set_prop(&obj, "trackedHexes", &tracked_hexes)?;
        set_prop(&obj, "returnedHistoryHexes", &returned_history_hexes)?;

        Ok(obj.into())
    }

    /// Recompute tracks (trim history, hide ground, refresh timestamps).
    ///
    /// Returns `{ trackCount: number }`.
    pub fn recompute(
        &mut self,
        now_ms: f64,
        history_minutes: f64,
        hide_ground: bool,
    ) -> Result<JsValue, JsValue> {
        self.inner.recompute(now_ms as i64, history_minutes, hide_ground);

        let obj = js_sys::Object::new();
        set_prop(&obj, "trackCount", &JsValue::from(self.inner.track_count() as u32))?;
        Ok(obj.into())
    }

    /// Build render-ready tracks projected to scene coordinates (SoA return).
    ///
    /// `airport_data`: flat Float64Array of `[lat, lon, elevation, ...]` triples.
    ///
    /// Returns a flat JS object with parallel typed arrays (SoA layout):
    /// `{ trackCount, markerPositions: Float32Array, headingDeg: Float32Array,
    ///    flags: Uint8Array, trailPointsFlat: Float32Array, trailOffsets: Uint32Array,
    ///    trailCounts: Uint32Array, hexes: string[], callsignLabels: (string|null)[],
    ///    hash: number }`
    ///
    /// `flags` bit layout: bit 0 = isCurrentlyPresent, bit 1 = isOnGround.
    pub fn build_render_tracks(
        &self,
        ref_lat: f64,
        ref_lon: f64,
        airport_data: &[f64],
        vertical_scale: f64,
        apply_earth_curvature: bool,
        show_departed_trails: bool,
    ) -> Result<JsValue, JsValue> {
        // Unpack flat [lat, lon, elev, ...] triples into Vec<SceneAirport>.
        let mut airports: Vec<crate::traffic_merge::SceneAirport> =
            Vec::with_capacity(airport_data.len() / 3);
        let mut i = 0;
        while i + 2 < airport_data.len() {
            airports.push(crate::traffic_merge::SceneAirport {
                lat: airport_data[i],
                lon: airport_data[i + 1],
                elevation_feet: airport_data[i + 2],
            });
            i += 3;
        }

        let (render_tracks, hash) = self.inner.build_render_tracks(
            ref_lat,
            ref_lon,
            &airports,
            vertical_scale,
            apply_earth_curvature,
            show_departed_trails,
        );

        let track_count = render_tracks.len();
        let total_trail_points: usize = render_tracks.iter().map(|rt| rt.trail_points.len()).sum();

        // Build SoA parallel arrays
        let mut marker_positions = Vec::with_capacity(track_count * 3);
        let mut heading_deg = Vec::with_capacity(track_count);
        let mut flags = Vec::with_capacity(track_count);
        let mut trail_offsets: Vec<u32> = Vec::with_capacity(track_count);
        let mut trail_counts: Vec<u32> = Vec::with_capacity(track_count);
        let mut trail_points_flat = Vec::with_capacity(total_trail_points * 3);
        let hexes = js_sys::Array::new_with_length(track_count as u32);
        let callsign_labels = js_sys::Array::new_with_length(track_count as u32);

        let mut point_offset: u32 = 0;
        for (i, rt) in render_tracks.iter().enumerate() {
            marker_positions.push(rt.marker_position[0]);
            marker_positions.push(rt.marker_position[1]);
            marker_positions.push(rt.marker_position[2]);
            heading_deg.push(rt.heading_deg as f32);
            flags.push(
                (if rt.is_currently_present { 1u8 } else { 0 })
                    | (if rt.is_on_ground { 2u8 } else { 0 }),
            );
            trail_offsets.push(point_offset);
            trail_counts.push(rt.trail_points.len() as u32);

            for pt in &rt.trail_points {
                trail_points_flat.push(pt[0]);
                trail_points_flat.push(pt[1]);
                trail_points_flat.push(pt[2]);
            }
            point_offset += rt.trail_points.len() as u32;

            hexes.set(i as u32, JsValue::from_str(&rt.hex));
            callsign_labels.set(
                i as u32,
                match &rt.callsign_label {
                    Some(s) => JsValue::from_str(s),
                    None => JsValue::NULL,
                },
            );
        }

        let obj = js_sys::Object::new();
        set_prop(&obj, "trackCount", &JsValue::from(track_count as u32))?;
        set_prop(&obj, "markerPositions", &js_sys::Float32Array::from(&marker_positions[..]).into())?;
        set_prop(&obj, "headingDeg", &js_sys::Float32Array::from(&heading_deg[..]).into())?;
        set_prop(&obj, "flags", &js_sys::Uint8Array::from(&flags[..]).into())?;
        set_prop(&obj, "trailPointsFlat", &js_sys::Float32Array::from(&trail_points_flat[..]).into())?;
        set_prop(&obj, "trailOffsets", &js_sys::Uint32Array::from(&trail_offsets[..]).into())?;
        set_prop(&obj, "trailCounts", &js_sys::Uint32Array::from(&trail_counts[..]).into())?;
        set_prop(&obj, "hexes", &hexes.into())?;
        set_prop(&obj, "callsignLabels", &callsign_labels.into())?;
        set_prop(&obj, "hash", &JsValue::from(hash as f64))?;

        Ok(obj.into())
    }

    /// Prune tracks after a fetch error.
    pub fn prune_for_error(&mut self, now_ms: f64, history_minutes: f64) {
        self.inner.prune_for_error(now_ms as i64, history_minutes);
    }
}

#[wasm_bindgen]
pub fn approach_path_resolve_altitudes(params: JsValue) -> Result<JsValue, JsValue> {
    let params: crate::approach_path::ResolveApproachAltitudesParams =
        serde_wasm_bindgen::from_value(params)
            .map_err(|error| js_err("failed to decode approach altitude params", error))?;
    let result = crate::approach_path::resolve_approach_altitudes(params);
    serde_wasm_bindgen::to_value(&result)
        .map_err(|error| js_err("failed to encode approach altitude result", error))
}

#[wasm_bindgen]
pub fn approach_path_build_geometry(params: JsValue) -> Result<JsValue, JsValue> {
    let params: crate::approach_path::BuildPathGeometryParams =
        serde_wasm_bindgen::from_value(params)
            .map_err(|error| js_err("failed to decode approach geometry params", error))?;
    let result = crate::approach_path::build_path_geometry(params);
    serde_wasm_bindgen::to_value(&result)
        .map_err(|error| js_err("failed to encode approach geometry result", error))
}

#[wasm_bindgen]
pub fn approach_path_build_hold_protected_area(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    leg_length_nm: f64,
    altitude_feet: f64,
    turn_direction: String,
    vertical_scale: f64,
) -> Result<JsValue, JsValue> {
    let result = crate::approach_path::build_hold_protected_area(
        center_x,
        center_z,
        heading_deg,
        leg_length_nm,
        altitude_feet,
        &turn_direction,
        vertical_scale,
    );
    serde_wasm_bindgen::to_value(&result)
        .map_err(|error| js_err("failed to encode hold protected area", error))
}

#[wasm_bindgen]
pub fn approach_path_resolve_hold_leg_length_nm(
    hold_distance_nm: Option<f64>,
    hold_time_minutes: Option<f64>,
    altitude_feet: f64,
) -> f64 {
    crate::approach_path::resolve_hold_leg_length_nm(
        hold_distance_nm,
        hold_time_minutes,
        altitude_feet,
    )
}

#[wasm_bindgen]
pub fn approach_path_build_hold_points(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    hold_distance_nm: f64,
    altitude_feet: f64,
    turn_direction: String,
    vertical_scale: f64,
) -> Result<JsValue, JsValue> {
    let result = crate::approach_path::build_hold_geometry(
        center_x,
        center_z,
        heading_deg,
        hold_distance_nm,
        altitude_feet,
        &turn_direction,
        vertical_scale,
    );
    serde_wasm_bindgen::to_value(&result)
        .map_err(|error| js_err("failed to encode hold geometry result", error))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Set a property on a JS object using `Reflect::set`.
fn set_prop(obj: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), value)?;
    Ok(())
}

/// Collect unique history hex codes from an FB payload into a set + JS array.
fn collect_fb_history_hexes<'a>(
    fb: &crate::generated::TrafficPayload<'a>,
    set: &mut std::collections::HashSet<&'a str>,
    js_array: &js_sys::Array,
) {
    let hg_count = fb.history_group_count() as usize;
    if let Some(hg_hex) = fb.hg_hex() {
        for i in 0..hg_count {
            let hex = hg_hex.get(i);
            if !hex.is_empty() && set.insert(hex) {
                js_array.push(&JsValue::from_str(hex));
            }
        }
    }
}

/// Convert u16 to JsValue (0 → null, otherwise f32).
fn option_u16_to_js(val: u16) -> JsValue {
    if val == 0 {
        JsValue::NULL
    } else {
        JsValue::from(val as f32)
    }
}
