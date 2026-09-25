use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_sqs::types::DeleteMessageBatchRequestEntry;
use aws_sdk_sqs::Client as SqsClient;
use chrono::Utc;
use regex::Regex;
use serde_json::Value;
use tokio::sync::watch;
use tokio::time::sleep;
use tracing::{error, info, warn};

use super::discovery::{extract_timestamp_from_key, find_recent_base_level_keys};
use super::edge_publish::spawn_edge_publish_worker;
use super::processor::ingest_timestamp;
use super::storage::persist_snapshot;
use crate::config::Config;
use crate::constants::{MAX_BASE_KEYS_LOOKUP, MAX_PENDING_ATTEMPTS};
use crate::http_client::is_not_found;
use crate::types::{AppState, PendingIngest, ScanSnapshot};

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
        let (voxel_fp, meta_fp) = scan_fingerprint(&scan);
        info!("Scan fingerprint: voxels={voxel_fp:016x} meta={meta_fp:016x}");
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

        let mut delete_entries = Vec::with_capacity(messages.len());
        for (index, message) in messages.iter().enumerate() {
            let mut extracted_timestamps = Vec::new();
            if let Some(body) = message.body() {
                extracted_timestamps = extract_timestamps_from_sqs_body(body, &base_key_regex);
            }

            for timestamp in extracted_timestamps {
                enqueue_timestamp(&state, &timestamp).await;
            }

            if let Some(receipt_handle) = message.receipt_handle() {
                match DeleteMessageBatchRequestEntry::builder()
                    .id(index.to_string())
                    .receipt_handle(receipt_handle)
                    .build()
                {
                    Ok(entry) => delete_entries.push(entry),
                    Err(error) => warn!("Failed to build SQS batch delete entry: {error}"),
                }
            }
        }

        // One batch delete per receive keeps SQS request volume at ~2 calls per
        // poll cycle instead of 1 + N (deletes are billed per API call).
        if !delete_entries.is_empty() {
            match sqs_client
                .delete_message_batch()
                .queue_url(queue_url)
                .set_entries(Some(delete_entries))
                .send()
                .await
            {
                Ok(result) => {
                    for failure in result.failed() {
                        warn!(
                            "Failed to delete SQS message (id={}, code={}): {}",
                            failure.id(),
                            failure.code(),
                            failure.message().unwrap_or("no detail"),
                        );
                    }
                }
                Err(error) => warn!("SQS delete_message_batch failed: {error}"),
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

/// Persists snapshots on its own task so a new scan is served as soon as it is
/// assembled instead of after the (multi-second) serialize + compress + write.
/// The channel keeps only the newest scan: if persisting falls behind, scans it
/// never got to are superseded rather than queued.
fn spawn_persist_worker(cfg: Arc<Config>) -> watch::Sender<Option<Arc<ScanSnapshot>>> {
    let (sender, mut receiver) = watch::channel::<Option<Arc<ScanSnapshot>>>(None);
    tokio::spawn(async move {
        while receiver.changed().await.is_ok() {
            let Some(scan) = receiver.borrow_and_update().clone() else {
                continue;
            };
            if let Err(error) = persist_snapshot(&cfg, scan.clone()).await {
                error!("Failed to persist scan {}: {error:#}", scan.timestamp);
            }
        }
    });
    sender
}

async fn mark_handled(state: &AppState, timestamp: &str) {
    let mut recent = state.recent_timestamps.lock().await;
    recent.insert(timestamp.to_string());
    if recent.len() > 512 {
        if let Some(first) = recent.iter().next().cloned() {
            recent.remove(&first);
        }
    }
}

/// The pending timestamp to ingest next: the newest one that is due.
fn next_due_timestamp(
    pending: &std::collections::HashMap<String, PendingIngest>,
    now: Instant,
) -> Option<String> {
    pending
        .iter()
        .filter(|(_, entry)| entry.next_attempt_at <= now)
        .map(|(timestamp, _)| timestamp)
        .max()
        .cloned()
}

async fn ingest_scheduler_loop(state: AppState) {
    let persist_sender = spawn_persist_worker(state.cfg.clone());
    let edge_sender = state
        .cfg
        .edge_publish
        .clone()
        .map(spawn_edge_publish_worker);
    if let Some(sender) = &edge_sender {
        // Publish the snapshot loaded at startup; the publisher skips it when
        // the bucket already holds the same or a newer scan.
        if let Some(scan) = state.latest.read().await.clone() {
            sender.send_replace(Some(scan));
        }
    }
    loop {
        // Newest due timestamp first: a live product only wants the latest scan,
        // and finishing it drops every older pending timestamp (see below), so
        // a backlog (cold start, long outage) costs one ingest instead of one
        // per missed scan.
        let candidate = {
            let mut pending = state.pending.lock().await;
            let selected = next_due_timestamp(&pending, Instant::now());
            selected.and_then(|timestamp| {
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

                mark_handled(&state, &scan.timestamp).await;

                {
                    let mut pending = state.pending.lock().await;
                    pending.retain(|timestamp, _| timestamp > &scan.timestamp);
                }

                if let Some(sender) = &edge_sender {
                    sender.send_replace(Some(scan.clone()));
                }
                persist_sender.send_replace(Some(scan));
            }
            Err(error) if is_not_found(&error) => {
                // Missing objects are awaited for the whole publication window
                // inside the ingest, so a 404 that survives is permanent (or the
                // scan was already past the window). Retrying would re-download
                // every level that is present for the same result, and the
                // bootstrap poll must not queue it again.
                warn!("Skipping MRMS scan {timestamp}: {error:#}");
                mark_handled(&state, &timestamp).await;
                state.pending.lock().await.remove(&timestamp);
            }
            Err(error) => {
                let next_attempt = pending_entry.attempts + 1;
                warn!(
                    "Ingest attempt {} failed (attempt {}/{}): {error:#}",
                    timestamp, next_attempt, MAX_PENDING_ATTEMPTS,
                );

                if next_attempt < MAX_PENDING_ATTEMPTS {
                    let mut pending = state.pending.lock().await;
                    pending.insert(
                        timestamp,
                        PendingIngest {
                            attempts: next_attempt,
                            next_attempt_at: Instant::now() + state.cfg.pending_retry_delay,
                        },
                    );
                }
            }
        }
    }
}

/// Order-sensitive digests of a scan (voxels; everything else) so profiling runs
/// can prove an optimization left the produced snapshot unchanged.
fn scan_fingerprint(scan: &crate::types::ScanSnapshot) -> (u64, u64) {
    use std::hash::Hasher;
    let mut voxels = rustc_hash::FxHasher::default();
    for v in &scan.voxels {
        voxels.write_u16(v.row);
        voxels.write_u16(v.col);
        voxels.write_u8(v.level_idx);
        voxels.write_u8(v.phase);
        voxels.write_u8(v.surface_phase);
        voxels.write_i16(v.dbz_tenths);
    }
    let mut meta = rustc_hash::FxHasher::default();
    for e in &scan.echo_tops {
        meta.write_u16(e.row);
        meta.write_u16(e.col);
        meta.write_u16(e.top18_feet);
        meta.write_u16(e.top30_feet);
        meta.write_u16(e.top50_feet);
        meta.write_u16(e.top60_feet);
    }
    for o in &scan.tile_offsets {
        meta.write_u32(*o);
    }
    for b in &scan.level_bounds {
        meta.write_u16(b.bottom_feet);
        meta.write_u16(b.top_feet);
    }
    meta.write(format!("{:?}|{:?}|{:?}|{}|{}|{}", scan.grid, scan.echo_top_debug, scan.phase_debug, scan.tile_size, scan.tile_cols, scan.tile_rows).as_bytes());
    (voxels.finish(), meta.finish())
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
    use std::collections::HashMap;

    fn pending(entries: &[(&str, Duration)], now: Instant) -> HashMap<String, PendingIngest> {
        entries
            .iter()
            .map(|(timestamp, due_in)| {
                (
                    timestamp.to_string(),
                    PendingIngest {
                        attempts: 0,
                        next_attempt_at: now + *due_in,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn newest_due_timestamp_is_ingested_first() {
        let now = Instant::now();
        let queue = pending(
            &[
                ("20260923-200000", Duration::ZERO),
                ("20260923-201442", Duration::ZERO),
                ("20260923-200240", Duration::ZERO),
            ],
            now,
        );
        assert_eq!(next_due_timestamp(&queue, now).as_deref(), Some("20260923-201442"));
    }

    #[test]
    fn timestamps_that_are_not_due_yet_are_skipped() {
        let now = Instant::now();
        let queue = pending(
            &[
                ("20260923-201442", Duration::from_secs(30)),
                ("20260923-200240", Duration::ZERO),
            ],
            now,
        );
        assert_eq!(next_due_timestamp(&queue, now).as_deref(), Some("20260923-200240"));
        assert_eq!(next_due_timestamp(&queue, now + Duration::from_secs(30)).as_deref(), Some("20260923-201442"));
    }

    #[test]
    fn nothing_is_selected_when_nothing_is_due() {
        let now = Instant::now();
        assert_eq!(next_due_timestamp(&HashMap::new(), now), None);
        let queue = pending(&[("20260923-201442", Duration::from_secs(5))], now);
        assert_eq!(next_due_timestamp(&queue, now), None);
    }

    #[test]
    fn sqs_bodies_yield_base_level_timestamps_only() {
        let regex = Regex::new(r#"MergedReflectivityQC_00\.50[^\s"']*_(\d{8}-\d{6})\.grib2\.gz"#).unwrap();
        let body = r#"{"Message":"{\"Records\":[{\"s3\":{\"object\":{\"key\":\"CONUS/MergedReflectivityQC_00.50/20260923/MRMS_MergedReflectivityQC_00.50_20260923-201442.grib2.gz\"}}}]}"}"#;
        assert_eq!(extract_timestamps_from_sqs_body(body, &regex), vec!["20260923-201442"]);
        let other = r#"{"Message":"CONUS/MergedReflectivityQC_03.00/20260923/MRMS_MergedReflectivityQC_03.00_20260923-201442.grib2.gz"}"#;
        assert!(extract_timestamps_from_sqs_body(other, &regex).is_empty());
    }
}
