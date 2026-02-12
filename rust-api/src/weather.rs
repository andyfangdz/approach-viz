use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Timelike, Utc};
use flate2::read::GzDecoder;
use futures::future::join_all;
use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
    time::Duration as StdDuration,
};

use crate::AppState;

const MRMS_BUCKET_URL: &str = "https://noaa-mrms-pds.s3.amazonaws.com";
const MRMS_CONUS_PREFIX: &str = "CONUS";
const MRMS_PRODUCT_PREFIX: &str = "MergedReflectivityQC";
const MRMS_PRECIP_FLAG_PRODUCT: &str = "PrecipFlag_00.00";
const MRMS_MODEL_FREEZING_HEIGHT_PRODUCT: &str = "Model_0degC_Height_00.50";
const MRMS_BASE_LEVEL_TAG: &str = "00.50";
const MRMS_LEVEL_TAGS: [&str; 33] = [
    "00.50", "00.75", "01.00", "01.25", "01.50", "01.75", "02.00", "02.25", "02.50", "02.75",
    "03.00", "03.50", "04.00", "04.50", "05.00", "05.50", "06.00", "06.50", "07.00", "07.50",
    "08.00", "08.50", "09.00", "10.00", "11.00", "12.00", "13.00", "14.00", "15.00", "16.00",
    "17.00", "18.00", "19.00",
];
const MRMS_REQUEST_TIMEOUT_MS: u64 = 18000;
const CACHE_TTL_MS: i64 = 75_000;
const MIN_DBZ_DEFAULT: f64 = 20.0;
const MAX_RANGE_DEFAULT_NM: f64 = 120.0;
const MAX_VOXELS_DEFAULT: usize = 12_000;
const MAX_BASE_KEY_CANDIDATES: usize = 6;
const LEVEL_TIMESTAMP_CACHE_TTL_MS: i64 = 120_000;
const AUX_PRECIP_FLAG_LOOKBACK_STEPS: usize = 15;
const AUX_MODEL_LOOKBACK_STEPS: usize = 24;
const PRECIP_FLAG_STEP_SECONDS: i64 = 120;
const MODEL_STEP_SECONDS: i64 = 3600;
const FEET_PER_KM: f64 = 3280.84;
const FEET_PER_METER: f64 = 3.28084;
const METERS_TO_NM: f64 = 1.0 / 1852.0;
const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.0;
const WGS84_SEMI_MAJOR_METERS: f64 = 6378137.0;
const WGS84_FLATTENING: f64 = 1.0 / 298.257223563;
const WGS84_E2: f64 = WGS84_FLATTENING * (2.0 - WGS84_FLATTENING);
const PHASE_RAIN: i32 = 0;
const PHASE_MIXED: i32 = 1;
const PHASE_SNOW: i32 = 2;
const FREEZING_LEVEL_TRANSITION_FEET: f64 = 1500.0;

fn parse_env_usize(name: &str, default_value: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default_value)
}
#[derive(Debug, Clone)]
pub(crate) struct CacheEntry {
    expires_at_ms: i64,
    payload: NexradVolumePayload,
}

#[derive(Debug, Clone)]
pub(crate) struct MrmsLevelTimestampCacheEntry {
    expires_at_ms: i64,
    timestamps: HashSet<String>,
}

#[derive(Debug, Clone)]
struct MrmsTimestampCandidate {
    date_part: String,
    timestamp: String,
}

#[derive(Debug, Clone)]
struct ParsedMrmsGrid {
    nx: usize,
    ny: usize,
    la1_deg: f64,
    lo1_deg360: f64,
    di_deg: f64,
    dj_deg: f64,
    scanning_mode: u8,
}

#[derive(Debug, Clone)]
struct ParsedMrmsPacking {
    data_point_count: usize,
    reference_value: f64,
    binary_scale_factor: i16,
    decimal_scale_factor: i16,
}

#[derive(Debug, Clone)]
enum MrmsValues {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

impl MrmsValues {
    fn len(&self) -> usize {
        match self {
            Self::U8(values) => values.len(),
            Self::U16(values) => values.len(),
        }
    }

