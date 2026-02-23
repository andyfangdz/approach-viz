use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tracing::{debug, warn};

use crate::constants::{
    AUX_TIMESTAMP_LOOKBACK_DAYS, MAX_BASE_DAY_LOOKBACK, MRMS_BUCKET_URL, MRMS_CONUS_PREFIX,
};
use crate::discovery::extract_timestamp_from_key;
use crate::grib::{parse_aux_grib_gzipped, parse_reflectivity_grib_gzipped};
use crate::http_client::{fetch_bytes, fetch_text};
use crate::types::{AppState, AuxTimestampCacheEntry, ParsedAuxField, ParsedReflectivityField};
use crate::utils::parse_timestamp_utc;

const AUX_TIMESTAMP_CACHE_TTL: Duration = Duration::from_secs(45);
const AUX_TIMESTAMP_CACHE_MAX_ENTRIES: usize = 4096;

pub(super) fn build_level_key(
    product_prefix: &str,
    level_tag: &str,
    date_part: &str,
    timestamp: &str,
) -> String {
    format!(
        "{MRMS_CONUS_PREFIX}/{product_prefix}_{level_tag}/{date_part}/MRMS_{product_prefix}_{level_tag}_{timestamp}.grib2.gz"
    )
}

pub(super) async fn parse_reflectivity_grib_with_limit(
    state: &AppState,
    zipped: Vec<u8>,
    decode_label: &str,
) -> Result<ParsedReflectivityField> {
    let queued_at = Instant::now();
    let permit = state
        .ingest_parse_limiter
        .clone()
        .acquire_owned()
        .await
        .context("Failed to acquire ingest parse limiter permit")?;
    let queue_wait_ms = queued_at.elapsed().as_millis() as u64;
    let payload_bytes = zipped.len() as u64;
    let decode_started = Instant::now();
    let parsed = tokio::task::spawn_blocking(move || parse_reflectivity_grib_gzipped(&zipped))
        .await
        .context("Join error while parsing level GRIB")??;
    let decode_ms = decode_started.elapsed().as_millis() as u64;
    debug!(
        target: "mrms_decode_timing",
        label = decode_label,
        payload_bytes,
        queue_wait_ms,
        decode_ms,
        "MRMS reflectivity decode complete"
    );
    drop(permit);
    Ok(parsed)
}

async fn parse_aux_grib_with_limit(
    state: &AppState,
    zipped: Vec<u8>,
    decode_label: &str,
) -> Result<ParsedAuxField> {
    let queued_at = Instant::now();
    let permit = state
        .ingest_parse_limiter
        .clone()
        .acquire_owned()
        .await
        .context("Failed to acquire ingest parse limiter permit")?;
    let queue_wait_ms = queued_at.elapsed().as_millis() as u64;
    let payload_bytes = zipped.len() as u64;
    let decode_started = Instant::now();
    let parsed = tokio::task::spawn_blocking(move || parse_aux_grib_gzipped(&zipped))
        .await
        .context("Join error while parsing aux GRIB")??;
    let decode_ms = decode_started.elapsed().as_millis() as u64;
    debug!(
        target: "mrms_decode_timing",
        label = decode_label,
        payload_bytes,
        queue_wait_ms,
        decode_ms,
        "MRMS aux decode complete"
    );
    drop(permit);
    Ok(parsed)
}

pub(super) async fn fetch_level_aux_field_at_timestamp(
    state: &AppState,
    product_prefix: &str,
    level_tag: &str,
    date_part: &str,
    timestamp: &str,
) -> Result<ParsedAuxField> {
    let key = build_level_key(product_prefix, level_tag, date_part, timestamp);
    let zipped = fetch_mrms_key_bytes(state, &key).await?;
    let decode_label = format!("aux_level:{product_prefix}:{level_tag}");
    let parsed = parse_aux_grib_with_limit(state, zipped, &decode_label).await?;
    Ok(parsed)
}

fn build_aux_key(product: &str, date_part: &str, timestamp: &str) -> String {
    format!("{MRMS_CONUS_PREFIX}/{product}/{date_part}/MRMS_{product}_{timestamp}.grib2.gz")
}

