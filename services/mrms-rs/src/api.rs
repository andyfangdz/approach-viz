use anyhow::Result;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::cmp::min;
use std::collections::{BTreeMap, HashMap};
use tracing::warn;

use crate::constants::{
    DEFAULT_MAX_RANGE_NM, DEFAULT_MIN_DBZ, MAX_ALLOWED_DBZ, MAX_ALLOWED_RANGE_NM, MIN_ALLOWED_DBZ,
    MIN_ALLOWED_RANGE_NM, WIRE_HEADER_BYTES, WIRE_MAGIC, WIRE_V1_RECORD_BYTES, WIRE_V1_VERSION,
    WIRE_V2_DBZ_QUANT_STEP_TENTHS, WIRE_V2_MAX_SPAN_HIGH_DBZ, WIRE_V2_MAX_SPAN_LOW_DBZ,
    WIRE_V2_MAX_VERTICAL_SPAN, WIRE_V2_RECORD_BYTES, WIRE_V2_VERSION,
};
use crate::types::{AppState, ScanSnapshot};
use crate::utils::{
    clamp, clamp_i64, iso_from_ms, projection_scales_nm_per_degree, round_i16, round_u16,
    shortest_lon_delta_degrees, to_lon360,
};

#[derive(Debug, Deserialize)]
pub(crate) struct VolumeQuery {
    lat: f64,
    lon: f64,
    #[serde(default, rename = "minDbz")]
    min_dbz: Option<f64>,
    #[serde(default, rename = "maxRangeNm")]
    max_range_nm: Option<f64>,
    #[serde(default, rename = "wireVersion")]
    wire_version: Option<u16>,
}

#[derive(Debug, Serialize)]
pub(crate) struct MetaResponse {
    ready: bool,
    #[serde(rename = "generatedAt")]
    generated_at: Option<String>,
    #[serde(rename = "scanTime")]
    scan_time: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "voxelCount")]
    voxel_count: usize,
    #[serde(rename = "tileCount")]
    tile_count: usize,
    #[serde(rename = "layerCount")]
    layer_count: usize,
    #[serde(rename = "phaseMode")]
    phase_mode: Option<String>,
    #[serde(rename = "phaseDetail")]
    phase_detail: Option<String>,
    #[serde(rename = "zdrTimestamp")]
    zdr_timestamp: Option<String>,
    #[serde(rename = "rhohvTimestamp")]
    rhohv_timestamp: Option<String>,
    #[serde(rename = "precipFlagTimestamp")]
    precip_flag_timestamp: Option<String>,
    #[serde(rename = "freezingLevelTimestamp")]
    freezing_level_timestamp: Option<String>,
    #[serde(rename = "zdrAgeSeconds")]
    zdr_age_seconds: Option<i64>,
    #[serde(rename = "rhohvAgeSeconds")]
    rhohv_age_seconds: Option<i64>,
    #[serde(rename = "storageDir")]
    storage_dir: String,
    #[serde(rename = "retentionBytes")]
    retention_bytes: u64,
    #[serde(rename = "sqsEnabled")]
    sqs_enabled: bool,
}

pub async fn healthz() -> &'static str {
    "ok"
}

pub async fn meta(State(state): State<AppState>) -> Json<MetaResponse> {
    let latest = state.latest.read().await;
    let (
        ready,
        generated_at,
        scan_time,
        timestamp,
        voxel_count,
        tile_count,
        layer_count,
        phase_mode,
        phase_detail,
        zdr_timestamp,
        rhohv_timestamp,
        precip_flag_timestamp,
        freezing_level_timestamp,
        zdr_age_seconds,
        rhohv_age_seconds,
    ) = if let Some(scan) = latest.as_ref() {
        (
            true,
            iso_from_ms(scan.generated_at_ms),
            iso_from_ms(scan.scan_time_ms),
            Some(scan.timestamp.clone()),
            scan.voxels.len(),
            scan.tile_offsets.len().saturating_sub(1),
            scan.level_bounds.len(),
            Some(scan.phase_debug.mode.clone()),
            Some(scan.phase_debug.detail.clone()),
            scan.phase_debug.zdr_timestamp.clone(),
            scan.phase_debug.rhohv_timestamp.clone(),
            scan.phase_debug.precip_flag_timestamp.clone(),
            scan.phase_debug.freezing_level_timestamp.clone(),
            scan.phase_debug.zdr_age_seconds,
            scan.phase_debug.rhohv_age_seconds,
        )
    } else {
        (
            false, None, None, None, 0, 0, 0, None, None, None, None, None, None, None, None,
        )
    };

    Json(MetaResponse {
        ready,
        generated_at,
        scan_time,
        timestamp,
        voxel_count,
        tile_count,
        layer_count,
        phase_mode,
        phase_detail,
        zdr_timestamp,
        rhohv_timestamp,
        precip_flag_timestamp,
        freezing_level_timestamp,
        zdr_age_seconds,
        rhohv_age_seconds,
        storage_dir: state.cfg.storage_dir.display().to_string(),
        retention_bytes: state.cfg.retention_bytes,
        sqs_enabled: state.cfg.sqs_queue_url.is_some(),
    })
}

