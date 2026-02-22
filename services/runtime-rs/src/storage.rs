use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use bincode::config::standard as bincode_config;
use bincode::serde::{decode_from_slice, encode_to_vec};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tracing::{info, warn};

use crate::config::Config;
use crate::constants::{SNAPSHOT_MAGIC, SNAPSHOT_VERSION};
use crate::types::{ScanSnapshot, TrafficCacheState};

const TRAFFIC_CACHE_MAGIC: [u8; 4] = *b"AVTC";
const TRAFFIC_CACHE_VERSION: u16 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SnapshotFile {
    magic: [u8; 4],
    version: u16,
    payload: ScanSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TrafficCacheFile {
    magic: [u8; 4],
    version: u16,
    payload: TrafficCacheState,
}

pub async fn load_latest_snapshot(cfg: &Config) -> Result<Option<Arc<ScanSnapshot>>> {
    let scans_dir = cfg.scans_dir();
    if !Path::new(&scans_dir).exists() {
        return Ok(None);
    }

    let mut dir = fs::read_dir(&scans_dir)
        .await
        .with_context(|| format!("Failed to read {}", scans_dir.display()))?;

    let mut files = Vec::new();
    while let Some(entry) = dir.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("zst") {
            files.push(path);
        }
    }

    files.sort();
    files.reverse();

    for path in files {
        match load_snapshot_file(&path).await {
            Ok(scan) => {
                info!("Loaded snapshot {}", path.display());
                return Ok(Some(Arc::new(scan)));
            }
            Err(error) => {
                warn!("Failed loading snapshot {}: {error:#}", path.display());
            }
        }
    }

    Ok(None)
}

async fn load_snapshot_file(path: &Path) -> Result<ScanSnapshot> {
    let compressed = fs::read(path)
        .await
        .with_context(|| format!("Failed to read snapshot file {}", path.display()))?;
    let decompressed = zstd::stream::decode_all(Cursor::new(compressed))
        .context("Failed to decompress snapshot")?;
    let (snapshot_file, _): (SnapshotFile, usize) =
        decode_from_slice(&decompressed, bincode_config()).context("Failed to decode snapshot")?;

    if snapshot_file.magic != SNAPSHOT_MAGIC {
        bail!("Invalid snapshot magic");
    }
    if snapshot_file.version != SNAPSHOT_VERSION {
        bail!("Unsupported snapshot version {}", snapshot_file.version);
    }

    Ok(snapshot_file.payload)
}

pub async fn persist_snapshot(cfg: &Config, snapshot: Arc<ScanSnapshot>) -> Result<()> {
    let file = SnapshotFile {
        magic: SNAPSHOT_MAGIC,
        version: SNAPSHOT_VERSION,
        payload: (*snapshot).clone(),
    };

    let encoded = encode_to_vec(&file, bincode_config()).context("Failed to encode snapshot")?;
    let compressed = zstd::stream::encode_all(Cursor::new(encoded), 6)
        .context("Failed to zstd-compress snapshot")?;

    let scans_dir = cfg.scans_dir();
    fs::create_dir_all(&scans_dir)
        .await
        .with_context(|| format!("Failed to create {}", scans_dir.display()))?;

    let path = scans_dir.join(format!("{}.avsn.zst", snapshot.timestamp));
    let tmp_path = scans_dir.join(format!("{}.tmp", snapshot.timestamp));

    fs::write(&tmp_path, compressed)
        .await
        .with_context(|| format!("Failed writing {}", tmp_path.display()))?;
    fs::rename(&tmp_path, &path).await.with_context(|| {
        format!(
            "Failed renaming {} -> {}",
            tmp_path.display(),
            path.display()
        )
    })?;

    apply_retention(cfg).await?;
    Ok(())
}

pub async fn load_traffic_cache(cfg: &Config) -> Result<Option<TrafficCacheState>> {
    let path = cfg.traffic_cache_file();
    if !path.exists() {
        return Ok(None);
    }

    let compressed = fs::read(&path)
        .await
        .with_context(|| format!("Failed reading traffic cache {}", path.display()))?;
    let decompressed = zstd::stream::decode_all(Cursor::new(compressed))
        .context("Failed to decompress traffic cache")?;
    let (cache_file, _): (TrafficCacheFile, usize) =
        decode_from_slice(&decompressed, bincode_config())
            .context("Failed to decode traffic cache")?;

    if cache_file.magic != TRAFFIC_CACHE_MAGIC {
        bail!("Invalid traffic cache magic");
    }
    if cache_file.version != TRAFFIC_CACHE_VERSION {
        bail!("Unsupported traffic cache version {}", cache_file.version);
    }

    Ok(Some(cache_file.payload))
}

