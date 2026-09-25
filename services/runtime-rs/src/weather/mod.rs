mod discovery;
mod edge_publish;
mod grib;
mod ingest;
mod phase;
mod phase_batch;
#[cfg(test)]
mod pipeline_tests;
mod processor;
mod scan_source;
mod simd_lut;
mod sources;
mod storage;
#[cfg(test)]
mod testkit;

// Re-exports for main.rs
pub use self::edge_publish::build_scan_pack;
pub use self::ingest::{enqueue_latest_from_s3, run_ingest_profile, spawn_background_workers};
pub use self::storage::{load_latest_snapshot, load_snapshot_file};

// Re-exports for benchmarks (not consumed by the binary itself)
#[allow(unused_imports)]
pub use phase::{resolve_thermo_phase, DualPolEvidence, PhaseScores, ThermoPhaseEvidence};
#[allow(unused_imports)]
pub use phase_batch::{compute_phase_scores_branchless, BatchPhaseResult};
#[allow(unused_imports)]
pub use processor::{filter_voxels_by_threshold, FilterResult};

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::{field, instrument, warn};

use approach_viz_core::mrms_query::{
    build_echo_top_wire_fb, build_query_window, build_volume_wire_fb, normalize_echo_top_query,
    normalize_volume_query, ECHO_TOP_FB_CONTENT_TYPE, VOLUME_FB_CONTENT_TYPE,
};

use crate::types::{AppState, ScanSnapshot};
use crate::utils::iso_from_ms;

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
    let query =
        match normalize_volume_query(query.lat, query.lon, query.min_dbz, query.max_range_nm) {
            Ok(query) => query,
            Err(message) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": message })),
                )
                    .into_response();
            }
        };
    let span = tracing::Span::current();
    span.record("lat", &query.lat);
    span.record("lon", &query.lon);
    span.record("min_dbz", &query.min_dbz);
    span.record("max_range_nm", &query.max_range_nm);

    // Clone the snapshot Arc and release the read lock before the (potentially
    // long) wire-payload encoding so ingest writers are never blocked on it.
    let scan = state.latest.read().await.as_ref().map(Arc::clone);
    let Some(scan) = scan else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "No MRMS scan is available yet."
            })),
        )
            .into_response();
    };

    // The voxel scan + brick merge + FlatBuffers encode is pure CPU work that
    // can take long enough to stall an async worker thread; run it on the
    // blocking pool so concurrent requests and ingest tasks stay responsive.
    let build_span = tracing::info_span!("runtime.volume.build_wire_payload");
    let scan_for_encode = Arc::clone(&scan);
    let encode_result = tokio::task::spawn_blocking(move || {
        build_span.in_scope(|| {
            let window = build_query_window(
                scan_for_encode.as_ref(),
                query.lat,
                query.lon,
                query.min_dbz,
                query.max_range_nm,
            );
            build_volume_wire_fb(scan_for_encode.as_ref(), &window)
        })
    })
    .await;
    match encode_result {
        Ok(body) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                "Content-Type",
                HeaderValue::from_static(VOLUME_FB_CONTENT_TYPE),
            );
            headers.insert("Cache-Control", HeaderValue::from_static("no-store"));
            for (name, value) in volume_response_headers(&scan) {
                headers.insert(name, value);
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

#[instrument(
    name = "runtime.echo_tops",
    skip(state, query),
    fields(lat = field::Empty, lon = field::Empty, max_range_nm = field::Empty)
)]
pub(crate) async fn echo_tops(
    State(state): State<AppState>,
    Query(query): Query<EchoTopsQuery>,
) -> Response {
    let query = match normalize_echo_top_query(query.lat, query.lon, query.max_range_nm) {
        Ok(query) => query,
        Err(message) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": message })),
            )
                .into_response();
        }
    };
    let span = tracing::Span::current();
    span.record("lat", &query.lat);
    span.record("lon", &query.lon);
    span.record("max_range_nm", &query.max_range_nm);

    // Clone the snapshot Arc and release the read lock before window/cell
    // building and encoding so ingest writers are never blocked on it.
    let scan = state.latest.read().await.as_ref().map(Arc::clone);
    let Some(scan) = scan else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "No MRMS scan is available yet."
            })),
        )
            .into_response();
    };

    // Cell filtering scans every stored echo-top record; run it (plus the
    // encode) on the blocking pool to keep async workers free.
    let build_span = tracing::info_span!("runtime.echo_tops.build_cells");
    let scan_for_build = Arc::clone(&scan);
    let build_result = tokio::task::spawn_blocking(move || {
        build_span.in_scope(|| {
            let window = build_query_window(
                scan_for_build.as_ref(),
                query.lat,
                query.lon,
                query.min_dbz,
                query.max_range_nm,
            );
            build_echo_top_wire_fb(scan_for_build.as_ref(), &window, &scan_for_build.echo_tops)
        })
    })
    .await;
    let body = match build_result {
        Ok(body) => body,
        Err(error) => {
            warn!("Failed to build echo-top payload: {error:#}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to build MRMS echo-top payload."
                })),
            )
                .into_response();
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        "Content-Type",
        HeaderValue::from_static(ECHO_TOP_FB_CONTENT_TYPE),
    );
    headers.insert("Cache-Control", HeaderValue::from_static("no-store"));
    for (name, value) in echo_top_response_headers(&scan) {
        headers.insert(name, value);
    }
    (headers, body).into_response()
}

