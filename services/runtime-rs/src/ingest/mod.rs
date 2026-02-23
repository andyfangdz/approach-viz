mod phase;
mod sources;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_sqs::Client as SqsClient;
use chrono::Utc;
use futures::stream::{FuturesUnordered, StreamExt};
use regex::Regex;
use serde_json::Value;
use tokio::time::sleep;
use tracing::{error, info, warn};

use self::phase::{
    promote_mixed_transition_edges, resolve_dual_pol_evidence, resolve_phase_from_evidence,
    resolve_thermo_phase, LevelPhaseVoxel,
};
use self::sources::{
    build_level_key, fetch_aux_field_at_timestamp, fetch_level_aux_field_at_timestamp,
    fetch_mrms_key_bytes, find_latest_aux_timestamp_at_or_before,
    find_latest_level_timestamp_at_or_before, parse_reflectivity_grib_with_limit,
    timestamp_age_seconds,
};
use crate::constants::{
    DUAL_POL_STALE_THRESHOLD_SECONDS, FEET_PER_KM, LEVEL_TAGS, MAX_BASE_KEYS_LOOKUP,
    MAX_PENDING_ATTEMPTS, MIXED_COMPETING_RAIN_SNOW_DELTA_MAX, MIXED_COMPETING_RAIN_SNOW_MIN_SCORE,
    MRMS_BASE_LEVEL_TAG, MRMS_BRIGHT_BAND_BOTTOM_PRODUCT, MRMS_BRIGHT_BAND_TOP_PRODUCT,
    MRMS_ECHO_TOP_18_PRODUCT, MRMS_ECHO_TOP_30_PRODUCT, MRMS_ECHO_TOP_50_PRODUCT,
    MRMS_ECHO_TOP_60_PRODUCT, MRMS_MODEL_FREEZING_HEIGHT_PRODUCT, MRMS_MODEL_SURFACE_TEMP_PRODUCT,
    MRMS_MODEL_WET_BULB_TEMP_PRODUCT, MRMS_PRECIP_FLAG_PRODUCT, MRMS_PRODUCT_PREFIX,
    MRMS_RHOHV_PRODUCT_PREFIX, MRMS_RQI_PRODUCT, MRMS_ZDR_PRODUCT_PREFIX, PHASE_MIXED, PHASE_RAIN,
    STORE_MIN_DBZ_TENTHS,
};
use crate::discovery::{extract_timestamp_from_key, find_recent_base_level_keys};
use crate::storage::persist_snapshot;
use crate::types::{
    AppState, EchoTopDebugMetadata, GridDef, LevelBounds, ParsedAuxField, ParsedReflectivityField,
    PendingIngest, PhaseDebugMetadata, ScanSnapshot, StoredEchoTop, StoredVoxel,
};
use crate::utils::{parse_timestamp_utc, round_u16, to_lon360};

pub async fn spawn_background_workers(state: AppState) -> Result<()> {
    let worker_state = state.clone();
    tokio::spawn(async move {
        ingest_scheduler_loop(worker_state).await;
    });

    let bootstrap_state = state.clone();
    tokio::spawn(async move {
        bootstrap_loop(bootstrap_state).await;
    });

    if let Some(queue_url) = state.cfg.sqs_queue_url.clone() {
        let sqs_state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = sqs_loop(sqs_state, &queue_url).await {
                error!("SQS loop exited: {error:#}");
            }
        });
    } else {
        warn!(
            "RUNTIME_MRMS_SQS_QUEUE_URL/MRMS_SQS_QUEUE_URL is not set; relying only on periodic S3 bootstrap polling."
        );
    }

    Ok(())
}

pub async fn run_ingest_profile(state: &AppState, timestamp: &str, repeats: u32) -> Result<()> {
    info!(
        "Starting one-shot ingest profile mode: timestamp={}, repeats={}, local_dir={}, offline={}",
        timestamp,
        repeats.max(1),
        state
            .cfg
            .ingest_local_data_dir
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<none>".to_string()),
        bool_label(state.cfg.ingest_local_data_offline),
    );

    for run_idx in 1..=repeats.max(1) {
        let started = Instant::now();
        let scan = ingest_timestamp(state, timestamp).await?;
        info!(
            "Profile ingest run {}/{} complete: {} stored voxels, {} echo-top cells, elapsed={}ms",
            run_idx,
            repeats.max(1),
            scan.voxels.len(),
            scan.echo_tops.len(),
            started.elapsed().as_millis(),
        );
    }

    Ok(())
}

async fn sqs_loop(state: AppState, queue_url: &str) -> Result<()> {
    info!("Starting SQS loop for {queue_url}");
    let shared_config = aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(state.cfg.aws_region.clone()))
        .load()
        .await;
    let sqs_client = SqsClient::new(&shared_config);

    let base_key_regex =
        Regex::new(r#"MergedReflectivityQC_00\.50[^\s"']*_(\d{8}-\d{6})\.grib2\.gz"#)
            .context("Failed to compile base key regex")?;

    loop {
        let receive_result = sqs_client
            .receive_message()
            .queue_url(queue_url)
            .max_number_of_messages(10)
            .wait_time_seconds(20)
            .visibility_timeout(90)
            .send()
            .await;

        let response = match receive_result {
            Ok(response) => response,
            Err(error) => {
                warn!("SQS receive_message failed: {error}");
                sleep(state.cfg.sqs_poll_delay).await;
                continue;
            }
        };

        let messages = response.messages.unwrap_or_default();
        if messages.is_empty() {
            continue;
        }

        for message in messages {
            let mut extracted_timestamps = Vec::new();
            if let Some(body) = message.body() {
                extracted_timestamps = extract_timestamps_from_sqs_body(body, &base_key_regex);
            }

            for timestamp in extracted_timestamps {
                enqueue_timestamp(&state, &timestamp).await;
            }

            if let Some(receipt_handle) = message.receipt_handle() {
                if let Err(error) = sqs_client
                    .delete_message()
                    .queue_url(queue_url)
                    .receipt_handle(receipt_handle)
                    .send()
                    .await
                {
                    warn!("Failed to delete SQS message: {error}");
                }
            }
        }
    }
}

