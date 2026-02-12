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
    FEET_PER_KM, LEVEL_TAGS, MAX_BASE_KEYS_LOOKUP, MAX_PENDING_ATTEMPTS, MRMS_BUCKET_URL,
    MRMS_CONUS_PREFIX, MRMS_PRODUCT_PREFIX, MRMS_RHOHV_PRODUCT_PREFIX, MRMS_ZDR_PRODUCT_PREFIX,
    PHASE_MIXED, PHASE_RAIN, PHASE_RHOHV_MAX_VALID, PHASE_RHOHV_MIN_VALID, PHASE_RHOHV_MIXED_MAX,
    PHASE_SNOW, PHASE_ZDR_MAX_VALID_DB, PHASE_ZDR_MIN_VALID_DB, PHASE_ZDR_RAIN_MIN_DB,
    PHASE_ZDR_SNOW_MAX_DB, STORE_MIN_DBZ_TENTHS,
};
use crate::discovery::{extract_timestamp_from_key, find_recent_base_level_keys};
use crate::grib::{parse_aux_grib_gzipped, parse_reflectivity_grib_gzipped};
use crate::http_client::fetch_bytes;
use crate::storage::persist_snapshot;
use crate::types::{
    AppState, GridDef, LevelBounds, ParsedAuxField, ParsedReflectivityField, PendingIngest,
    ScanSnapshot, StoredVoxel,
};
use crate::utils::{parse_timestamp_utc, round_u16};

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

            let mut selected_timestamp: Option<String> = None;
            for (timestamp, entry) in pending.iter() {
                if entry.next_attempt_at <= now {
                    match &selected_timestamp {
                        Some(current) if timestamp <= current => {}
                        _ => selected_timestamp = Some(timestamp.clone()),
                    }
                }
            }

            selected_timestamp.and_then(|timestamp| {
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
                    "Ingested MRMS scan {} with {} stored voxels",
                    scan.timestamp,
                    scan.voxels.len()
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

            let zdr = fetch_level_aux_field_at_timestamp(
                &http,
                MRMS_ZDR_PRODUCT_PREFIX,
                &level_tag,
                &date_part,
                &timestamp,
            )
            .await
            .map_err(|error| {
                warn!(
                    "ZDR aux unavailable for level {} at {}: {error:#}",
                    level_tag, timestamp
                );
                error
            })
            .ok();

            let rhohv = fetch_level_aux_field_at_timestamp(
                &http,
                MRMS_RHOHV_PRODUCT_PREFIX,
                &level_tag,
                &date_part,
                &timestamp,
            )
            .await
            .map_err(|error| {
                warn!(
                    "RhoHV aux unavailable for level {} at {}: {error:#}",
                    level_tag, timestamp
                );
                error
            })
            .ok();

            Ok::<_, anyhow::Error>((level_idx, level_tag, reflectivity, zdr, rhohv))
        });
    }

    let mut parsed_levels: Vec<
        Option<(
            String,
            ParsedReflectivityField,
            Option<ParsedAuxField>,
            Option<ParsedAuxField>,
        )>,
    > = vec![None; LEVEL_TAGS.len()];
    while let Some(result) = futures.next().await {
        let (level_idx, level_tag, reflectivity, zdr, rhohv) = result?;
        parsed_levels[level_idx] = Some((level_tag, reflectivity, zdr, rhohv));
    }

    let mut levels = Vec::with_capacity(parsed_levels.len());
    for (idx, item) in parsed_levels.into_iter().enumerate() {
        let (level_tag, reflectivity, zdr, rhohv) =
            item.ok_or_else(|| anyhow!("Missing parsed level {}", LEVEL_TAGS[idx]))?;
        levels.push((idx as u8, level_tag, reflectivity, zdr, rhohv));
    }

    levels.sort_by_key(|(idx, _, _, _, _)| *idx);

    let base_grid = levels
        .first()
        .map(|(_, _, parsed, _, _)| parsed.grid.clone())
        .ok_or_else(|| anyhow!("No parsed MRMS levels"))?;

    for (_, tag, parsed, _, _) in levels.iter().skip(1) {
        if !is_same_grid(&parsed.grid, &base_grid) {
            bail!("MRMS grid mismatch for level {tag}");
        }
    }

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

    for (level_idx, level_tag, parsed, zdr_aux, rhohv_aux) in &levels {
        let level_index = *level_idx as usize;
        if level_bounds.get(level_index).is_none() {
            continue;
        }

        let zdr_values = zdr_aux.as_ref().and_then(|field| {
            if is_same_grid(&field.grid, &parsed.grid) {
                Some(field.values.as_slice())
            } else {
                warn!(
                    "Ignoring ZDR aux for level {} at {} due to grid mismatch",
                    level_tag, timestamp
                );
                None
            }
        });
        let rhohv_values = rhohv_aux.as_ref().and_then(|field| {
            if is_same_grid(&field.grid, &parsed.grid) {
                Some(field.values.as_slice())
            } else {
                warn!(
                    "Ignoring RhoHV aux for level {} at {} due to grid mismatch",
                    level_tag, timestamp
                );
                None
            }
        });

        for row in 0..parsed.grid.ny as usize {
            let row_offset = row * parsed.grid.nx as usize;

            for col in 0..parsed.grid.nx as usize {
                let value_idx = row_offset + col;
                let dbz_tenths = parsed.dbz_tenths[value_idx];
                if dbz_tenths < STORE_MIN_DBZ_TENTHS {
                    continue;
                }

                let phase = resolve_phase(
                    zdr_values.and_then(|values| values.get(value_idx).copied()),
                    rhohv_values.and_then(|values| values.get(value_idx).copied()),
                );

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
    }))
}

