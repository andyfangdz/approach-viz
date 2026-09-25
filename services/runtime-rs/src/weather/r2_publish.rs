//! Publishes each finished scan to R2 as a scan pack, from which the web
//! weather route answers while this service is down. See
//! docs/runtime-fallbacks.md.

use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use approach_viz_core::mrms_pack::{write_scan_pack, PackInput, PACK_CONTENT_TYPE};
use approach_viz_core::mrms_query::ScanMeta;
use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{error, info};

use super::{echo_top_response_headers, volume_response_headers};
use crate::config::R2PublishConfig;
use crate::types::ScanSnapshot;
use crate::utils::iso_from_ms;

/// Packs kept in the bucket. The web route only reads the newest; older ones
/// cover requests that read the previous manifest just before a publish.
const RETAINED_PACKS: usize = 5;
/// On a 21.4M-voxel CONUS scan: level 1 gives 34.0 MB in 0.32 s, level 3
/// 21.8 MB in 0.55 s, level 6 19.0 MB in 1.25 s. Level 3 takes most of the
/// size win, which also shrinks every range read the web route makes.
const PACK_DEFLATE_LEVEL: u32 = 3;
const MANIFEST_VERSION: u32 = 1;

/// `<prefix>/latest.json`: the only mutable object. The web route reads it to find
/// the newest pack and fetches that pack's header in one range read.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackManifest {
    version: u32,
    timestamp: String,
    key: String,
    header_length: u32,
    byte_length: u64,
    scan_time: Option<String>,
    generated_at: Option<String>,
    published_at: Option<String>,
}

/// Serialize `scan` as a scan pack with the response headers the runtime
/// itself would send.
pub fn build_scan_pack(scan: &ScanSnapshot) -> Result<Vec<u8>> {
    let headers = |pairs: Vec<(&'static str, axum::http::HeaderValue)>| {
        pairs
            .into_iter()
            .map(|(name, value)| {
                let value = String::from_utf8(value.as_bytes().to_vec())
                    .context("response header value is not UTF-8")?;
                Ok((name.to_string(), value))
            })
            .collect::<Result<Vec<_>>>()
    };
    let input = PackInput {
        timestamp: &scan.timestamp,
        generated_at_ms: scan.generated_at_ms,
        scan_time_ms: scan.scan_time_ms,
        grid: &scan.grid,
        tile_size: scan.tile_size,
        tile_cols: scan.tile_cols,
        tile_rows: scan.tile_rows,
        level_bounds: &scan.level_bounds,
        tile_offsets: &scan.tile_offsets,
        voxels: &scan.voxels,
        echo_tops: &scan.echo_tops,
        echo_top_summary: scan.echo_top_summary(),
        volume_headers: headers(volume_response_headers(scan))?,
        echo_top_headers: headers(echo_top_response_headers(scan))?,
    };
    let pack = write_scan_pack(&input, |raw| {
        let mut encoder = DeflateEncoder::new(
            Vec::with_capacity(raw.len() / 3),
            Compression::new(PACK_DEFLATE_LEVEL),
        );
        encoder
            .write_all(raw)
            .expect("in-memory deflate cannot fail");
        encoder.finish().expect("in-memory deflate cannot fail")
    })?;
    Ok(pack)
}

/// Publishes on its own task, like persistence: the channel keeps only the
/// newest scan, so a slow upload supersedes scans instead of queueing them.
pub(crate) fn spawn_r2_publish_worker(
    cfg: R2PublishConfig,
) -> watch::Sender<Option<Arc<ScanSnapshot>>> {
    let (sender, mut receiver) = watch::channel::<Option<Arc<ScanSnapshot>>>(None);
    let publisher = R2Publisher::new(cfg);
    tokio::spawn(async move {
        while receiver.changed().await.is_ok() {
            let Some(scan) = receiver.borrow_and_update().clone() else {
                continue;
            };
            if let Err(error) = publisher.publish(scan.clone()).await {
                error!("Failed to publish scan {} to R2: {error:#}", scan.timestamp);
            }
        }
    });
    sender
}