fn extract_timestamps_from_sqs_body(body: &str, base_key_regex: &Regex) -> Vec<String> {
    let mut candidates = HashSet::new();

    for captures in base_key_regex.captures_iter(body) {
        if let Some(timestamp) = captures.get(1) {
            candidates.insert(timestamp.as_str().to_string());
        }
    }

    let parsed = serde_json::from_str::<Value>(body);
    if let Ok(value) = parsed {
        collect_json_strings(&value, &mut candidates, base_key_regex);
        if let Some(message_value) = value.get("Message") {
            if let Some(message_str) = message_value.as_str() {
                if let Ok(inner_json) = serde_json::from_str::<Value>(message_str) {
                    collect_json_strings(&inner_json, &mut candidates, base_key_regex);
                }
            }
        }
    }

    let mut sorted: Vec<String> = candidates.into_iter().collect();
    sorted.sort();
    sorted
}

fn collect_json_strings(value: &Value, candidates: &mut HashSet<String>, base_key_regex: &Regex) {
    match value {
        Value::String(text) => {
            let decoded = urlencoding::decode(text)
                .map(|value| value.to_string())
                .unwrap_or_else(|_| text.clone());
            for target in [text.as_str(), decoded.as_str()] {
                for captures in base_key_regex.captures_iter(target) {
                    if let Some(timestamp) = captures.get(1) {
                        candidates.insert(timestamp.as_str().to_string());
                    }
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_json_strings(item, candidates, base_key_regex);
            }
        }
        Value::Object(items) => {
            for (_key, item) in items {
                collect_json_strings(item, candidates, base_key_regex);
            }
        }
        _ => {}
    }
}

async fn bootstrap_loop(state: AppState) {
    loop {
        if let Err(error) = enqueue_latest_from_s3(&state).await {
            warn!("Periodic S3 bootstrap enqueue failed: {error:#}");
        }
        sleep(state.cfg.bootstrap_interval).await;
    }
}

pub async fn enqueue_latest_from_s3(state: &AppState) -> Result<()> {
    let now = Utc::now();
    let base_keys = find_recent_base_level_keys(&state.http, now, MAX_BASE_KEYS_LOOKUP).await?;
    for key in base_keys {
        if let Some(timestamp) = extract_timestamp_from_key(&key) {
            enqueue_timestamp(state, &timestamp).await;
        }
    }
    Ok(())
}

async fn enqueue_timestamp(state: &AppState, timestamp: &str) {
    let latest_timestamp = state
        .latest
        .read()
        .await
        .as_ref()
        .map(|scan| scan.timestamp.clone());
    if let Some(latest) = latest_timestamp {
        if timestamp <= latest.as_str() {
            return;
        }
    }

    {
        let recent = state.recent_timestamps.lock().await;
        if recent.contains(timestamp) {
            return;
        }
    }

    let mut pending = state.pending.lock().await;
    pending
        .entry(timestamp.to_string())
        .and_modify(|entry| {
            entry.next_attempt_at = Instant::now();
        })
        .or_insert(PendingIngest {
            attempts: 0,
            next_attempt_at: Instant::now(),
        });
}

async fn ingest_scheduler_loop(state: AppState) {
    loop {
        let candidate = {
            let now = Instant::now();
            let mut pending = state.pending.lock().await;

            let mut selected: Option<(String, Instant)> = None;
            for (timestamp, entry) in pending.iter() {
                if entry.next_attempt_at <= now {
                    match &selected {
                        Some((current_timestamp, current_due_at))
                            if entry.next_attempt_at > *current_due_at
                                || (entry.next_attempt_at == *current_due_at
                                    && timestamp >= current_timestamp) => {}
                        _ => selected = Some((timestamp.clone(), entry.next_attempt_at)),
                    }
                }
            }

            selected.and_then(|(timestamp, _)| {
                let entry = pending.remove(&timestamp)?;
                Some((timestamp, entry))
            })
        };

        let Some((timestamp, pending_entry)) = candidate else {
            sleep(Duration::from_secs(2)).await;
            continue;
        };

        match ingest_timestamp(&state, &timestamp).await {
            Ok(scan) => {
                info!(
                    "Ingested MRMS scan {} with {} stored voxels (phase_mode={}, phase_detail={})",
                    scan.timestamp,
                    scan.voxels.len(),
                    scan.phase_debug.mode,
                    scan.phase_debug.detail,
                );

                if let Err(error) = persist_snapshot(&state.cfg, scan.clone()).await {
                    error!("Failed to persist scan {}: {error:#}", scan.timestamp);
                }

                {
                    let mut latest = state.latest.write().await;
                    let should_replace = match latest.as_ref() {
                        Some(current) => scan.timestamp >= current.timestamp,
                        None => true,
                    };
                    if should_replace {
                        *latest = Some(scan.clone());
                    }
                }

                {
                    let mut recent = state.recent_timestamps.lock().await;
                    recent.insert(scan.timestamp.clone());
                    if recent.len() > 512 {
                        if let Some(first) = recent.iter().next().cloned() {
                            recent.remove(&first);
                        }
                    }
                }

                {
                    let mut pending = state.pending.lock().await;
                    pending.retain(|timestamp, _| timestamp > &scan.timestamp);
                }
            }
            Err(error) => {
                warn!(
                    "Ingest attempt {} failed (attempt {}): {error:#}",
                    timestamp,
                    pending_entry.attempts + 1
                );

                if pending_entry.attempts + 1 < MAX_PENDING_ATTEMPTS {
                    let mut pending = state.pending.lock().await;
                    pending.insert(
                        timestamp,
                        PendingIngest {
                            attempts: pending_entry.attempts + 1,
                            next_attempt_at: Instant::now() + state.cfg.pending_retry_delay,
                        },
                    );
                }
            }
        }
    }
}

async fn ingest_timestamp(state: &AppState, timestamp: &str) -> Result<Arc<ScanSnapshot>> {
    let date_part = timestamp
        .split('-')
        .next()
        .ok_or_else(|| anyhow!("Invalid timestamp format: {timestamp}"))?;

    let (levels_result, mut zdr_bundle, mut rhohv_bundle, thermo_aux_bundle, echo_top_bundle) = tokio::join!(
        parse_reflectivity_levels(state, timestamp, date_part),
        fetch_dual_pol_bundle(state, MRMS_ZDR_PRODUCT_PREFIX, timestamp),
        fetch_dual_pol_bundle(state, MRMS_RHOHV_PRODUCT_PREFIX, timestamp),
        fetch_thermo_aux_bundle(state, timestamp),
        fetch_echo_top_bundle(state, timestamp),
    );
    let levels = levels_result?;

    let base_grid = levels
        .first()
        .map(|(_, _, parsed)| parsed.grid.clone())
        .ok_or_else(|| anyhow!("No parsed MRMS levels"))?;

    for (_, tag, parsed) in levels.iter().skip(1) {
        if !is_same_grid(&parsed.grid, &base_grid) {
            bail!("MRMS grid mismatch for level {tag}");
        }
    }

    if zdr_bundle.fields_by_level.len() != LEVEL_TAGS.len() {
        zdr_bundle
            .fields_by_level
            .resize_with(LEVEL_TAGS.len(), || None);
    }
    if rhohv_bundle.fields_by_level.len() != LEVEL_TAGS.len() {
        rhohv_bundle
            .fields_by_level
            .resize_with(LEVEL_TAGS.len(), || None);
    }

    let dual_pol_stale = zdr_bundle
        .age_seconds
        .is_some_and(|age| age > DUAL_POL_STALE_THRESHOLD_SECONDS)
        || rhohv_bundle
            .age_seconds
            .is_some_and(|age| age > DUAL_POL_STALE_THRESHOLD_SECONDS);
    let dual_pol_incomplete = zdr_bundle.available_level_count() < LEVEL_TAGS.len()
        || rhohv_bundle.available_level_count() < LEVEL_TAGS.len();
    let use_aux_fallback = dual_pol_stale || dual_pol_incomplete;

    let level_km: Vec<f64> = LEVEL_TAGS
        .iter()
        .map(|tag| tag.parse::<f64>().unwrap_or(0.0))
        .collect();
    let level_bounds = compute_level_bounds(&level_km);

    let point_count = base_grid.nx as usize * base_grid.ny as usize;
    let top18_values = validate_echo_top_values(
        echo_top_bundle
            .top18
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_18_PRODUCT,
        timestamp,
    );
    let top30_values = validate_echo_top_values(
        echo_top_bundle
            .top30
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_30_PRODUCT,
        timestamp,
    );
    let top50_values = validate_echo_top_values(
        echo_top_bundle
            .top50
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_50_PRODUCT,
        timestamp,
    );
    let top60_values = validate_echo_top_values(
        echo_top_bundle
            .top60
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_60_PRODUCT,
        timestamp,
    );
    let mut echo_tops: Vec<StoredEchoTop> = Vec::new();
    let mut max_top18_feet: Option<u16> = None;
    let mut max_top30_feet: Option<u16> = None;
    let mut max_top50_feet: Option<u16> = None;
    let mut max_top60_feet: Option<u16> = None;
    if top18_values.is_some()
        || top30_values.is_some()
        || top50_values.is_some()
        || top60_values.is_some()
    {
        echo_tops.reserve(point_count / 32);
        for row in 0..base_grid.ny as usize {
            let row_offset = row * base_grid.nx as usize;
            for col in 0..base_grid.nx as usize {
                let value_idx = row_offset + col;
                let top18_feet = top18_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);
                let top30_feet = top30_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);
                let top50_feet = top50_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);
                let top60_feet = top60_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);

                if top18_feet == 0 && top30_feet == 0 && top50_feet == 0 && top60_feet == 0 {
                    continue;
                }

                if top18_feet > 0 {
                    max_top18_feet =
                        Some(max_top18_feet.map_or(top18_feet, |value| value.max(top18_feet)));
                }
                if top30_feet > 0 {
                    max_top30_feet =
                        Some(max_top30_feet.map_or(top30_feet, |value| value.max(top30_feet)));
                }
                if top50_feet > 0 {
                    max_top50_feet =
                        Some(max_top50_feet.map_or(top50_feet, |value| value.max(top50_feet)));
                }
                if top60_feet > 0 {
                    max_top60_feet =
                        Some(max_top60_feet.map_or(top60_feet, |value| value.max(top60_feet)));
                }

                echo_tops.push(StoredEchoTop {
                    row: row as u16,
                    col: col as u16,
                    top18_feet,
                    top30_feet,
                    top50_feet,
                    top60_feet,
                });
            }
        }
    }

    let tile_size = state.cfg.tile_size.max(16);
    let tile_cols = ((base_grid.nx + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_rows = ((base_grid.ny + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_count = tile_cols as usize * tile_rows as usize;

    let mut buckets: Vec<Vec<StoredVoxel>> = (0..tile_count).map(|_| Vec::new()).collect();

    let precip_field = thermo_aux_bundle
        .precip_flag
        .as_ref()
        .map(|(_timestamp, field)| field);
    let freezing_field = thermo_aux_bundle
        .freezing_level
        .as_ref()
        .map(|(_timestamp, field)| field);
    let wet_bulb_field = thermo_aux_bundle
        .wet_bulb_temp
        .as_ref()
        .map(|(_timestamp, field)| field);
    let surface_temp_field = thermo_aux_bundle
        .surface_temp
        .as_ref()
        .map(|(_timestamp, field)| field);
    let bright_band_top_field = thermo_aux_bundle
        .bright_band_top
        .as_ref()
        .map(|(_timestamp, field)| field);
    let bright_band_bottom_field = thermo_aux_bundle
        .bright_band_bottom
        .as_ref()
        .map(|(_timestamp, field)| field);
    let rqi_field = thermo_aux_bundle
        .radar_quality_index
        .as_ref()
        .map(|(_timestamp, field)| field);
    let aux_context_available = precip_field.is_some()
        || freezing_field.is_some()
        || wet_bulb_field.is_some()
        || surface_temp_field.is_some()
        || (bright_band_top_field.is_some() && bright_band_bottom_field.is_some())
        || rqi_field.is_some();
    let base_point_count = base_grid.nx as usize * base_grid.ny as usize;
    let precip_values = validate_base_aux_values(
        precip_field,
        &base_grid,
        base_point_count,
        "PrecipFlag_00.00",
        timestamp,
    );
    let freezing_values = validate_base_aux_values(
        freezing_field,
        &base_grid,
        base_point_count,
        "ModelFreezingLevel",
        timestamp,
    );
    let wet_bulb_values = validate_base_aux_values(
        wet_bulb_field,
        &base_grid,
        base_point_count,
        "ModelWetBulbTemp",
        timestamp,
    );
    let surface_temp_values = validate_base_aux_values(
        surface_temp_field,
        &base_grid,
        base_point_count,
        "ModelSurfaceTemp",
        timestamp,
    );
    let bright_band_top_values = validate_base_aux_values(
        bright_band_top_field,
        &base_grid,
        base_point_count,
        "BrightBandTop",
        timestamp,
    );
    let bright_band_bottom_values = validate_base_aux_values(
        bright_band_bottom_field,
        &base_grid,
        base_point_count,
        "BrightBandBottom",
        timestamp,
    );
    let rqi_values = validate_base_aux_values(
        rqi_field,
        &base_grid,
        base_point_count,
        "RadarQualityIndex",
        timestamp,
    );
    let precip_sampler = AuxFieldSampler::new(precip_field, precip_values, &base_grid);
    let freezing_sampler = AuxFieldSampler::new(freezing_field, freezing_values, &base_grid);
    let wet_bulb_sampler = AuxFieldSampler::new(wet_bulb_field, wet_bulb_values, &base_grid);
    let surface_temp_sampler =
        AuxFieldSampler::new(surface_temp_field, surface_temp_values, &base_grid);
    let bright_band_top_sampler =
        AuxFieldSampler::new(bright_band_top_field, bright_band_top_values, &base_grid);
    let bright_band_bottom_sampler = AuxFieldSampler::new(
        bright_band_bottom_field,
        bright_band_bottom_values,
        &base_grid,
    );
    let rqi_sampler = AuxFieldSampler::new(rqi_field, rqi_values, &base_grid);

    let mut dual_missing_voxel_count: u64 = 0;
    let mut thermo_signal_voxel_count: u64 = 0;
    let mut thermo_no_signal_voxel_count: u64 = 0;
    let mut dual_adjusted_voxel_count: u64 = 0;
    let mut dual_suppressed_voxel_count: u64 = 0;
    let mut stale_dual_adjusted_voxel_count: u64 = 0;
    let mut mixed_suppressed_voxel_count: u64 = 0;
    let mut mixed_edge_promoted_voxel_count: u64 = 0;
    let mut precip_snow_forced_voxel_count: u64 = 0;

    for (level_idx, level_tag, parsed) in &levels {
        let level_index = *level_idx as usize;
        let Some(bounds) = level_bounds.get(level_index) else {
            continue;
        };
        let voxel_mid_feet = (bounds.bottom_feet as f64 + bounds.top_feet as f64) / 2.0;
        let mut level_voxels: Vec<LevelPhaseVoxel> =
            Vec::with_capacity((parsed.grid.nx as usize * parsed.grid.ny as usize) / 4);

        let zdr_values = validate_level_aux_values(
            zdr_bundle.fields_by_level[level_index].as_ref(),
            parsed,
            "ZDR",
            level_tag,
            timestamp,
        );
        let rhohv_values = validate_level_aux_values(
            rhohv_bundle.fields_by_level[level_index].as_ref(),
            parsed,
            "RhoHV",
            level_tag,
            timestamp,
        );

        for row in 0..parsed.grid.ny as usize {
            let row_offset = row * parsed.grid.nx as usize;

            for col in 0..parsed.grid.nx as usize {
                let value_idx = row_offset + col;
                let dbz_tenths = parsed.dbz_tenths[value_idx];
                if dbz_tenths < STORE_MIN_DBZ_TENTHS {
                    continue;
                }

                let dual_evidence = resolve_dual_pol_evidence(
                    zdr_values.and_then(|values| values.get(value_idx).copied()),
                    rhohv_values.and_then(|values| values.get(value_idx).copied()),
                );
                if dual_evidence.is_none() {
                    dual_missing_voxel_count += 1;
                }

                let precip_value = precip_sampler.sample(value_idx, row, col);
                let freezing_value = freezing_sampler.sample(value_idx, row, col);
                let wet_bulb_value = wet_bulb_sampler.sample(value_idx, row, col);
                let surface_temp_value = surface_temp_sampler.sample(value_idx, row, col);
                let bright_band_top_value = bright_band_top_sampler.sample(value_idx, row, col);
                let bright_band_bottom_value =
                    bright_band_bottom_sampler.sample(value_idx, row, col);
                let rqi_value = rqi_sampler.sample(value_idx, row, col);
                let thermo_evidence = resolve_thermo_phase(
                    voxel_mid_feet,
                    precip_value,
                    freezing_value,
                    wet_bulb_value,
                    surface_temp_value,
                    bright_band_top_value,
                    bright_band_bottom_value,
                    rqi_value,
                );
                if thermo_evidence.signal_count > 0 {
                    thermo_signal_voxel_count += 1;
                } else {
                    thermo_no_signal_voxel_count += 1;
                }

                let resolution =
                    resolve_phase_from_evidence(thermo_evidence, dual_evidence, use_aux_fallback);
                if resolution.used_dual {
                    dual_adjusted_voxel_count += 1;
                    if use_aux_fallback {
                        stale_dual_adjusted_voxel_count += 1;
                    }
                }
                if resolution.suppressed_dual {
                    dual_suppressed_voxel_count += 1;
                }
                if resolution.suppressed_mixed {
                    mixed_suppressed_voxel_count += 1;
                }
                if resolution.forced_precip_snow {
                    precip_snow_forced_voxel_count += 1;
                }
                let thermo_competing = thermo_evidence.scores.rain
                    >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
                    && thermo_evidence.scores.snow >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
                    && (thermo_evidence.scores.rain - thermo_evidence.scores.snow).abs()
                        <= MIXED_COMPETING_RAIN_SNOW_DELTA_MAX + 0.45;
                let dual_mixed_candidate = dual_evidence
                    .is_some_and(|sample| sample.phase == PHASE_MIXED && sample.confidence >= 0.35);
                let transition_candidate = !resolution.forced_precip_snow
                    && (thermo_evidence.near_transition
                        || thermo_competing
                        || dual_mixed_candidate);
                let surface_phase = thermo_evidence.precip_flag_phase.unwrap_or(PHASE_RAIN);

                level_voxels.push(LevelPhaseVoxel {
                    row: row as u16,
                    col: col as u16,
                    dbz_tenths,
                    phase: resolution.phase,
                    surface_phase,
                    transition_candidate,
                });
            }
        }

        mixed_edge_promoted_voxel_count +=
            promote_mixed_transition_edges(&mut level_voxels, parsed.grid.nx, parsed.grid.ny);

        for voxel in level_voxels {
            let tile_row = voxel.row as usize / tile_size as usize;
            let tile_col = voxel.col as usize / tile_size as usize;
            let tile_idx = tile_row * tile_cols as usize + tile_col;
            buckets[tile_idx].push(StoredVoxel {
                row: voxel.row,
                col: voxel.col,
                level_idx: *level_idx,
                phase: voxel.phase,
                surface_phase: voxel.surface_phase,
                dbz_tenths: voxel.dbz_tenths,
            });
        }
    }

    let mut tile_offsets = Vec::with_capacity(tile_count + 1);
    tile_offsets.push(0_u32);
    let total_voxel_count: usize = buckets.iter().map(Vec::len).sum();
    let mut voxels = Vec::with_capacity(total_voxel_count);
    for bucket in buckets {
        voxels.extend(bucket);
        tile_offsets.push(voxels.len() as u32);
    }

    let scan_time_ms = parse_timestamp_utc(timestamp)
        .map(|datetime| datetime.timestamp_millis())
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    let mode = if use_aux_fallback {
        if dual_adjusted_voxel_count > 0 {
            "thermo-primary+stale-dual-correction"
        } else {
            "thermo-primary+aux-fallback"
        }
    } else if dual_adjusted_voxel_count > 0 {
        "thermo-primary+dual-correction"
    } else {
        "thermo-primary"
    };
    let detail = format!(
        "aux_fallback={},aux_any={},zdr_levels={}/{},rhohv_levels={}/{},zdr_age_s={},rhohv_age_s={},aux_precip={},aux_freezing={},aux_wetbulb={},aux_surface_temp={},aux_brightband_pair={},aux_rqi={},thermo_signal_voxels={},thermo_no_signal_voxels={},dual_missing_voxels={},dual_adjusted_voxels={},dual_suppressed_voxels={},stale_dual_adjusted_voxels={},mixed_suppressed_voxels={},mixed_edge_promoted_voxels={},precip_snow_forced_voxels={}",
        bool_label(use_aux_fallback),
        bool_label(aux_context_available),
        zdr_bundle.available_level_count(),
        LEVEL_TAGS.len(),
        rhohv_bundle.available_level_count(),
        LEVEL_TAGS.len(),
        format_optional_i64(zdr_bundle.age_seconds),
        format_optional_i64(rhohv_bundle.age_seconds),
        bool_label(precip_field.is_some()),
        bool_label(freezing_field.is_some()),
        bool_label(wet_bulb_field.is_some()),
        bool_label(surface_temp_field.is_some()),
        bool_label(bright_band_top_field.is_some() && bright_band_bottom_field.is_some()),
        bool_label(rqi_field.is_some()),
        thermo_signal_voxel_count,
        thermo_no_signal_voxel_count,
        dual_missing_voxel_count,
        dual_adjusted_voxel_count,
        dual_suppressed_voxel_count,
        stale_dual_adjusted_voxel_count,
        mixed_suppressed_voxel_count,
        mixed_edge_promoted_voxel_count,
        precip_snow_forced_voxel_count,
    );

    Ok(Arc::new(ScanSnapshot {
        timestamp: timestamp.to_string(),
        generated_at_ms: Utc::now().timestamp_millis(),
        scan_time_ms,
        grid: base_grid,
        tile_size,
        tile_cols,
        tile_rows,
        level_bounds,
        tile_offsets,
        voxels,
        echo_tops,
        echo_top_debug: EchoTopDebugMetadata {
            top18_timestamp: echo_top_bundle
                .top18
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            top30_timestamp: echo_top_bundle
                .top30
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            top50_timestamp: echo_top_bundle
                .top50
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            top60_timestamp: echo_top_bundle
                .top60
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            max_top18_feet,
            max_top30_feet,
            max_top50_feet,
            max_top60_feet,
        },
        phase_debug: PhaseDebugMetadata {
            mode: mode.to_string(),
            detail,
            zdr_timestamp: zdr_bundle.selected_timestamp,
            rhohv_timestamp: rhohv_bundle.selected_timestamp,
            precip_flag_timestamp: thermo_aux_bundle
                .precip_flag
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            freezing_level_timestamp: thermo_aux_bundle
                .freezing_level
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            zdr_age_seconds: zdr_bundle.age_seconds,
            rhohv_age_seconds: rhohv_bundle.age_seconds,
        },
    }))
}

async fn parse_reflectivity_levels(
    state: &AppState,
    timestamp: &str,
    date_part: &str,
) -> Result<Vec<(u8, String, ParsedReflectivityField)>> {
    let mut futures = FuturesUnordered::new();
    for (level_idx, level_tag) in LEVEL_TAGS.iter().enumerate() {
        let state = state.clone();
        let level_tag = level_tag.to_string();
        let timestamp = timestamp.to_string();
        let date_part = date_part.to_string();
        futures.push(async move {
            let reflectivity_key =
                build_level_key(MRMS_PRODUCT_PREFIX, &level_tag, &date_part, &timestamp);
            let reflectivity_zipped = fetch_mrms_key_bytes(&state, &reflectivity_key).await?;
            let decode_label = format!("reflectivity:{level_tag}");
            let reflectivity =
                parse_reflectivity_grib_with_limit(&state, reflectivity_zipped, &decode_label)
                    .await?;
            Ok::<_, anyhow::Error>((level_idx, level_tag, reflectivity))
        });
    }

    let mut parsed_levels: Vec<Option<(String, ParsedReflectivityField)>> =
        vec![None; LEVEL_TAGS.len()];
    while let Some(result) = futures.next().await {
        let (level_idx, level_tag, reflectivity) = result?;
        parsed_levels[level_idx] = Some((level_tag, reflectivity));
    }

    let mut levels = Vec::with_capacity(parsed_levels.len());
    for (idx, item) in parsed_levels.into_iter().enumerate() {
        let (level_tag, reflectivity) =
            item.ok_or_else(|| anyhow!("Missing parsed level {}", LEVEL_TAGS[idx]))?;
        levels.push((idx as u8, level_tag, reflectivity));
    }
    levels.sort_by_key(|(idx, _, _)| *idx);
    Ok(levels)
}

#[derive(Default)]
struct ThermoAuxBundle {
    precip_flag: Option<(String, ParsedAuxField)>,
    freezing_level: Option<(String, ParsedAuxField)>,
    wet_bulb_temp: Option<(String, ParsedAuxField)>,
    surface_temp: Option<(String, ParsedAuxField)>,
    bright_band_top: Option<(String, ParsedAuxField)>,
    bright_band_bottom: Option<(String, ParsedAuxField)>,
    radar_quality_index: Option<(String, ParsedAuxField)>,
}

#[derive(Default)]
struct EchoTopBundle {
    top18: Option<(String, ParsedAuxField)>,
    top30: Option<(String, ParsedAuxField)>,
    top50: Option<(String, ParsedAuxField)>,
    top60: Option<(String, ParsedAuxField)>,
}

#[derive(Clone, Debug)]
struct AuxFieldSampler<'a> {
    direct_values: Option<&'a [f32]>,
    sampled_lookup: Option<AuxFieldLookup<'a>>,
}

impl<'a> AuxFieldSampler<'a> {
    fn new(
        field: Option<&'a ParsedAuxField>,
        direct_values: Option<&'a [f32]>,
        base_grid: &GridDef,
    ) -> Self {
        Self {
            direct_values,
            sampled_lookup: if direct_values.is_none() {
                field.and_then(|field| AuxFieldLookup::build(field, base_grid))
            } else {
                None
            },
        }
    }

    #[inline]
    fn sample(&self, value_idx: usize, row: usize, col: usize) -> Option<f32> {
        if let Some(values) = self.direct_values {
            return values.get(value_idx).copied();
        }
        self.sampled_lookup
            .as_ref()
            .and_then(|lookup| lookup.sample(row, col))
    }
}

#[derive(Clone, Debug)]
struct AuxFieldLookup<'a> {
    values: &'a [f32],
    nx: u32,
    row_map: Vec<Option<u32>>,
    col_map: Vec<Option<u32>>,
}

impl<'a> AuxFieldLookup<'a> {
    fn build(field: &'a ParsedAuxField, base_grid: &GridDef) -> Option<Self> {
        if field.grid.lat_step_deg.abs() < f64::EPSILON
            || field.grid.lon_step_deg.abs() < f64::EPSILON
        {
            return None;
        }

        let row_map = (0..base_grid.ny)
            .map(|base_row| {
                let lat_deg = base_grid.la1_deg + base_row as f64 * base_grid.lat_step_deg;
                let row = ((lat_deg - field.grid.la1_deg) / field.grid.lat_step_deg).round() as i64;
                if row < 0 || row >= field.grid.ny as i64 {
                    None
                } else {
                    Some(row as u32)
                }
            })
            .collect();

        let col_map = (0..base_grid.nx)
            .map(|base_col| {
                let lon_deg360 =
                    to_lon360(base_grid.lo1_deg360 + base_col as f64 * base_grid.lon_step_deg);
                let col =
                    ((lon_deg360 - field.grid.lo1_deg360) / field.grid.lon_step_deg).round() as i64;
                if col < 0 || col >= field.grid.nx as i64 {
                    None
                } else {
                    Some(col as u32)
                }
            })
            .collect();

        Some(Self {
            values: field.values.as_slice(),
            nx: field.grid.nx,
            row_map,
            col_map,
        })
    }

    #[inline]
    fn sample(&self, row: usize, col: usize) -> Option<f32> {
        let sample_row = self.row_map.get(row).and_then(|value| *value)?;
        let sample_col = self.col_map.get(col).and_then(|value| *value)?;
        let index = sample_row as usize * self.nx as usize + sample_col as usize;
        self.values.get(index).copied()
    }
}

struct DualPolBundle {
    selected_timestamp: Option<String>,
    age_seconds: Option<i64>,
    fields_by_level: Vec<Option<ParsedAuxField>>,
}

impl DualPolBundle {
    fn available_level_count(&self) -> usize {
        self.fields_by_level
            .iter()
            .filter(|field| field.is_some())
            .count()
    }
}

async fn fetch_dual_pol_bundle(
    state: &AppState,
    product_prefix: &'static str,
    target_timestamp: &str,
) -> DualPolBundle {
    let target_date_part = match target_timestamp.split('-').next() {
        Some(value) => value,
        None => {
            warn!("Invalid timestamp for aux selection: {target_timestamp}");
            return DualPolBundle {
                selected_timestamp: None,
                age_seconds: None,
                fields_by_level: vec![None; LEVEL_TAGS.len()],
            };
        }
    };

    let mut selected_timestamp = Some(target_timestamp.to_string());
    let mut base_level_field: Option<ParsedAuxField> = match fetch_level_aux_field_at_timestamp(
        state,
        product_prefix,
        MRMS_BASE_LEVEL_TAG,
        target_date_part,
        target_timestamp,
    )
    .await
    {
        Ok(field) => Some(field),
        Err(error) => {
            warn!(
                "{product_prefix} exact aux unavailable at {target_timestamp}: {error:#}; searching latest available timestamp"
            );
            None
        }
    };

    if base_level_field.is_none() {
        selected_timestamp = find_latest_level_timestamp_at_or_before(
            state,
            product_prefix,
            MRMS_BASE_LEVEL_TAG,
            target_timestamp,
        )
        .await;
        if let Some(selected) = selected_timestamp.as_ref() {
            let date_part = match selected.split('-').next() {
                Some(value) => value,
                None => {
                    warn!(
                        "Invalid fallback aux timestamp for {product_prefix}: {selected}; skipping aux bundle"
                    );
                    return DualPolBundle {
                        selected_timestamp: None,
                        age_seconds: None,
                        fields_by_level: vec![None; LEVEL_TAGS.len()],
                    };
                }
            };
            base_level_field = fetch_level_aux_field_at_timestamp(
                state,
                product_prefix,
                MRMS_BASE_LEVEL_TAG,
                date_part,
                selected,
            )
            .await
            .map_err(|error| {
                warn!(
                    "{product_prefix} fallback aux fetch failed at {selected}: {error:#}; skipping aux bundle"
                );
                error
            })
            .ok();
        }
    }

    let Some(selected_timestamp_value) = selected_timestamp else {
        return DualPolBundle {
            selected_timestamp: None,
            age_seconds: None,
            fields_by_level: vec![None; LEVEL_TAGS.len()],
        };
    };

    let selected_date_part = match selected_timestamp_value.split('-').next() {
        Some(value) => value.to_string(),
        None => {
            warn!(
                "Invalid selected aux timestamp for {product_prefix}: {selected_timestamp_value}"
            );
            return DualPolBundle {
                selected_timestamp: None,
                age_seconds: None,
                fields_by_level: vec![None; LEVEL_TAGS.len()],
            };
        }
    };

    let mut fields_by_level = vec![None; LEVEL_TAGS.len()];
    fields_by_level[0] = base_level_field.take();
    let mut futures = FuturesUnordered::new();

    for (level_idx, level_tag) in LEVEL_TAGS.iter().enumerate().skip(1) {
        let state = state.clone();
        let level_tag = level_tag.to_string();
        let product_prefix = product_prefix.to_string();
        let date_part = selected_date_part.clone();
        let selected_timestamp_value = selected_timestamp_value.clone();

        futures.push(async move {
            let field = fetch_level_aux_field_at_timestamp(
                &state,
                &product_prefix,
                &level_tag,
                &date_part,
                &selected_timestamp_value,
            )
            .await
            .map_err(|error| {
                warn!(
                    "{product_prefix} aux unavailable for level {level_tag} at {selected_timestamp_value}: {error:#}"
                );
                error
            })
            .ok();
            (level_idx, field)
        });
    }

    while let Some((level_idx, field)) = futures.next().await {
        fields_by_level[level_idx] = field;
    }

    let age_seconds = timestamp_age_seconds(target_timestamp, &selected_timestamp_value);
    DualPolBundle {
        selected_timestamp: Some(selected_timestamp_value),
        age_seconds,
        fields_by_level,
    }
}

async fn fetch_thermo_aux_bundle(state: &AppState, target_timestamp: &str) -> ThermoAuxBundle {
    let (
        precip_flag,
        freezing_level,
        wet_bulb_temp,
        surface_temp,
        bright_band_top,
        bright_band_bottom,
        radar_quality_index,
    ) = tokio::join!(
        fetch_latest_aux_field_at_or_before(state, MRMS_PRECIP_FLAG_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_MODEL_FREEZING_HEIGHT_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_MODEL_WET_BULB_TEMP_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_MODEL_SURFACE_TEMP_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(state, MRMS_BRIGHT_BAND_TOP_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_BRIGHT_BAND_BOTTOM_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(state, MRMS_RQI_PRODUCT, target_timestamp),
    );

    ThermoAuxBundle {
        precip_flag,
        freezing_level,
        wet_bulb_temp,
        surface_temp,
        bright_band_top,
        bright_band_bottom,
        radar_quality_index,
    }
}

async fn fetch_echo_top_bundle(state: &AppState, target_timestamp: &str) -> EchoTopBundle {
    let (top18, top30, top50, top60) = tokio::join!(
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_18_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_30_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_50_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_60_PRODUCT, target_timestamp),
    );

    EchoTopBundle {
        top18,
        top30,
        top50,
        top60,
    }
}

async fn fetch_latest_aux_field_at_or_before(
    state: &AppState,
    product: &'static str,
    target_timestamp: &str,
) -> Option<(String, ParsedAuxField)> {
    let timestamp =
        find_latest_aux_timestamp_at_or_before(state, product, target_timestamp).await?;
    let date_part = timestamp.split('-').next()?;
    match fetch_aux_field_at_timestamp(state, product, date_part, &timestamp).await {
        Ok(field) => Some((timestamp, field)),
        Err(error) => {
            warn!(
                "Aux context fetch failed for {product} at {timestamp}: {error:#}; continuing without aux field"
            );
            None
        }
    }
}

fn validate_level_aux_values<'a>(
    field: Option<&'a ParsedAuxField>,
    reflectivity: &ParsedReflectivityField,
    product_label: &str,
    level_tag: &str,
    timestamp: &str,
) -> Option<&'a [f32]> {
    let field = field?;
    if !is_same_grid(&field.grid, &reflectivity.grid) {
        warn!(
            "{product_label} aux grid mismatch for level {level_tag} at {timestamp}; using aux fallback for affected voxels"
        );
        return None;
    }
    if field.values.len() != reflectivity.dbz_tenths.len() {
        warn!(
            "{product_label} aux point-count mismatch for level {level_tag} at {timestamp}: expected {}, got {}; using aux fallback for affected voxels",
            reflectivity.dbz_tenths.len(),
            field.values.len()
        );
        return None;
    }
    Some(field.values.as_slice())
}

