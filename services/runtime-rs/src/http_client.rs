use std::future::Future;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Client;

/// Pauses before each retry of a transient failure; one entry per retry.
const TRANSIENT_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_millis(750)];

/// HTTP error carrying the status code so callers can distinguish
/// retriable failures (5xx, timeouts) from permanent ones (404).
#[derive(Debug)]
pub struct HttpStatusError {
    pub status: u16,
    pub url: String,
}

impl std::fmt::Display for HttpStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Request failed ({}) for {}", self.status, self.url)
    }
}

impl std::error::Error for HttpStatusError {}

/// Whether `error` is an HTTP 404 (object not there, at least not yet).
pub fn is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<HttpStatusError>()
            .is_some_and(|e| e.status == 404)
    })
}

/// Connection, timeout and body-read failures (no HTTP status) plus 5xx and
/// 429 responses are worth another try; any other status is final.
fn is_transient(error: &anyhow::Error) -> bool {
    match error
        .chain()
        .find_map(|cause| cause.downcast_ref::<HttpStatusError>())
    {
        Some(status) => status.status >= 500 || status.status == 429,
        None => true,
    }
}

async fn with_transient_retries<T, F, Fut>(mut attempt: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut retries = TRANSIENT_RETRY_DELAYS.iter();
    loop {
        match attempt().await {
            Err(error) if is_transient(&error) => match retries.next() {
                Some(delay) => tokio::time::sleep(*delay).await,
                None => return Err(error),
            },
            result => return result,
        }
    }
}

pub async fn fetch_bytes(http: &Client, url: &str) -> Result<Vec<u8>> {
    with_transient_retries(|| fetch_bytes_once(http, url)).await
}

async fn fetch_bytes_once(http: &Client, url: &str) -> Result<Vec<u8>> {
    let response = http
        .get(url)
        .send()
        .await
        .with_context(|| format!("Request failed for {url}"))?;

    if !response.status().is_success() {
        return Err(HttpStatusError {
            status: response.status().as_u16(),
            url: url.to_string(),
        }
        .into());
    }

    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("Failed to read body for {url}"))?;
    Ok(bytes.to_vec())
}

pub async fn fetch_text(http: &Client, url: &str) -> Result<String> {
    with_transient_retries(|| fetch_text_once(http, url)).await
}

async fn fetch_text_once(http: &Client, url: &str) -> Result<String> {
    let response = http
        .get(url)
        .send()
        .await
        .with_context(|| format!("Request failed for {url}"))?;

    if !response.status().is_success() {
        return Err(HttpStatusError {
            status: response.status().as_u16(),
            url: url.to_string(),
        }
        .into());
    }

    response
        .text()
        .await
        .with_context(|| format!("Failed to read text body for {url}"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    fn status_error(status: u16) -> anyhow::Error {
        HttpStatusError {
            status,
            url: "https://example.test/object".to_string(),
        }
        .into()
    }

    #[test]
    fn not_found_is_detected_through_context_layers() {
        assert!(is_not_found(&status_error(404)));
        assert!(is_not_found(&status_error(404).context("while fetching level")));
        assert!(!is_not_found(&status_error(503)));
        assert!(!is_not_found(&anyhow::anyhow!("connection reset")));
    }

    #[test]
    fn only_server_side_and_network_failures_are_transient() {
        assert!(is_transient(&status_error(500)));
        assert!(is_transient(&status_error(503)));
        assert!(is_transient(&status_error(429)));
        assert!(is_transient(&anyhow::anyhow!("connection closed before message completed")));
        assert!(!is_transient(&status_error(404)));
        assert!(!is_transient(&status_error(403)));
    }

    #[tokio::test(start_paused = true)]
    async fn transient_failures_are_retried_then_succeed() {
        let calls = AtomicU32::new(0);
        let result = with_transient_retries(|| async {
            if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                Err(status_error(503))
            } else {
                Ok("body")
            }
        })
        .await;
        assert_eq!(result.unwrap(), "body");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn permanent_failures_are_not_retried() {
        let calls = AtomicU32::new(0);
        let result: Result<()> = with_transient_retries(|| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(status_error(404))
        })
        .await;
        assert!(is_not_found(&result.unwrap_err()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn transient_failures_give_up_after_the_last_retry() {
        let calls = AtomicU32::new(0);
        let result: Result<()> = with_transient_retries(|| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(status_error(500))
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
}
