use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::Utc;
use tokio::time::Instant;
use tracing::warn;

use crate::constants::{
    AUX_TIMESTAMP_LOOKBACK_DAYS, LEVEL_TIMESTAMP_TOLERANCE_SECONDS, MAX_BASE_DAY_LOOKBACK,
    MRMS_BUCKET_URL, MRMS_CONUS_PREFIX, MRMS_PRODUCT_PREFIX, NEIGHBOR_LOOKUP_EVERY_POLLS,
    PUBLICATION_MIN_WAIT_SECONDS, PUBLICATION_POLL_INTERVAL_MS, PUBLICATION_WINDOW_SECONDS,
};
use super::discovery::extract_timestamp_from_key;
use super::grib::parse_aux_grib_gzipped;
use crate::http_client::{fetch_bytes, fetch_text, is_not_found, HttpStatusError};
use crate::types::{AppState, ParsedAuxField};
use crate::utils::parse_timestamp_utc;

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

async fn parse_aux_grib_with_limit(state: &AppState, zipped: Vec<u8>) -> Result<ParsedAuxField> {
    let permit = state
        .ingest_parse_limiter
        .clone()
        .acquire_owned()
        .await
        .context("Failed to acquire ingest parse limiter permit")?;
    let parsed = tokio::task::spawn_blocking(move || parse_aux_grib_gzipped(&zipped))
        .await
        .context("Join error while parsing aux GRIB")??;
    drop(permit);
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
    let parsed = parse_aux_grib_with_limit(state, zipped).await?;
    Ok(parsed)
}

pub(super) async fn find_latest_level_timestamp_at_or_before(
    state: &AppState,
    product_prefix: &str,
    level_tag: &str,
    target_timestamp: &str,
) -> Option<String> {
    find_latest_timestamp_at_or_before(
        state,
        |day| format!("{MRMS_CONUS_PREFIX}/{product_prefix}_{level_tag}/{day}/"),
        target_timestamp,
    )
    .await
}