fn validate_base_aux_values<'a>(
    field: Option<&'a ParsedAuxField>,
    base_grid: &GridDef,
    point_count: usize,
    product_label: &str,
    timestamp: &str,
) -> Option<&'a [f32]> {
    let field = field?;
    if !is_same_grid(&field.grid, base_grid) {
        warn!(
            "{product_label} aux grid mismatch at {timestamp}; using coordinate-sampled aux fallback"
        );
        return None;
    }
    if field.values.len() != point_count {
        warn!(
            "{product_label} aux point-count mismatch at {timestamp}: expected {point_count}, got {}; using coordinate-sampled aux fallback",
            field.values.len()
        );
        return None;
    }
    Some(field.values.as_slice())
}

fn validate_echo_top_values<'a>(
    field: Option<&'a ParsedAuxField>,
    base_grid: &GridDef,
    point_count: usize,
    product_label: &str,
    timestamp: &str,
) -> Option<&'a [f32]> {
    let field = field?;
    if !is_same_grid(&field.grid, base_grid) {
        warn!(
            "Echo-top aux grid mismatch for {product_label} at {timestamp}; skipping echo-top product"
        );
        return None;
    }
    if field.values.len() != point_count {
        warn!(
            "Echo-top aux point-count mismatch for {product_label} at {timestamp}: expected {point_count}, got {}; skipping echo-top product",
            field.values.len()
        );
        return None;
    }
    Some(field.values.as_slice())
}