pub async fn volume(State(state): State<AppState>, Query(query): Query<VolumeQuery>) -> Response {
    if query.lat < -90.0 || query.lat > 90.0 || query.lon < -180.0 || query.lon > 180.0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Invalid lat/lon query parameters."
            })),
        )
            .into_response();
    }

    let min_dbz = clamp(
        query.min_dbz.unwrap_or(DEFAULT_MIN_DBZ),
        MIN_ALLOWED_DBZ,
        MAX_ALLOWED_DBZ,
    );
    let max_range_nm = clamp(
        query.max_range_nm.unwrap_or(DEFAULT_MAX_RANGE_NM),
        MIN_ALLOWED_RANGE_NM,
        MAX_ALLOWED_RANGE_NM,
    );

    let latest = state.latest.read().await;
    let Some(scan) = latest.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "No MRMS scan is available yet."
            })),
        )
            .into_response();
    };

    let wire_version = match query.wire_version.unwrap_or(WIRE_V2_VERSION) {
        WIRE_V1_VERSION => WIRE_V1_VERSION,
        _ => WIRE_V2_VERSION,
    };

    match build_volume_wire(
        scan,
        query.lat,
        query.lon,
        min_dbz,
        max_range_nm,
        wire_version,
    ) {
        Ok(body) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                "Content-Type",
                HeaderValue::from_static(if wire_version == WIRE_V2_VERSION {
                    "application/vnd.approach-viz.mrms.v2"
                } else {
                    "application/vnd.approach-viz.mrms.v1"
                }),
            );
            headers.insert("Cache-Control", HeaderValue::from_static("no-store"));
            if let Some(scan_time) = iso_from_ms(scan.scan_time_ms) {
                if let Ok(value) = HeaderValue::from_str(&scan_time) {
                    headers.insert("X-AV-SCAN-TIME", value);
                }
            }
            if let Some(generated_at) = iso_from_ms(scan.generated_at_ms) {
                if let Ok(value) = HeaderValue::from_str(&generated_at) {
                    headers.insert("X-AV-GENERATED-AT", value);
                }
            }
            if !scan.phase_debug.mode.is_empty() {
                if let Ok(value) = HeaderValue::from_str(&scan.phase_debug.mode) {
                    headers.insert("X-AV-PHASE-MODE", value);
                }
            }
            if !scan.phase_debug.detail.is_empty() {
                if let Ok(value) = HeaderValue::from_str(&scan.phase_debug.detail) {
                    headers.insert("X-AV-PHASE-DETAIL", value);
                }
            }
            if let Some(value) = scan.phase_debug.zdr_age_seconds {
                if let Ok(header) = HeaderValue::from_str(&value.to_string()) {
                    headers.insert("X-AV-ZDR-AGE-SECONDS", header);
                }
            }
            if let Some(value) = scan.phase_debug.rhohv_age_seconds {
                if let Ok(header) = HeaderValue::from_str(&value.to_string()) {
                    headers.insert("X-AV-RHOHV-AGE-SECONDS", header);
                }
            }
            if let Some(value) = scan.phase_debug.zdr_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-ZDR-TIMESTAMP", header);
                }
            }
            if let Some(value) = scan.phase_debug.rhohv_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-RHOHV-TIMESTAMP", header);
                }
            }
            if let Some(value) = scan.phase_debug.precip_flag_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-PRECIP-TIMESTAMP", header);
                }
            }
            if let Some(value) = scan.phase_debug.freezing_level_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-FREEZING-TIMESTAMP", header);
                }
            }
            (headers, body).into_response()
        }
        Err(error) => {
            warn!("Failed to build wire payload: {error:#}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to build MRMS volume payload."
                })),
            )
                .into_response()
        }
    }
}