pub async fn persist_traffic_cache(cfg: &Config, cache: &TrafficCacheState) -> Result<()> {
    let file = TrafficCacheFile {
        magic: TRAFFIC_CACHE_MAGIC,
        version: TRAFFIC_CACHE_VERSION,
        payload: cache.clone(),
    };
    let encoded =
        encode_to_vec(&file, bincode_config()).context("Failed to encode traffic cache file")?;
    let compressed = zstd::stream::encode_all(Cursor::new(encoded), 3)
        .context("Failed to zstd-compress traffic cache file")?;

    let path = cfg.traffic_cache_file();
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Traffic cache path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .await
        .with_context(|| format!("Failed to create {}", parent.display()))?;
    let tmp_path = path.with_extension("tmp");

    fs::write(&tmp_path, compressed)
        .await
        .with_context(|| format!("Failed writing {}", tmp_path.display()))?;
    fs::rename(&tmp_path, &path).await.with_context(|| {
        format!(
            "Failed renaming {} -> {}",
            tmp_path.display(),
            path.display()
        )
    })?;

    Ok(())
}

async fn apply_retention(cfg: &Config) -> Result<()> {
    let scans_dir = cfg.scans_dir();
    let mut dir = fs::read_dir(&scans_dir)
        .await
        .with_context(|| format!("Failed to read {}", scans_dir.display()))?;

    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    let mut total_bytes: u64 = 0;

    while let Some(entry) = dir.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("zst") {
            continue;
        }
        let metadata = entry.metadata().await?;
        let len = metadata.len();
        total_bytes = total_bytes.saturating_add(len);
        files.push((path, len));
    }

    if total_bytes <= cfg.retention_bytes {
        return Ok(());
    }

    files.sort_by(|left, right| left.0.cmp(&right.0));
    for (path, len) in files {
        if total_bytes <= cfg.retention_bytes {
            break;
        }
        if let Err(error) = fs::remove_file(&path).await {
            warn!("Failed removing {}: {error}", path.display());
            continue;
        }
        total_bytes = total_bytes.saturating_sub(len);
        info!("Pruned {} ({} bytes)", path.display(), len);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{load_traffic_cache, persist_traffic_cache};
    use crate::config::Config;
    use crate::types::{TrafficCachePoint, TrafficCacheState, TrafficCacheTrack};

    fn test_config(storage_dir: PathBuf) -> Config {
        Config {
            listen_addr: "127.0.0.1:9191".to_string(),
            storage_dir,
            retention_bytes: 1024 * 1024,
            request_timeout: Duration::from_secs(10),
            bootstrap_interval: Duration::from_secs(300),
            sqs_poll_delay: Duration::from_secs(3),
            pending_retry_delay: Duration::from_secs(30),
            aws_region: "us-east-1".to_string(),
            sqs_queue_url: None,
            tile_size: 64,
            adsbx_primary_base_url: "https://globe.adsbexchange.com".to_string(),
            adsbx_fallback_base_urls: vec!["https://globe.theairtraffic.com".to_string()],
            ingest_profile_timestamp: None,
            ingest_profile_repeats: 1,
            ingest_local_data_dir: None,
            ingest_local_data_offline: false,
            ingest_parse_concurrency: 1,
        }
    }

    fn unique_temp_dir() -> PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "approach-viz-runtime-traffic-cache-test-{}-{ts}",
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn traffic_cache_persists_and_loads_round_trip() {
        let temp_dir = unique_temp_dir();
        let cfg = test_config(temp_dir.clone());

        let mut tracks = HashMap::new();
        tracks.insert(
            "abc123".to_string(),
            TrafficCacheTrack {
                hex: "abc123".to_string(),
                flight: Some("DAL123".to_string()),
                is_on_ground: false,
                altitude_feet: Some(12100.0),
                ground_speed_kt: Some(242.0),
                track_deg: Some(84.0),
                last_observed_at_ms: 1_700_000_000_000,
                points: VecDeque::from(vec![
                    TrafficCachePoint {
                        timestamp_ms: 1_700_000_000_000,
                        lat: 40.6,
                        lon: -73.7,
                        altitude_feet: 11_900.0,
                        is_on_ground: false,
                    },
                    TrafficCachePoint {
                        timestamp_ms: 1_700_000_001_000,
                        lat: 40.61,
                        lon: -73.69,
                        altitude_feet: 12_100.0,
                        is_on_ground: false,
                    },
                ]),
            },
        );
        let cache = TrafficCacheState {
            updated_at_ms: 1_700_000_001_000,
            source: Some("traffic-cache (test)".to_string()),
            tracks_by_hex: tracks,
        };

        persist_traffic_cache(&cfg, &cache)
            .await
            .expect("persist_traffic_cache should succeed");
        let loaded = load_traffic_cache(&cfg)
            .await
            .expect("load_traffic_cache should succeed")
            .expect("load_traffic_cache should return Some");

        assert_eq!(loaded.updated_at_ms, cache.updated_at_ms);
        assert_eq!(loaded.source, cache.source);
        assert_eq!(loaded.tracks_by_hex.len(), 1);
        let loaded_track = loaded
            .tracks_by_hex
            .get("abc123")
            .expect("track should be present");
        assert_eq!(loaded_track.flight.as_deref(), Some("DAL123"));
        assert_eq!(loaded_track.points.len(), 2);
        assert_eq!(loaded_track.points[0].lat, 40.6);
        assert_eq!(loaded_track.points[1].altitude_feet, 12_100.0);

        let _ = tokio::fs::remove_dir_all(temp_dir).await;
    }
}