pub(super) async fn fetch_aux_field_at_timestamp(
    state: &AppState,
    product: &str,
    date_part: &str,
    timestamp: &str,
) -> Result<ParsedAuxField> {
    let key = build_aux_key(product, date_part, timestamp);
    let zipped = fetch_mrms_key_bytes(state, &key).await?;
    let decode_label = format!("aux:{product}");
    let parsed = parse_aux_grib_with_limit(state, zipped, &decode_label).await?;
    Ok(parsed)
}

pub(super) async fn find_latest_level_timestamp_at_or_before(
    state: &AppState,
    product_prefix: &str,
    level_tag: &str,
    target_timestamp: &str,
) -> Option<String> {
    let cache_key = format!("level:{product_prefix}:{level_tag}:{target_timestamp}");
    if let Some(cached) = aux_timestamp_cache_get(state, &cache_key).await {
        return cached;
    }

    let resolved = find_latest_timestamp_at_or_before(
        state,
        |day| format!("{MRMS_CONUS_PREFIX}/{product_prefix}_{level_tag}/{day}/"),
        target_timestamp,
    )
    .await;
    aux_timestamp_cache_insert(state, &cache_key, resolved.clone()).await;
    resolved
}

pub(super) async fn find_latest_aux_timestamp_at_or_before(
    state: &AppState,
    product: &str,
    target_timestamp: &str,
) -> Option<String> {
    let cache_key = format!("aux:{product}:{target_timestamp}");
    if let Some(cached) = aux_timestamp_cache_get(state, &cache_key).await {
        return cached;
    }

    let resolved = find_latest_timestamp_at_or_before(
        state,
        |day| format!("{MRMS_CONUS_PREFIX}/{product}/{day}/"),
        target_timestamp,
    )
    .await;
    aux_timestamp_cache_insert(state, &cache_key, resolved.clone()).await;
    resolved
}