fn build_volume_wire(
    scan: &ScanSnapshot,
    origin_lat: f64,
    origin_lon: f64,
    min_dbz: f64,
    max_range_nm: f64,
    wire_version: u16,
) -> Result<Vec<u8>> {
    let window = build_query_window(scan, origin_lat, origin_lon, min_dbz, max_range_nm);
    if wire_version == WIRE_V1_VERSION {
        return Ok(build_volume_wire_v1(scan, &window));
    }

    Ok(build_volume_wire_v2(scan, &window))
}

#[derive(Clone, Copy)]
struct QueryWindow {
    min_dbz_tenths: i16,
    origin_lat: f64,
    origin_lon: f64,
    origin_lon360: f64,
    max_range_nm: f64,
    max_range_squared_nm: f64,
    east_nm_per_lon_deg_safe: f64,
    north_nm_per_lat_deg_safe: f64,
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    lon_wrapped: bool,
    tile_row_start: u32,
    tile_row_end: u32,
    tile_col_start: u32,
    tile_col_end: u32,
    footprint_x_milli: u16,
    footprint_y_milli: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct MergeKey {
    phase: u8,
    dbz_tenths: i16,
}

#[derive(Clone, Copy, Debug)]
struct MergeCell {
    row: u32,
    col: u32,
    key: MergeKey,
}

#[derive(Clone, Copy, Debug)]
struct RowRun {
    col_start: u32,
    col_end: u32,
    key: MergeKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct RunSignature {
    col_start: u32,
    col_end: u32,
    key: MergeKey,
}

#[derive(Clone, Copy, Debug)]
struct HorizontalRect {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    key: MergeKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct VerticalSignature {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    key: MergeKey,
}

#[derive(Clone, Copy, Debug)]
struct BrickCandidate {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
    level_start: u8,
    level_end: u8,
    key: MergeKey,
}

fn build_query_window(
    scan: &ScanSnapshot,
    origin_lat: f64,
    origin_lon: f64,
    min_dbz: f64,
    max_range_nm: f64,
) -> QueryWindow {
    let min_dbz_tenths = (min_dbz * 10.0).round() as i16;
    let max_range_squared_nm = max_range_nm * max_range_nm;

    let origin_lon360 = to_lon360(origin_lon);
    let (east_nm_per_lon_deg, north_nm_per_lat_deg) = projection_scales_nm_per_degree(origin_lat);
    let east_nm_per_lon_deg_safe = east_nm_per_lon_deg.abs().max(1e-6);
    let north_nm_per_lat_deg_safe = north_nm_per_lat_deg.abs().max(1e-6);

    let lat_padding_deg = max_range_nm / north_nm_per_lat_deg_safe;
    let lon_padding_deg = max_range_nm / east_nm_per_lon_deg_safe;

    let lat_min = origin_lat - lat_padding_deg;
    let lat_max = origin_lat + lat_padding_deg;
    let lon_min360 = origin_lon360 - lon_padding_deg;
    let lon_max360 = origin_lon360 + lon_padding_deg;
    let lon_wrapped = lon_min360 < 0.0 || lon_max360 >= 360.0;

    let row_from_lat = |lat: f64| (lat - scan.grid.la1_deg) / scan.grid.lat_step_deg;
    let row_start = clamp_i64(
        (row_from_lat(lat_min).min(row_from_lat(lat_max)) - 1.0).floor() as i64,
        0,
        scan.grid.ny as i64 - 1,
    ) as u32;
    let row_end = clamp_i64(
        (row_from_lat(lat_min).max(row_from_lat(lat_max)) + 1.0).ceil() as i64,
        0,
        scan.grid.ny as i64 - 1,
    ) as u32;

    let (col_start, col_end) = if lon_wrapped {
        (0_u32, scan.grid.nx - 1)
    } else {
        let col_from_lon = |lon: f64| (lon - scan.grid.lo1_deg360) / scan.grid.lon_step_deg;
        let start = clamp_i64(
            (col_from_lon(lon_min360).min(col_from_lon(lon_max360)) - 1.0).floor() as i64,
            0,
            scan.grid.nx as i64 - 1,
        ) as u32;
        let end = clamp_i64(
            (col_from_lon(lon_min360).max(col_from_lon(lon_max360)) + 1.0).ceil() as i64,
            0,
            scan.grid.nx as i64 - 1,
        ) as u32;
        (start, end)
    };

    let tile_size = scan.tile_size as u32;
    let tile_row_start = row_start / tile_size;
    let tile_row_end = row_end / tile_size;
    let tile_col_start = if lon_wrapped {
        0
    } else {
        col_start / tile_size
    };
    let tile_col_end = if lon_wrapped {
        scan.tile_cols as u32 - 1
    } else {
        col_end / tile_size
    };

    let footprint_x_milli = round_u16(scan.grid.di_deg.abs() * east_nm_per_lon_deg_safe * 1000.0);
    let footprint_y_milli = round_u16(scan.grid.dj_deg.abs() * north_nm_per_lat_deg_safe * 1000.0);

    QueryWindow {
        min_dbz_tenths,
        origin_lat,
        origin_lon,
        origin_lon360,
        max_range_nm,
        max_range_squared_nm,
        east_nm_per_lon_deg_safe,
        north_nm_per_lat_deg_safe,
        row_start,
        row_end,
        col_start,
        col_end,
        lon_wrapped,
        tile_row_start,
        tile_row_end,
        tile_col_start,
        tile_col_end,
        footprint_x_milli,
        footprint_y_milli,
    }
}

fn build_wire_header(
    scan: &ScanSnapshot,
    window: &QueryWindow,
    wire_version: u16,
    record_bytes: u16,
    encoding_hint: u16,
) -> Vec<u8> {
    let mut body = vec![0_u8; WIRE_HEADER_BYTES + scan.level_bounds.len() * 4];
    body[0..4].copy_from_slice(&WIRE_MAGIC);
    body[4..6].copy_from_slice(&wire_version.to_le_bytes());
    body[6..8].copy_from_slice(&(WIRE_HEADER_BYTES as u16).to_le_bytes());
    body[8..12].copy_from_slice(&0_u32.to_le_bytes());
    body[12..16].copy_from_slice(&0_u32.to_le_bytes());
    body[16..18].copy_from_slice(&(scan.level_bounds.len() as u16).to_le_bytes());
    body[18..20].copy_from_slice(&record_bytes.to_le_bytes());
    body[20..28].copy_from_slice(&scan.generated_at_ms.to_le_bytes());
    body[28..36].copy_from_slice(&scan.scan_time_ms.to_le_bytes());
    body[36..38].copy_from_slice(&window.footprint_x_milli.to_le_bytes());
    body[38..40].copy_from_slice(&window.footprint_y_milli.to_le_bytes());
    body[40..42].copy_from_slice(&window.min_dbz_tenths.to_le_bytes());
    body[42..44].copy_from_slice(&round_u16(window.max_range_nm * 10.0).to_le_bytes());
    body[44..46].copy_from_slice(&scan.tile_size.to_le_bytes());
    body[46..48].copy_from_slice(&encoding_hint.to_le_bytes());
    body[48..52].copy_from_slice(&((window.origin_lat * 1_000_000.0).round() as i32).to_le_bytes());
    body[52..56].copy_from_slice(&((window.origin_lon * 1_000_000.0).round() as i32).to_le_bytes());
    body
}

fn project_grid_position_nm(
    scan: &ScanSnapshot,
    window: &QueryWindow,
    row: f64,
    col: f64,
) -> (f64, f64) {
    let lat_deg = scan.grid.la1_deg + row * scan.grid.lat_step_deg;
    let lon_deg360 = to_lon360(scan.grid.lo1_deg360 + col * scan.grid.lon_step_deg);
    let delta_lon_deg = shortest_lon_delta_degrees(lon_deg360, window.origin_lon360);
    let x_nm = delta_lon_deg * window.east_nm_per_lon_deg_safe;
    let z_nm = -(lat_deg - window.origin_lat) * window.north_nm_per_lat_deg_safe;
    (x_nm, z_nm)
}

fn build_volume_wire_v1(scan: &ScanSnapshot, window: &QueryWindow) -> Vec<u8> {
    let mut body = build_wire_header(
        scan,
        window,
        WIRE_V1_VERSION,
        WIRE_V1_RECORD_BYTES as u16,
        0_u16,
    );

    let layer_counts_offset = WIRE_HEADER_BYTES;
    let mut layer_counts = vec![0_u32; scan.level_bounds.len()];
    let mut voxel_count: u32 = 0;

    for tile_row in window.tile_row_start..=window.tile_row_end {
        for tile_col in window.tile_col_start..=window.tile_col_end {
            let tile_idx = (tile_row * scan.tile_cols as u32 + tile_col) as usize;
            if tile_idx + 1 >= scan.tile_offsets.len() {
                continue;
            }
            let start = scan.tile_offsets[tile_idx] as usize;
            let end = scan.tile_offsets[tile_idx + 1] as usize;
            for record in &scan.voxels[start..end] {
                let row = record.row as u32;
                let col = record.col as u32;
                if row < window.row_start || row > window.row_end {
                    continue;
                }
                if !window.lon_wrapped && (col < window.col_start || col > window.col_end) {
                    continue;
                }
                if record.dbz_tenths < window.min_dbz_tenths {
                    continue;
                }

                let (x_nm, z_nm) = project_grid_position_nm(scan, window, row as f64, col as f64);
                if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
                    continue;
                }

                let level_idx = record.level_idx as usize;
                let Some(level_bounds) = scan.level_bounds.get(level_idx) else {
                    continue;
                };

                body.extend_from_slice(&round_i16(x_nm * 100.0).to_le_bytes());
                body.extend_from_slice(&round_i16(z_nm * 100.0).to_le_bytes());
                body.extend_from_slice(&level_bounds.bottom_feet.to_le_bytes());
                body.extend_from_slice(&level_bounds.top_feet.to_le_bytes());
                body.extend_from_slice(&record.dbz_tenths.to_le_bytes());
                body.push(record.phase);
                body.push(record.level_idx);

                layer_counts[level_idx] = layer_counts[level_idx].saturating_add(1);
                voxel_count = voxel_count.saturating_add(1);
            }
        }
    }

