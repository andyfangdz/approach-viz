// wasm-bindgen bindings for approach-viz-core.
//
// Thin wrappers exposing core decode/preprocess/merge functions to JS workers
// via wasm-bindgen. The goal is to minimize JS<->WASM boundary crossings by
// accepting raw bytes / typed-array slices and returning structured JS objects.
//
// All functions in this module are feature-gated behind `#[cfg(feature = "wasm")]`
// at the module level (see lib.rs).

use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// MRMS Decode
// ---------------------------------------------------------------------------

/// Decode an AVMR binary payload into a JS object matching NexradVolumePayload shape.
///
/// Returns raw decoded values (dBZ in tenths, feet as u16, spans as-is).
/// The TS caller is responsible for any further conversions (e.g. tenths -> whole dBZ).
#[wasm_bindgen]
pub fn decode_mrms_volume(data: &[u8]) -> Result<JsValue, JsValue> {
    let vol = crate::mrms_wire_codec::decode_mrms_binary(data)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let obj = js_sys::Object::new();

    // Scalar header fields
    set_prop(&obj, "version", &JsValue::from(vol.version))?;
    set_prop(&obj, "voxelCount", &JsValue::from(vol.voxel_count))?;
    set_prop(&obj, "layerCount", &JsValue::from(vol.layer_count))?;
    set_prop(&obj, "generatedAtMs", &JsValue::from(vol.generated_at_ms as f64))?;
    set_prop(&obj, "scanTimeMs", &JsValue::from(vol.scan_time_ms as f64))?;
    set_prop(&obj, "footprintXNm", &JsValue::from(vol.footprint_x_nm))?;
    set_prop(&obj, "footprintYNm", &JsValue::from(vol.footprint_y_nm))?;

    // Typed arrays (SoA parallel arrays)
    set_prop(&obj, "xNm", &js_sys::Float32Array::from(&vol.x_nm[..]).into())?;
    set_prop(&obj, "zNm", &js_sys::Float32Array::from(&vol.z_nm[..]).into())?;
    set_prop(&obj, "bottomFeet", &js_sys::Uint16Array::from(&vol.bottom_feet[..]).into())?;
    set_prop(&obj, "topFeet", &js_sys::Uint16Array::from(&vol.top_feet[..]).into())?;
    set_prop(&obj, "dbzTenths", &js_sys::Int16Array::from(&vol.dbz_tenths[..]).into())?;
    set_prop(&obj, "phase", &js_sys::Uint8Array::from(&vol.phase[..]).into())?;
    set_prop(&obj, "surfacePhase", &js_sys::Uint8Array::from(&vol.surface_phase[..]).into())?;
    set_prop(&obj, "footprintXSpan", &js_sys::Uint16Array::from(&vol.footprint_x_span[..]).into())?;
    set_prop(&obj, "footprintYSpan", &js_sys::Uint16Array::from(&vol.footprint_y_span[..]).into())?;
    set_prop(&obj, "layerVoxelCounts", &js_sys::Uint32Array::from(&vol.layer_voxel_counts[..]).into())?;

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// MRMS Decode + Prepare + Cross-Section (single boundary crossing)
// ---------------------------------------------------------------------------

/// Decode, filter, curvature-correct, declutter, and optionally build a
/// cross-section from a raw AVMR binary payload — all in one WASM call.
///
/// Returns a JS object with three top-level keys:
///   `prepared`  — NexradPreparedVolumeData (for SAB write)
///   `crossSection` — CrossSectionData | null
///   `volumePayload` — NexradVolumePayload fields (for transferable arrays)
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
) -> Result<JsValue, JsValue> {
    // 1. Decode
    let vol = crate::mrms_wire_codec::decode_mrms_binary(data)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // 2. Prepare
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
        &vol, min_dbz_tenths, pm, dm, apply_earth_curvature, ref_lat,
    );

    // 3. Cross-section (optional)
    let cross_section = if include_cross_section {
        crate::mrms_preprocess::build_cross_section(
            &vol,
            &prepared,
            (slice_axis_x, slice_axis_z),
            (slice_perp_x, slice_perp_z),
            normalized_range,
            half_width_nm,
        )
    } else {
        None
    };

    // 4. Build result object
    let root = js_sys::Object::new();

    // -- prepared volume --
    let prep_obj = js_sys::Object::new();
    set_prop(&prep_obj, "validCount", &JsValue::from(prepared.valid_count as u32))?;
    set_prop(&prep_obj, "validIndices", &js_sys::Int32Array::from(&prepared.valid_indices[..]).into())?;
    set_prop(&prep_obj, "yBase", &js_sys::Float32Array::from(&prepared.y_base[..]).into())?;
    set_prop(&prep_obj, "heightBase", &js_sys::Float32Array::from(&prepared.height_base[..]).into())?;
    set_prop(&prep_obj, "correctedBottomFeet", &js_sys::Float32Array::from(&prepared.corrected_bottom_feet[..]).into())?;
    set_prop(&prep_obj, "correctedTopFeet", &js_sys::Float32Array::from(&prepared.corrected_top_feet[..]).into())?;
    set_prop(&prep_obj, "effectivePhaseCode", &js_sys::Uint8Array::from(&prepared.effective_phase_code[..]).into())?;
    set_prop(&prep_obj, "declutterIndices", &js_sys::Int32Array::from(&prepared.declutter_indices[..]).into())?;
    set_prop(&prep_obj, "declutterCount", &JsValue::from(prepared.declutter_count as u32))?;
    set_prop(&root, "prepared", &prep_obj.into())?;

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

    // -- volume payload (converted fields for transferable arrays) --
    let vp_obj = js_sys::Object::new();
    let voxel_count = vol.voxel_count as usize;

    set_prop(&vp_obj, "voxelCount", &JsValue::from(vol.voxel_count))?;
    set_prop(&vp_obj, "generatedAtMs", &JsValue::from(vol.generated_at_ms as f64))?;
    set_prop(&vp_obj, "scanTimeMs", &JsValue::from(vol.scan_time_ms as f64))?;
    set_prop(&vp_obj, "layerCount", &JsValue::from(vol.layer_count))?;
    set_prop(&vp_obj, "layerVoxelCounts", &js_sys::Uint32Array::from(&vol.layer_voxel_counts[..]).into())?;

    // xNm, zNm passed through
    set_prop(&vp_obj, "xNm", &js_sys::Float32Array::from(&vol.x_nm[..]).into())?;
    set_prop(&vp_obj, "zNm", &js_sys::Float32Array::from(&vol.z_nm[..]).into())?;

    // Convert dbzTenths i16 -> f32 (whole dBZ)
    let mut dbz_f32 = Vec::with_capacity(voxel_count);
    for i in 0..voxel_count {
        dbz_f32.push(vol.dbz_tenths[i] as f32 / 10.0);
    }
    set_prop(&vp_obj, "dbz", &js_sys::Float32Array::from(&dbz_f32[..]).into())?;

    // Per-voxel footprint NM = scalar * max(1, span)
    let mut fp_x_nm = Vec::with_capacity(voxel_count);
    let mut fp_y_nm = Vec::with_capacity(voxel_count);
    for i in 0..voxel_count {
        fp_x_nm.push(vol.footprint_x_nm * (vol.footprint_x_span[i].max(1) as f32));
        fp_y_nm.push(vol.footprint_y_nm * (vol.footprint_y_span[i].max(1) as f32));
    }
    set_prop(&vp_obj, "footprintXNm", &js_sys::Float32Array::from(&fp_x_nm[..]).into())?;
    set_prop(&vp_obj, "footprintYNm", &js_sys::Float32Array::from(&fp_y_nm[..]).into())?;

    // Phase code passed through (surfacePhaseCode omitted — already in prepared.effectivePhaseCode)
    set_prop(&vp_obj, "phaseCode", &js_sys::Uint8Array::from(&vol.phase[..]).into())?;

    set_prop(&root, "volumePayload", &vp_obj.into())?;

    Ok(root.into())
}

