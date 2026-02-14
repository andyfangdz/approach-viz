use anyhow::{bail, Context, Result};
use reqwest::Client;

pub async fn fetch_bytes(http: &Client, url: &str) -> Result<Vec<u8>> {
    let response = http
        .get(url)
        .send()
        .await
        .with_context(|| format!("Request failed for {url}"))?;

    if !response.status().is_success() {
        bail!("Request failed ({}) for {url}", response.status());
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
        bail!("Request failed ({}) for {url}", response.status());
    }

    response
        .text()
        .await
        .with_context(|| format!("Failed to read text body for {url}"))
}