    body[12..16].copy_from_slice(&voxel_count.to_le_bytes());
    for (idx, count) in layer_counts.iter().enumerate() {
        let offset = layer_counts_offset + idx * 4;
        body[offset..offset + 4].copy_from_slice(&count.to_le_bytes());
    }

    body
}

fn build_volume_wire_v2(scan: &ScanSnapshot, window: &QueryWindow) -> Vec<u8> {
    let mut body = build_wire_header(
        scan,
        window,
        WIRE_V2_VERSION,
        WIRE_V2_RECORD_BYTES as u16,
        WIRE_V2_DBZ_QUANT_STEP_TENTHS as u16,
    );

    let layer_counts_offset = WIRE_HEADER_BYTES;
    let mut layer_counts = vec![0_u32; scan.level_bounds.len()];
    let mut source_voxel_count: u32 = 0;
    let mut cells_by_level: Vec<Vec<MergeCell>> = vec![Vec::new(); scan.level_bounds.len()];

    for tile_row in window.tile_row_start..=window.tile_row_end {
        for tile_col in window.tile_col_start..=window.tile_col_end {
            let tile_idx = (tile_row * scan.tile_cols as u32 + tile_col) as usize;
            if tile_idx + 1 >= scan.tile_offsets.len() {
                continue;
            }
            let start = scan.tile_offsets[tile_idx] as usize;
            let end = scan.tile_offsets[tile_idx + 1] as usize;
            for record in &scan.voxels[start..end] {
                let row = record.row as u32;
                let col = record.col as u32;
                if row < window.row_start || row > window.row_end {
                    continue;
                }
                if !window.lon_wrapped && (col < window.col_start || col > window.col_end) {
                    continue;
                }
                if record.dbz_tenths < window.min_dbz_tenths {
                    continue;
                }

                let (x_nm, z_nm) = project_grid_position_nm(scan, window, row as f64, col as f64);
                if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
                    continue;
                }

                let level_idx = record.level_idx as usize;
                if level_idx >= cells_by_level.len() {
                    continue;
                }
                layer_counts[level_idx] = layer_counts[level_idx].saturating_add(1);
                source_voxel_count = source_voxel_count.saturating_add(1);
                cells_by_level[level_idx].push(MergeCell {
                    row,
                    col,
                    key: MergeKey {
                        phase: record.phase,
                        dbz_tenths: quantize_dbz_tenths(
                            record.dbz_tenths,
                            WIRE_V2_DBZ_QUANT_STEP_TENTHS,
                        ),
                    },
                });
            }
        }
    }

