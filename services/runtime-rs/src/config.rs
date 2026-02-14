use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::constants::{
    DEFAULT_BOOTSTRAP_INTERVAL_SECONDS, DEFAULT_PENDING_RETRY_SECONDS,
    DEFAULT_REQUEST_TIMEOUT_SECONDS, DEFAULT_RETENTION_BYTES, DEFAULT_SQS_POLL_DELAY_SECONDS,
    DEFAULT_TILE_SIZE,
};

#[derive(Clone)]
pub struct Config {
    pub listen_addr: String,
    pub storage_dir: PathBuf,
    pub retention_bytes: u64,
    pub request_timeout: Duration,
    pub bootstrap_interval: Duration,
    pub sqs_poll_delay: Duration,
    pub pending_retry_delay: Duration,
    pub aws_region: String,
    pub sqs_queue_url: Option<String>,
    pub tile_size: u16,
    pub adsbx_primary_base_url: String,
    pub adsbx_fallback_base_urls: Vec<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let listen_addr =
            env_string_with_fallback("RUNTIME_LISTEN_ADDR", "MRMS_LISTEN_ADDR", "127.0.0.1:9191");
        let storage_dir = PathBuf::from(env_string_with_fallback(
            "RUNTIME_STORAGE_DIR",
            "MRMS_STORAGE_DIR",
            "/var/lib/approach-viz-runtime",
        ));
        let retention_bytes = env_u64_with_fallback(
            "RUNTIME_MRMS_RETENTION_BYTES",
            "MRMS_RETENTION_BYTES",
            DEFAULT_RETENTION_BYTES,
        )?;
        let request_timeout = Duration::from_secs(env_u64_with_fallback(
            "RUNTIME_MRMS_REQUEST_TIMEOUT_SECONDS",
            "MRMS_REQUEST_TIMEOUT_SECONDS",
            DEFAULT_REQUEST_TIMEOUT_SECONDS,
        )?);
        let bootstrap_interval = Duration::from_secs(env_u64_with_fallback(
            "RUNTIME_MRMS_BOOTSTRAP_INTERVAL_SECONDS",
            "MRMS_BOOTSTRAP_INTERVAL_SECONDS",
            DEFAULT_BOOTSTRAP_INTERVAL_SECONDS,
        )?);
        let sqs_poll_delay = Duration::from_secs(env_u64_with_fallback(
            "RUNTIME_MRMS_SQS_POLL_DELAY_SECONDS",
            "MRMS_SQS_POLL_DELAY_SECONDS",
            DEFAULT_SQS_POLL_DELAY_SECONDS,
        )?);
        let pending_retry_delay = Duration::from_secs(env_u64_with_fallback(
            "RUNTIME_MRMS_PENDING_RETRY_SECONDS",
            "MRMS_PENDING_RETRY_SECONDS",
            DEFAULT_PENDING_RETRY_SECONDS,
        )?);
        let aws_region = env_string("AWS_REGION", "us-east-1");
        let sqs_queue_url = env_optional("RUNTIME_MRMS_SQS_QUEUE_URL")
            .or_else(|| env_optional("MRMS_SQS_QUEUE_URL"));
        let tile_size = env_u16_with_fallback(
            "RUNTIME_MRMS_TILE_SIZE",
            "MRMS_TILE_SIZE",
            DEFAULT_TILE_SIZE,
        )?;

        let adsbx_primary_base_url = trim_base_url(&env_string_with_fallback(
            "RUNTIME_ADSBX_TAR1090_BASE_URL",
            "ADSBX_TAR1090_BASE_URL",
            "https://globe.adsbexchange.com",
        ));
        let adsbx_fallback_base_urls = env_string_with_fallback(
            "RUNTIME_ADSBX_TAR1090_FALLBACK_BASE_URLS",
            "ADSBX_TAR1090_FALLBACK_BASE_URLS",
            "https://globe.theairtraffic.com",
        )
        .split(',')
        .map(trim_base_url)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();

        Ok(Self {
            listen_addr,
            storage_dir,
            retention_bytes,
            request_timeout,
            bootstrap_interval,
            sqs_poll_delay,
            pending_retry_delay,
            aws_region,
            sqs_queue_url,
            tile_size,
            adsbx_primary_base_url,
            adsbx_fallback_base_urls,
        })
    }

    pub fn scans_dir(&self) -> PathBuf {
        self.storage_dir.join("scans")
    }

    pub fn traffic_base_urls(&self) -> Vec<String> {
        let mut deduped = Vec::new();
        for candidate in std::iter::once(&self.adsbx_primary_base_url)
            .chain(self.adsbx_fallback_base_urls.iter())
        {
            if candidate.is_empty() {
                continue;
            }
            if deduped
                .iter()
                .any(|existing: &String| existing == candidate)
            {
                continue;
            }
            deduped.push(candidate.clone());
        }
        deduped
    }
}

fn trim_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_string_with_fallback(primary: &str, fallback: &str, default: &str) -> String {
    env_optional(primary)
        .or_else(|| env_optional(fallback))
        .unwrap_or_else(|| default.to_string())
}

fn env_u64_with_fallback(primary: &str, fallback: &str, default: u64) -> Result<u64> {
    if let Some(value) = env_optional(primary) {
        return value
            .parse::<u64>()
            .with_context(|| format!("Failed to parse {}={} as u64", primary, value));
    }
    env_u64(fallback, default)
}

fn env_u16_with_fallback(primary: &str, fallback: &str, default: u16) -> Result<u16> {
    if let Some(value) = env_optional(primary) {
        return value
            .parse::<u16>()
            .with_context(|| format!("Failed to parse {}={} as u16", primary, value));
    }
    env_u16(fallback, default)
}

fn env_string(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn env_u64(name: &str, default: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("Failed to parse {}={} as u64", name, value)),
        Err(_) => Ok(default),
    }
}

fn env_u16(name: &str, default: u16) -> Result<u16> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u16>()
            .with_context(|| format!("Failed to parse {}={} as u16", name, value)),
        Err(_) => Ok(default),
    }
}