async fn find_latest_timestamp_at_or_before<F>(
    state: &AppState,
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
        let keys = match list_keys_for_prefix(state, &prefix).await {
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

async fn list_keys_for_prefix(state: &AppState, prefix: &str) -> Result<Vec<String>> {
    if let Some(root) = state.cfg.ingest_local_data_dir.as_ref() {
        let keys = list_keys_for_prefix_local(root, prefix).await?;
        if !keys.is_empty() || state.cfg.ingest_local_data_offline {
            return Ok(keys);
        }
    }

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

        let xml = fetch_text(&state.http, &url).await?;
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

pub(super) async fn fetch_mrms_key_bytes(state: &AppState, key: &str) -> Result<Vec<u8>> {
    if let Some(root) = state.cfg.ingest_local_data_dir.as_ref() {
        let local_path = root.join(key);
        match tokio::fs::read(&local_path).await {
            Ok(bytes) => return Ok(bytes),
            Err(error) => {
                if state.cfg.ingest_local_data_offline {
                    bail!(
                        "Local MRMS mirror miss in offline mode for key {} (path {}): {}",
                        key,
                        local_path.display(),
                        error
                    );
                }
            }
        }
    }

    let url = format!("{MRMS_BUCKET_URL}/{key}");
    let bytes = fetch_bytes(&state.http, &url).await?;

    if let Some(root) = state.cfg.ingest_local_data_dir.as_ref() {
        let local_path = root.join(key);
        if let Some(parent) = local_path.parent() {
            if let Err(error) = tokio::fs::create_dir_all(parent).await {
                warn!(
                    "Failed creating local MRMS mirror directory {}: {}",
                    parent.display(),
                    error
                );
            }
        }
        if let Err(error) = tokio::fs::write(&local_path, &bytes).await {
            warn!(
                "Failed writing local MRMS mirror file {}: {}",
                local_path.display(),
                error
            );
        }
    }

    Ok(bytes)
}

async fn list_keys_for_prefix_local(root: &Path, prefix: &str) -> Result<Vec<String>> {
    let root = root.to_path_buf();
    let prefix = prefix.to_string();
    tokio::task::spawn_blocking(move || list_keys_for_prefix_local_blocking(&root, &prefix))
        .await
        .context("Join error while listing local MRMS mirror keys")?
}

fn list_keys_for_prefix_local_blocking(root: &Path, prefix: &str) -> Result<Vec<String>> {
    let prefix_dir = root.join(prefix);
    if !prefix_dir.exists() {
        return Ok(Vec::new());
    }

    let mut stack: Vec<PathBuf> = vec![prefix_dir];
    let mut keys = Vec::new();
    while let Some(path) = stack.pop() {
        let entries = std::fs::read_dir(&path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        for entry in entries {
            let entry =
                entry.with_context(|| format!("Failed reading entry in {}", path.display()))?;
            let entry_path = entry.path();
            let file_type = entry.file_type().with_context(|| {
                format!("Failed reading file type for {}", entry_path.display())
            })?;
            if file_type.is_dir() {
                stack.push(entry_path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            if !entry_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".grib2.gz"))
            {
                continue;
            }

            let relative = entry_path
                .strip_prefix(root)
                .with_context(|| format!("Failed strip_prefix for {}", entry_path.display()))?;
            keys.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }

    Ok(keys)
}

fn parse_xml_tag_values(xml: &str, tag_name: &str) -> Vec<String> {
    let start_tag = format!("<{tag_name}>");
    let end_tag = format!("</{tag_name}>");
    let mut values = Vec::new();
    let mut cursor = 0usize;

    while let Some(start_idx) = xml[cursor..].find(&start_tag) {
        let value_start = cursor + start_idx + start_tag.len();
        let Some(end_idx_rel) = xml[value_start..].find(&end_tag) else {
            break;
        };
        let value_end = value_start + end_idx_rel;
        values.push(xml[value_start..value_end].to_string());
        cursor = value_end + end_tag.len();
    }

    values
}

fn parse_xml_tag_value(xml: &str, tag_name: &str) -> Option<String> {
    parse_xml_tag_values(xml, tag_name).into_iter().next()
}

pub(super) fn timestamp_age_seconds(newer_timestamp: &str, older_timestamp: &str) -> Option<i64> {
    let newer = parse_timestamp_utc(newer_timestamp)?;
    let older = parse_timestamp_utc(older_timestamp)?;
    Some((newer - older).num_seconds().max(0))
}

async fn aux_timestamp_cache_get(state: &AppState, key: &str) -> Option<Option<String>> {
    let now = Instant::now();
    let mut cache = state.aux_timestamp_cache.lock().await;
    prune_aux_timestamp_cache(&mut cache, now);
    let value = cache.get(key).map(|entry| entry.value.clone());
    if let Some(ref cached_value) = value {
        debug!(
            target: "mrms_aux_timestamp_cache",
            key,
            has_value = cached_value.is_some(),
            "Aux timestamp cache hit"
        );
    }
    value
}

async fn aux_timestamp_cache_insert(state: &AppState, key: &str, value: Option<String>) {
    let now = Instant::now();
    let mut cache = state.aux_timestamp_cache.lock().await;
    prune_aux_timestamp_cache(&mut cache, now);
    if cache.len() >= AUX_TIMESTAMP_CACHE_MAX_ENTRIES {
        let oldest_key = cache
            .iter()
            .min_by_key(|(_key, entry)| entry.cached_at)
            .map(|(entry_key, _entry)| entry_key.clone());
        if let Some(entry_key) = oldest_key {
            cache.remove(&entry_key);
        }
    }
    cache.insert(
        key.to_string(),
        AuxTimestampCacheEntry {
            value,
            cached_at: now,
        },
    );
}

fn prune_aux_timestamp_cache(
    cache: &mut std::collections::HashMap<String, AuxTimestampCacheEntry>,
    now: Instant,
) {
    cache.retain(|_key, entry| now.duration_since(entry.cached_at) <= AUX_TIMESTAMP_CACHE_TTL);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        MRMS_PRODUCT_PREFIX, MRMS_RHOHV_PRODUCT_PREFIX, MRMS_ZDR_PRODUCT_PREFIX,
    };

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
