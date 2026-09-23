use std::io::{BufWriter, Cursor};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use bincode::config::standard as bincode_config;
use bincode::serde::decode_from_slice;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tracing::{info, warn};

use crate::config::Config;
use crate::constants::{SNAPSHOT_MAGIC, SNAPSHOT_VERSION, SNAPSHOT_ZSTD_LEVEL};
use crate::types::ScanSnapshot;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SnapshotFile {
    magic: [u8; 4],
    version: u16,
    payload: ScanSnapshot,
}

/// Borrowing twin of `SnapshotFile` used for writing. Serde serializes a
/// reference exactly like the value it points to, so the bytes are identical to
/// those of an owned `SnapshotFile` and existing files stay readable, without
/// deep-cloning the ~150 MB snapshot first.
#[derive(Serialize)]
struct SnapshotFileRef<'a> {
    magic: [u8; 4],
    version: u16,
    payload: &'a ScanSnapshot,
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
    let started = Instant::now();
    let scans_dir = cfg.scans_dir();
    let timestamp = snapshot.timestamp.clone();

    // Offload CPU-intensive bincode encode + zstd compress to the blocking pool
    // so the async runtime stays free for request handling.
    let compressed = tokio::task::spawn_blocking(move || encode_snapshot(&snapshot))
        .await
        .context("Join error in snapshot compression")??;

    fs::create_dir_all(&scans_dir)
        .await
        .with_context(|| format!("Failed to create {}", scans_dir.display()))?;

    let path = scans_dir.join(format!("{timestamp}.avsn.zst"));
    let tmp_path = scans_dir.join(format!("{timestamp}.tmp"));

    fs::write(&tmp_path, &compressed)
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
    info!(
        "Persisted scan {timestamp} ({} bytes) in {}ms",
        compressed.len(),
        started.elapsed().as_millis()
    );
    Ok(())
}

/// Serializes straight into the compressor: no intermediate copy of the raw
/// encoding (~150 MB for a CONUS scan), and small writes are coalesced so the
/// compressor sees large blocks.
fn encode_snapshot(snapshot: &ScanSnapshot) -> Result<Vec<u8>> {
    let file = SnapshotFileRef {
        magic: SNAPSHOT_MAGIC,
        version: SNAPSHOT_VERSION,
        payload: snapshot,
    };
    let encoder = zstd::stream::Encoder::new(
        Vec::with_capacity(snapshot.voxels.len() * 3),
        SNAPSHOT_ZSTD_LEVEL,
    )
    .context("Failed to start snapshot compression")?;
    let mut writer = BufWriter::with_capacity(1 << 20, encoder);
    bincode::serde::encode_into_std_write(&file, &mut writer, bincode_config())
        .context("Failed to encode snapshot")?;
    let encoder = writer
        .into_inner()
        .map_err(|error| anyhow::anyhow!("Failed to flush snapshot encoder: {error}"))?;
    encoder
        .finish()
        .context("Failed to zstd-compress snapshot")
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
    use super::*;
    use crate::types::{
        EchoTopDebugMetadata, GridDef, LevelBounds, PhaseDebugMetadata, StoredEchoTop, StoredVoxel,
    };

    fn sample_snapshot(timestamp: &str) -> ScanSnapshot {
        let voxels = (0..5_000u32)
            .map(|i| StoredVoxel {
                row: (i * 7 % 3500) as u16,
                col: (i * 13 % 7000) as u16,
                level_idx: (i % 33) as u8,
                phase: (i % 3) as u8,
                surface_phase: (i % 2) as u8,
                dbz_tenths: (50 + (i % 600) as i16) - (i % 5) as i16,
            })
            .collect();
        ScanSnapshot {
            timestamp: timestamp.to_string(),
            generated_at_ms: 1_700_000_000_123,
            scan_time_ms: 1_700_000_000_000,
            grid: GridDef {
                nx: 7000,
                ny: 3500,
                la1_deg: 54.995,
                lo1_deg360: 230.005,
                di_deg: 0.01,
                dj_deg: 0.01,
                scanning_mode: 0,
                lat_step_deg: -0.01,
                lon_step_deg: 0.01,
            },
            tile_size: 64,
            tile_cols: 110,
            tile_rows: 55,
            level_bounds: vec![LevelBounds { bottom_feet: 0, top_feet: 1500 }; 33],
            tile_offsets: vec![0, 2_500, 5_000],
            voxels,
            echo_tops: vec![StoredEchoTop {
                row: 10,
                col: 20,
                top18_feet: 30_000,
                top30_feet: 25_000,
                top50_feet: 0,
                top60_feet: 0,
            }],
            echo_top_debug: EchoTopDebugMetadata::default(),
            phase_debug: PhaseDebugMetadata {
                mode: "thermo-primary".to_string(),
                detail: "aux_fallback=no".to_string(),
                ..Default::default()
            },
        }
    }

    #[test]
    fn borrowed_encoding_matches_the_owned_format_byte_for_byte() {
        let snapshot = sample_snapshot("20260923-201442");
        let owned = SnapshotFile {
            magic: SNAPSHOT_MAGIC,
            version: SNAPSHOT_VERSION,
            payload: snapshot.clone(),
        };
        let expected =
            bincode::serde::encode_to_vec(&owned, bincode_config()).expect("owned encode");

        let compressed = encode_snapshot(&snapshot).expect("streamed encode");
        let actual = zstd::stream::decode_all(Cursor::new(compressed)).expect("decompress");
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn persisted_snapshot_loads_back_identically() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::from_env().unwrap();
        cfg.storage_dir = dir.path().to_path_buf();
        cfg.retention_bytes = u64::MAX;

        let snapshot = sample_snapshot("20260923-201442");
        persist_snapshot(&cfg, Arc::new(snapshot.clone()))
            .await
            .unwrap();

        let loaded = load_latest_snapshot(&cfg)
            .await
            .unwrap()
            .expect("snapshot on disk");
        assert_eq!(loaded.timestamp, snapshot.timestamp);
        assert_eq!(loaded.voxels.len(), snapshot.voxels.len());
        for (a, b) in loaded.voxels.iter().zip(&snapshot.voxels) {
            assert_eq!(
                (a.row, a.col, a.level_idx, a.phase, a.surface_phase, a.dbz_tenths),
                (b.row, b.col, b.level_idx, b.phase, b.surface_phase, b.dbz_tenths)
            );
        }
        assert_eq!(loaded.tile_offsets, snapshot.tile_offsets);
        assert_eq!(loaded.phase_debug.detail, snapshot.phase_debug.detail);
        assert_eq!(loaded.echo_tops.len(), 1);
    }

    #[tokio::test]
    async fn retention_prunes_oldest_snapshots_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::from_env().unwrap();
        cfg.storage_dir = dir.path().to_path_buf();
        cfg.retention_bytes = u64::MAX;

        for ts in ["20260923-201000", "20260923-201200", "20260923-201400"] {
            persist_snapshot(&cfg, Arc::new(sample_snapshot(ts))).await.unwrap();
        }
        let one_file = std::fs::metadata(cfg.scans_dir().join("20260923-201400.avsn.zst"))
            .unwrap()
            .len();
        // Room for two files: the oldest must go.
        cfg.retention_bytes = one_file * 2 + one_file / 2;
        persist_snapshot(&cfg, Arc::new(sample_snapshot("20260923-201600"))).await.unwrap();

        let mut names: Vec<_> = std::fs::read_dir(cfg.scans_dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["20260923-201400.avsn.zst", "20260923-201600.avsn.zst"]);
    }
}
