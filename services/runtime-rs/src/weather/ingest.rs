use std::collections::HashSet;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_sqs::Client as SqsClient;
use chrono::Utc;
use regex::Regex;
use serde_json::Value;
use tokio::time::sleep;
use tracing::{error, info, warn};

use super::discovery::{extract_timestamp_from_key, find_recent_base_level_keys};
use super::processor::ingest_timestamp;
use super::storage::persist_snapshot;
use crate::constants::{
    MAX_BASE_KEYS_LOOKUP, MAX_PENDING_ATTEMPTS, NOT_FOUND_INITIAL_RETRY_SECONDS,
    NOT_FOUND_MAX_ATTEMPTS,
};
use crate::http_client::HttpStatusError;
use crate::types::{AppState, PendingIngest};

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
                let is_not_found = error.chain().any(|cause| {
                    cause
                        .downcast_ref::<HttpStatusError>()
                        .is_some_and(|e| e.status == 404)
                });
                let (max_attempts, retry_delay) = if is_not_found {
                    // Exponential backoff: 5s, 10s, 20s, … (capped at 3 attempts)
                    let delay = Duration::from_secs(NOT_FOUND_INITIAL_RETRY_SECONDS)
                        * 2u32.pow(pending_entry.attempts);
                    (NOT_FOUND_MAX_ATTEMPTS, delay)
                } else {
                    (MAX_PENDING_ATTEMPTS, state.cfg.pending_retry_delay)
                };

                let next_attempt = pending_entry.attempts + 1;
                warn!(
                    "Ingest attempt {} failed (attempt {}/{}): {error:#}",
                    timestamp, next_attempt, max_attempts,
                );

                if next_attempt < max_attempts {
                    let mut pending = state.pending.lock().await;
                    pending.insert(
                        timestamp,
                        PendingIngest {
                            attempts: next_attempt,
                            next_attempt_at: Instant::now() + retry_delay,
                        },
                    );
                }
            }
        }
    }
}

fn bool_label(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}
