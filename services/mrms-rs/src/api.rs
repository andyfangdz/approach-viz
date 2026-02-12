use anyhow::Result;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::constants::{
    DEFAULT_MAX_RANGE_NM, DEFAULT_MIN_DBZ, MAX_ALLOWED_DBZ, MAX_ALLOWED_RANGE_NM, MIN_ALLOWED_DBZ,
    MIN_ALLOWED_RANGE_NM, WIRE_HEADER_BYTES, WIRE_MAGIC, WIRE_VERSION,
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
    let (ready, generated_at, scan_time, timestamp, voxel_count, tile_count, layer_count) =
        if let Some(scan) = latest.as_ref() {
            (
                true,
                iso_from_ms(scan.generated_at_ms),
                iso_from_ms(scan.scan_time_ms),
                Some(scan.timestamp.clone()),
                scan.voxels.len(),
                scan.tile_offsets.len().saturating_sub(1),
                scan.level_bounds.len(),
            )
        } else {
            (false, None, None, None, 0, 0, 0)
        };

    Json(MetaResponse {
        ready,
        generated_at,
        scan_time,
        timestamp,
        voxel_count,
        tile_count,
        layer_count,
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

    match build_volume_wire(scan, query.lat, query.lon, min_dbz, max_range_nm) {
        Ok(body) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                "Content-Type",
                HeaderValue::from_static("application/vnd.approach-viz.mrms.v1"),
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
) -> Result<Vec<u8>> {
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

    let mut body = vec![0_u8; WIRE_HEADER_BYTES + scan.level_bounds.len() * 4];
    body[0..4].copy_from_slice(&WIRE_MAGIC);
    body[4..6].copy_from_slice(&WIRE_VERSION.to_le_bytes());
    body[6..8].copy_from_slice(&(WIRE_HEADER_BYTES as u16).to_le_bytes());
    body[8..12].copy_from_slice(&0_u32.to_le_bytes());
    body[12..16].copy_from_slice(&0_u32.to_le_bytes());
    body[16..18].copy_from_slice(&(scan.level_bounds.len() as u16).to_le_bytes());
    body[18..20].copy_from_slice(&0_u16.to_le_bytes());
    body[20..28].copy_from_slice(&scan.generated_at_ms.to_le_bytes());
    body[28..36].copy_from_slice(&scan.scan_time_ms.to_le_bytes());
    body[36..38].copy_from_slice(&footprint_x_milli.to_le_bytes());
    body[38..40].copy_from_slice(&footprint_y_milli.to_le_bytes());
    body[40..42].copy_from_slice(&min_dbz_tenths.to_le_bytes());
    body[42..44].copy_from_slice(&round_u16(max_range_nm * 10.0).to_le_bytes());
    body[44..46].copy_from_slice(&scan.tile_size.to_le_bytes());
    body[46..48].copy_from_slice(&0_u16.to_le_bytes());
    body[48..52].copy_from_slice(&((origin_lat * 1_000_000.0).round() as i32).to_le_bytes());
    body[52..56].copy_from_slice(&((origin_lon * 1_000_000.0).round() as i32).to_le_bytes());

    let layer_counts_offset = WIRE_HEADER_BYTES;
    let mut layer_counts = vec![0_u32; scan.level_bounds.len()];

    let mut voxel_count: u32 = 0;
    for tile_row in tile_row_start..=tile_row_end {
        for tile_col in tile_col_start..=tile_col_end {
            let tile_idx = (tile_row * scan.tile_cols as u32 + tile_col) as usize;
            if tile_idx + 1 >= scan.tile_offsets.len() {
                continue;
            }
            let start = scan.tile_offsets[tile_idx] as usize;
            let end = scan.tile_offsets[tile_idx + 1] as usize;
            for record in &scan.voxels[start..end] {
                let row = record.row as u32;
                let col = record.col as u32;
                if row < row_start || row > row_end {
                    continue;
                }
                if !lon_wrapped && (col < col_start || col > col_end) {
                    continue;
                }
                if record.dbz_tenths < min_dbz_tenths {
                    continue;
                }

                let lat_deg = scan.grid.la1_deg + row as f64 * scan.grid.lat_step_deg;
                let lon_deg360 =
                    to_lon360(scan.grid.lo1_deg360 + col as f64 * scan.grid.lon_step_deg);
                let delta_lon_deg = shortest_lon_delta_degrees(lon_deg360, origin_lon360);
                let x_nm = delta_lon_deg * east_nm_per_lon_deg_safe;
                let z_nm = -(lat_deg - origin_lat) * north_nm_per_lat_deg_safe;
                if x_nm * x_nm + z_nm * z_nm > max_range_squared_nm {
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

    Ok(body)
}