/// Scan metadata headers of a volume response, in insertion order. The scan
/// pack stores these so the edge Worker returns exactly the same set.
pub(crate) fn volume_response_headers(scan: &ScanSnapshot) -> Vec<(&'static str, HeaderValue)> {
    let debug = &scan.phase_debug;
    let echo = &scan.echo_top_debug;
    let mut headers = echo_top_response_headers(scan);
    let optional: [(&'static str, Option<String>); 12] = [
        (
            "X-AV-PHASE-MODE",
            Some(debug.mode.clone()).filter(|value| !value.is_empty()),
        ),
        (
            "X-AV-PHASE-DETAIL",
            Some(debug.detail.clone()).filter(|value| !value.is_empty()),
        ),
        (
            "X-AV-ZDR-AGE-SECONDS",
            debug.zdr_age_seconds.map(|value| value.to_string()),
        ),
        (
            "X-AV-RHOHV-AGE-SECONDS",
            debug.rhohv_age_seconds.map(|value| value.to_string()),
        ),
        ("X-AV-ZDR-TIMESTAMP", debug.zdr_timestamp.clone()),
        ("X-AV-RHOHV-TIMESTAMP", debug.rhohv_timestamp.clone()),
        ("X-AV-PRECIP-TIMESTAMP", debug.precip_flag_timestamp.clone()),
        (
            "X-AV-FREEZING-TIMESTAMP",
            debug.freezing_level_timestamp.clone(),
        ),
        ("X-AV-ECHOTOP18-TIMESTAMP", echo.top18_timestamp.clone()),
        ("X-AV-ECHOTOP30-TIMESTAMP", echo.top30_timestamp.clone()),
        ("X-AV-ECHOTOP50-TIMESTAMP", echo.top50_timestamp.clone()),
        ("X-AV-ECHOTOP60-TIMESTAMP", echo.top60_timestamp.clone()),
    ];
    push_valid_headers(&mut headers, optional);
    headers
}

/// Scan timing headers carried by both weather responses.
pub(crate) fn echo_top_response_headers(scan: &ScanSnapshot) -> Vec<(&'static str, HeaderValue)> {
    let mut headers = Vec::new();
    push_valid_headers(
        &mut headers,
        [
            ("X-AV-SCAN-TIME", iso_from_ms(scan.scan_time_ms)),
            ("X-AV-GENERATED-AT", iso_from_ms(scan.generated_at_ms)),
        ],
    );
    headers
}

/// Values that are not valid header text are dropped rather than failing the response.
fn push_valid_headers<const N: usize>(
    headers: &mut Vec<(&'static str, HeaderValue)>,
    candidates: [(&'static str, Option<String>); N],
) {
    for (name, value) in candidates {
        if let Some(value) = value.and_then(|value| HeaderValue::from_str(&value).ok()) {
            headers.push((name, value));
        }
    }
}