    fn at(&self, index: usize) -> Option<u32> {
        match self {
            Self::U8(values) => values.get(index).copied().map(u32::from),
            Self::U16(values) => values.get(index).copied().map(u32::from),
        }
    }
}

#[derive(Debug, Clone)]
struct ParsedMrmsField {
    grid: ParsedMrmsGrid,
    packing: ParsedMrmsPacking,
    values: MrmsValues,
}

#[derive(Debug, Clone)]
struct ParsedMrmsLevel {
    level_tag: String,
    level_km: f64,
    key: String,
    parsed: ParsedMrmsField,
}

#[derive(Debug, Clone)]
struct ParsedMrmsAuxField {
    parsed: ParsedMrmsField,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NexradLayerSummary {
    product: String,
    elevation_angle_deg: f64,
    source_key: String,
    scan_time: String,
    voxel_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NexradRadarPayload {
    id: String,
    name: String,
    lat: f64,
    lon: f64,
    elevation_feet: f64,
}

type NexradVoxelTuple = (f64, f64, i64, i64, f64, f64, f64, i32);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NexradVolumePayload {
    generated_at: String,
    radar: Option<NexradRadarPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    radars: Option<Vec<NexradRadarPayload>>,
    layer_summaries: Vec<NexradLayerSummary>,
    voxels: Vec<NexradVoxelTuple>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
fn no_store_response<T: Serialize>(
    status: StatusCode,
    payload: &T,
    max_age_zero: bool,
) -> Response {
    let mut response = (status, Json(payload)).into_response();
    let cache_value = if max_age_zero {
        "no-store, max-age=0"
    } else {
        "no-store"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_value));
    response
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn to_finite_number(input: Option<&String>) -> Option<f64> {
    let value = input?.trim();
    if value.is_empty() {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite())
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.min(max).max(min)
}

fn clamp_i64(value: i64, min: i64, max: i64) -> i64 {
    value.min(max).max(min)
}
async fn fetch_with_timeout(
    state: &AppState,
    url: &str,
    timeout_ms: u64,
    headers: Option<HeaderMap>,
) -> anyhow::Result<reqwest::Response> {
    let mut request = state
        .client
        .get(url)
        .timeout(StdDuration::from_millis(timeout_ms));

    let mut merged_headers = HeaderMap::new();
    merged_headers.insert(header::ACCEPT, HeaderValue::from_static("*/*"));
    merged_headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static("approach-viz/1.0"),
    );
    if let Some(overrides) = headers {
        for (key, value) in overrides {
            if let Some(key) = key {
                merged_headers.insert(key, value);
            }
        }
    }
    request = request.headers(merged_headers);

    let response = request.send().await?;
    Ok(response)
}

async fn fetch_text(state: &AppState, url: &str) -> anyhow::Result<String> {
    let response = fetch_with_timeout(state, url, MRMS_REQUEST_TIMEOUT_MS, None).await?;
    if !response.status().is_success() {
        anyhow::bail!("Request failed ({}) for {url}", response.status().as_u16());
    }
    Ok(response.text().await?)
}

async fn fetch_buffer(state: &AppState, url: &str) -> anyhow::Result<Vec<u8>> {
    let response = fetch_with_timeout(state, url, MRMS_REQUEST_TIMEOUT_MS, None).await?;
    if !response.status().is_success() {
        anyhow::bail!("Request failed ({}) for {url}", response.status().as_u16());
    }
    Ok(response.bytes().await?.to_vec())
}

fn parse_tag_values(xml: &str, tag_name: &str) -> Vec<String> {
    let open = format!("<{tag_name}>");
    let close = format!("</{tag_name}>");
    let mut values = Vec::new();
    let mut cursor = 0usize;

    while let Some(start_rel) = xml[cursor..].find(&open) {
        let start = cursor + start_rel + open.len();
        let Some(end_rel) = xml[start..].find(&close) else {
            break;
        };
        let end = start + end_rel;
        values.push(xml[start..end].to_string());
        cursor = end + close.len();
    }

    values
}

fn parse_tag_value(xml: &str, tag_name: &str) -> Option<String> {
    parse_tag_values(xml, tag_name).into_iter().next()
}

async fn list_keys_for_prefix(state: &AppState, prefix: &str) -> anyhow::Result<Vec<String>> {
    let mut keys = Vec::new();
    let mut continuation_token: Option<String> = None;

    for _ in 0..4 {
        let mut url = reqwest::Url::parse(MRMS_BUCKET_URL)?;
        url.query_pairs_mut()
            .append_pair("list-type", "2")
            .append_pair("prefix", prefix)
            .append_pair("max-keys", "1000");
        if let Some(token) = continuation_token.as_ref() {
            url.query_pairs_mut()
                .append_pair("continuation-token", token);
        }

        let xml = fetch_text(state, url.as_str()).await?;
        keys.extend(parse_tag_values(&xml, "Key"));

        let is_truncated = parse_tag_value(&xml, "IsTruncated")
            .map(|value| value == "true")
            .unwrap_or(false);
        if !is_truncated {
            break;
        }

        continuation_token = parse_tag_value(&xml, "NextContinuationToken");
        if continuation_token.is_none() {
            break;
        }
    }

    Ok(keys)
}

fn is_mrms_grib2_key(key: &str) -> bool {
    key.ends_with(".grib2.gz")
}

fn format_date_compact_utc(date: DateTime<Utc>) -> String {
    format!("{:04}{:02}{:02}", date.year(), date.month(), date.day())
}

async fn find_recent_base_level_keys(
    state: &AppState,
    now: DateTime<Utc>,
    limit: usize,
) -> anyhow::Result<Vec<String>> {
    let mut candidates = Vec::new();

    for day_offset in 0..=1 {
        let date = now - Duration::days(day_offset);
        let day = format_date_compact_utc(date);
        let prefix =
            format!("{MRMS_CONUS_PREFIX}/{MRMS_PRODUCT_PREFIX}_{MRMS_BASE_LEVEL_TAG}/{day}/");
        let mut keys = list_keys_for_prefix(state, &prefix)
            .await?
            .into_iter()
            .filter(|key| is_mrms_grib2_key(key))
            .collect::<Vec<_>>();

        if keys.is_empty() {
            continue;
        }

        keys.sort();
        for key in keys.into_iter().rev() {
            candidates.push(key);
            if candidates.len() >= limit {
                return Ok(candidates);
            }
        }
    }

    Ok(candidates)
}

fn extract_date_from_key(key: &str) -> Option<String> {
    let segments = key.split('/').collect::<Vec<_>>();
    for segment in segments {
        if segment.len() == 8 && segment.chars().all(|ch| ch.is_ascii_digit()) {
            return Some(segment.to_string());
        }
    }
    None
}

fn extract_timestamp_from_key(key: &str) -> Option<String> {
    let suffix = ".grib2.gz";
    if !key.ends_with(suffix) {
        return None;
    }
    let without_suffix = &key[..key.len() - suffix.len()];
    let index = without_suffix.rfind('_')?;
    let timestamp = &without_suffix[index + 1..];
    if timestamp.len() != 15 {
        return None;
    }

    let (date, time) = timestamp.split_once('-')?;
    if date.len() != 8 || time.len() != 6 {
        return None;
    }
    if !date.chars().all(|ch| ch.is_ascii_digit()) || !time.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(timestamp.to_string())
}

fn build_level_timestamp_cache_key(level_tag: &str, date_part: &str) -> String {
    format!("{level_tag}:{date_part}")
}

async fn cleanup_expired_level_timestamp_cache_entries(state: &AppState, now_ms: i64) {
    let mut cache = state.level_timestamp_cache.write().await;
    cache.retain(|_, entry| entry.expires_at_ms > now_ms);
}

async fn fetch_level_timestamps_for_date(
    state: &AppState,
    level_tag: &str,
    date_part: &str,
) -> anyhow::Result<HashSet<String>> {
    let cache_key = build_level_timestamp_cache_key(level_tag, date_part);
    let now_ms = now_ms();

    if let Some(entry) = state
        .level_timestamp_cache
        .read()
        .await
        .get(&cache_key)
        .cloned()
    {
        if entry.expires_at_ms > now_ms {
            return Ok(entry.timestamps);
        }
    }

    let prefix = format!("{MRMS_CONUS_PREFIX}/{MRMS_PRODUCT_PREFIX}_{level_tag}/{date_part}/");
    let keys = list_keys_for_prefix(state, &prefix).await?;

    let mut timestamps = HashSet::new();
    for key in keys {
        if !is_mrms_grib2_key(&key) {
            continue;
        }
        if let Some(timestamp) = extract_timestamp_from_key(&key) {
            timestamps.insert(timestamp);
        }
    }

    state.level_timestamp_cache.write().await.insert(
        cache_key,
        MrmsLevelTimestampCacheEntry {
            expires_at_ms: now_ms + LEVEL_TIMESTAMP_CACHE_TTL_MS,
            timestamps: timestamps.clone(),
        },
    );

    Ok(timestamps)
}

fn build_timestamp_candidates(base_keys: &[String]) -> Vec<MrmsTimestampCandidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for base_key in base_keys {
        let date_part = match extract_date_from_key(base_key) {
            Some(value) => value,
            None => continue,
        };
        let timestamp = match extract_timestamp_from_key(base_key) {
            Some(value) => value,
            None => continue,
        };

        let dedupe_key = format!("{date_part}:{timestamp}");
        if !seen.insert(dedupe_key) {
            continue;
        }

        candidates.push(MrmsTimestampCandidate {
            date_part,
            timestamp,
        });
    }

    candidates
}

async fn find_complete_timestamp_candidates(
    state: &AppState,
    base_keys: &[String],
) -> anyhow::Result<Vec<MrmsTimestampCandidate>> {
    let candidates = build_timestamp_candidates(base_keys);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let unique_date_parts = candidates
        .iter()
        .map(|candidate| candidate.date_part.clone())
        .collect::<HashSet<_>>();

    let mut tasks = Vec::new();
    for date_part in unique_date_parts {
        for level_tag in MRMS_LEVEL_TAGS {
            let state_ref = state.clone();
            let date_part_owned = date_part.clone();
            let level_tag_owned = level_tag.to_string();
            tasks.push(async move {
                let timestamps =
                    fetch_level_timestamps_for_date(&state_ref, &level_tag_owned, &date_part_owned)
                        .await?;
                Ok::<(String, HashSet<String>), anyhow::Error>((
                    build_level_timestamp_cache_key(&level_tag_owned, &date_part_owned),
                    timestamps,
                ))
            });
        }
    }

    let mut availability_by_level_and_date = HashMap::new();
    for result in join_all(tasks).await {
        let (key, timestamps) = result?;
        availability_by_level_and_date.insert(key, timestamps);
    }

    let complete = candidates
        .into_iter()
        .filter(|candidate| {
            MRMS_LEVEL_TAGS.iter().all(|level_tag| {
                availability_by_level_and_date
                    .get(&build_level_timestamp_cache_key(
                        level_tag,
                        &candidate.date_part,
                    ))
                    .map(|timestamps| timestamps.contains(&candidate.timestamp))
                    .unwrap_or(false)
            })
        })
        .collect::<Vec<_>>();

    Ok(complete)
}

fn parse_scan_time_from_timestamp(timestamp: &str) -> Option<String> {
    let parsed = parse_timestamp_utc(timestamp)?;
    Some(parsed.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn parse_timestamp_utc(timestamp: &str) -> Option<DateTime<Utc>> {
    let parsed = NaiveDateTime::parse_from_str(timestamp, "%Y%m%d-%H%M%S").ok()?;
    Some(DateTime::<Utc>::from_naive_utc_and_offset(parsed, Utc))
}

fn format_timestamp_compact_utc(date: DateTime<Utc>) -> String {
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        date.year(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second()
    )
}

fn floor_date_to_step_seconds(date: DateTime<Utc>, step_seconds: i64) -> DateTime<Utc> {
    let step_ms = step_seconds.max(1) * 1000;
    let floored_ms = (date.timestamp_millis() / step_ms) * step_ms;
    DateTime::<Utc>::from_timestamp_millis(floored_ms).unwrap_or(date)
}

fn build_level_key(level_tag: &str, date_part: &str, timestamp: &str) -> String {
    format!(
        "{MRMS_CONUS_PREFIX}/{MRMS_PRODUCT_PREFIX}_{level_tag}/{date_part}/MRMS_{MRMS_PRODUCT_PREFIX}_{level_tag}_{timestamp}.grib2.gz"
    )
}

fn build_aux_product_key(product: &str, date_part: &str, timestamp: &str) -> String {
    format!("{MRMS_CONUS_PREFIX}/{product}/{date_part}/MRMS_{product}_{timestamp}.grib2.gz")
}

fn to_lon360(lon_deg: f64) -> f64 {
    let normalized = lon_deg % 360.0;
    if normalized < 0.0 {
        normalized + 360.0
    } else {
        normalized
    }
}

fn shortest_lon_delta_degrees(lon_deg360: f64, origin_lon_deg360: f64) -> f64 {
    let mut delta = lon_deg360 - origin_lon_deg360;
    if delta > 180.0 {
        delta -= 360.0;
    }
    if delta < -180.0 {
        delta += 360.0;
    }
    delta
}

fn projection_scales_nm_per_degree(lat_deg: f64) -> (f64, f64) {
    let phi = lat_deg * DEG_TO_RAD;
    let sin_phi = phi.sin();
    let cos_phi = phi.cos();
    let denom = (1.0 - WGS84_E2 * sin_phi * sin_phi).sqrt();
    let prime_vertical_meters = WGS84_SEMI_MAJOR_METERS / denom;
    let meridional_meters = (WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_E2)) / (denom * denom * denom);

    (
        (std::f64::consts::PI / 180.0) * prime_vertical_meters * cos_phi * METERS_TO_NM,
        (std::f64::consts::PI / 180.0) * meridional_meters * METERS_TO_NM,
    )
}

fn read_u32_be(buffer: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ])
}

fn read_i16_be(buffer: &[u8], offset: usize) -> i16 {
    i16::from_be_bytes([buffer[offset], buffer[offset + 1]])
}

fn read_u16_be(buffer: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([buffer[offset], buffer[offset + 1]])
}

fn read_f32_be(buffer: &[u8], offset: usize) -> f32 {
    f32::from_be_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ])
}

