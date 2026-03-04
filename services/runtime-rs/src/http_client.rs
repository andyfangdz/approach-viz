use anyhow::{Context, Result};
use reqwest::Client;

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

pub async fn fetch_bytes(http: &Client, url: &str) -> Result<Vec<u8>> {
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
