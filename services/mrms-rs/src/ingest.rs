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
    FEET_PER_KM, FEET_PER_METER, FREEZING_LEVEL_TRANSITION_FEET, LEVEL_TAGS, MAX_BASE_KEYS_LOOKUP,
    MAX_PENDING_ATTEMPTS, MODEL_STEP_SECONDS, MRMS_BUCKET_URL, MRMS_CONUS_PREFIX,
    MRMS_MODEL_FREEZING_HEIGHT_PRODUCT, MRMS_PRECIP_FLAG_PRODUCT, MRMS_PRODUCT_PREFIX, PHASE_MIXED,
    PHASE_RAIN, PHASE_SNOW, PRECIP_FLAG_STEP_SECONDS, STORE_MIN_DBZ_TENTHS,
};
use crate::discovery::{extract_timestamp_from_key, find_recent_base_level_keys};
use crate::grib::parse_grib_gzipped;
use crate::http_client::fetch_bytes;
use crate::storage::persist_snapshot;
use crate::types::{
    AppState, AuxFieldSampler, LevelBounds, PackedValues, ParsedField, PendingIngest, ScanSnapshot,
    StoredVoxel,
};
use crate::utils::{cycle_anchor_timestamp, parse_timestamp_utc, round_u16, to_lon360};

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
            let key = build_level_key(&level_tag, &date_part, &timestamp);
            let zipped = fetch_bytes(&http, &format!("{MRMS_BUCKET_URL}/{key}")).await?;
            let parsed = tokio::task::spawn_blocking(move || parse_grib_gzipped(&zipped))
                .await
                .context("Join error while parsing level GRIB")??;
            Ok::<_, anyhow::Error>((level_idx, level_tag, parsed))
        });
    }

    let mut parsed_levels: Vec<Option<(String, ParsedField)>> = vec![None; LEVEL_TAGS.len()];
    while let Some(result) = futures.next().await {
        let (level_idx, level_tag, parsed) = result?;
        parsed_levels[level_idx] = Some((level_tag, parsed));
    }

    let mut levels = Vec::with_capacity(parsed_levels.len());
    for (idx, item) in parsed_levels.into_iter().enumerate() {
        let (level_tag, parsed) =
            item.ok_or_else(|| anyhow!("Missing parsed level {}", LEVEL_TAGS[idx]))?;
        levels.push((idx as u8, level_tag, parsed));
    }

    levels.sort_by_key(|(idx, _, _)| *idx);

    let base_grid = levels
        .first()
        .map(|(_, _, parsed)| parsed.grid.clone())
        .ok_or_else(|| anyhow!("No parsed MRMS levels"))?;

    for (_, tag, parsed) in levels.iter().skip(1) {
        if parsed.grid.nx != base_grid.nx
            || parsed.grid.ny != base_grid.ny
            || (parsed.grid.la1_deg - base_grid.la1_deg).abs() > 1e-6
            || (parsed.grid.lo1_deg360 - base_grid.lo1_deg360).abs() > 1e-6
            || (parsed.grid.di_deg - base_grid.di_deg).abs() > 1e-6
            || (parsed.grid.dj_deg - base_grid.dj_deg).abs() > 1e-6
        {
            bail!("MRMS grid mismatch for level {tag}");
        }
    }

    let precip_cycle_timestamp = cycle_anchor_timestamp(timestamp, PRECIP_FLAG_STEP_SECONDS)?;
    let precip_aux = fetch_aux_field_at_timestamp(
        &state.http,
        MRMS_PRECIP_FLAG_PRODUCT,
        &precip_cycle_timestamp,
    )
    .await
    .map_err(|error| {
        warn!(
            "PrecipFlag aux unavailable for reflectivity {} (cycle {}): {error:#}",
            timestamp, precip_cycle_timestamp
        );
        error
    })
    .ok();

    let model_cycle_timestamp = cycle_anchor_timestamp(timestamp, MODEL_STEP_SECONDS)?;
    let freezing_aux = fetch_aux_field_at_timestamp(
        &state.http,
        MRMS_MODEL_FREEZING_HEIGHT_PRODUCT,
        &model_cycle_timestamp,
    )
    .await
    .map_err(|error| {
        warn!(
            "Freezing-level aux unavailable for reflectivity {} (cycle {}): {error:#}",
            timestamp, model_cycle_timestamp
        );
        error
    })
    .ok();

    let precip_sampler = precip_aux
        .as_ref()
        .map(build_aux_sampler)
        .transpose()
        .context("Failed to build precip sampler")?;
    let freezing_sampler = freezing_aux
        .as_ref()
        .map(build_aux_sampler)
        .transpose()
        .context("Failed to build freezing sampler")?;

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

    for (level_idx, _tag, parsed) in &levels {
        let level_index = *level_idx as usize;
        let Some(bounds) = level_bounds.get(level_index) else {
            continue;
        };
        let voxel_mid_feet = (bounds.bottom_feet as f64 + bounds.top_feet as f64) / 2.0;

        let decode_lookup = build_decode_lookup(parsed);
        for row in 0..parsed.grid.ny as usize {
            let lat_deg = row_lats[row];
            let row_offset = row * parsed.grid.nx as usize;

            for col in 0..parsed.grid.nx as usize {
                let packed = parsed.values.get_u32(row_offset + col) as usize;
                let dbz_tenths = decode_lookup.get(packed).copied().unwrap_or(i16::MIN);
                if dbz_tenths < STORE_MIN_DBZ_TENTHS {
                    continue;
                }

                let lon_deg360 = col_lons360[col];
                let phase = resolve_phase(
                    lat_deg,
                    lon_deg360,
                    voxel_mid_feet,
                    precip_sampler.as_ref(),
                    freezing_sampler.as_ref(),
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

fn build_decode_lookup(field: &ParsedField) -> Vec<i16> {
    let max_packed = match &field.values {
        PackedValues::U8(_) => 255,
        PackedValues::U16(_) => 65_535,
    };

    let mut lookup = vec![i16::MIN; max_packed + 1];
    let binary_scale = 2_f64.powi(field.packing.binary_scale_factor as i32);
    let decimal_scale = 10_f64.powi(field.packing.decimal_scale_factor as i32);

    for packed in 0..=max_packed {
        let decoded =
            (field.packing.reference_value + packed as f64 * binary_scale) / decimal_scale;
        let dbz_tenths = (decoded * 10.0).round();
        lookup[packed] = dbz_tenths.clamp(i16::MIN as f64, i16::MAX as f64) as i16;
    }

    lookup
}

fn build_aux_sampler(field: &ParsedField) -> Result<AuxFieldSampler> {
    let mut values = Vec::with_capacity(field.values.len());
    let binary_scale = 2_f64.powi(field.packing.binary_scale_factor as i32);
    let decimal_scale = 10_f64.powi(field.packing.decimal_scale_factor as i32);

    for idx in 0..field.values.len() {
        let packed = field.values.get_u32(idx) as f64;
        let decoded = (field.packing.reference_value + packed * binary_scale) / decimal_scale;
        values.push(decoded as f32);
    }

    Ok(AuxFieldSampler {
        grid: field.grid.clone(),
        values,
    })
}

fn resolve_phase(
    lat_deg: f64,
    lon_deg360: f64,
    voxel_mid_feet: f64,
    precip_sampler: Option<&AuxFieldSampler>,
    freezing_sampler: Option<&AuxFieldSampler>,
) -> u8 {
    let phase_from_flag = precip_sampler
        .and_then(|sampler| sampler.sample(lat_deg, lon_deg360))
        .and_then(phase_from_precip_flag);

    if let Some(phase) = phase_from_flag {
        return phase;
    }

    let phase_from_freezing = freezing_sampler
        .and_then(|sampler| sampler.sample(lat_deg, lon_deg360))
        .and_then(|meters| phase_from_freezing_level(voxel_mid_feet, meters as f64));

    phase_from_freezing.unwrap_or(PHASE_RAIN)
}

fn phase_from_precip_flag(value: f32) -> Option<u8> {
    if !value.is_finite() {
        return None;
    }
    let code = value.round() as i32;
    let phase = match code {
        -3 | 0 => PHASE_RAIN,
        3 => PHASE_SNOW,
        7 => PHASE_MIXED,
        1 | 6 | 10 | 91 | 96 => PHASE_RAIN,
        _ => PHASE_RAIN,
    };
    Some(phase)
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

fn build_level_key(level_tag: &str, date_part: &str, timestamp: &str) -> String {
    format!(
        "{MRMS_CONUS_PREFIX}/{MRMS_PRODUCT_PREFIX}_{level_tag}/{date_part}/MRMS_{MRMS_PRODUCT_PREFIX}_{level_tag}_{timestamp}.grib2.gz"
    )
}

fn build_aux_key(product: &str, date_part: &str, timestamp: &str) -> String {
    format!("{MRMS_CONUS_PREFIX}/{product}/{date_part}/MRMS_{product}_{timestamp}.grib2.gz")
}

async fn fetch_aux_field_at_timestamp(
    http: &Client,
    product: &str,
    timestamp: &str,
) -> Result<ParsedField> {
    let target = parse_timestamp_utc(timestamp)
        .ok_or_else(|| anyhow!("Invalid target timestamp: {timestamp}"))?;
    let date_part = target.format("%Y%m%d").to_string();
    let key = build_aux_key(product, &date_part, timestamp);
    let url = format!("{MRMS_BUCKET_URL}/{key}");
    let zipped = fetch_bytes(http, &url).await?;
    let parsed = tokio::task::spawn_blocking(move || parse_grib_gzipped(&zipped))
        .await
        .context("Join error while parsing aux GRIB")??;
    Ok(parsed)
}