fn read_grib_signed_scaled_int32(buffer: &[u8], offset: usize, scale: f64) -> f64 {
    let raw = read_u32_be(buffer, offset);
    let sign = if (raw & 0x8000_0000) != 0 { -1.0 } else { 1.0 };
    let magnitude = (raw & 0x7fff_ffff) as f64;
    (sign * magnitude) / scale
}

fn parse_mrms_grib(buffer: &[u8]) -> anyhow::Result<ParsedMrmsField> {
    if buffer.len() < 20 {
        anyhow::bail!("MRMS GRIB payload is too small.");
    }
    if &buffer[0..4] != b"GRIB" {
        anyhow::bail!("MRMS payload did not begin with GRIB indicator bytes.");
    }

    let mut pointer = 16usize;
    let mut grid: Option<ParsedMrmsGrid> = None;
    let mut packing: Option<ParsedMrmsPacking> = None;
    let mut bitmap_indicator: u8 = 255;
    let mut section7_data: Option<Vec<u8>> = None;

    while pointer + 5 <= buffer.len() {
        if pointer + 4 <= buffer.len() && &buffer[pointer..pointer + 4] == b"7777" {
            break;
        }

        let section_length = read_u32_be(buffer, pointer) as usize;
        let section_number = buffer[pointer + 4];
        if section_length < 5 || pointer + section_length > buffer.len() {
            anyhow::bail!("Invalid GRIB section length ({section_length}) at offset {pointer}.");
        }

        if section_number == 3 {
            let template_number = read_u16_be(buffer, pointer + 12);
            if template_number != 0 {
                anyhow::bail!("Unsupported MRMS grid definition template ({template_number}).");
            }

            let nx = read_u32_be(buffer, pointer + 30) as usize;
            let ny = read_u32_be(buffer, pointer + 34) as usize;
            let la1_deg = read_grib_signed_scaled_int32(buffer, pointer + 46, 1_000_000.0);
            let lo1_deg360 = to_lon360(read_grib_signed_scaled_int32(
                buffer,
                pointer + 50,
                1_000_000.0,
            ));
            let _la2_deg = read_grib_signed_scaled_int32(buffer, pointer + 55, 1_000_000.0);
            let _lo2_deg360 = to_lon360(read_grib_signed_scaled_int32(
                buffer,
                pointer + 59,
                1_000_000.0,
            ));
            let di_deg = read_u32_be(buffer, pointer + 63) as f64 / 1_000_000.0;
            let dj_deg = read_u32_be(buffer, pointer + 67) as f64 / 1_000_000.0;
            let scanning_mode = buffer[pointer + 71];

            grid = Some(ParsedMrmsGrid {
                nx,
                ny,
                la1_deg,
                lo1_deg360,
                di_deg,
                dj_deg,
                scanning_mode,
            });
        } else if section_number == 5 {
            let template_number = read_u16_be(buffer, pointer + 9);
            if template_number != 41 {
                anyhow::bail!("Unsupported MRMS data representation template ({template_number}).");
            }

            packing = Some(ParsedMrmsPacking {
                data_point_count: read_u32_be(buffer, pointer + 5) as usize,
                reference_value: read_f32_be(buffer, pointer + 11) as f64,
                binary_scale_factor: read_i16_be(buffer, pointer + 15),
                decimal_scale_factor: read_i16_be(buffer, pointer + 17),
            });
        } else if section_number == 6 {
            bitmap_indicator = buffer[pointer + 5];
        } else if section_number == 7 {
            section7_data = Some(buffer[pointer + 5..pointer + section_length].to_vec());
        }

        pointer += section_length;
    }

    let grid = grid.ok_or_else(|| {
        anyhow::anyhow!("MRMS GRIB payload did not include required sections 3/5/7.")
    })?;
    let packing = packing.ok_or_else(|| {
        anyhow::anyhow!("MRMS GRIB payload did not include required sections 3/5/7.")
    })?;
    let section7_data = section7_data.ok_or_else(|| {
        anyhow::anyhow!("MRMS GRIB payload did not include required sections 3/5/7.")
    })?;

    if bitmap_indicator != 255 {
        anyhow::bail!("Unsupported MRMS bitmap indicator ({bitmap_indicator}); expected 255.");
    }

    let decoder = png::Decoder::new(Cursor::new(section7_data));
    let mut reader = decoder.read_info()?;
    let mut decoded = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut decoded)?;
    let data = &decoded[..info.buffer_size()];

    if info.width as usize != grid.nx || info.height as usize != grid.ny {
        anyhow::bail!(
            "MRMS grid mismatch: section3 {}x{}, png {}x{}.",
            grid.nx,
            grid.ny,
            info.width,
            info.height
        );
    }

    let values = match info.bit_depth {
        png::BitDepth::Eight => {
            if !matches!(info.color_type, png::ColorType::Grayscale) {
                anyhow::bail!("Unsupported MRMS PNG channels; expected single-channel grayscale.");
            }
            MrmsValues::U8(data.to_vec())
        }
        png::BitDepth::Sixteen => {
            if !matches!(info.color_type, png::ColorType::Grayscale) {
                anyhow::bail!("Unsupported MRMS PNG channels; expected single-channel grayscale.");
            }
            if data.len() % 2 != 0 {
                anyhow::bail!("Invalid 16-bit MRMS PNG payload length.");
            }
            let mut unpacked = Vec::with_capacity(data.len() / 2);
            let mut index = 0usize;
            while index + 1 < data.len() {
                unpacked.push(u16::from_be_bytes([data[index], data[index + 1]]));
                index += 2;
            }
            MrmsValues::U16(unpacked)
        }
        _ => anyhow::bail!("Unsupported MRMS PNG bit depth."),
    };

    if values.len() != packing.data_point_count {
        anyhow::bail!(
            "MRMS data-point mismatch: section5 {}, png {}.",
            packing.data_point_count,
            values.len()
        );
    }

    Ok(ParsedMrmsField {
        grid,
        packing,
        values,
    })
}