fn is_same_grid(left: &GridDef, right: &GridDef) -> bool {
    left.nx == right.nx
        && left.ny == right.ny
        && (left.la1_deg - right.la1_deg).abs() <= 1e-6
        && (left.lo1_deg360 - right.lo1_deg360).abs() <= 1e-6
        && (left.di_deg - right.di_deg).abs() <= 1e-6
        && (left.dj_deg - right.dj_deg).abs() <= 1e-6
}

fn resolve_phase(zdr_value: Option<f32>, rhohv_value: Option<f32>) -> u8 {
    let zdr = zdr_value.and_then(sanitize_zdr);
    let rhohv = rhohv_value.and_then(sanitize_rhohv);

    if let Some(rhohv) = rhohv {
        if rhohv < PHASE_RHOHV_MIXED_MAX {
            return PHASE_MIXED;
        }
    }

    if let Some(zdr) = zdr {
        if zdr >= PHASE_ZDR_RAIN_MIN_DB {
            return PHASE_RAIN;
        }
        if zdr <= PHASE_ZDR_SNOW_MAX_DB {
            return PHASE_SNOW;
        }
        return PHASE_MIXED;
    }

    PHASE_RAIN
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_phase_marks_low_rhohv_as_mixed() {
        assert_eq!(resolve_phase(Some(0.8), Some(0.94)), PHASE_MIXED);
    }

    #[test]
    fn resolve_phase_marks_high_zdr_as_rain() {
        assert_eq!(resolve_phase(Some(0.7), Some(0.99)), PHASE_RAIN);
    }

    #[test]
    fn resolve_phase_marks_neutral_zdr_as_snow_when_rhohv_is_high() {
        assert_eq!(resolve_phase(Some(0.0), Some(0.99)), PHASE_SNOW);
    }

    #[test]
    fn resolve_phase_falls_back_to_rain_for_missing_or_invalid_dual_pol() {
        assert_eq!(resolve_phase(None, None), PHASE_RAIN);
        assert_eq!(resolve_phase(Some(99.0), Some(-1.0)), PHASE_RAIN);
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
