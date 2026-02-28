use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue};
use futures::future::join_all;
use tokio::time::{interval, MissedTickBehavior};
use tracing::warn;

use super::store::{ingest_to_store, wal_maintenance};
use super::types::{
    box_param, normalize_altitude_feet_value, normalize_callsign, normalize_heading_value,
    normalize_lat_value, normalize_lon_value, normalize_seen_seconds_value, normalize_speed_kt,
    now_ms, BoundingBox, TrafficAircraft,
};
use crate::types::AppState;

const CACHE_POLL_INTERVAL_MS: u64 = 1000;
const RETENTION_SWEEP_INTERVAL_MS: i64 = 5 * 60_000;
const WAL_MAINTENANCE_INTERVAL_MS: i64 = 60_000;
const REQUEST_TIMEOUT_MS: u64 = 5500;
const BINCRAFT_MIN_STRIDE_BYTES: usize = 112;
const BINCRAFT_MAX_STRIDE_BYTES: usize = 256;
const BINCRAFT_S32_SEEN_VERSION: u32 = 20240218;

const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const US_FETCH_BOXES: [BoundingBox; 4] = [
    // CONUS
    BoundingBox {
        south: 23.0,
        north: 50.0,
        west: -127.0,
        east: -65.0,
        crosses_dateline: false,
    },
    // Alaska
    BoundingBox {
        south: 50.0,
        north: 72.0,
        west: -171.0,
        east: -129.0,
        crosses_dateline: false,
    },
    // Hawaii
    BoundingBox {
        south: 18.0,
        north: 23.5,
        west: -161.5,
        east: -153.5,
        crosses_dateline: false,
    },
    // Puerto Rico / USVI
    BoundingBox {
        south: 17.0,
        north: 19.5,
        west: -68.5,
        east: -64.0,
        crosses_dateline: false,
    },
];

pub(crate) fn spawn_traffic_cache_worker(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_millis(CACHE_POLL_INTERVAL_MS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut next_retention_sweep_at_ms = now_ms() + RETENTION_SWEEP_INTERVAL_MS;
        let mut next_wal_maintenance_at_ms = now_ms() + WAL_MAINTENANCE_INTERVAL_MS;

        loop {
            ticker.tick().await;
            let polled_at_ms = now_ms();
            match fetch_us_aircraft_snapshot(&state).await {
                Ok((source, aircraft)) => {
                    let should_sweep = polled_at_ms >= next_retention_sweep_at_ms;
                    if should_sweep {
                        next_retention_sweep_at_ms = polled_at_ms + RETENTION_SWEEP_INTERVAL_MS;
                    }
                    if let Err(error) = ingest_to_store(
                        &state.traffic_store,
                        source,
                        aircraft,
                        polled_at_ms,
                        should_sweep,
                    )
                    .await
                    {
                        warn!("Traffic store ingest failed: {error}");
                    }
                }
                Err(error) => {
                    warn!("Traffic cache poll failed: {error}");
                }
            }

            if polled_at_ms >= next_wal_maintenance_at_ms {
                next_wal_maintenance_at_ms = polled_at_ms + WAL_MAINTENANCE_INTERVAL_MS;
                if let Err(error) = wal_maintenance(&state.traffic_store, polled_at_ms).await {
                    warn!("Traffic WAL maintenance failed: {error}");
                }
            }
        }
    });
}

async fn fetch_us_aircraft_snapshot(
    state: &AppState,
) -> Result<(String, Vec<TrafficAircraft>), String> {
    let futures = US_FETCH_BOXES
        .iter()
        .copied()
        .map(|bounds| fetch_adsbx_traffic(state, bounds));
    let results = join_all(futures).await;

    let mut by_hex = HashMap::new();
    let mut sources = HashSet::new();
    let mut errors = Vec::new();

    for result in results {
        match result {
            Ok((source, _base_url, aircraft)) => {
                sources.insert(source);
                for candidate in aircraft {
                    merge_aircraft_candidate(&mut by_hex, candidate);
                }
            }
            Err(error) => errors.push(error),
        }
    }

    if by_hex.is_empty() {
        return Err(errors.join(" | "));
    }

    let mut source_list = sources.into_iter().collect::<Vec<_>>();
    source_list.sort();
    Ok((
        format!("traffic-store ({})", source_list.join(", ")),
        by_hex.into_values().collect(),
    ))
}

fn merge_aircraft_candidate(
    by_hex: &mut HashMap<String, TrafficAircraft>,
    candidate: TrafficAircraft,
) {
    match by_hex.get(&candidate.hex) {
        Some(current) => {
            let current_seen = current.last_seen_seconds.unwrap_or(f64::INFINITY);
            let candidate_seen = candidate.last_seen_seconds.unwrap_or(f64::INFINITY);
            if candidate_seen < current_seen {
                by_hex.insert(candidate.hex.clone(), candidate);
            }
        }
        None => {
            by_hex.insert(candidate.hex.clone(), candidate);
        }
    }
}

