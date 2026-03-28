mod discovery;
mod encoding;
mod grib;
mod ingest;
mod phase;
mod phase_batch;
mod processor;
mod projection;
mod simd_lut;
mod sources;
mod storage;

// Re-exports for main.rs
pub use self::ingest::{enqueue_latest_from_s3, run_ingest_profile, spawn_background_workers};
pub use self::storage::load_latest_snapshot;

// Re-exports for benchmarks (not consumed by the binary itself)
#[allow(unused_imports)]
pub use phase::{resolve_thermo_phase, DualPolEvidence, PhaseScores, ThermoPhaseEvidence};
#[allow(unused_imports)]
pub use phase_batch::{compute_phase_scores_branchless, BatchPhaseResult};
#[allow(unused_imports)]
pub use processor::filter_voxels_by_threshold;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::{field, instrument, warn};

use self::encoding::{build_echo_top_cells, build_echo_top_wire_fb, build_volume_wire_fb};
use self::projection::build_query_window;
use crate::constants::{
    DEFAULT_MAX_RANGE_NM, DEFAULT_MIN_DBZ, ECHO_TOP_FB_CONTENT_TYPE,
    MAX_ALLOWED_DBZ, MAX_ALLOWED_RANGE_NM, MIN_ALLOWED_DBZ,
    MIN_ALLOWED_RANGE_NM, VOLUME_FB_CONTENT_TYPE,
};
use crate::types::AppState;
use crate::utils::{clamp, iso_from_ms};

