use anyhow::Result;
use chrono::{DateTime, Utc};
use reqwest::Client;

use crate::constants::{
    MAX_BASE_DAY_LOOKBACK, MRMS_BASE_LEVEL_TAG, MRMS_BUCKET_URL, MRMS_CONUS_PREFIX,
    MRMS_PRODUCT_PREFIX,
};
use crate::http_client::fetch_text;

pub async fn find_recent_base_level_keys(
    http: &Client,
    now: DateTime<Utc>,
    limit: usize,
) -> Result<Vec<String>> {
    let mut candidates = Vec::new();

    for day_offset in 0..=MAX_BASE_DAY_LOOKBACK {
        let date = now - chrono::Duration::days(day_offset);
        let day = date.format("%Y%m%d").to_string();
        let prefix =
            format!("{MRMS_CONUS_PREFIX}/{MRMS_PRODUCT_PREFIX}_{MRMS_BASE_LEVEL_TAG}/{day}/");
        let keys = list_keys_for_prefix(http, &prefix).await?;
        let mut filtered: Vec<String> = keys
            .into_iter()
            .filter(|key| is_mrms_grib2_key(key))
            .collect();
        filtered.sort();
        filtered.reverse();

        for key in filtered {
            candidates.push(key);
            if candidates.len() >= limit {
                return Ok(candidates);
            }
        }
    }

    Ok(candidates)
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

        let xml = fetch_text(http, &url).await?;
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

fn is_mrms_grib2_key(key: &str) -> bool {
    key.ends_with(".grib2.gz")
}

pub fn extract_timestamp_from_key(key: &str) -> Option<String> {
    const SUFFIX: &str = ".grib2.gz";
    let stem = key.strip_suffix(SUFFIX)?;
    let underscore_idx = stem.rfind('_')?;
    let timestamp = &stem[underscore_idx + 1..];
    if timestamp.len() != 15 {
        return None;
    }
    let bytes = timestamp.as_bytes();
    if !bytes[..8].iter().all(|ch| ch.is_ascii_digit())
        || bytes[8] != b'-'
        || !bytes[9..].iter().all(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    Some(timestamp.to_string())
}