    let mut rectangles_by_level: Vec<Vec<HorizontalRect>> =
        Vec::with_capacity(cells_by_level.len());
    for cells in &mut cells_by_level {
        let mut rectangles = build_level_rectangles(cells);
        let mut split_rectangles: Vec<HorizontalRect> = Vec::with_capacity(rectangles.len());
        for rect in rectangles.drain(..) {
            let max_span = max_span_for_dbz(rect.key.dbz_tenths);
            split_rectangle(rect, max_span, &mut split_rectangles);
        }
        rectangles_by_level.push(split_rectangles);
    }

    let mut active: HashMap<VerticalSignature, usize> = HashMap::new();
    let mut merged_bricks: Vec<BrickCandidate> = Vec::new();

    for (level_idx, rectangles) in rectangles_by_level.iter().enumerate() {
        let mut next_active: HashMap<VerticalSignature, usize> = HashMap::new();
        for rect in rectangles {
            let signature = VerticalSignature {
                row_start: rect.row_start,
                row_end: rect.row_end,
                col_start: rect.col_start,
                col_end: rect.col_end,
                key: rect.key,
            };

            let mut extended = false;
            if let Some(existing_idx) = active.remove(&signature) {
                let current = merged_bricks[existing_idx];
                let next_vertical_span = level_idx as u16 - current.level_start as u16 + 1_u16;
                if current.level_end as usize + 1 == level_idx
                    && next_vertical_span <= WIRE_V2_MAX_VERTICAL_SPAN
                {
                    let prev_bounds = scan.level_bounds[current.level_end as usize];
                    let next_bounds = scan.level_bounds[level_idx];
                    if next_bounds.bottom_feet <= prev_bounds.top_feet.saturating_add(1) {
                        merged_bricks[existing_idx].level_end = level_idx as u8;
                        next_active.insert(signature, existing_idx);
                        extended = true;
                    }
                }
            }

            if !extended {
                let new_idx = merged_bricks.len();
                merged_bricks.push(BrickCandidate {
                    row_start: rect.row_start,
                    row_end: rect.row_end,
                    col_start: rect.col_start,
                    col_end: rect.col_end,
                    level_start: level_idx as u8,
                    level_end: level_idx as u8,
                    key: rect.key,
                });
                next_active.insert(signature, new_idx);
            }
        }
        active = next_active;
    }

