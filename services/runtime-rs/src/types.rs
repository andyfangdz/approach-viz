use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, Semaphore};

use crate::config::Config;
use crate::traffic::TrafficStore;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub http: Client,
    pub latest: Arc<RwLock<Option<Arc<ScanSnapshot>>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingIngest>>>,
    pub recent_timestamps: Arc<Mutex<HashSet<String>>>,
    pub ingest_parse_limiter: Arc<Semaphore>,
    pub(crate) traffic_store: Arc<TrafficStore>,
}

// Stored scan records live in core so the weather edge Worker can decode scan
// packs into the same types; serde derives keep the snapshot format unchanged.
pub use approach_viz_core::mrms_query::{GridDef, LevelBounds, StoredEchoTop, StoredVoxel};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanSnapshot {
    pub timestamp: String,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub grid: GridDef,
    pub tile_size: u16,
    pub tile_cols: u16,
    pub tile_rows: u16,
    pub level_bounds: Vec<LevelBounds>,
    pub tile_offsets: Vec<u32>,
    pub voxels: Vec<StoredVoxel>,
    #[serde(default)]
    pub echo_tops: Vec<StoredEchoTop>,
    #[serde(default)]
    pub echo_top_debug: EchoTopDebugMetadata,
    #[serde(default)]
    pub phase_debug: PhaseDebugMetadata,
}

#[derive(Clone, Debug)]
pub struct PendingIngest {
    pub attempts: u32,
    pub next_attempt_at: Instant,
}

#[derive(Clone, Debug)]
pub struct ParsedReflectivityField {
    pub grid: GridDef,
    pub dbz_tenths: Vec<i16>,
}

#[derive(Clone, Debug)]
pub struct ParsedAuxField {
    pub grid: GridDef,
    pub values: AuxValues,
}

/// Values of a decoded GRIB2 field, indexed by flat grid position.
///
/// PNG-packed fields keep their raw integer samples and convert on access with
/// the exact arithmetic the GRIB decoder applies, so a CONUS field costs its
/// 24-73 MB of samples rather than a 98 MB `f32` copy, and readers that only
/// need a sparse set of positions never convert the rest.
#[derive(Clone, Debug)]
pub enum AuxValues {
    Dense(Vec<f32>),
    Packed(PackedSamples),
}

/// Big-endian fixed-width unsigned samples plus the rule that maps a sample to
/// its physical value.
#[derive(Clone)]
pub struct PackedSamples {
    samples: Vec<u8>,
    width: usize,
    mapping: SampleMapping,
}

#[derive(Clone, Debug)]
enum SampleMapping {
    /// One entry per possible sample value (8/16-bit samples).
    Table(Box<[f32]>),
    /// `(ref_val + sample * pow2) * dig_factor`, evaluated per sample (24-bit).
    Linear {
        ref_val: f32,
        pow2: f32,
        dig_factor: f32,
    },
}

/// The GRIB2 simple-packing value of an integer sample, `(R + X * 2^E) * 10^-D`,
/// with `pow2 = 2^E` and `dig_factor = 10^-D`. Evaluated in `f32` in exactly this
/// order because the decoder tests pin it bit for bit against the `grib` crate;
/// every conversion of a packed sample goes through here.
#[inline(always)]
pub fn packed_sample_value(ref_val: f32, pow2: f32, dig_factor: f32, sample: u32) -> f32 {
    (ref_val + sample as f32 * pow2) * dig_factor
}

impl std::fmt::Debug for PackedSamples {
    // The sample buffer is tens of megabytes; never print it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PackedSamples")
            .field("points", &self.len())
            .field("width", &self.width)
            .finish_non_exhaustive()
    }
}

impl PackedSamples {
    pub fn with_table(samples: Vec<u8>, width: usize, table: Vec<f32>) -> Self {
        debug_assert!(matches!(width, 1 | 2) && table.len() == 1 << (width * 8));
        Self {
            samples,
            width,
            mapping: SampleMapping::Table(table.into_boxed_slice()),
        }
    }

    pub fn with_linear(samples: Vec<u8>, width: usize, ref_val: f32, pow2: f32, dig_factor: f32) -> Self {
        Self {
            samples,
            width,
            mapping: SampleMapping::Linear {
                ref_val,
                pow2,
                dig_factor,
            },
        }
    }

    #[inline(always)]
    fn sample_at(&self, idx: usize) -> u32 {
        let bytes = &self.samples[idx * self.width..(idx + 1) * self.width];
        match self.width {
            1 => u32::from(bytes[0]),
            2 => u32::from(u16::from_be_bytes([bytes[0], bytes[1]])),
            _ => u32::from(bytes[0]) << 16 | u32::from(bytes[1]) << 8 | u32::from(bytes[2]),
        }
    }

    #[inline(always)]
    fn value_of(&self, sample: u32) -> f32 {
        match &self.mapping {
            SampleMapping::Table(table) => table[sample as usize],
            SampleMapping::Linear {
                ref_val,
                pow2,
                dig_factor,
            } => packed_sample_value(*ref_val, *pow2, *dig_factor, sample),
        }
    }

    fn len(&self) -> usize {
        self.samples.len() / self.width
    }
}

impl AuxValues {
    pub fn len(&self) -> usize {
        match self {
            Self::Dense(values) => values.len(),
            Self::Packed(packed) => packed.len(),
        }
    }

    /// Value at a flat grid position, or `None` when out of range.
    #[inline]
    pub fn get(&self, idx: usize) -> Option<f32> {
        match self {
            Self::Dense(values) => values.get(idx).copied(),
            Self::Packed(packed) => (idx < packed.len()).then(|| packed.value_of(packed.sample_at(idx))),
        }
    }

    /// Values at `indices`, `NaN` where an index is out of range.
    pub fn gather(&self, indices: &[u32]) -> Vec<f32> {
        let mut out = Vec::new();
        self.gather_into(indices, &mut out);
        out
    }

    /// Like `gather`, replacing the contents of `out` (its allocation is reused).
    pub fn gather_into(&self, indices: &[u32], out: &mut Vec<f32>) {
        out.clear();
        out.reserve(indices.len());
        match self {
            Self::Dense(values) => out.extend(
                indices
                    .iter()
                    .map(|&idx| values.get(idx as usize).copied().unwrap_or(f32::NAN)),
            ),
            Self::Packed(packed) => {
                let len = packed.len();
                out.extend(indices.iter().map(|&idx| {
                    let idx = idx as usize;
                    if idx < len {
                        packed.value_of(packed.sample_at(idx))
                    } else {
                        f32::NAN
                    }
                }));
            }
        }
    }

    #[cfg(test)]
    pub fn to_vec(&self) -> Vec<f32> {
        (0..self.len()).map(|idx| self.get(idx).unwrap()).collect()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PhaseDebugMetadata {
    pub mode: String,
    pub detail: String,
    pub zdr_timestamp: Option<String>,
    pub rhohv_timestamp: Option<String>,
    pub precip_flag_timestamp: Option<String>,
    pub freezing_level_timestamp: Option<String>,
    pub zdr_age_seconds: Option<i64>,
    pub rhohv_age_seconds: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EchoTopDebugMetadata {
    pub top18_timestamp: Option<String>,
    pub top30_timestamp: Option<String>,
    pub top50_timestamp: Option<String>,
    pub top60_timestamp: Option<String>,
    pub max_top18_feet: Option<u16>,
    pub max_top30_feet: Option<u16>,
    pub max_top50_feet: Option<u16>,
    pub max_top60_feet: Option<u16>,
}