async fn fetch_mrms_levels_for_timestamp(
    state: &AppState,
    date_part: &str,
    timestamp: &str,
) -> anyhow::Result<Vec<ParsedMrmsLevel>> {
    let max_parallel_level_fetches =
        parse_env_usize("MRMS_LEVEL_FETCH_CONCURRENCY", MRMS_LEVEL_TAGS.len())
            .clamp(1, MRMS_LEVEL_TAGS.len());
    let level_fetch_retries = parse_env_usize("MRMS_LEVEL_FETCH_RETRIES", 2).min(6);
    let mut levels = Vec::new();

    for level_chunk in MRMS_LEVEL_TAGS.chunks(max_parallel_level_fetches) {
        let tasks = level_chunk.iter().map(|level_tag| {
            let level_tag_owned = (*level_tag).to_string();
            let date_part_owned = date_part.to_string();
            let timestamp_owned = timestamp.to_string();
            let state_ref = state.clone();

            async move {
                let key = build_level_key(&level_tag_owned, &date_part_owned, &timestamp_owned);
                let level_km = level_tag_owned
                    .parse::<f64>()
                    .map_err(|_| anyhow::anyhow!("Invalid MRMS level tag ({level_tag_owned})."))?;

                let mut last_error: Option<String> = None;
                for _attempt in 0..=level_fetch_retries {
                    match fetch_buffer(&state_ref, &format!("{MRMS_BUCKET_URL}/{key}")).await {
                        Ok(zipped) => {
                            let mut decoder = GzDecoder::new(Cursor::new(zipped));
                            let mut grib_buffer = Vec::new();
                            if let Err(error) = decoder.read_to_end(&mut grib_buffer) {
                                last_error = Some(error.to_string());
                                continue;
                            }

                            match parse_mrms_grib(&grib_buffer) {
                                Ok(parsed) => {
                                    return Ok::<ParsedMrmsLevel, anyhow::Error>(ParsedMrmsLevel {
                                        level_tag: level_tag_owned,
                                        level_km,
                                        key,
                                        parsed,
                                    });
                                }
                                Err(error) => {
                                    last_error = Some(error.to_string());
                                }
                            }
                        }
                        Err(error) => {
                            last_error = Some(error.to_string());
                        }
                    }
                }

                Err(anyhow::anyhow!(
                    "{}",
                    last_error.unwrap_or_else(|| "Unknown MRMS level fetch error".to_string())
                ))
            }
        });

        for result in join_all(tasks).await {
            levels.push(result?);
        }
    }
    levels.sort_by(|left, right| {
        left.level_km
            .partial_cmp(&right.level_km)
            .unwrap_or(Ordering::Equal)
    });

    Ok(levels)
}

