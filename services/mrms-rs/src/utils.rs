use std::cmp::{max, min};
use std::f64::consts::PI;

use anyhow::{anyhow, Result};
use chrono::{DateTime, NaiveDateTime, Utc};

use crate::constants::{DEG_TO_RAD, METERS_TO_NM, WGS84_E2, WGS84_SEMI_MAJOR_METERS};

pub fn init_tracing() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(false)
        .without_time()
        .init();
}

pub fn clamp(value: f64, min_value: f64, max_value: f64) -> f64 {
    value.max(min_value).min(max_value)
}

pub fn round_i16(value: f64) -> i16 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

pub fn round_u16(value: f64) -> u16 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(0.0, u16::MAX as f64) as u16
}

pub fn to_lon360(lon_deg: f64) -> f64 {
    let normalized = lon_deg % 360.0;
    if normalized < 0.0 {
        normalized + 360.0
    } else {
        normalized
    }
}

pub fn shortest_lon_delta_degrees(lon_deg360: f64, origin_lon_deg360: f64) -> f64 {
    let mut delta = lon_deg360 - origin_lon_deg360;
    if delta > 180.0 {
        delta -= 360.0;
    }
    if delta < -180.0 {
        delta += 360.0;
    }
    delta
}

pub fn projection_scales_nm_per_degree(lat_deg: f64) -> (f64, f64) {
    let phi = lat_deg * DEG_TO_RAD;
    let sin_phi = phi.sin();
    let cos_phi = phi.cos();
    let denom = (1.0 - WGS84_E2 * sin_phi * sin_phi).sqrt();
    let prime_vertical_meters = WGS84_SEMI_MAJOR_METERS / denom;
    let meridional_meters = (WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_E2)) / (denom * denom * denom);

    (
        (PI / 180.0) * prime_vertical_meters * cos_phi * METERS_TO_NM,
        (PI / 180.0) * meridional_meters * METERS_TO_NM,
    )
}

pub fn clamp_i64(value: i64, min_value: i64, max_value: i64) -> i64 {
    min(max(value, min_value), max_value)
}

pub fn parse_timestamp_utc(timestamp: &str) -> Option<DateTime<Utc>> {
    let naive = NaiveDateTime::parse_from_str(timestamp, "%Y%m%d-%H%M%S").ok()?;
    Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

pub fn iso_from_ms(timestamp_ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms).map(|ts| ts.to_rfc3339())
}

pub fn floor_timestamp(timestamp: DateTime<Utc>, step_seconds: i64) -> DateTime<Utc> {
    let step_ms = max(step_seconds, 1) * 1000;
    let floored_ms = (timestamp.timestamp_millis() / step_ms) * step_ms;
    DateTime::<Utc>::from_timestamp_millis(floored_ms).unwrap_or(timestamp)
}

pub fn cycle_anchor_timestamp(target_timestamp: &str, step_seconds: i64) -> Result<String> {
    let target = parse_timestamp_utc(target_timestamp)
        .ok_or_else(|| anyhow!("Invalid target timestamp: {target_timestamp}"))?;
    let floored = floor_timestamp(target, step_seconds);
    Ok(floored.format("%Y%m%d-%H%M%S").to_string())
}