    let mut brick_count: u32 = 0;
    for brick in merged_bricks {
        let level_start_idx = brick.level_start as usize;
        let level_end_idx = brick.level_end as usize;
        let Some(level_start_bounds) = scan.level_bounds.get(level_start_idx) else {
            continue;
        };
        let Some(level_end_bounds) = scan.level_bounds.get(level_end_idx) else {
            continue;
        };

        let center_row = (brick.row_start as f64 + brick.row_end as f64) * 0.5;
        let center_col = (brick.col_start as f64 + brick.col_end as f64) * 0.5;
        let (x_nm, z_nm) = project_grid_position_nm(scan, window, center_row, center_col);
        if x_nm * x_nm + z_nm * z_nm > window.max_range_squared_nm {
            continue;
        }

        let span_x = (brick.col_end - brick.col_start + 1).min(u16::MAX as u32) as u16;
        let span_y = (brick.row_end - brick.row_start + 1).min(u16::MAX as u32) as u16;
        let span_z = (level_end_idx - level_start_idx + 1).min(u16::MAX as usize) as u16;

        body.extend_from_slice(&round_i16(x_nm * 100.0).to_le_bytes());
        body.extend_from_slice(&round_i16(z_nm * 100.0).to_le_bytes());
        body.extend_from_slice(&level_start_bounds.bottom_feet.to_le_bytes());
        body.extend_from_slice(&level_end_bounds.top_feet.to_le_bytes());
        body.extend_from_slice(&brick.key.dbz_tenths.to_le_bytes());
        body.push(brick.key.phase);
        body.push(brick.level_start);
        body.extend_from_slice(&span_x.to_le_bytes());
        body.extend_from_slice(&span_y.to_le_bytes());
        body.extend_from_slice(&span_z.to_le_bytes());
        body.extend_from_slice(&0_u16.to_le_bytes());
        brick_count = brick_count.saturating_add(1);
    }