async fn fetch_aux_field_near_timestamp(
    state: &AppState,
    product: &str,
    target_timestamp: &str,
    step_seconds: i64,
    max_steps: usize,
) -> Option<ParsedMrmsAuxField> {
    let target_date = parse_timestamp_utc(target_timestamp)?;
    let floored_start_date = floor_date_to_step_seconds(target_date, step_seconds);
    let step_ms = step_seconds.max(1) * 1000;

    for step in 0..=max_steps {
        let candidate_date = floored_start_date - Duration::milliseconds(step as i64 * step_ms);
        let candidate_date_part = format_date_compact_utc(candidate_date);
        let candidate_timestamp = format_timestamp_compact_utc(candidate_date);
        let key = build_aux_product_key(product, &candidate_date_part, &candidate_timestamp);

        let zipped = match fetch_buffer(state, &format!("{MRMS_BUCKET_URL}/{key}")).await {
            Ok(zipped) => zipped,
            Err(_) => continue,
        };

        let mut decoder = GzDecoder::new(Cursor::new(zipped));
        let mut grib_buffer = Vec::new();
        if decoder.read_to_end(&mut grib_buffer).is_err() {
            continue;
        }

        let parsed = match parse_mrms_grib(&grib_buffer) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        return Some(ParsedMrmsAuxField { parsed });
    }

    None
}

fn decode_packed_value(packing: &ParsedMrmsPacking, packed_value: f64) -> f64 {
    let binary_scale = 2f64.powi(packing.binary_scale_factor as i32);
    let decimal_scale = 10f64.powi(packing.decimal_scale_factor as i32);
    (packing.reference_value + packed_value * binary_scale) / decimal_scale
}

#[derive(Clone)]
struct FieldSampler<'a> {
    field: &'a ParsedMrmsField,
    lat_step_deg: f64,
    lon_step_deg: f64,
}

impl<'a> FieldSampler<'a> {
    fn sample(&self, lat_deg: f64, lon_deg360: f64) -> Option<f64> {
        let grid = &self.field.grid;
        let row = ((lat_deg - grid.la1_deg) / self.lat_step_deg).round() as isize;
        let col = ((lon_deg360 - grid.lo1_deg360) / self.lon_step_deg).round() as isize;

        if row < 0 || row >= grid.ny as isize || col < 0 || col >= grid.nx as isize {
            return None;
        }

        let index = row as usize * grid.nx + col as usize;
        let packed = self.field.values.at(index)? as f64;
        if !packed.is_finite() {
            return None;
        }

        Some(decode_packed_value(&self.field.packing, packed))
    }
}