async fn fetch_adsbx_traffic(
    state: &AppState,
    bounds: BoundingBox,
) -> Result<(String, String, Vec<TrafficAircraft>), String> {
    let mut errors = Vec::new();
    for base_url in state.cfg.traffic_base_urls() {
        let request_url = format!("{base_url}/re-api/?binCraft&zstd&box={}", box_param(bounds));
        match fetch_bincraft(state, &request_url, &base_url).await {
            Ok(aircraft) => {
                return Ok((
                    format!("{base_url} (/re-api binCraft+zstd)"),
                    base_url,
                    aircraft,
                ));
            }
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join(" | "))
}

async fn fetch_bincraft(
    state: &AppState,
    request_url: &str,
    base_url: &str,
) -> Result<Vec<TrafficAircraft>, String> {
    let response = state
        .http
        .get(request_url)
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .headers(build_fetch_headers(base_url))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !content_type.contains("application/zstd") {
        return Err(format!(
            "Unexpected content-type: {}",
            if content_type.is_empty() {
                "none"
            } else {
                content_type.as_str()
            }
        ));
    }

    let payload = response.bytes().await.map_err(|error| error.to_string())?;
    if payload.is_empty() {
        return Err("Empty response".to_string());
    }

    decode_bincraft_aircraft(&payload)
}

pub fn decode_bincraft_aircraft(payload: &[u8]) -> Result<Vec<TrafficAircraft>, String> {
    let decoded = zstd::stream::decode_all(Cursor::new(payload))
        .map_err(|error| format!("binCraft zstd decode failed: {error}"))?;

    if decoded.len() < 44 {
        return Err("binCraft payload is too small.".to_string());
    }

    let stride = read_u32_le(&decoded, 8).unwrap_or(0) as usize;
    if stride < BINCRAFT_MIN_STRIDE_BYTES || stride > BINCRAFT_MAX_STRIDE_BYTES || stride % 4 != 0 {
        return Err(format!("Unexpected binCraft stride: {stride}"));
    }

    let version = read_u32_le(&decoded, 40).unwrap_or_default();
    let max_offset = decoded.len() - (decoded.len() % stride);

    let mut by_hex: HashMap<String, TrafficAircraft> = HashMap::new();

    let mut offset = stride;
    while offset + stride <= max_offset {
        let u8 = &decoded[offset..offset + stride];
        let validity73 = u8[73];
        if (validity73 & 64) == 0 {
            offset += stride;
            continue;
        }

        let lat = read_i32_le(u8, 12)
            .map(|value| normalize_lat_value(value as f64 / 1_000_000.0))
            .flatten();
        let lon = read_i32_le(u8, 8)
            .map(|value| normalize_lon_value(value as f64 / 1_000_000.0))
            .flatten();
        let (lat, lon) = match (lat, lon) {
            (Some(lat), Some(lon)) => (lat, lon),
            _ => {
                offset += stride;
                continue;
            }
        };

        let raw_hex = read_i32_le(u8, 0).unwrap_or_default() as u32;
        let hex_base = raw_hex & 0x00ff_ffff;
        if hex_base == 0 {
            offset += stride;
            continue;
        }
        let is_temporary = (raw_hex & (1 << 24)) != 0;
        let hex = if is_temporary {
            format!("~{hex_base:06x}")
        } else {
            format!("{hex_base:06x}")
        };

        let altitude_feet = if (validity73 & 32) != 0 {
            normalize_altitude_feet_value(
                (25_i32 * read_i16_le(u8, 22).unwrap_or_default() as i32) as f64,
            )
        } else if (validity73 & 16) != 0 {
            normalize_altitude_feet_value(
                (25_i32 * read_i16_le(u8, 20).unwrap_or_default() as i32) as f64,
            )
        } else {
            None
        };

        let ground_speed_kt = if (validity73 & 128) != 0 {
            normalize_speed_kt(
                read_i16_le(u8, 34)
                    .map(|value| value as f64 / 10.0)
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        let track_deg = if (u8[74] & 8) != 0 {
            normalize_heading_value(
                read_i16_le(u8, 40)
                    .map(|value| value as f64 / 90.0)
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        let flight = if (validity73 & 8) != 0 {
            decode_flight(u8)
        } else {
            None
        };
        let airground = u8[68] & 15;
        let is_on_ground = airground == 1;

        let seen_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(u8, 4).map(|value| value as f64 / 10.0)
        } else {
            read_u16_le(u8, 6).map(|value| value as f64 / 10.0)
        };
        let seen_pos_seconds = if version >= BINCRAFT_S32_SEEN_VERSION {
            read_i32_le(u8, 108).map(|value| value as f64 / 10.0)
        } else {
            read_u16_le(u8, 4).map(|value| value as f64 / 10.0)
        };

        let last_seen_seconds = seen_pos_seconds
            .and_then(normalize_seen_seconds_value)
            .or_else(|| seen_seconds.and_then(normalize_seen_seconds_value));

        let aircraft = TrafficAircraft {
            hex: hex.clone(),
            flight,
            lat,
            lon,
            is_on_ground,
            altitude_feet,
            ground_speed_kt,
            track_deg,
            last_seen_seconds,
        };

        merge_aircraft_candidate(&mut by_hex, aircraft);
        offset += stride;
    }

    Ok(by_hex.into_values().collect())
}

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    data.get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_i16_le(data: &[u8], offset: usize) -> Option<i16> {
    data.get(offset..offset + 2)
        .map(|slice| i16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32_le(data: &[u8], offset: usize) -> Option<i32> {
    data.get(offset..offset + 4)
        .map(|slice| i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn decode_flight(u8: &[u8]) -> Option<String> {
    let mut bytes = Vec::new();
    for index in 78..86 {
        let code = *u8.get(index)?;
        if code == 0 {
            break;
        }
        bytes.push(code);
    }

    let text = String::from_utf8_lossy(&bytes);
    normalize_callsign(Some(text.trim()))
}

fn build_fetch_headers(base_url: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("*/*"));
    headers.insert(
        "accept-language",
        HeaderValue::from_static("en-US,en;q=0.9"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-cache"));
    headers.insert("pragma", HeaderValue::from_static("no-cache"));
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
    headers.insert("user-agent", HeaderValue::from_static(USER_AGENT));

    if let Ok(value) = HeaderValue::from_str(base_url) {
        headers.insert("origin", value);
    }
    if let Ok(value) = HeaderValue::from_str(&format!("{base_url}/")) {
        headers.insert("referer", value);
    }

    headers
}
