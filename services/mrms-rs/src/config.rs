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
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let listen_addr = env_string("MRMS_LISTEN_ADDR", "127.0.0.1:9191");
        let storage_dir =
            PathBuf::from(env_string("MRMS_STORAGE_DIR", "/var/lib/approach-viz-mrms"));
        let retention_bytes = env_u64("MRMS_RETENTION_BYTES", DEFAULT_RETENTION_BYTES)?;
        let request_timeout = Duration::from_secs(env_u64(
            "MRMS_REQUEST_TIMEOUT_SECONDS",
            DEFAULT_REQUEST_TIMEOUT_SECONDS,
        )?);
        let bootstrap_interval = Duration::from_secs(env_u64(
            "MRMS_BOOTSTRAP_INTERVAL_SECONDS",
            DEFAULT_BOOTSTRAP_INTERVAL_SECONDS,
        )?);
        let sqs_poll_delay = Duration::from_secs(env_u64(
            "MRMS_SQS_POLL_DELAY_SECONDS",
            DEFAULT_SQS_POLL_DELAY_SECONDS,
        )?);
        let pending_retry_delay = Duration::from_secs(env_u64(
            "MRMS_PENDING_RETRY_SECONDS",
            DEFAULT_PENDING_RETRY_SECONDS,
        )?);
        let aws_region = env_string("AWS_REGION", "us-east-1");
        let sqs_queue_url = std::env::var("MRMS_SQS_QUEUE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let tile_size = env_u16("MRMS_TILE_SIZE", DEFAULT_TILE_SIZE)?;

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
        })
    }

    pub fn scans_dir(&self) -> PathBuf {
        self.storage_dir.join("scans")
    }
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