// ---------------------------------------------------------------------------
// Traffic Decode
// ---------------------------------------------------------------------------

/// Decode an AVTR binary payload into a JS object.
///
/// Uses serde-wasm-bindgen for the complex nested structure (aircraft array,
/// history groups with nested point arrays).
#[wasm_bindgen]
pub fn decode_traffic(data: &[u8]) -> Result<JsValue, JsValue> {
    let payload = crate::traffic_codec::decode_traffic_binary(data)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Build JS object manually to match expected TS shape.
    let obj = js_sys::Object::new();

    set_prop(&obj, "fetchedAtMs", &JsValue::from(payload.fetched_at_ms as f64))?;
    set_prop(
        &obj,
        "source",
        &match &payload.source {
            Some(s) => JsValue::from_str(s),
            None => JsValue::NULL,
        },
    )?;
    set_prop(
        &obj,
        "error",
        &match &payload.error {
            Some(s) => JsValue::from_str(s),
            None => JsValue::NULL,
        },
    )?;

    // Aircraft array
    let ac_array = js_sys::Array::new_with_length(payload.aircraft.len() as u32);
    for (i, ac) in payload.aircraft.iter().enumerate() {
        let ac_obj = js_sys::Object::new();
        set_prop(&ac_obj, "hex", &JsValue::from_str(&ac.hex))?;
        set_prop(
            &ac_obj,
            "flight",
            &match &ac.flight {
                Some(f) => JsValue::from_str(f),
                None => JsValue::NULL,
            },
        )?;
        set_prop(&ac_obj, "lat", &JsValue::from(ac.lat))?;
        set_prop(&ac_obj, "lon", &JsValue::from(ac.lon))?;
        set_prop(
            &ac_obj,
            "altitudeFeet",
            &option_f32_to_js(ac.altitude_feet),
        )?;
        set_prop(
            &ac_obj,
            "groundSpeedKt",
            &option_f32_to_js(ac.ground_speed_kt),
        )?;
        set_prop(
            &ac_obj,
            "trackDeg",
            &option_f32_to_js(ac.track_deg),
        )?;
        set_prop(
            &ac_obj,
            "lastSeenSeconds",
            &option_f32_to_js(ac.last_seen_seconds),
        )?;
        set_prop(&ac_obj, "isOnGround", &JsValue::from(ac.is_on_ground))?;
        ac_array.set(i as u32, ac_obj.into());
    }
    set_prop(&obj, "aircraft", &ac_array.into())?;

    // History groups
    let hg_array = js_sys::Array::new_with_length(payload.history_groups.len() as u32);
    for (i, group) in payload.history_groups.iter().enumerate() {
        let group_obj = js_sys::Object::new();
        set_prop(&group_obj, "hex", &JsValue::from_str(&group.hex))?;

        let points_array = js_sys::Array::new_with_length(group.points.len() as u32);
        for (j, pt) in group.points.iter().enumerate() {
            let pt_obj = js_sys::Object::new();
            set_prop(&pt_obj, "lat", &JsValue::from(pt.lat))?;
            set_prop(&pt_obj, "lon", &JsValue::from(pt.lon))?;
            set_prop(&pt_obj, "altitudeFeet", &JsValue::from(pt.altitude_feet))?;
            set_prop(&pt_obj, "timestampMs", &JsValue::from(pt.timestamp_ms as f64))?;
            points_array.set(j as u32, pt_obj.into());
        }
        set_prop(&group_obj, "points", &points_array.into())?;
        hg_array.set(i as u32, group_obj.into());
    }
    set_prop(&obj, "historyGroups", &hg_array.into())?;

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// MRMS Preprocess — prepare_volume
// ---------------------------------------------------------------------------

/// Filter, curvature-correct, and declutter an MRMS decoded volume.
///
/// Accepts raw SoA arrays (matching the decode output) plus configuration params.
///
/// NOTE: `min_dbz_tenths` is in tenths of dBZ (e.g. 50 = 5.0 dBZ). The TS caller
/// passes whole dBZ and must multiply by 10 before calling this function.
///
/// `phase_mode`: 0 = Altitude, 1 = Surface.
/// `declutter_mode`: 0 = All, 1 = Low, 2 = Mid, 3 = High.
#[wasm_bindgen]
pub fn prepare_mrms_volume(
    x_nm: &[f32],
    z_nm: &[f32],
    bottom_feet: &[u16],
    top_feet: &[u16],
    dbz_tenths: &[i16],
    phase: &[u8],
    surface_phase: &[u8],
    footprint_x_span: &[u16],
    footprint_y_span: &[u16],
    footprint_x_nm: f32,
    footprint_y_nm: f32,
    layer_count: u16,
    layer_voxel_counts: &[u32],
    min_dbz_tenths: i16,
    phase_mode: u8,
    declutter_mode: u8,
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> Result<JsValue, JsValue> {
    let voxel_count = x_nm.len() as u32;

    // Reconstruct DecodedMrmsVolume from slices
    let volume = crate::types::DecodedMrmsVolume {
        version: crate::types::MRMS_WIRE_VERSION,
        voxel_count,
        layer_count,
        generated_at_ms: 0,
        scan_time_ms: 0,
        footprint_x_nm,
        footprint_y_nm,
        layer_voxel_counts: layer_voxel_counts.to_vec(),
        x_nm: x_nm.to_vec(),
        z_nm: z_nm.to_vec(),
        bottom_feet: bottom_feet.to_vec(),
        top_feet: top_feet.to_vec(),
        dbz_tenths: dbz_tenths.to_vec(),
        phase: phase.to_vec(),
        surface_phase: surface_phase.to_vec(),
        footprint_x_span: footprint_x_span.to_vec(),
        footprint_y_span: footprint_y_span.to_vec(),
    };

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

    let prepared =
        crate::mrms_preprocess::prepare_volume(&volume, min_dbz_tenths, pm, dm, apply_earth_curvature, ref_lat);

    let obj = js_sys::Object::new();
    set_prop(&obj, "validCount", &JsValue::from(prepared.valid_count as u32))?;
    set_prop(&obj, "validIndices", &js_sys::Int32Array::from(&prepared.valid_indices[..]).into())?;
    set_prop(&obj, "yBase", &js_sys::Float32Array::from(&prepared.y_base[..]).into())?;
    set_prop(&obj, "heightBase", &js_sys::Float32Array::from(&prepared.height_base[..]).into())?;
    set_prop(&obj, "correctedBottomFeet", &js_sys::Float32Array::from(&prepared.corrected_bottom_feet[..]).into())?;
    set_prop(&obj, "correctedTopFeet", &js_sys::Float32Array::from(&prepared.corrected_top_feet[..]).into())?;
    set_prop(&obj, "effectivePhaseCode", &js_sys::Uint8Array::from(&prepared.effective_phase_code[..]).into())?;
    set_prop(&obj, "declutterIndices", &js_sys::Int32Array::from(&prepared.declutter_indices[..]).into())?;
    set_prop(&obj, "declutterCount", &JsValue::from(prepared.declutter_count as u32))?;

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// MRMS Preprocess — cross section
// ---------------------------------------------------------------------------

/// Build a 2D cross-section grid from a prepared volume along a given slice axis.
///
/// Accepts raw volume arrays, prepared volume arrays, and slice parameters.
/// Returns null if the cross-section cannot be built (empty volume).
#[wasm_bindgen]
pub fn build_mrms_cross_section(
    // Volume arrays (raw decode output)
    x_nm: &[f32],
    z_nm: &[f32],
    bottom_feet: &[u16],
    top_feet: &[u16],
    dbz_tenths: &[i16],
    phase: &[u8],
    surface_phase: &[u8],
    footprint_x_span: &[u16],
    footprint_y_span: &[u16],
    footprint_x_nm: f32,
    footprint_y_nm: f32,
    layer_count: u16,
    layer_voxel_counts: &[u32],
    // Prepared volume arrays
    valid_count: u32,
    valid_indices: &[i32],
    corrected_bottom_feet: &[f32],
    corrected_top_feet: &[f32],
    effective_phase_code: &[u8],
    // Slice parameters
    slice_axis_x: f64,
    slice_axis_z: f64,
    slice_perp_x: f64,
    slice_perp_z: f64,
    normalized_range: f64,
    half_width_nm: f64,
) -> Result<JsValue, JsValue> {
    let voxel_count = x_nm.len() as u32;

    // Reconstruct DecodedMrmsVolume from slices
    let volume = crate::types::DecodedMrmsVolume {
        version: crate::types::MRMS_WIRE_VERSION,
        voxel_count,
        layer_count,
        generated_at_ms: 0,
        scan_time_ms: 0,
        footprint_x_nm,
        footprint_y_nm,
        layer_voxel_counts: layer_voxel_counts.to_vec(),
        x_nm: x_nm.to_vec(),
        z_nm: z_nm.to_vec(),
        bottom_feet: bottom_feet.to_vec(),
        top_feet: top_feet.to_vec(),
        dbz_tenths: dbz_tenths.to_vec(),
        phase: phase.to_vec(),
        surface_phase: surface_phase.to_vec(),
        footprint_x_span: footprint_x_span.to_vec(),
        footprint_y_span: footprint_y_span.to_vec(),
    };

    // Reconstruct PreparedVolume from slices
    let prepared = crate::types::PreparedVolume {
        valid_count: valid_count as usize,
        valid_indices: valid_indices.to_vec(),
        y_base: Vec::new(),         // not used by build_cross_section
        height_base: Vec::new(),     // not used by build_cross_section
        corrected_bottom_feet: corrected_bottom_feet.to_vec(),
        corrected_top_feet: corrected_top_feet.to_vec(),
        effective_phase_code: effective_phase_code.to_vec(),
        declutter_indices: Vec::new(), // not used by build_cross_section
        declutter_count: 0,            // not used by build_cross_section
    };

    let result = crate::mrms_preprocess::build_cross_section(
        &volume,
        &prepared,
        (slice_axis_x, slice_axis_z),
        (slice_perp_x, slice_perp_z),
        normalized_range,
        half_width_nm,
    );

    match result {
        None => Ok(JsValue::NULL),
        Some(cs) => {
            let obj = js_sys::Object::new();
            set_prop(&obj, "binsX", &JsValue::from(cs.bins_x as u32))?;
            set_prop(&obj, "binsY", &JsValue::from(cs.bins_y as u32))?;
            set_prop(&obj, "grid", &js_sys::Float32Array::from(&cs.grid[..]).into())?;

            // phase_grid is Vec<i8>: Int8Array::from expects &[i8]
            set_prop(&obj, "phaseGrid", &js_sys::Int8Array::from(&cs.phase_grid[..]).into())?;

            set_prop(&obj, "topEnvelopeFeet", &js_sys::Float32Array::from(&cs.top_envelope_feet[..]).into())?;
            set_prop(&obj, "maxTopFeet", &JsValue::from(cs.max_top_feet))?;

            Ok(obj.into())
        }
    }
}

// ---------------------------------------------------------------------------
// MRMS Preprocess — echo-top surfaces
// ---------------------------------------------------------------------------

/// Build echo-top surfaces from typed echo-top input arrays.
#[wasm_bindgen]
pub fn prepare_echo_top_surfaces(
    x_nm: &[f32],
    z_nm: &[f32],
    top18_feet: &[f32],
    top30_feet: &[f32],
    top50_feet: &[f32],
    footprint_x_nm: f32,
    footprint_y_nm: f32,
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> Result<JsValue, JsValue> {
    let input = crate::mrms_preprocess::EchoTopInput {
        x_nm: x_nm.to_vec(),
        z_nm: z_nm.to_vec(),
        top18_feet: top18_feet.to_vec(),
        top30_feet: top30_feet.to_vec(),
        top50_feet: top50_feet.to_vec(),
        footprint_x_nm,
        footprint_y_nm,
    };

    let surfaces = crate::mrms_preprocess::prepare_echo_top_surfaces(&input, apply_earth_curvature, ref_lat);

    let obj = js_sys::Object::new();

    set_prop(&obj, "top18", &echo_top_cells_to_js(&surfaces.top18)?)?;
    set_prop(&obj, "top30", &echo_top_cells_to_js(&surfaces.top30)?)?;
    set_prop(&obj, "top50", &echo_top_cells_to_js(&surfaces.top50)?)?;

    Ok(obj.into())
}

/// Convert a Vec of EchoTopSurfaceCell into a JS object with SoA typed arrays.
fn echo_top_cells_to_js(
    cells: &[crate::mrms_preprocess::EchoTopSurfaceCell],
) -> Result<JsValue, JsValue> {
    let count = cells.len();
    let mut x = Vec::with_capacity(count);
    let mut z = Vec::with_capacity(count);
    let mut y_base = Vec::with_capacity(count);
    let mut fp_x = Vec::with_capacity(count);
    let mut fp_y = Vec::with_capacity(count);

    for cell in cells {
        x.push(cell.x);
        z.push(cell.z);
        y_base.push(cell.y_base);
        fp_x.push(cell.footprint_x_nm);
        fp_y.push(cell.footprint_y_nm);
    }

    let obj = js_sys::Object::new();
    set_prop(&obj, "count", &JsValue::from(count as u32))?;
    set_prop(&obj, "x", &js_sys::Float32Array::from(&x[..]).into())?;
    set_prop(&obj, "z", &js_sys::Float32Array::from(&z[..]).into())?;
    set_prop(&obj, "yBase", &js_sys::Float32Array::from(&y_base[..]).into())?;
    set_prop(&obj, "footprintXNm", &js_sys::Float32Array::from(&fp_x[..]).into())?;
    set_prop(&obj, "footprintYNm", &js_sys::Float32Array::from(&fp_y[..]).into())?;

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// MRMS Echo-Top — binary decode + prepare (single boundary crossing)
// ---------------------------------------------------------------------------

/// Decode an AVET binary echo-top payload and build prepared surfaces in one WASM call.
///
/// Returns `{ top18, top30, top50, summary }` where each top is an SoA typed-array
/// object from `echo_top_cells_to_js` and `summary` contains passthrough metadata.
#[wasm_bindgen]
pub fn decode_and_prepare_echo_top(
    data: &[u8],
    apply_earth_curvature: bool,
    ref_lat: f64,
) -> Result<JsValue, JsValue> {
    let decoded = crate::echo_top_wire_codec::decode_echo_top_binary(data)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Convert u16 feet to f32 for prepare_echo_top_surfaces
    let top18_f32: Vec<f32> = decoded.top18_feet.iter().map(|&v| v as f32).collect();
    let top30_f32: Vec<f32> = decoded.top30_feet.iter().map(|&v| v as f32).collect();
    let top50_f32: Vec<f32> = decoded.top50_feet.iter().map(|&v| v as f32).collect();

    let input = crate::mrms_preprocess::EchoTopInput {
        x_nm: decoded.x_nm,
        z_nm: decoded.z_nm,
        top18_feet: top18_f32,
        top30_feet: top30_f32,
        top50_feet: top50_f32,
        footprint_x_nm: decoded.footprint_x_nm,
        footprint_y_nm: decoded.footprint_y_nm,
    };

    let surfaces =
        crate::mrms_preprocess::prepare_echo_top_surfaces(&input, apply_earth_curvature, ref_lat);

    let root = js_sys::Object::new();
    set_prop(&root, "top18", &echo_top_cells_to_js(&surfaces.top18)?)?;
    set_prop(&root, "top30", &echo_top_cells_to_js(&surfaces.top30)?)?;
    set_prop(&root, "top50", &echo_top_cells_to_js(&surfaces.top50)?)?;

    let summary_obj = js_sys::Object::new();
    set_prop(&summary_obj, "sourceCellCount", &JsValue::from(decoded.source_cell_count))?;
    set_prop(&summary_obj, "maxTop18Feet", &option_u16_to_js(decoded.max_top18_feet))?;
    set_prop(&summary_obj, "maxTop30Feet", &option_u16_to_js(decoded.max_top30_feet))?;
    set_prop(&summary_obj, "maxTop50Feet", &option_u16_to_js(decoded.max_top50_feet))?;
    set_prop(&summary_obj, "maxTop60Feet", &option_u16_to_js(decoded.max_top60_feet))?;
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
    /// Returns a JS object with `{ trackCount: number, fetchedAtMs: number }`.
    pub fn merge(
        &mut self,
        data: &[u8],
        now_ms: f64,
        history_minutes: f64,
        hide_ground: bool,
        backfill_data: &[u8],
    ) -> Result<JsValue, JsValue> {
        let now_ms_i64 = now_ms as i64;

        // Decode main payload
        let payload = crate::traffic_codec::decode_traffic_binary(data)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        // Decode backfill payload (if non-empty)
        let backfill_payload = if !backfill_data.is_empty() {
            Some(
                crate::traffic_codec::decode_traffic_binary(backfill_data)
                    .map_err(|e| JsValue::from_str(&format!("backfill decode error: {e}")))?,
            )
        } else {
            None
        };

        // Convert decoded aircraft to MergeAircraft
        let merge_aircraft: Vec<crate::traffic_merge::MergeAircraft> = payload
            .aircraft
            .iter()
            .map(|ac| crate::traffic_merge::MergeAircraft {
                hex: ac.hex.clone(),
                lat: ac.lat as f64,
                lon: ac.lon as f64,
                altitude_feet: ac.altitude_feet.map(|v| v as f64),
                ground_speed_kt: ac.ground_speed_kt.map(|v| v as f64),
                track_deg: ac.track_deg.map(|v| v as f64),
                flight: ac.flight.clone(),
                is_on_ground: ac.is_on_ground,
                last_seen_seconds: ac.last_seen_seconds.map(|v| v as f64),
            })
            .collect();

        // Build backfill history from both payloads' history groups
        let mut backfill_history: Vec<crate::traffic_merge::BackfillHistory> = Vec::new();

        // Add history from main payload
        for group in &payload.history_groups {
            backfill_history.push(crate::traffic_merge::BackfillHistory {
                hex: group.hex.clone(),
                points: group
                    .points
                    .iter()
                    .map(|p| crate::traffic_merge::TrafficHistoryPoint {
                        lat: p.lat as f64,
                        lon: p.lon as f64,
                        altitude_feet: p.altitude_feet as f64,
                        timestamp_ms: p.timestamp_ms,
                    })
                    .collect(),
            });
        }

        // Add history from backfill payload
        if let Some(bp) = &backfill_payload {
            for group in &bp.history_groups {
                backfill_history.push(crate::traffic_merge::BackfillHistory {
                    hex: group.hex.clone(),
                    points: group
                        .points
                        .iter()
                        .map(|p| crate::traffic_merge::TrafficHistoryPoint {
                            lat: p.lat as f64,
                            lon: p.lon as f64,
                            altitude_feet: p.altitude_feet as f64,
                            timestamp_ms: p.timestamp_ms,
                        })
                        .collect(),
                });
            }
        }

        self.inner
            .merge(&merge_aircraft, now_ms_i64, history_minutes, hide_ground, &backfill_history);

        let obj = js_sys::Object::new();
        set_prop(&obj, "trackCount", &JsValue::from(self.inner.track_count() as u32))?;
        set_prop(&obj, "fetchedAtMs", &JsValue::from(payload.fetched_at_ms as f64))?;
        set_prop(
            &obj,
            "source",
            &match &payload.source {
                Some(s) => JsValue::from_str(s),
                None => JsValue::NULL,
            },
        )?;
        set_prop(
            &obj,
            "error",
            &match &payload.error {
                Some(s) => JsValue::from_str(s),
                None => JsValue::NULL,
            },
        )?;

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

    /// Merge pre-decoded aircraft + history into the state (for JSON/ingest paths).
    ///
    /// `aircraft_js`: JS Array of `{ hex, lat, lon, altitudeFeet?, groundSpeedKt?, trackDeg?, flight?, isOnGround, lastSeenSeconds? }`
    /// `history_js`: JS object `Record<string, Array<{ lat, lon, altitudeFeet, timestampMs }>>` or null/undefined.
    ///
    /// Returns `{ trackCount: number }`.
    pub fn merge_decoded(
        &mut self,
        aircraft_js: &JsValue,
        history_js: &JsValue,
        now_ms: f64,
        history_minutes: f64,
        hide_ground: bool,
    ) -> Result<JsValue, JsValue> {
        let now_ms_i64 = now_ms as i64;

        // Convert aircraft JS array to Vec<MergeAircraft>.
        let ac_array: js_sys::Array = aircraft_js.clone().dyn_into()
            .map_err(|_| JsValue::from_str("aircraft must be an array"))?;
        let mut merge_aircraft: Vec<crate::traffic_merge::MergeAircraft> =
            Vec::with_capacity(ac_array.length() as usize);
        for i in 0..ac_array.length() {
            let ac = ac_array.get(i);
            let hex = js_sys::Reflect::get(&ac, &JsValue::from_str("hex"))
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_default();
            let lat = js_sys::Reflect::get(&ac, &JsValue::from_str("lat"))
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let lon = js_sys::Reflect::get(&ac, &JsValue::from_str("lon"))
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let altitude_feet = js_sys::Reflect::get(&ac, &JsValue::from_str("altitudeFeet"))
                .ok()
                .and_then(|v| v.as_f64());
            let ground_speed_kt =
                js_sys::Reflect::get(&ac, &JsValue::from_str("groundSpeedKt"))
                    .ok()
                    .and_then(|v| v.as_f64());
            let track_deg = js_sys::Reflect::get(&ac, &JsValue::from_str("trackDeg"))
                .ok()
                .and_then(|v| v.as_f64());
            let flight = js_sys::Reflect::get(&ac, &JsValue::from_str("flight"))
                .ok()
                .and_then(|v| v.as_string());
            let is_on_ground =
                js_sys::Reflect::get(&ac, &JsValue::from_str("isOnGround"))
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            let last_seen_seconds =
                js_sys::Reflect::get(&ac, &JsValue::from_str("lastSeenSeconds"))
                    .ok()
                    .and_then(|v| v.as_f64());

            merge_aircraft.push(crate::traffic_merge::MergeAircraft {
                hex,
                lat,
                lon,
                altitude_feet,
                ground_speed_kt,
                track_deg,
                flight,
                is_on_ground,
                last_seen_seconds,
            });
        }

        // Convert history JS object to Vec<BackfillHistory>.
        let mut backfill_history: Vec<crate::traffic_merge::BackfillHistory> = Vec::new();
        if !history_js.is_null() && !history_js.is_undefined() {
            let keys = js_sys::Object::keys(&history_js.clone().unchecked_into::<js_sys::Object>());
            for i in 0..keys.length() {
                let hex_key = keys.get(i);
                let hex = hex_key.as_string().unwrap_or_default();
                let points_js = js_sys::Reflect::get(history_js, &hex_key)
                    .unwrap_or(JsValue::NULL);
                if js_sys::Array::is_array(&points_js) {
                    let points_array = js_sys::Array::from(&points_js);
                    let mut points: Vec<crate::traffic_merge::TrafficHistoryPoint> =
                        Vec::with_capacity(points_array.length() as usize);
                    for j in 0..points_array.length() {
                        let pt = points_array.get(j);
                        let lat =
                            js_sys::Reflect::get(&pt, &JsValue::from_str("lat"))
                                .ok()
                                .and_then(|v| v.as_f64())
                                .filter(|v| v.is_finite());
                        let lon =
                            js_sys::Reflect::get(&pt, &JsValue::from_str("lon"))
                                .ok()
                                .and_then(|v| v.as_f64())
                                .filter(|v| v.is_finite());
                        let altitude_feet =
                            js_sys::Reflect::get(&pt, &JsValue::from_str("altitudeFeet"))
                                .ok()
                                .and_then(|v| v.as_f64())
                                .filter(|v| v.is_finite());
                        let timestamp_ms =
                            js_sys::Reflect::get(&pt, &JsValue::from_str("timestampMs"))
                                .ok()
                                .and_then(|v| v.as_f64())
                                .filter(|v| v.is_finite());
                        // Skip points with any missing/non-finite field (matches old TS behavior)
                        let (Some(lat), Some(lon), Some(alt), Some(ts)) =
                            (lat, lon, altitude_feet, timestamp_ms)
                        else {
                            continue;
                        };
                        points.push(crate::traffic_merge::TrafficHistoryPoint {
                            lat,
                            lon,
                            altitude_feet: alt,
                            timestamp_ms: ts as i64,
                        });
                    }
                    backfill_history.push(crate::traffic_merge::BackfillHistory {
                        hex,
                        points,
                    });
                }
            }
        }

        self.inner.merge(
            &merge_aircraft,
            now_ms_i64,
            history_minutes,
            hide_ground,
            &backfill_history,
        );

        let obj = js_sys::Object::new();
        set_prop(
            &obj,
            "trackCount",
            &JsValue::from(self.inner.track_count() as u32),
        )?;
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

// ---------------------------------------------------------------------------
// Coordinate Helpers
// ---------------------------------------------------------------------------

/// Convert (lat, lon) to local scene coordinates relative to a reference point.
///
/// Returns a Float64Array of `[x, z]` where x = east (NM), z = -north (NM).
#[wasm_bindgen]
pub fn wasm_lat_lon_to_local(lat: f64, lon: f64, ref_lat: f64, ref_lon: f64) -> Box<[f64]> {
    let (x, z) = crate::coords::lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    Box::new([x, z])
}

/// Scale an altitude in feet to scene Y units.
#[wasm_bindgen]
pub fn wasm_alt_to_y(alt_feet: f64, vertical_scale: f64) -> f64 {
    crate::coords::alt_to_y(alt_feet, vertical_scale)
}

/// Approximate earth-curvature sag at a horizontal range, in nautical miles.
#[wasm_bindgen]
pub fn wasm_earth_curvature_drop_nm(x_nm: f64, z_nm: f64, ref_lat: f64) -> f64 {
    crate::coords::earth_curvature_drop_nm(x_nm, z_nm, ref_lat)
}

/// WGS84 geocentric radius at the given latitude, in nautical miles.
#[wasm_bindgen]
pub fn wasm_geocentric_radius_nm(latitude_deg: f64) -> f64 {
    crate::coords::geocentric_radius_nm(latitude_deg)
}

/// Projection scale factors at a given latitude, in NM per degree.
///
/// Returns a Float64Array of `[east_nm_per_lon_deg, north_nm_per_lat_deg]`.
#[wasm_bindgen]
pub fn wasm_projection_scales(lat_deg: f64) -> Box<[f64]> {
    let (east, north) = crate::coords::projection_scales_nm_per_degree(lat_deg);
    Box::new([east, north])
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Set a property on a JS object using `Reflect::set`.
fn set_prop(obj: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), value)?;
    Ok(())
}

/// Convert Option<f32> to JsValue (null if None).
fn option_f32_to_js(val: Option<f32>) -> JsValue {
    match val {
        Some(v) => JsValue::from(v),
        None => JsValue::NULL,
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