fn create_field_sampler(field: Option<&ParsedMrmsField>) -> Option<FieldSampler<'_>> {
    let field = field?;
    let grid = &field.grid;
    let lat_step_deg = if (grid.scanning_mode & 0x40) == 0 {
        -grid.dj_deg.abs()
    } else {
        grid.dj_deg.abs()
    };
    let lon_step_deg = if (grid.scanning_mode & 0x80) == 0 {
        grid.di_deg.abs()
    } else {
        -grid.di_deg.abs()
    };

    if !lat_step_deg.is_finite()
        || !lon_step_deg.is_finite()
        || lat_step_deg == 0.0
        || lon_step_deg == 0.0
    {
        return None;
    }

    Some(FieldSampler {
        field,
        lat_step_deg,
        lon_step_deg,
    })
}

fn phase_from_precip_flag(value: Option<f64>) -> Option<i32> {
    let value = value?;
    if !value.is_finite() {
        return None;
    }

    let flag_code = value.round() as i64;
    if flag_code == -3 || flag_code == 0 {
        return Some(PHASE_RAIN);
    }
    if flag_code == 3 {
        return Some(PHASE_SNOW);
    }
    if flag_code == 7 {
        return Some(PHASE_MIXED);
    }
    if [1, 6, 10, 91, 96].contains(&flag_code) {
        return Some(PHASE_RAIN);
    }

    Some(PHASE_RAIN)
}

fn phase_from_freezing_level(
    voxel_mid_feet: f64,
    freezing_level_meters_msl: Option<f64>,
) -> Option<i32> {
    if !voxel_mid_feet.is_finite() {
        return None;
    }

    let freezing_level_meters = freezing_level_meters_msl?;
    if !freezing_level_meters.is_finite() {
        return None;
    }

    let freezing_level_feet = freezing_level_meters * FEET_PER_METER;
    if !freezing_level_feet.is_finite() || freezing_level_feet <= 0.0 {
        return None;
    }

    if voxel_mid_feet >= freezing_level_feet + FREEZING_LEVEL_TRANSITION_FEET {
        return Some(PHASE_SNOW);
    }
    if voxel_mid_feet <= freezing_level_feet - FREEZING_LEVEL_TRANSITION_FEET {
        return Some(PHASE_RAIN);
    }
    Some(PHASE_MIXED)
}

