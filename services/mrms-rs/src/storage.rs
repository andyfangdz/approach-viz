use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use bincode::config::standard as bincode_config;
use bincode::serde::{decode_from_slice, encode_to_vec};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tracing::{info, warn};

use crate::config::Config;
use crate::constants::{SNAPSHOT_MAGIC, SNAPSHOT_VERSION};
use crate::types::ScanSnapshot;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SnapshotFile {
    magic: [u8; 4],
    version: u16,
    payload: ScanSnapshot,
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