    body[8..12].copy_from_slice(&source_voxel_count.to_le_bytes());
    body[12..16].copy_from_slice(&brick_count.to_le_bytes());
    for (idx, count) in layer_counts.iter().enumerate() {
        let offset = layer_counts_offset + idx * 4;
        body[offset..offset + 4].copy_from_slice(&count.to_le_bytes());
    }

    body
}

fn quantize_dbz_tenths(dbz_tenths: i16, step_tenths: i16) -> i16 {
    if step_tenths <= 1 {
        return dbz_tenths;
    }
    let step = step_tenths as i32;
    let value = dbz_tenths as i32;
    let half = step / 2;
    let quantized = if value >= 0 {
        ((value + half) / step) * step
    } else {
        ((value - half) / step) * step
    };
    quantized.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

fn max_span_for_dbz(dbz_tenths: i16) -> u16 {
    if dbz_tenths >= 450 {
        WIRE_V2_MAX_SPAN_HIGH_DBZ.max(1)
    } else {
        WIRE_V2_MAX_SPAN_LOW_DBZ.max(1)
    }
}

fn split_rectangle(rect: HorizontalRect, max_span: u16, out: &mut Vec<HorizontalRect>) {
    let chunk_size = max_span.max(1) as u32;
    let mut row_start = rect.row_start;
    while row_start <= rect.row_end {
        let row_end = min(row_start.saturating_add(chunk_size - 1), rect.row_end);
        let mut col_start = rect.col_start;
        while col_start <= rect.col_end {
            let col_end = min(col_start.saturating_add(chunk_size - 1), rect.col_end);
            out.push(HorizontalRect {
                row_start,
                row_end,
                col_start,
                col_end,
                key: rect.key,
            });
            if col_end == rect.col_end {
                break;
            }
            col_start = col_end.saturating_add(1);
        }
        if row_end == rect.row_end {
            break;
        }
        row_start = row_end.saturating_add(1);
    }
}

fn build_level_rectangles(cells: &mut [MergeCell]) -> Vec<HorizontalRect> {
    if cells.is_empty() {
        return Vec::new();
    }

    cells.sort_unstable_by(|a, b| {
        a.row
            .cmp(&b.row)
            .then(a.col.cmp(&b.col))
            .then(a.key.phase.cmp(&b.key.phase))
            .then(a.key.dbz_tenths.cmp(&b.key.dbz_tenths))
    });

    let mut runs_by_row: BTreeMap<u32, Vec<RowRun>> = BTreeMap::new();
    let mut run_row = cells[0].row;
    let mut run_col_start = cells[0].col;
    let mut run_col_end = cells[0].col;
    let mut run_key = cells[0].key;

    for cell in &cells[1..] {
        if cell.row == run_row && cell.key == run_key {
            if cell.col == run_col_end {
                continue;
            }
            if cell.col == run_col_end.saturating_add(1) {
                run_col_end = cell.col;
                continue;
            }
        }
        runs_by_row.entry(run_row).or_default().push(RowRun {
            col_start: run_col_start,
            col_end: run_col_end,
            key: run_key,
        });
        run_row = cell.row;
        run_col_start = cell.col;
        run_col_end = cell.col;
        run_key = cell.key;
    }

    runs_by_row.entry(run_row).or_default().push(RowRun {
        col_start: run_col_start,
        col_end: run_col_end,
        key: run_key,
    });

    let mut rectangles: Vec<HorizontalRect> = Vec::new();
    let mut active: HashMap<RunSignature, usize> = HashMap::new();
    let mut prev_row: Option<u32> = None;

    for (row, runs) in runs_by_row {
        if let Some(previous_row) = prev_row {
            if row != previous_row.saturating_add(1) {
                active.clear();
            }
        }
        let mut next_active: HashMap<RunSignature, usize> = HashMap::new();
        for run in runs {
            let signature = RunSignature {
                col_start: run.col_start,
                col_end: run.col_end,
                key: run.key,
            };
            if let Some(rect_idx) = active.remove(&signature) {
                rectangles[rect_idx].row_end = row;
                next_active.insert(signature, rect_idx);
            } else {
                let rect_idx = rectangles.len();
                rectangles.push(HorizontalRect {
                    row_start: row,
                    row_end: row,
                    col_start: run.col_start,
                    col_end: run.col_end,
                    key: run.key,
                });
                next_active.insert(signature, rect_idx);
            }
        }
        active = next_active;
        prev_row = Some(row);
    }

    rectangles
}