fn resolve_voxel_phase(
    lat_deg: f64,
    lon_deg360: f64,
    voxel_mid_feet: f64,
    precip_flag_sampler: Option<&FieldSampler<'_>>,
    freezing_level_sampler: Option<&FieldSampler<'_>>,
) -> i32 {
    let phase_from_flag = precip_flag_sampler
        .and_then(|sampler| phase_from_precip_flag(sampler.sample(lat_deg, lon_deg360)));

    if let Some(phase) = phase_from_flag {
        return phase;
    }

    let phase_from_freezing = freezing_level_sampler.and_then(|sampler| {
        phase_from_freezing_level(voxel_mid_feet, sampler.sample(lat_deg, lon_deg360))
    });

    phase_from_freezing.unwrap_or(PHASE_RAIN)
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn limit_voxels(mut voxels: Vec<NexradVoxelTuple>, max_voxels: usize) -> Vec<NexradVoxelTuple> {
    if voxels.len() <= max_voxels {
        return voxels;
    }

    let mut high_intensity = Vec::new();
    let mut lower_intensity = Vec::new();

    for voxel in voxels.drain(..) {
        if voxel.4 >= 45.0 {
            high_intensity.push(voxel);
        } else {
            lower_intensity.push(voxel);
        }
    }

    fn decimate<T: Clone>(items: &[T], target_count: usize) -> Vec<T> {
        if target_count == 0 || items.is_empty() {
            return Vec::new();
        }
        if items.len() <= target_count {
            return items.to_vec();
        }

        let mut result = Vec::with_capacity(target_count);
        let step = items.len() as f64 / target_count as f64;
        let mut cursor: f64 = 0.0;

        for _ in 0..target_count {
            result.push(items[cursor.floor() as usize].clone());
            cursor += step;
        }

        result
    }

    if high_intensity.len() >= max_voxels {
        return decimate(&high_intensity, max_voxels);
    }

    let remaining = max_voxels - high_intensity.len();
    let mut combined = high_intensity;
    combined.extend(decimate(&lower_intensity, remaining));
    combined
}

fn build_voxels_from_mrms_levels(
    levels: &[ParsedMrmsLevel],
    origin_lat: f64,
    origin_lon: f64,
    min_dbz: f64,
    max_range_nm: f64,
    precip_flag_field: Option<&ParsedMrmsField>,
    freezing_level_field: Option<&ParsedMrmsField>,
) -> (Vec<NexradVoxelTuple>, HashMap<String, usize>) {
    let mut sorted_levels = levels.to_vec();
    sorted_levels.sort_by(|left, right| {
        left.level_km
            .partial_cmp(&right.level_km)
            .unwrap_or(Ordering::Equal)
    });

    let mut voxels = Vec::new();
    let mut level_voxel_counts = HashMap::new();
    let precip_flag_sampler = create_field_sampler(precip_flag_field);
    let freezing_level_sampler = create_field_sampler(freezing_level_field);

    let origin_lon360 = to_lon360(origin_lon);
    let (east_nm_per_lon_deg, north_nm_per_lat_deg) = projection_scales_nm_per_degree(origin_lat);
    let east_nm_per_lon_deg_safe = east_nm_per_lon_deg.abs().max(1e-6);
    let north_nm_per_lat_deg_safe = north_nm_per_lat_deg.abs().max(1e-6);
    let max_range_squared_nm = max_range_nm * max_range_nm;

    let lat_padding_deg = max_range_nm / north_nm_per_lat_deg_safe;
    let lon_padding_deg = max_range_nm / east_nm_per_lon_deg_safe;
    let lat_min = origin_lat - lat_padding_deg;
    let lat_max = origin_lat + lat_padding_deg;
    let lon_min360 = origin_lon360 - lon_padding_deg;
    let lon_max360 = origin_lon360 + lon_padding_deg;
    let lon_bounds_wrapped = lon_min360 < 0.0 || lon_max360 >= 360.0;

    for level_index in 0..sorted_levels.len() {
        let level = &sorted_levels[level_index];
        let previous = if level_index > 0 {
            Some(&sorted_levels[level_index - 1])
        } else {
            None
        };
        let next = sorted_levels.get(level_index + 1);

        let bottom_km = if let Some(previous) = previous {
            (previous.level_km + level.level_km) / 2.0
        } else {
            let next_level = next
                .map(|item| item.level_km)
                .unwrap_or(level.level_km + 0.5);
            (level.level_km - (next_level - level.level_km) / 2.0).max(0.0)
        };

        let top_km = if let Some(next) = next {
            (level.level_km + next.level_km) / 2.0
        } else {
            let previous_level = previous
                .map(|item| item.level_km)
                .unwrap_or(level.level_km - 0.5);
            level.level_km + (level.level_km - previous_level) / 2.0
        };

        let bottom_feet = bottom_km * FEET_PER_KM;
        let top_feet = top_km * FEET_PER_KM;

        let grid = &level.parsed.grid;
        let packing = &level.parsed.packing;

        let lat_step_deg = if (grid.scanning_mode & 0x40) == 0 {
            -grid.dj_deg.abs()
        } else {
            grid.dj_deg.abs()
        };
        let lon_step_deg = if (grid.scanning_mode & 0x80) == 0 {
            grid.di_deg.abs()
        } else {
            -grid.di_deg.abs()
        };

        let row_from_lat = |lat: f64| (lat - grid.la1_deg) / lat_step_deg;

        let row_start = clamp_i64(
            (row_from_lat(lat_min).min(row_from_lat(lat_max)).floor() - 1.0) as i64,
            0,
            grid.ny as i64 - 1,
        ) as usize;
        let row_end = clamp_i64(
            (row_from_lat(lat_min).max(row_from_lat(lat_max)).ceil() + 1.0) as i64,
            0,
            grid.ny as i64 - 1,
        ) as usize;

        let (mut col_start, mut col_end) = (0usize, grid.nx - 1);
        if !lon_bounds_wrapped {
            let col_from_lon = |lon: f64| (lon - grid.lo1_deg360) / lon_step_deg;
            col_start = clamp_i64(
                (col_from_lon(lon_min360)
                    .min(col_from_lon(lon_max360))
                    .floor()
                    - 1.0) as i64,
                0,
                grid.nx as i64 - 1,
            ) as usize;
            col_end = clamp_i64(
                (col_from_lon(lon_min360)
                    .max(col_from_lon(lon_max360))
                    .ceil()
                    + 1.0) as i64,
                0,
                grid.nx as i64 - 1,
            ) as usize;
        }

        let footprint_x_nm_safe = (grid.di_deg.abs() * east_nm_per_lon_deg_safe).max(0.05);
        let footprint_y_nm_safe = (grid.dj_deg.abs() * north_nm_per_lat_deg_safe).max(0.05);

        let mut level_voxel_count = 0usize;

        for row in row_start..=row_end {
            let lat_deg = grid.la1_deg + row as f64 * lat_step_deg;
            if !lat_deg.is_finite() {
                continue;
            }

            let row_offset = row * grid.nx;

            for col in col_start..=col_end {
                let packed_value = match level.parsed.values.at(row_offset + col) {
                    Some(value) => value as f64,
                    None => continue,
                };

                let dbz = decode_packed_value(packing, packed_value);
                if !dbz.is_finite() || dbz < min_dbz {
                    continue;
                }

                let lon_deg360 = to_lon360(grid.lo1_deg360 + col as f64 * lon_step_deg);
                let delta_lon_deg = shortest_lon_delta_degrees(lon_deg360, origin_lon360);
                let x_nm = delta_lon_deg * east_nm_per_lon_deg_safe;
                let z_nm = -(lat_deg - origin_lat) * north_nm_per_lat_deg_safe;

                if (x_nm * x_nm) + (z_nm * z_nm) > max_range_squared_nm {
                    continue;
                }

                let voxel_mid_feet = (bottom_feet + top_feet) / 2.0;
                let phase_code = resolve_voxel_phase(
                    lat_deg,
                    lon_deg360,
                    voxel_mid_feet,
                    precip_flag_sampler.as_ref(),
                    freezing_level_sampler.as_ref(),
                );

                voxels.push((
                    round3(x_nm),
                    round3(z_nm),
                    bottom_feet.round() as i64,
                    top_feet.round() as i64,
                    round1(dbz),
                    round3(footprint_x_nm_safe),
                    round3(footprint_y_nm_safe),
                    phase_code,
                ));
                level_voxel_count += 1;
            }
        }

        level_voxel_counts.insert(level.key.clone(), level_voxel_count);
    }

    (voxels, level_voxel_counts)
}

fn build_cache_key(
    lat: f64,
    lon: f64,
    min_dbz: f64,
    max_range_nm: f64,
    max_voxels: usize,
) -> String {
    format!(
        "mrms:{:.2}:{:.2}:{:.1}:{:.1}:{}",
        lat, lon, min_dbz, max_range_nm, max_voxels
    )
}

async fn cleanup_expired_cache_entries(state: &AppState, now_ms: i64) {
    let mut cache = state.response_cache.write().await;
    cache.retain(|_, entry| entry.expires_at_ms > now_ms);
}

pub(crate) async fn get(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let lat = to_finite_number(params.get("lat"));
    let lon = to_finite_number(params.get("lon"));
    if lat.is_none()
        || lon.is_none()
        || !(-90.0..=90.0).contains(&lat.unwrap_or_default())
        || !(-180.0..=180.0).contains(&lon.unwrap_or_default())
    {
        let payload = NexradVolumePayload {
            generated_at: Utc::now().to_rfc3339(),
            radar: None,
            radars: None,
            layer_summaries: Vec::new(),
            voxels: Vec::new(),
            stale: None,
            error: Some("Invalid lat/lon query parameters. Expected decimal degrees.".to_string()),
        };
        return no_store_response(StatusCode::BAD_REQUEST, &payload, false);
    }

    let lat = lat.unwrap_or_default();
    let lon = lon.unwrap_or_default();

    let min_dbz = clamp(
        to_finite_number(params.get("minDbz")).unwrap_or(MIN_DBZ_DEFAULT),
        5.0,
        60.0,
    );
    let max_range_nm = clamp(
        to_finite_number(params.get("maxRangeNm")).unwrap_or(MAX_RANGE_DEFAULT_NM),
        30.0,
        220.0,
    );
    let max_voxels = clamp(
        to_finite_number(params.get("maxVoxels")).unwrap_or(MAX_VOXELS_DEFAULT as f64),
        200.0,
        30_000.0,
    )
    .round() as usize;

    let cache_key = build_cache_key(lat, lon, min_dbz, max_range_nm, max_voxels);
    let now = now_ms();
    cleanup_expired_cache_entries(&state, now).await;
    cleanup_expired_level_timestamp_cache_entries(&state, now).await;

    let cache_entry = state.response_cache.read().await.get(&cache_key).cloned();
    if let Some(cache_entry) = cache_entry.clone() {
        if cache_entry.expires_at_ms > now {
            return no_store_response(StatusCode::OK, &cache_entry.payload, false);
        }
    }

    let now_dt = Utc::now();

    let result = async {
        let base_keys = find_recent_base_level_keys(&state, now_dt, MAX_BASE_KEY_CANDIDATES).await?;
        if base_keys.is_empty() {
            anyhow::bail!("No recent MRMS base-level reflectivity files were available.");
        }

        let complete_candidates = find_complete_timestamp_candidates(&state, &base_keys).await?;
        if complete_candidates.is_empty() {
            anyhow::bail!(
                "No recent MRMS scan had complete level availability across all reflectivity slices."
            );
        }

        let mut parsed_levels = Vec::new();
        let mut selected_timestamp: Option<String> = None;
        let mut last_candidate_error: Option<String> = None;
        let mut candidate_attempts = 0usize;
        for candidate in complete_candidates {
            candidate_attempts += 1;
            match fetch_mrms_levels_for_timestamp(&state, &candidate.date_part, &candidate.timestamp)
                .await
            {
                Ok(levels) => {
                    parsed_levels = levels;
                    selected_timestamp = Some(candidate.timestamp);
                    break;
                }
                Err(error) => {
                    last_candidate_error = Some(error.to_string());
                    continue;
                }
            }
        }

        if parsed_levels.is_empty() || selected_timestamp.is_none() {
            if let Some(last_error) = last_candidate_error {
                anyhow::bail!(
                    "No recent MRMS scan had complete fetch/decode coverage across all reflectivity slices. Last error: {last_error}"
                );
            }
            anyhow::bail!(
                "No recent MRMS scan had complete fetch/decode coverage across all reflectivity slices (attempts={candidate_attempts})."
            );
        }

        let selected_timestamp = selected_timestamp.unwrap_or_default();

        let (precip_flag_field, freezing_level_field) = tokio::join!(
            fetch_aux_field_near_timestamp(
                &state,
                MRMS_PRECIP_FLAG_PRODUCT,
                &selected_timestamp,
                PRECIP_FLAG_STEP_SECONDS,
                AUX_PRECIP_FLAG_LOOKBACK_STEPS,
            ),
            fetch_aux_field_near_timestamp(
                &state,
                MRMS_MODEL_FREEZING_HEIGHT_PRODUCT,
                &selected_timestamp,
                MODEL_STEP_SECONDS,
                AUX_MODEL_LOOKBACK_STEPS,
            )
        );

        let (raw_voxels, level_voxel_counts) = build_voxels_from_mrms_levels(
            &parsed_levels,
            lat,
            lon,
            min_dbz,
            max_range_nm,
            precip_flag_field.as_ref().map(|field| &field.parsed),
            freezing_level_field.as_ref().map(|field| &field.parsed),
        );

        let raw_voxel_count = raw_voxels.len();
        let voxels = limit_voxels(raw_voxels, max_voxels);
        let voxel_sample_ratio = if raw_voxel_count == 0 {
            0.0
        } else {
            voxels.len() as f64 / raw_voxel_count as f64
        };

        let scan_time = parse_scan_time_from_timestamp(&selected_timestamp)
            .unwrap_or_else(|| now_dt.to_rfc3339());

        let layer_summaries = parsed_levels
            .iter()
            .map(|level| NexradLayerSummary {
                product: format!("{MRMS_PRODUCT_PREFIX}_{}", level.level_tag),
                elevation_angle_deg: round1(level.level_km),
                source_key: level.key.clone(),
                scan_time: scan_time.clone(),
                voxel_count: ((level_voxel_counts.get(&level.key).copied().unwrap_or(0) as f64)
                    * voxel_sample_ratio)
                    .round() as i64,
            })
            .collect::<Vec<_>>();

        let payload = NexradVolumePayload {
            generated_at: now_dt.to_rfc3339(),
            radar: None,
            radars: None,
            layer_summaries,
            voxels,
            stale: None,
            error: None,
        };

        state.response_cache.write().await.insert(
            cache_key,
            CacheEntry {
                expires_at_ms: now_ms() + CACHE_TTL_MS,
                payload: payload.clone(),
            },
        );

        Ok::<NexradVolumePayload, anyhow::Error>(payload)
    }
    .await;

    match result {
        Ok(payload) => no_store_response(StatusCode::OK, &payload, false),
        Err(error) => {
            let message = error.to_string();

            if let Some(cache_entry) = cache_entry {
                let mut stale_payload = cache_entry.payload.clone();
                stale_payload.stale = Some(true);
                stale_payload.error = Some(message);
                return no_store_response(StatusCode::OK, &stale_payload, false);
            }

            let payload = NexradVolumePayload {
                generated_at: Utc::now().to_rfc3339(),
                radar: None,
                radars: None,
                layer_summaries: Vec::new(),
                voxels: Vec::new(),
                stale: None,
                error: Some(message),
            };
            no_store_response(StatusCode::OK, &payload, false)
        }
    }
}