pub(super) async fn find_latest_aux_timestamp_at_or_before(
    state: &AppState,
    product: &str,
    target_timestamp: &str,
) -> Option<String> {
    find_latest_timestamp_at_or_before(
        state,
        |day| format!("{MRMS_CONUS_PREFIX}/{product}/{day}/"),
        target_timestamp,
    )
    .await
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

/// The first `max_keys` keys under `prefix` that sort after `start_after`.
async fn list_keys_after(
    state: &AppState,
    prefix: &str,
    start_after: Option<&str>,
    max_keys: usize,
) -> Result<Vec<String>> {
    if let Some(root) = state.cfg.ingest_local_data_dir.as_ref() {
        let mut keys = list_keys_for_prefix_local(root, prefix).await?;
        if !keys.is_empty() || state.cfg.ingest_local_data_offline {
            keys.sort();
            keys.retain(|key| start_after.is_none_or(|after| key.as_str() > after));
            keys.truncate(max_keys);
            return Ok(keys);
        }
    }

    let mut url = format!(
        "{MRMS_BUCKET_URL}/?list-type=2&prefix={}&max-keys={max_keys}",
        urlencoding::encode(prefix)
    );
    if let Some(after) = start_after {
        url.push_str("&start-after=");
        url.push_str(&urlencoding::encode(after));
    }
    let xml = fetch_text(&state.http, &url).await?;
    Ok(parse_xml_tag_values(&xml, "Key"))
}

/// Key of the `level_tag` reflectivity object stamped within the tolerance of
/// `timestamp` (the closest one), if it has been published. Levels of one scan
/// are usually stamped identically but not always, so the base level's stamp
/// cannot be assumed to name every level.
pub(super) async fn find_level_key_near(
    state: &AppState,
    product_prefix: &str,
    level_tag: &str,
    timestamp: &str,
) -> Result<Option<String>> {
    let target = parse_timestamp_utc(timestamp)
        .with_context(|| format!("Invalid scan timestamp {timestamp}"))?;
    let tolerance = chrono::Duration::seconds(LEVEL_TIMESTAMP_TOLERANCE_SECONDS);
    let (earliest, latest) = (target - tolerance, target + tolerance);
    let format_stamp = |at: chrono::DateTime<Utc>| at.format("%Y%m%d-%H%M%S").to_string();

    // Near midnight the window can straddle two day directories.
    let mut days = vec![earliest.format("%Y%m%d").to_string()];
    let last_day = latest.format("%Y%m%d").to_string();
    if days[0] != last_day {
        days.push(last_day);
    }

    let mut closest: Option<(i64, String)> = None;
    for day in days {
        let prefix = format!("{MRMS_CONUS_PREFIX}/{product_prefix}_{level_tag}/{day}/");
        let scan_start = earliest - chrono::Duration::seconds(1);
        let start_after = (scan_start.format("%Y%m%d").to_string() == day).then(|| {
            build_level_key(product_prefix, level_tag, &day, &format_stamp(scan_start))
        });
        // Scans are 120 s apart, so the first few keys after the window's start
        // hold the candidate.
        for key in list_keys_after(state, &prefix, start_after.as_deref(), 4).await? {
            let Some(stamp) = extract_timestamp_from_key(&key) else {
                continue;
            };
            let Some(stamped_at) = parse_timestamp_utc(&stamp) else {
                continue;
            };
            let distance = (stamped_at - target).num_seconds().abs();
            if distance <= LEVEL_TIMESTAMP_TOLERANCE_SECONDS
                && closest.as_ref().is_none_or(|(best, _)| distance < *best)
            {
                closest = Some((distance, key));
            }
        }
    }
    Ok(closest.map(|(_, key)| key))
}

/// Whether a missing object of the scan stamped `key_timestamp` may still be
/// published: the scan is inside its publication window, or its ingest began
/// less than the minimum wait ago (a scan first seen late must still get time
/// for the rest of its levels). Never when offline: a local mirror is final.
fn may_still_publish(key_timestamp: &str, ingest_started: Instant, offline: bool) -> bool {
    !offline
        && (publication_window_open(key_timestamp)
            || ingest_started.elapsed() < Duration::from_secs(PUBLICATION_MIN_WAIT_SECONDS))
}

/// Compressed reflectivity level for the scan stamped `timestamp`: the exact key
/// first, then any neighbor within the stamp tolerance, polled for while the scan
/// may still be publishing (see `may_still_publish`).
///
/// Each poll tries the exact key (a cheap request); the costlier neighbor
/// listing runs right after the first miss, when a permanently off-stamp level
/// shows up on a scan that is already complete, and then every few polls.
pub(super) async fn fetch_reflectivity_level_bytes(
    state: &AppState,
    level_tag: &str,
    timestamp: &str,
    ingest_started: Instant,
) -> Result<Vec<u8>> {
    let date_part = timestamp.split('-').next().unwrap_or_default();
    let exact_key = build_level_key(MRMS_PRODUCT_PREFIX, level_tag, date_part, timestamp);
    let offline = state.cfg.ingest_local_data_offline;
    let polls = AtomicU32::new(0);
    retry_while_unpublished(
        || async {
            match fetch_mrms_key_bytes(state, &exact_key).await {
                Err(error) if is_not_found(&error) => {}
                result => return result,
            }
            let poll = polls.fetch_add(1, Ordering::Relaxed);
            let not_found = || {
                anyhow::Error::from(HttpStatusError {
                    status: 404,
                    url: exact_key.clone(),
                })
            };
            if poll % NEIGHBOR_LOOKUP_EVERY_POLLS != 0 {
                return Err(not_found());
            }
            match find_level_key_near(state, MRMS_PRODUCT_PREFIX, level_tag, timestamp).await {
                Ok(Some(key)) => fetch_mrms_key_bytes(state, &key).await,
                Ok(None) => Err(not_found()),
                // A failed listing does not show the level is absent. While the
                // scan may still be publishing keep polling; once it may not,
                // surface the failure as such so the scan is retried rather than
                // written off as missing.
                Err(error) if may_still_publish(timestamp, ingest_started, offline) => Err(
                    not_found().context(format!("Neighbor lookup for level {level_tag} failed: {error:#}")),
                ),
                Err(error) => {
                    Err(error.context(format!("Neighbor lookup for level {level_tag} failed")))
                }
            }
        },
        || may_still_publish(timestamp, ingest_started, offline),
        Duration::from_millis(PUBLICATION_POLL_INTERVAL_MS),
        None,
    )
    .await
}

pub(super) async fn fetch_mrms_key_bytes(state: &AppState, key: &str) -> Result<Vec<u8>> {
    if let Some(root) = state.cfg.ingest_local_data_dir.as_ref() {
        let local_path = root.join(key);
        match tokio::fs::read(&local_path).await {
            Ok(bytes) => return Ok(bytes),
            Err(error) => {
                if state.cfg.ingest_local_data_offline {
                    // The mirror is authoritative when offline, so a miss is a
                    // 404 exactly like a miss on the bucket.
                    return Err(anyhow::Error::from(HttpStatusError {
                        status: 404,
                        url: key.to_string(),
                    })
                    .context(format!(
                        "Local MRMS mirror miss in offline mode for key {} (path {}): {}",
                        key,
                        local_path.display(),
                        error
                    )));
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

/// Whether objects keyed with `key_timestamp` may still be in flight.
pub(super) fn publication_window_open(key_timestamp: &str) -> bool {
    parse_timestamp_utc(key_timestamp)
        .is_some_and(|scan_time| (Utc::now() - scan_time).num_seconds() < PUBLICATION_WINDOW_SECONDS)
}

/// Fetches `key`, polling while a 404 can still resolve into an object: the key
/// timestamp is inside the publication window. Completed downloads are never
/// repeated, so waiting for the slowest level costs nothing extra. `max_wait`
/// caps the polling for objects the caller can do without.
pub(super) async fn fetch_mrms_key_bytes_when_published(
    state: &AppState,
    key: &str,
    key_timestamp: &str,
    max_wait: Option<Duration>,
) -> Result<Vec<u8>> {
    retry_while_unpublished(
        || fetch_mrms_key_bytes(state, key),
        || publication_window_open(key_timestamp),
        Duration::from_millis(PUBLICATION_POLL_INTERVAL_MS),
        max_wait,
    )
    .await
}

/// Repeats `fetch` every `poll_interval` for as long as it fails with a 404 while
/// `may_still_publish()` holds and `max_wait` (when set) has not run out. Any
/// other outcome, including any other error, is returned as is.
async fn retry_while_unpublished<T, F, Fut>(
    mut fetch: F,
    may_still_publish: impl Fn() -> bool,
    poll_interval: Duration,
    max_wait: Option<Duration>,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let give_up_at = max_wait.map(|wait| Instant::now() + wait);
    loop {
        match fetch().await {
            Err(error)
                if is_not_found(&error)
                    && may_still_publish()
                    && give_up_at.is_none_or(|limit| Instant::now() + poll_interval < limit) =>
            {
                tokio::time::sleep(poll_interval).await;
            }
            result => return result,
        }
    }
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

    fn status_error(status: u16) -> anyhow::Error {
        crate::http_client::HttpStatusError {
            status,
            url: "https://example.test/key".to_string(),
        }
        .into()
    }

    fn scan_timestamp_seconds_ago(seconds: i64) -> String {
        (Utc::now() - chrono::Duration::seconds(seconds))
            .format("%Y%m%d-%H%M%S")
            .to_string()
    }

    #[test]
    fn publication_window_covers_recent_scans_only() {
        assert!(publication_window_open(&scan_timestamp_seconds_ago(10)));
        assert!(publication_window_open(&scan_timestamp_seconds_ago(PUBLICATION_WINDOW_SECONDS - 30)));
        assert!(!publication_window_open(&scan_timestamp_seconds_ago(PUBLICATION_WINDOW_SECONDS + 30)));
        assert!(!publication_window_open("not-a-timestamp"));
    }

    #[tokio::test(start_paused = true)]
    async fn late_scans_still_get_a_minimum_wait_from_the_start_of_their_ingest() {
        let old_scan = scan_timestamp_seconds_ago(PUBLICATION_WINDOW_SECONDS + 60);
        let started = Instant::now();
        // Past the window, but this ingest only just began.
        assert!(may_still_publish(&old_scan, started, false));
        tokio::time::advance(Duration::from_secs(PUBLICATION_MIN_WAIT_SECONDS - 1)).await;
        assert!(may_still_publish(&old_scan, started, false));
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(!may_still_publish(&old_scan, started, false));

        // A scan inside its window keeps polling regardless of how long the ingest has run.
        let fresh = scan_timestamp_seconds_ago(10);
        assert!(may_still_publish(&fresh, started, false));
    }

    #[tokio::test(start_paused = true)]
    async fn an_offline_mirror_is_final() {
        let fresh = scan_timestamp_seconds_ago(1);
        assert!(!may_still_publish(&fresh, Instant::now(), true));
    }

    #[tokio::test(start_paused = true)]
    async fn polls_until_the_object_appears_without_repeating_finished_work() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let started = Instant::now();
        let body = retry_while_unpublished(
            || async {
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 3 {
                    Err(status_error(404))
                } else {
                    Ok("level bytes")
                }
            },
            || true,
            Duration::from_millis(1_500),
            None,
        )
        .await
        .unwrap();
        assert_eq!(body, "level bytes");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 4);
        assert_eq!(started.elapsed(), Duration::from_millis(4_500));
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_with_the_404_once_the_window_closes() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let error = retry_while_unpublished::<(), _, _>(
            || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(status_error(404))
            },
            // Open for the first two checks, then closed.
            || calls.load(std::sync::atomic::Ordering::SeqCst) < 3,
            Duration::from_millis(1_500),
            None,
        )
        .await
        .unwrap_err();
        assert!(is_not_found(&error));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_poll_when_the_window_is_already_closed() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let error = retry_while_unpublished::<(), _, _>(
            || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(status_error(404))
            },
            || false,
            Duration::from_millis(1_500),
            None,
        )
        .await
        .unwrap_err();
        assert!(is_not_found(&error));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn max_wait_caps_the_polling() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let started = Instant::now();
        let error = retry_while_unpublished::<(), _, _>(
            || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(status_error(404))
            },
            || true,
            Duration::from_secs(1),
            Some(Duration::from_millis(3_500)),
        )
        .await
        .unwrap_err();
        assert!(is_not_found(&error));
        // Attempts at 0, 1, 2 and 3 s; a fifth would start after the 3.5 s cap.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 4);
        assert!(started.elapsed() <= Duration::from_millis(3_500));
    }

    #[tokio::test(start_paused = true)]
    async fn other_errors_are_returned_immediately() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let error = retry_while_unpublished::<(), _, _>(
            || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(status_error(403))
            },
            || true,
            Duration::from_secs(1),
            None,
        )
        .await
        .unwrap_err();
        assert!(!is_not_found(&error));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