#[derive(Debug, Deserialize)]
pub struct VolumeQuery {
    lat: f64,
    lon: f64,
    #[serde(default, rename = "minDbz")]
    min_dbz: Option<f64>,
    #[serde(default, rename = "maxRangeNm")]
    max_range_nm: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct EchoTopsQuery {
    lat: f64,
    lon: f64,
    #[serde(default, rename = "maxRangeNm")]
    max_range_nm: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct MetaResponse {
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
    #[serde(rename = "echoTopCellCount")]
    echo_top_cell_count: usize,
    #[serde(rename = "echoTop18Timestamp")]
    echo_top18_timestamp: Option<String>,
    #[serde(rename = "echoTop30Timestamp")]
    echo_top30_timestamp: Option<String>,
    #[serde(rename = "echoTop50Timestamp")]
    echo_top50_timestamp: Option<String>,
    #[serde(rename = "echoTop60Timestamp")]
    echo_top60_timestamp: Option<String>,
    #[serde(rename = "echoTop18MaxFeet")]
    echo_top18_max_feet: Option<u16>,
    #[serde(rename = "echoTop30MaxFeet")]
    echo_top30_max_feet: Option<u16>,
    #[serde(rename = "echoTop50MaxFeet")]
    echo_top50_max_feet: Option<u16>,
    #[serde(rename = "echoTop60MaxFeet")]
    echo_top60_max_feet: Option<u16>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EchoTopsResponse {
    generated_at: Option<String>,
    scan_time: Option<String>,
    timestamp: String,
    source_cell_count: usize,
    footprint_x_nm: f64,
    footprint_y_nm: f64,
    max_top18_feet: Option<u16>,
    max_top30_feet: Option<u16>,
    max_top50_feet: Option<u16>,
    max_top60_feet: Option<u16>,
    top18_timestamp: Option<String>,
    top30_timestamp: Option<String>,
    top50_timestamp: Option<String>,
    top60_timestamp: Option<String>,
    cells: Vec<EchoTopCellRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EchoTopCellRecord {
    x_nm: f32,
    z_nm: f32,
    top18_feet: u16,
    top30_feet: u16,
    top50_feet: u16,
    top60_feet: u16,
}

#[instrument(name = "runtime.healthz", skip_all)]
pub async fn healthz() -> &'static str {
    "ok"
}

#[instrument(name = "runtime.meta", skip(state))]
pub(crate) async fn meta(State(state): State<AppState>) -> Json<MetaResponse> {
    let latest = state.latest.read().await;
    let (
        ready,
        generated_at,
        scan_time,
        timestamp,
        voxel_count,
        tile_count,
        layer_count,
        echo_top_cell_count,
        echo_top18_timestamp,
        echo_top30_timestamp,
        echo_top50_timestamp,
        echo_top60_timestamp,
        echo_top18_max_feet,
        echo_top30_max_feet,
        echo_top50_max_feet,
        echo_top60_max_feet,
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
            scan.echo_tops.len(),
            scan.echo_top_debug.top18_timestamp.clone(),
            scan.echo_top_debug.top30_timestamp.clone(),
            scan.echo_top_debug.top50_timestamp.clone(),
            scan.echo_top_debug.top60_timestamp.clone(),
            scan.echo_top_debug.max_top18_feet,
            scan.echo_top_debug.max_top30_feet,
            scan.echo_top_debug.max_top50_feet,
            scan.echo_top_debug.max_top60_feet,
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
            false, None, None, None, 0, 0, 0, 0, None, None, None, None, None, None, None, None,
            None, None, None, None, None, None, None, None,
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
        echo_top_cell_count,
        echo_top18_timestamp,
        echo_top30_timestamp,
        echo_top50_timestamp,
        echo_top60_timestamp,
        echo_top18_max_feet,
        echo_top30_max_feet,
        echo_top50_max_feet,
        echo_top60_max_feet,
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

#[instrument(
    name = "runtime.volume",
    skip(state, query),
    fields(
        lat = field::Empty,
        lon = field::Empty,
        min_dbz = field::Empty,
        max_range_nm = field::Empty
    )
)]
pub(crate) async fn volume(
    State(state): State<AppState>,
    Query(query): Query<VolumeQuery>,
) -> Response {
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
    let span = tracing::Span::current();
    span.record("lat", &query.lat);
    span.record("lon", &query.lon);
    span.record("min_dbz", &min_dbz);
    span.record("max_range_nm", &max_range_nm);

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

    let build_span = tracing::info_span!("runtime.volume.build_wire_payload");
    match build_span
        .in_scope(|| build_volume_wire_fb(scan, query.lat, query.lon, min_dbz, max_range_nm))
    {
        Ok(body) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                "Content-Type",
                HeaderValue::from_static(VOLUME_FB_CONTENT_TYPE),
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
            if let Some(value) = scan.echo_top_debug.top18_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-ECHOTOP18-TIMESTAMP", header);
                }
            }
            if let Some(value) = scan.echo_top_debug.top30_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-ECHOTOP30-TIMESTAMP", header);
                }
            }
            if let Some(value) = scan.echo_top_debug.top50_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-ECHOTOP50-TIMESTAMP", header);
                }
            }
            if let Some(value) = scan.echo_top_debug.top60_timestamp.as_ref() {
                if let Ok(header) = HeaderValue::from_str(value) {
                    headers.insert("X-AV-ECHOTOP60-TIMESTAMP", header);
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

pub(crate) async fn echo_tops(
    State(state): State<AppState>,
    req_headers: HeaderMap,
    Query(query): Query<EchoTopsQuery>,
) -> Response {
    let span = tracing::info_span!(
        "runtime.echo_tops",
        lat = query.lat,
        lon = query.lon,
        max_range_nm = field::Empty
    );
    let _guard = span.enter();

    if query.lat < -90.0 || query.lat > 90.0 || query.lon < -180.0 || query.lon > 180.0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Invalid lat/lon query parameters."
            })),
        )
            .into_response();
    }

    let max_range_nm = clamp(
        query.max_range_nm.unwrap_or(DEFAULT_MAX_RANGE_NM),
        MIN_ALLOWED_RANGE_NM,
        MAX_ALLOWED_RANGE_NM,
    );
    tracing::Span::current().record("max_range_nm", &max_range_nm);

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

    let window = build_query_window(scan, query.lat, query.lon, DEFAULT_MIN_DBZ, max_range_nm);
    let build_cells_span = tracing::info_span!("runtime.echo_tops.build_cells");
    let cells = build_cells_span.in_scope(|| build_echo_top_cells(scan, &window));

    // Content negotiation: FlatBuffers binary or JSON
    let accept = req_headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let wants_binary = accept.contains(ECHO_TOP_FB_CONTENT_TYPE);

    let mut headers = HeaderMap::new();
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

    if wants_binary {
        let wire_body = build_echo_top_wire_fb(scan, &window, &cells);
        headers.insert(
            "Content-Type",
            HeaderValue::from_static(ECHO_TOP_FB_CONTENT_TYPE),
        );
        (headers, wire_body).into_response()
    } else {
        let body = EchoTopsResponse {
            generated_at: iso_from_ms(scan.generated_at_ms),
            scan_time: iso_from_ms(scan.scan_time_ms),
            timestamp: scan.timestamp.clone(),
            source_cell_count: scan.echo_tops.len(),
            footprint_x_nm: f64::from(window.footprint_x_milli) / 1000.0,
            footprint_y_nm: f64::from(window.footprint_y_milli) / 1000.0,
            max_top18_feet: scan.echo_top_debug.max_top18_feet,
            max_top30_feet: scan.echo_top_debug.max_top30_feet,
            max_top50_feet: scan.echo_top_debug.max_top50_feet,
            max_top60_feet: scan.echo_top_debug.max_top60_feet,
            top18_timestamp: scan.echo_top_debug.top18_timestamp.clone(),
            top30_timestamp: scan.echo_top_debug.top30_timestamp.clone(),
            top50_timestamp: scan.echo_top_debug.top50_timestamp.clone(),
            top60_timestamp: scan.echo_top_debug.top60_timestamp.clone(),
            cells,
        };
        (headers, Json(body)).into_response()
    }
}