struct R2Publisher {
    client: Client,
    bucket: String,
    prefix: String,
}

impl R2Publisher {
    fn new(cfg: R2PublishConfig) -> Self {
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("auto"))
            .endpoint_url(&cfg.endpoint)
            .credentials_provider(Credentials::new(
                cfg.access_key_id,
                cfg.secret_access_key,
                None,
                None,
                "runtime-r2",
            ))
            .force_path_style(true)
            // R2 does not need the SDK's default request/response checksums.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build();
        Self {
            client: Client::from_conf(config),
            bucket: cfg.bucket,
            prefix: cfg.prefix,
        }
    }

    fn manifest_key(&self) -> String {
        format!("{}/latest.json", self.prefix)
    }

    fn scans_prefix(&self) -> String {
        format!("{}/scans/", self.prefix)
    }

    async fn publish(&self, scan: Arc<ScanSnapshot>) -> Result<()> {
        // Never move the manifest backwards: after a restart the loaded
        // snapshot may be older than what is already published.
        if let Some(current) = self.read_manifest().await? {
            if current.timestamp >= scan.timestamp {
                return Ok(());
            }
        }

        let started = Instant::now();
        let scan_for_pack = Arc::clone(&scan);
        let pack = tokio::task::spawn_blocking(move || build_scan_pack(&scan_for_pack))
            .await
            .context("Join error building scan pack")??;
        let packed_ms = started.elapsed().as_millis();
        let header_length = approach_viz_core::mrms_pack::read_header_len(&pack)?;
        let byte_length = pack.len() as u64;
        let key = format!("{}{}.avsp", self.scans_prefix(), scan.timestamp);

        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .content_type(PACK_CONTENT_TYPE)
            .cache_control("public, max-age=31536000, immutable")
            .body(ByteStream::from(pack))
            .send()
            .await
            .with_context(|| format!("Failed to upload {key}"))?;

        let manifest = PackManifest {
            version: MANIFEST_VERSION,
            timestamp: scan.timestamp.clone(),
            key: key.clone(),
            header_length,
            byte_length,
            scan_time: iso_from_ms(scan.scan_time_ms),
            generated_at: iso_from_ms(scan.generated_at_ms),
            published_at: iso_from_ms(chrono::Utc::now().timestamp_millis()),
        };
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(self.manifest_key())
            .content_type("application/json")
            .cache_control("no-store")
            .body(ByteStream::from(serde_json::to_vec(&manifest)?))
            .send()
            .await
            .context("Failed to upload the edge manifest")?;

        let pruned = self.prune().await?;
        info!(
            "Published MRMS scan {} to R2: {:.1} MB, packed in {packed_ms} ms, published in {} ms, pruned {pruned}",
            scan.timestamp,
            byte_length as f64 / 1e6,
            started.elapsed().as_millis(),
        );
        Ok(())
    }

    async fn read_manifest(&self) -> Result<Option<PackManifest>> {
        let response = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(self.manifest_key())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) if error.code() == Some("NoSuchKey") => return Ok(None),
            Err(error) => {
                return Err(error).context("Failed to read the edge manifest");
            }
        };
        let body = response.body.collect().await?.into_bytes();
        let manifest = serde_json::from_slice(&body).context("Edge manifest is malformed")?;
        Ok(Some(manifest))
    }

    /// Delete all but the newest `RETAINED_PACKS` packs (keys sort by scan time).
    async fn prune(&self) -> Result<usize> {
        let mut keys = Vec::new();
        let mut pages = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(self.scans_prefix())
            .into_paginator()
            .send();
        while let Some(page) = pages.next().await {
            let page = page.context("Failed to list published packs")?;
            keys.extend(
                page.contents()
                    .iter()
                    .filter_map(|object| object.key().map(String::from)),
            );
        }
        keys.sort();
        let stale = keys.len().saturating_sub(RETAINED_PACKS);
        for key in &keys[..stale] {
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(key)
                .send()
                .await
                .with_context(|| format!("Failed to delete {key}"))?;
        }
        Ok(stale)
    }
}