fn is_same_grid(left: &GridDef, right: &GridDef) -> bool {
    left.nx == right.nx
        && left.ny == right.ny
        && (left.la1_deg - right.la1_deg).abs() <= 1e-6
        && (left.lo1_deg360 - right.lo1_deg360).abs() <= 1e-6
        && (left.di_deg - right.di_deg).abs() <= 1e-6
        && (left.dj_deg - right.dj_deg).abs() <= 1e-6
}

fn compute_level_bounds(level_km: &[f64]) -> Vec<LevelBounds> {
    let mut bounds = Vec::with_capacity(level_km.len());

    for idx in 0..level_km.len() {
        let level = level_km[idx];
        let previous = if idx > 0 {
            Some(level_km[idx - 1])
        } else {
            None
        };
        let next = level_km.get(idx + 1).copied();

        let bottom_km = if let Some(prev) = previous {
            (prev + level) / 2.0
        } else {
            let next_level = next.unwrap_or(level + 0.5);
            (level - (next_level - level) / 2.0).max(0.0)
        };

        let top_km = if let Some(next_level) = next {
            (level + next_level) / 2.0
        } else {
            let prev_level = previous.unwrap_or(level - 0.5);
            level + (level - prev_level) / 2.0
        };

        bounds.push(LevelBounds {
            bottom_feet: round_u16(bottom_km * FEET_PER_KM),
            top_feet: round_u16(top_km * FEET_PER_KM),
        });
    }

    bounds
}

fn echo_top_km_to_feet(value: f32) -> Option<u16> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(round_u16(f64::from(value) * FEET_PER_KM))
}

fn format_optional_i64(value: Option<i64>) -> String {
    value
        .map(|v| v.to_string())
        .unwrap_or_else(|| "n/a".to_string())
}

fn bool_label(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}
