use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_sqs::Client as SqsClient;
use chrono::Utc;
use futures::stream::{FuturesUnordered, StreamExt};
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use tokio::time::sleep;
use tracing::{error, info, warn};

use crate::constants::{
    AUX_TIMESTAMP_LOOKBACK_DAYS, DUAL_POL_STALE_THRESHOLD_SECONDS, FEET_PER_KM, FEET_PER_METER,
    FREEZING_LEVEL_TRANSITION_FEET, LEVEL_TAGS, MAX_BASE_DAY_LOOKBACK, MAX_BASE_KEYS_LOOKUP,
    MAX_PENDING_ATTEMPTS, MRMS_BASE_LEVEL_TAG, MRMS_BUCKET_URL, MRMS_CONUS_PREFIX,
    MRMS_MODEL_FREEZING_HEIGHT_PRODUCT, MRMS_PRECIP_FLAG_PRODUCT, MRMS_PRODUCT_PREFIX,
    MRMS_RHOHV_PRODUCT_PREFIX, MRMS_ZDR_PRODUCT_PREFIX, PHASE_MIXED, PHASE_RAIN,
    PHASE_RHOHV_MAX_VALID, PHASE_RHOHV_MIN_VALID, PHASE_RHOHV_MIXED_MAX, PHASE_SNOW,
    PHASE_ZDR_MAX_VALID_DB, PHASE_ZDR_MIN_VALID_DB, PHASE_ZDR_RAIN_MIN_DB, PHASE_ZDR_SNOW_MAX_DB,
    STORE_MIN_DBZ_TENTHS,
};
use crate::discovery::{extract_timestamp_from_key, find_recent_base_level_keys};
use crate::grib::{parse_aux_grib_gzipped, parse_reflectivity_grib_gzipped};
use crate::http_client::fetch_bytes;
use crate::storage::persist_snapshot;
use crate::types::{
    AppState, GridDef, LevelBounds, ParsedAuxField, ParsedReflectivityField, PendingIngest,
    PhaseDebugMetadata, ScanSnapshot, StoredVoxel,
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
        warn!("MRMS_SQS_QUEUE_URL is not set; relying only on periodic S3 bootstrap polling.");
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

    let mut futures = FuturesUnordered::new();
    for (level_idx, level_tag) in LEVEL_TAGS.iter().enumerate() {
        let http = state.http.clone();
        let level_tag = level_tag.to_string();
        let timestamp = timestamp.to_string();
        let date_part = date_part.to_string();
        futures.push(async move {
            let reflectivity_key =
                build_level_key(MRMS_PRODUCT_PREFIX, &level_tag, &date_part, &timestamp);
            let reflectivity_zipped =
                fetch_bytes(&http, &format!("{MRMS_BUCKET_URL}/{reflectivity_key}")).await?;
            let reflectivity = tokio::task::spawn_blocking(move || {
                parse_reflectivity_grib_gzipped(&reflectivity_zipped)
            })
            .await
            .context("Join error while parsing level GRIB")??;
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

    let base_grid = levels
        .first()
        .map(|(_, _, parsed)| parsed.grid.clone())
        .ok_or_else(|| anyhow!("No parsed MRMS levels"))?;

    for (_, tag, parsed) in levels.iter().skip(1) {
        if !is_same_grid(&parsed.grid, &base_grid) {
            bail!("MRMS grid mismatch for level {tag}");
        }
    }

    let mut zdr_bundle =
        fetch_dual_pol_bundle(&state.http, MRMS_ZDR_PRODUCT_PREFIX, timestamp).await;
    let mut rhohv_bundle =
        fetch_dual_pol_bundle(&state.http, MRMS_RHOHV_PRODUCT_PREFIX, timestamp).await;

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
    let use_legacy_fallback = dual_pol_stale || dual_pol_incomplete;

    let legacy_bundle = fetch_legacy_aux_bundle(&state.http, timestamp).await;

    let level_km: Vec<f64> = LEVEL_TAGS
        .iter()
        .map(|tag| tag.parse::<f64>().unwrap_or(0.0))
        .collect();
    let level_bounds = compute_level_bounds(&level_km);

    let tile_size = state.cfg.tile_size.max(16);
    let tile_cols = ((base_grid.nx + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_rows = ((base_grid.ny + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_count = tile_cols as usize * tile_rows as usize;

    let mut buckets: Vec<Vec<StoredVoxel>> = (0..tile_count).map(|_| Vec::new()).collect();

    let row_lats: Vec<f64> = (0..base_grid.ny)
        .map(|row| base_grid.la1_deg + row as f64 * base_grid.lat_step_deg)
        .collect();
    let col_lons360: Vec<f64> = (0..base_grid.nx)
        .map(|col| to_lon360(base_grid.lo1_deg360 + col as f64 * base_grid.lon_step_deg))
        .collect();

    let precip_field = legacy_bundle
        .precip_flag
        .as_ref()
        .map(|(_timestamp, field)| field);
    let freezing_field = legacy_bundle
        .freezing_level
        .as_ref()
        .map(|(_timestamp, field)| field);
    let legacy_available = precip_field.is_some() || freezing_field.is_some();
    let mut dual_missing_voxel_count: u64 = 0;
    let mut legacy_override_mixed_count: u64 = 0;
    let mut legacy_only_resolve_count: u64 = 0;
    let mut legacy_snow_bias_override_count: u64 = 0;

    for (level_idx, level_tag, parsed) in &levels {
        let level_index = *level_idx as usize;
        let Some(bounds) = level_bounds.get(level_index) else {
            continue;
        };
        let voxel_mid_feet = (bounds.bottom_feet as f64 + bounds.top_feet as f64) / 2.0;

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
            let lat_deg = row_lats[row];
            let row_offset = row * parsed.grid.nx as usize;

            for col in 0..parsed.grid.nx as usize {
                let value_idx = row_offset + col;
                let dbz_tenths = parsed.dbz_tenths[value_idx];
                if dbz_tenths < STORE_MIN_DBZ_TENTHS {
                    continue;
                }

                let lon_deg360 = col_lons360[col];
                let dual_phase = resolve_dual_pol_phase(
                    zdr_values.and_then(|values| values.get(value_idx).copied()),
                    rhohv_values.and_then(|values| values.get(value_idx).copied()),
                );
                let legacy_phase = resolve_legacy_phase(
                    lat_deg,
                    lon_deg360,
                    voxel_mid_feet,
                    precip_field,
                    freezing_field,
                );
                let legacy_phase_value = legacy_phase.map(|sample| sample.phase);
                if dual_phase.is_none() {
                    dual_missing_voxel_count += 1;
                }
                if dual_phase == Some(PHASE_MIXED)
                    && legacy_phase_value.is_some_and(|phase| phase != PHASE_MIXED)
                {
                    legacy_override_mixed_count += 1;
                }
                if dual_phase == Some(PHASE_RAIN)
                    && legacy_phase.is_some_and(|sample| {
                        sample.source == LegacyPhaseSource::PrecipFlag && sample.phase == PHASE_SNOW
                    })
                {
                    legacy_snow_bias_override_count += 1;
                }
                if dual_phase.is_none() && legacy_phase_value.is_some() {
                    legacy_only_resolve_count += 1;
                }
                let phase = resolve_phase_with_legacy(dual_phase, legacy_phase);

                let row_u16 = row as u16;
                let col_u16 = col as u16;
                let tile_row = row_u16 as usize / tile_size as usize;
                let tile_col = col_u16 as usize / tile_size as usize;
                let tile_idx = tile_row * tile_cols as usize + tile_col;

                buckets[tile_idx].push(StoredVoxel {
                    row: row_u16,
                    col: col_u16,
                    level_idx: *level_idx,
                    phase,
                    dbz_tenths,
                });
            }
        }
    }

    let mut tile_offsets = Vec::with_capacity(tile_count + 1);
    tile_offsets.push(0_u32);
    let mut voxels = Vec::new();
    for bucket in buckets {
        voxels.extend(bucket);
        tile_offsets.push(voxels.len() as u32);
    }

    let scan_time_ms = parse_timestamp_utc(timestamp)
        .map(|datetime| datetime.timestamp_millis())
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    let used_legacy_for_correction = legacy_override_mixed_count > 0
        || legacy_only_resolve_count > 0
        || legacy_snow_bias_override_count > 0;
    let mode = if use_legacy_fallback {
        if legacy_available {
            "dual-pol-last-available+legacy-fallback"
        } else {
            "dual-pol-last-available"
        }
    } else if used_legacy_for_correction {
        "dual-pol-cycle-matched+legacy-correction"
    } else {
        "dual-pol-cycle-matched"
    };
    let detail = format!(
        "zdr_levels={}/{},rhohv_levels={}/{},zdr_age_s={},rhohv_age_s={},legacy_precip={},legacy_freezing={},dual_missing_voxels={},legacy_mixed_overrides={},legacy_only_resolves={},legacy_snow_bias_overrides={}",
        zdr_bundle.available_level_count(),
        LEVEL_TAGS.len(),
        rhohv_bundle.available_level_count(),
        LEVEL_TAGS.len(),
        format_optional_i64(zdr_bundle.age_seconds),
        format_optional_i64(rhohv_bundle.age_seconds),
        bool_label(precip_field.is_some()),
        bool_label(freezing_field.is_some()),
        dual_missing_voxel_count,
        legacy_override_mixed_count,
        legacy_only_resolve_count,
        legacy_snow_bias_override_count,
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
        phase_debug: PhaseDebugMetadata {
            mode: mode.to_string(),
            detail,
            zdr_timestamp: zdr_bundle.selected_timestamp,
            rhohv_timestamp: rhohv_bundle.selected_timestamp,
            precip_flag_timestamp: legacy_bundle
                .precip_flag
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            freezing_level_timestamp: legacy_bundle
                .freezing_level
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            zdr_age_seconds: zdr_bundle.age_seconds,
            rhohv_age_seconds: rhohv_bundle.age_seconds,
        },
    }))
}

#[derive(Default)]
struct LegacyAuxBundle {
    precip_flag: Option<(String, ParsedAuxField)>,
    freezing_level: Option<(String, ParsedAuxField)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LegacyPhaseSource {
    PrecipFlag,
    FreezingLevel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LegacyPhaseSample {
    phase: u8,
    source: LegacyPhaseSource,
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
    http: &Client,
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
        http,
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
            http,
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
                http,
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

    let Some(selected_timestamp_value) = selected_timestamp.clone() else {
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
    let mut futures = FuturesUnordered::new();

    for (level_idx, level_tag) in LEVEL_TAGS.iter().enumerate() {
        if level_idx == 0 {
            fields_by_level[level_idx] = base_level_field.clone();
            continue;
        }

        let http = http.clone();
        let level_tag = level_tag.to_string();
        let product_prefix = product_prefix.to_string();
        let date_part = selected_date_part.clone();
        let selected_timestamp_value = selected_timestamp_value.clone();

        futures.push(async move {
            let field = fetch_level_aux_field_at_timestamp(
                &http,
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

    DualPolBundle {
        selected_timestamp: Some(selected_timestamp_value.clone()),
        age_seconds: timestamp_age_seconds(target_timestamp, &selected_timestamp_value),
        fields_by_level,
    }
}

async fn fetch_legacy_aux_bundle(http: &Client, target_timestamp: &str) -> LegacyAuxBundle {
    let precip_flag =
        fetch_latest_aux_field_at_or_before(http, MRMS_PRECIP_FLAG_PRODUCT, target_timestamp).await;
    let freezing_level = fetch_latest_aux_field_at_or_before(
        http,
        MRMS_MODEL_FREEZING_HEIGHT_PRODUCT,
        target_timestamp,
    )
    .await;

    LegacyAuxBundle {
        precip_flag,
        freezing_level,
    }
}

async fn fetch_latest_aux_field_at_or_before(
    http: &Client,
    product: &'static str,
    target_timestamp: &str,
) -> Option<(String, ParsedAuxField)> {
    let timestamp = find_latest_aux_timestamp_at_or_before(http, product, target_timestamp).await?;
    let date_part = timestamp.split('-').next()?;
    match fetch_aux_field_at_timestamp(http, product, date_part, &timestamp).await {
        Ok(field) => Some((timestamp, field)),
        Err(error) => {
            warn!(
                "Legacy aux fetch failed for {product} at {timestamp}: {error:#}; continuing without legacy field"
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
            "{product_label} aux grid mismatch for level {level_tag} at {timestamp}; using legacy fallback for affected voxels"
        );
        return None;
    }
    if field.values.len() != reflectivity.dbz_tenths.len() {
        warn!(
            "{product_label} aux point-count mismatch for level {level_tag} at {timestamp}: expected {}, got {}; using legacy fallback for affected voxels",
            reflectivity.dbz_tenths.len(),
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

fn resolve_dual_pol_phase(zdr_value: Option<f32>, rhohv_value: Option<f32>) -> Option<u8> {
    let zdr = zdr_value.and_then(sanitize_zdr);
    let rhohv = rhohv_value.and_then(sanitize_rhohv);

    if let Some(rhohv) = rhohv {
        if rhohv < PHASE_RHOHV_MIXED_MAX {
            return Some(PHASE_MIXED);
        }
    }

    if let Some(zdr) = zdr {
        if zdr >= PHASE_ZDR_RAIN_MIN_DB {
            return Some(PHASE_RAIN);
        }
        if zdr <= PHASE_ZDR_SNOW_MAX_DB {
            return Some(PHASE_SNOW);
        }
        return Some(PHASE_MIXED);
    }

    None
}

fn sanitize_zdr(value: f32) -> Option<f32> {
    if !value.is_finite() || !(PHASE_ZDR_MIN_VALID_DB..=PHASE_ZDR_MAX_VALID_DB).contains(&value) {
        return None;
    }
    Some(value)
}

fn sanitize_rhohv(value: f32) -> Option<f32> {
    if !value.is_finite() || !(PHASE_RHOHV_MIN_VALID..=PHASE_RHOHV_MAX_VALID).contains(&value) {
        return None;
    }
    Some(value)
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

fn build_level_key(
    product_prefix: &str,
    level_tag: &str,
    date_part: &str,
    timestamp: &str,
) -> String {
    format!(
        "{MRMS_CONUS_PREFIX}/{product_prefix}_{level_tag}/{date_part}/MRMS_{product_prefix}_{level_tag}_{timestamp}.grib2.gz"
    )
}

async fn fetch_level_aux_field_at_timestamp(
    http: &Client,
    product_prefix: &str,
    level_tag: &str,
    date_part: &str,
    timestamp: &str,
) -> Result<ParsedAuxField> {
    let key = build_level_key(product_prefix, level_tag, date_part, timestamp);
    let url = format!("{MRMS_BUCKET_URL}/{key}");
    let zipped = fetch_bytes(http, &url).await?;
    let parsed = tokio::task::spawn_blocking(move || parse_aux_grib_gzipped(&zipped))
        .await
        .context("Join error while parsing aux GRIB")??;
    Ok(parsed)
}

fn build_aux_key(product: &str, date_part: &str, timestamp: &str) -> String {
    format!("{MRMS_CONUS_PREFIX}/{product}/{date_part}/MRMS_{product}_{timestamp}.grib2.gz")
}

async fn fetch_aux_field_at_timestamp(
    http: &Client,
    product: &str,
    date_part: &str,
    timestamp: &str,
) -> Result<ParsedAuxField> {
    let key = build_aux_key(product, date_part, timestamp);
    let url = format!("{MRMS_BUCKET_URL}/{key}");
    let zipped = fetch_bytes(http, &url).await?;
    let parsed = tokio::task::spawn_blocking(move || parse_aux_grib_gzipped(&zipped))
        .await
        .context("Join error while parsing legacy aux GRIB")??;
    Ok(parsed)
}

async fn find_latest_level_timestamp_at_or_before(
    http: &Client,
    product_prefix: &str,
    level_tag: &str,
    target_timestamp: &str,
) -> Option<String> {
    find_latest_timestamp_at_or_before(
        http,
        |day| format!("{MRMS_CONUS_PREFIX}/{product_prefix}_{level_tag}/{day}/"),
        target_timestamp,
    )
    .await
}

async fn find_latest_aux_timestamp_at_or_before(
    http: &Client,
    product: &str,
    target_timestamp: &str,
) -> Option<String> {
    find_latest_timestamp_at_or_before(
        http,
        |day| format!("{MRMS_CONUS_PREFIX}/{product}/{day}/"),
        target_timestamp,
    )
    .await
}

async fn find_latest_timestamp_at_or_before<F>(
    http: &Client,
    prefix_builder: F,
    target_timestamp: &str,
) -> Option<String>
where
    F: Fn(&str) -> String,
{
    let target_dt = match parse_timestamp_utc(target_timestamp) {
        Some(value) => value,
        None => {
            warn!("Invalid target timestamp while searching fallback aux: {target_timestamp}");
            return None;
        }
    };

    let mut best: Option<String> = None;
    let max_day_lookback = AUX_TIMESTAMP_LOOKBACK_DAYS.max(MAX_BASE_DAY_LOOKBACK);
    for day_offset in 0..=max_day_lookback {
        let day = (target_dt - chrono::Duration::days(day_offset))
            .format("%Y%m%d")
            .to_string();
        let prefix = prefix_builder(&day);
        let keys = match list_keys_for_prefix(http, &prefix).await {
            Ok(value) => value,
            Err(error) => {
                warn!("Failed listing MRMS keys for prefix {prefix}: {error:#}");
                continue;
            }
        };

        for key in keys {
            let Some(timestamp) = extract_timestamp_from_key(&key) else {
                continue;
            };
            if timestamp.as_str() > target_timestamp {
                continue;
            }
            match &best {
                Some(current) if timestamp <= *current => {}
                _ => best = Some(timestamp),
            }
        }
    }

    best
}

async fn list_keys_for_prefix(http: &Client, prefix: &str) -> Result<Vec<String>> {
    let mut keys = Vec::new();
    let mut continuation_token: Option<String> = None;

    for _ in 0..4 {
        let mut url = format!(
            "{MRMS_BUCKET_URL}/?list-type=2&prefix={}&max-keys=1000",
            urlencoding::encode(prefix)
        );
        if let Some(token) = continuation_token.as_ref() {
            url.push_str("&continuation-token=");
            url.push_str(&urlencoding::encode(token));
        }

        let xml = crate::http_client::fetch_text(http, &url).await?;
        keys.extend(parse_xml_tag_values(&xml, "Key"));

        let is_truncated = parse_xml_tag_value(&xml, "IsTruncated")
            .map(|value| value == "true")
            .unwrap_or(false);
        if !is_truncated {
            break;
        }

        continuation_token = parse_xml_tag_value(&xml, "NextContinuationToken");
        if continuation_token.is_none() {
            break;
        }
    }

    Ok(keys)
}

fn parse_xml_tag_values(xml: &str, tag_name: &str) -> Vec<String> {
    let regex = Regex::new(&format!(r"<{0}>([^<]+)</{0}>", regex::escape(tag_name)))
        .unwrap_or_else(|_| Regex::new(r"$^").unwrap());
    regex
        .captures_iter(xml)
        .filter_map(|captures| captures.get(1).map(|value| value.as_str().to_string()))
        .collect()
}

fn parse_xml_tag_value(xml: &str, tag_name: &str) -> Option<String> {
    parse_xml_tag_values(xml, tag_name).into_iter().next()
}

fn timestamp_age_seconds(newer_timestamp: &str, older_timestamp: &str) -> Option<i64> {
    let newer = parse_timestamp_utc(newer_timestamp)?;
    let older = parse_timestamp_utc(older_timestamp)?;
    Some((newer - older).num_seconds().max(0))
}

fn resolve_phase_with_legacy(
    dual_phase: Option<u8>,
    legacy_phase: Option<LegacyPhaseSample>,
) -> u8 {
    if legacy_phase.is_some_and(|sample| {
        sample.source == LegacyPhaseSource::PrecipFlag && sample.phase == PHASE_SNOW
    }) {
        return PHASE_SNOW;
    }

    let legacy_phase = legacy_phase.map(|sample| sample.phase);
    match dual_phase {
        Some(PHASE_MIXED) => match legacy_phase {
            Some(PHASE_RAIN) => PHASE_RAIN,
            Some(PHASE_SNOW) => PHASE_SNOW,
            _ => PHASE_MIXED,
        },
        Some(phase) => phase,
        None => legacy_phase.unwrap_or(PHASE_RAIN),
    }
}

fn resolve_legacy_phase(
    lat_deg: f64,
    lon_deg360: f64,
    voxel_mid_feet: f64,
    precip_field: Option<&ParsedAuxField>,
    freezing_field: Option<&ParsedAuxField>,
) -> Option<LegacyPhaseSample> {
    if let Some(phase) = precip_field
        .and_then(|field| sample_aux_field(field, lat_deg, lon_deg360))
        .and_then(phase_from_precip_flag)
    {
        return Some(LegacyPhaseSample {
            phase,
            source: LegacyPhaseSource::PrecipFlag,
        });
    }

    if let Some(phase) = freezing_field
        .and_then(|field| sample_aux_field(field, lat_deg, lon_deg360))
        .and_then(|meters| phase_from_freezing_level(voxel_mid_feet, meters as f64))
    {
        return Some(LegacyPhaseSample {
            phase,
            source: LegacyPhaseSource::FreezingLevel,
        });
    }

    None
}

fn sample_aux_field(field: &ParsedAuxField, lat_deg: f64, lon_deg360: f64) -> Option<f32> {
    if field.grid.lat_step_deg.abs() < f64::EPSILON || field.grid.lon_step_deg.abs() < f64::EPSILON
    {
        return None;
    }

    let row = ((lat_deg - field.grid.la1_deg) / field.grid.lat_step_deg).round() as i64;
    let col = ((lon_deg360 - field.grid.lo1_deg360) / field.grid.lon_step_deg).round() as i64;
    if row < 0 || col < 0 {
        return None;
    }

    let row_u = row as u32;
    let col_u = col as u32;
    if row_u >= field.grid.ny || col_u >= field.grid.nx {
        return None;
    }

    let index = row_u as usize * field.grid.nx as usize + col_u as usize;
    field.values.get(index).copied()
}

fn phase_from_precip_flag(value: f32) -> Option<u8> {
    if !value.is_finite() {
        return None;
    }
    let code = value.round() as i32;
    Some(match code {
        -3 | 0 => PHASE_RAIN,
        3 => PHASE_SNOW,
        7 => PHASE_MIXED,
        1 | 6 | 10 | 91 | 96 => PHASE_RAIN,
        _ => PHASE_RAIN,
    })
}

fn phase_from_freezing_level(voxel_mid_feet: f64, freezing_level_meters_msl: f64) -> Option<u8> {
    if !voxel_mid_feet.is_finite() || !freezing_level_meters_msl.is_finite() {
        return None;
    }

    let freezing_level_feet = freezing_level_meters_msl * FEET_PER_METER;
    if !freezing_level_feet.is_finite() || freezing_level_feet <= 0.0 {
        return None;
    }

    if voxel_mid_feet >= freezing_level_feet + FREEZING_LEVEL_TRANSITION_FEET {
        Some(PHASE_SNOW)
    } else if voxel_mid_feet <= freezing_level_feet - FREEZING_LEVEL_TRANSITION_FEET {
        Some(PHASE_RAIN)
    } else {
        Some(PHASE_MIXED)
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_dual_pol_phase_marks_low_rhohv_as_mixed() {
        assert_eq!(
            resolve_dual_pol_phase(Some(0.8), Some(0.94)),
            Some(PHASE_MIXED)
        );
    }

    #[test]
    fn resolve_dual_pol_phase_marks_high_zdr_as_rain() {
        assert_eq!(
            resolve_dual_pol_phase(Some(0.7), Some(0.99)),
            Some(PHASE_RAIN)
        );
    }

    #[test]
    fn resolve_dual_pol_phase_marks_neutral_zdr_as_snow_when_rhohv_is_high() {
        assert_eq!(
            resolve_dual_pol_phase(Some(0.0), Some(0.99)),
            Some(PHASE_SNOW)
        );
    }

    #[test]
    fn resolve_dual_pol_phase_returns_none_for_missing_or_invalid_dual_pol() {
        assert_eq!(resolve_dual_pol_phase(None, None), None);
        assert_eq!(resolve_dual_pol_phase(Some(99.0), Some(-1.0)), None);
    }

    #[test]
    fn resolve_phase_with_legacy_prefers_snow_over_dual_mixed() {
        assert_eq!(
            resolve_phase_with_legacy(
                Some(PHASE_MIXED),
                Some(LegacyPhaseSample {
                    phase: PHASE_SNOW,
                    source: LegacyPhaseSource::PrecipFlag,
                }),
            ),
            PHASE_SNOW
        );
    }

    #[test]
    fn resolve_phase_with_legacy_biases_precip_flag_snow_over_dual_rain() {
        assert_eq!(
            resolve_phase_with_legacy(
                Some(PHASE_RAIN),
                Some(LegacyPhaseSample {
                    phase: PHASE_SNOW,
                    source: LegacyPhaseSource::PrecipFlag,
                }),
            ),
            PHASE_SNOW
        );
    }

    #[test]
    fn resolve_phase_with_legacy_falls_back_to_legacy_when_dual_missing() {
        assert_eq!(
            resolve_phase_with_legacy(
                None,
                Some(LegacyPhaseSample {
                    phase: PHASE_SNOW,
                    source: LegacyPhaseSource::PrecipFlag,
                }),
            ),
            PHASE_SNOW
        );
        assert_eq!(resolve_phase_with_legacy(None, None), PHASE_RAIN);
    }

    #[test]
    fn phase_from_precip_flag_maps_known_codes() {
        assert_eq!(phase_from_precip_flag(3.0), Some(PHASE_SNOW));
        assert_eq!(phase_from_precip_flag(7.0), Some(PHASE_MIXED));
        assert_eq!(phase_from_precip_flag(0.0), Some(PHASE_RAIN));
    }

    #[test]
    fn phase_from_freezing_level_respects_transition_zone() {
        // 1,000 m MSL ~= 3,281 ft
        assert_eq!(
            phase_from_freezing_level(5_200.0, 1_000.0),
            Some(PHASE_SNOW)
        );
        assert_eq!(
            phase_from_freezing_level(1_200.0, 1_000.0),
            Some(PHASE_RAIN)
        );
    }

    #[test]
    fn dual_pol_keys_share_same_timestamp_and_level_as_reflectivity() {
        let date = "20260212";
        let timestamp = "20260212-123456";
        let level = "03.00";
        let suffix = format!("_{level}_{timestamp}.grib2.gz");

        let reflectivity = build_level_key(MRMS_PRODUCT_PREFIX, level, date, timestamp);
        let zdr = build_level_key(MRMS_ZDR_PRODUCT_PREFIX, level, date, timestamp);
        let rhohv = build_level_key(MRMS_RHOHV_PRODUCT_PREFIX, level, date, timestamp);

        assert!(reflectivity.ends_with(&suffix));
        assert!(zdr.ends_with(&suffix));
        assert!(rhohv.ends_with(&suffix));
    }
}
