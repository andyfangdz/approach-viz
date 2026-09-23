use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{OnceCell, Semaphore};
use tokio::time::Instant;
use tracing::{info, warn};

use wide::{i16x8, CmpEq, CmpGt};

use super::grib::{parse_aux_grib_gzipped, parse_reflectivity_grib_gzipped};
use super::phase::{promote_mixed_transition_edges, LevelPhaseVoxel};
use super::phase_batch::{
    compute_phase_scores_branchless, FLAG_FORCED_PRECIP_SNOW, FLAG_SUPPRESSED_DUAL,
    FLAG_SUPPRESSED_MIXED, FLAG_TRANSITION_CANDIDATE, FLAG_USED_DUAL,
};
use super::simd_lut::COMPRESS_LUT;
use super::sources::{
    build_level_key, fetch_aux_field_at_timestamp, fetch_mrms_key_bytes,
    fetch_mrms_key_bytes_when_published, fetch_reflectivity_level_bytes,
    find_latest_aux_timestamp_at_or_before,
    find_latest_level_timestamp_at_or_before, timestamp_age_seconds,
};
use crate::constants::{
    DUAL_POL_PUBLICATION_GRACE_SECONDS, DUAL_POL_STALE_THRESHOLD_SECONDS, FEET_PER_KM, LEVEL_TAGS,
    MRMS_BASE_LEVEL_TAG, MRMS_BRIGHT_BAND_BOTTOM_PRODUCT, MRMS_BRIGHT_BAND_TOP_PRODUCT,
    MRMS_ECHO_TOP_18_PRODUCT, MRMS_ECHO_TOP_30_PRODUCT, MRMS_ECHO_TOP_50_PRODUCT,
    MRMS_ECHO_TOP_60_PRODUCT, MRMS_MODEL_FREEZING_HEIGHT_PRODUCT, MRMS_MODEL_SURFACE_TEMP_PRODUCT,
    MRMS_MODEL_WET_BULB_TEMP_PRODUCT, MRMS_PRECIP_FLAG_PRODUCT, MRMS_RHOHV_PRODUCT_PREFIX, MRMS_RQI_PRODUCT, MRMS_ZDR_PRODUCT_PREFIX, STORE_MIN_DBZ_TENTHS,
};
use crate::types::{
    AppState, AuxValues, EchoTopDebugMetadata, GridDef, LevelBounds, ParsedAuxField,
    ParsedReflectivityField, PhaseDebugMetadata, ScanSnapshot, StoredEchoTop, StoredVoxel,
};
use crate::utils::{parse_timestamp_utc, round_u16, to_lon360};

/// Result of Pass 1 filter: flat indices plus precomputed row/col.
/// Precomputing row/col here avoids repeated `idx / nx` and `idx % nx`
/// integer division in the gather pass (9 fields × N voxels) and tally pass.
///
/// Designed for reuse across levels: call `clear()` then pass to
/// `filter_voxels_by_threshold` each iteration to avoid re-allocation.
pub struct FilterResult {
    /// Flat index into the level's 1D grid array.
    pub indices: Vec<u32>,
    /// Precomputed `(idx / nx) as u16` for each valid voxel.
    pub rows: Vec<u16>,
    /// Precomputed `(idx % nx) as u16` for each valid voxel.
    pub cols: Vec<u16>,
}

impl FilterResult {
    pub fn new() -> Self {
        Self {
            indices: Vec::new(),
            rows: Vec::new(),
            cols: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        self.indices.clear();
        self.rows.clear();
        self.cols.clear();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.indices.len()
    }
}

/// Pass 1: Scan dbz_tenths and collect indices of voxels at or above threshold.
///
/// Uses explicit SIMD via `wide::i16x8`: compares 8 i16 lanes per iteration,
/// extracts a bitmask, and uses `COMPRESS_LUT` to gather matching indices
/// without per-element branches. Scalar tail loop handles `n % 8` remainder.
///
/// Also precomputes row/col for each matching index to eliminate repeated
/// integer division in downstream passes.
///
/// Appends to `out` (caller should `out.clear()` before calling).
/// Reusing the same `FilterResult` across levels avoids re-allocation.
#[inline(never)] // Preserve as named function for LLVM remarks + asm inspection
pub fn filter_voxels_by_threshold(dbz_tenths: &[i16], threshold: i16, nx: u32, out: &mut FilterResult) {
    let n = dbz_tenths.len();

    let threshold_v = i16x8::splat(threshold);
    let chunks = n / 8;
    let nx_usize = nx as usize;

    for chunk_idx in 0..chunks {
        let base = chunk_idx * 8;
        // Safety: base + 8 <= chunks * 8 <= n, so slice is in bounds.
        let chunk: [i16; 8] = dbz_tenths[base..base + 8].try_into().unwrap();
        let vals = i16x8::new(chunk);

        // a >= b  <==>  (a > b) | (a == b)
        let mask_vec = vals.simd_gt(threshold_v) | vals.simd_eq(threshold_v);
        let mask = mask_vec.to_bitmask() as usize;

        if mask == 0 {
            continue;
        }

        let (positions, count) = COMPRESS_LUT[mask];
        let base_u32 = base as u32;
        for i in 0..count as usize {
            let idx = base + positions[i] as usize;
            out.indices.push(base_u32 + positions[i] as u32);
            out.rows.push((idx / nx_usize) as u16);
            out.cols.push((idx % nx_usize) as u16);
        }
    }

    // Scalar tail for remaining n % 8 elements
    let tail_start = chunks * 8;
    for i in tail_start..n {
        if dbz_tenths[i] >= threshold {
            out.indices.push(i as u32);
            out.rows.push((i / nx_usize) as u16);
            out.cols.push((i % nx_usize) as u16);
        }
    }
}

/// Base-level aux fields (one 2-D field each, shared by every level) sampled at
/// the voxels that survive the reflectivity filter. `NaN` marks missing values.
///
/// Designed for reuse across levels: the buffers are refilled in place.
pub(crate) struct GatheredAuxFields {
    pub(crate) precip_flag: Vec<f32>,
    pub(crate) freezing_level: Vec<f32>,
    pub(crate) wet_bulb: Vec<f32>,
    pub(crate) surface_temp: Vec<f32>,
    pub(crate) bright_band_top: Vec<f32>,
    pub(crate) bright_band_bottom: Vec<f32>,
    pub(crate) rqi: Vec<f32>,
}

impl GatheredAuxFields {
    fn new() -> Self {
        Self {
            precip_flag: Vec::new(),
            freezing_level: Vec::new(),
            wet_bulb: Vec::new(),
            surface_temp: Vec::new(),
            bright_band_top: Vec::new(),
            bright_band_bottom: Vec::new(),
            rqi: Vec::new(),
        }
    }
}

/// Samplers for the seven base-level aux fields.
pub(crate) struct BaseAuxSamplers<'a> {
    precip: AuxFieldSampler<'a>,
    freezing: AuxFieldSampler<'a>,
    wet_bulb: AuxFieldSampler<'a>,
    surface_temp: AuxFieldSampler<'a>,
    bright_band_top: AuxFieldSampler<'a>,
    bright_band_bottom: AuxFieldSampler<'a>,
    rqi: AuxFieldSampler<'a>,
}

/// Pass 2: Gather base-level aux field values for the filtered voxels into flat
/// f32 arrays.
///
/// Uses NaN as sentinel for missing values. This separates the Option-chain
/// indirection (AuxFieldSampler lookup) from the compute pass, so the compute
/// pass can operate on flat arrays without branches.
///
/// Uses the row/col arrays precomputed by `filter_voxels_by_threshold` to avoid
/// repeated `idx / nx` and `idx % nx` integer division.
#[inline(never)] // Preserve as named function for LLVM remarks + asm inspection
fn gather_base_aux_fields(
    filter: &FilterResult,
    samplers: &BaseAuxSamplers,
    out: &mut GatheredAuxFields,
) {
    samplers.precip.gather(filter, &mut out.precip_flag);
    samplers.freezing.gather(filter, &mut out.freezing_level);
    samplers.wet_bulb.gather(filter, &mut out.wet_bulb);
    samplers.surface_temp.gather(filter, &mut out.surface_temp);
    samplers
        .bright_band_top
        .gather(filter, &mut out.bright_band_top);
    samplers
        .bright_band_bottom
        .gather(filter, &mut out.bright_band_bottom);
    samplers.rqi.gather(filter, &mut out.rqi);
}

/// One reflectivity level reduced from a full-CONUS grid to the sparse voxels at
/// or above the storage threshold, together with the dual-pol values sampled at
/// exactly those voxels. Everything downstream (phase scoring, promotion, tile
/// packing) needs only this, so the 49-98 MB decoded grids are dropped as soon as
/// a level is reduced.
pub(crate) struct LevelInputs {
    level_idx: u8,
    level_tag: &'static str,
    grid: GridDef,
    filtered: FilterResult,
    /// Reflectivity (tenths of dBZ) at each filtered voxel.
    dbz_tenths: Vec<i16>,
    zdr: DualPolLevel,
    rhohv: DualPolLevel,
}

struct DualPolLevel {
    /// The level was fetched and decoded, whether or not its grid matched. This
    /// is what the bundle-completeness check counts.
    available: bool,
    /// Values at each filtered voxel; `None` when unavailable or grid-mismatched.
    values: Option<Vec<f32>>,
}

/// Dual-pol scan chosen to accompany a reflectivity scan: the exact timestamp
/// when its base level exists, otherwise the latest earlier one.
struct DualPolSource {
    product_prefix: &'static str,
    selected_timestamp: Option<String>,
    age_seconds: Option<i64>,
    /// Compressed base level, already downloaded while probing for the exact
    /// or latest timestamp; consumed by level 0.
    base_level_zipped: StdMutex<Option<Vec<u8>>>,
}

impl DualPolSource {
    fn take_base_level_zipped(&self) -> Option<Vec<u8>> {
        self.base_level_zipped
            .lock()
            .expect("dual-pol base level mutex poisoned")
            .take()
    }
}

/// Lazily selected once per ingest and shared by all level tasks.
struct DualPolSources {
    zdr: OnceCell<DualPolSource>,
    rhohv: OnceCell<DualPolSource>,
}

impl DualPolSources {
    fn new() -> Self {
        Self {
            zdr: OnceCell::new(),
            rhohv: OnceCell::new(),
        }
    }

    async fn zdr(&self, state: &AppState, timestamp: &str) -> &DualPolSource {
        self.zdr
            .get_or_init(|| select_dual_pol_source(state, MRMS_ZDR_PRODUCT_PREFIX, timestamp))
            .await
    }

    async fn rhohv(&self, state: &AppState, timestamp: &str) -> &DualPolSource {
        self.rhohv
            .get_or_init(|| select_dual_pol_source(state, MRMS_RHOHV_PRODUCT_PREFIX, timestamp))
            .await
    }
}

/// Selected dual-pol scan metadata carried into the assembled snapshot.
struct DualPolSummary {
    zdr_timestamp: Option<String>,
    zdr_age_seconds: Option<i64>,
    rhohv_timestamp: Option<String>,
    rhohv_age_seconds: Option<i64>,
}

/// Adds a permit when dropped, on every exit path of a level task, so the aux
/// fetch below never waits on a level that failed or was cancelled.
struct DownloadedSignal(Arc<Semaphore>);

impl Drop for DownloadedSignal {
    fn drop(&mut self) {
        self.0.add_permits(1);
    }
}

pub(super) async fn ingest_timestamp(state: &AppState, timestamp: &str) -> Result<Arc<ScanSnapshot>> {
    let started = Instant::now();
    if parse_timestamp_utc(timestamp).is_none() {
        bail!("Invalid timestamp format: {timestamp}");
    }

    // Every level is its own task: it waits for NOAA to publish its reflectivity
    // object, pairs it with the dual-pol level, and reduces both to sparse voxel
    // inputs. A level that lands late delays only itself, so nothing already
    // downloaded or decoded is ever repeated, and only a few full grids are
    // resident at once (bounded by the parse limiter).
    let dual_pol = Arc::new(DualPolSources::new());
    let downloaded = Arc::new(Semaphore::new(0));
    let mut level_tasks = FuturesUnordered::new();
    let mut aborts = Vec::with_capacity(LEVEL_TAGS.len());
    for level_idx in 0..LEVEL_TAGS.len() {
        let handle = tokio::spawn(ingest_level(
            state.clone(),
            timestamp.to_string(),
            level_idx,
            dual_pol.clone(),
            downloaded.clone(),
            started,
        ));
        aborts.push(handle.abort_handle());
        level_tasks.push(handle);
    }

    let levels_future = async {
        let mut levels: Vec<Option<LevelInputs>> = (0..LEVEL_TAGS.len()).map(|_| None).collect();
        while let Some(joined) = level_tasks.next().await {
            let level = joined.context("Join error while ingesting MRMS level")??;
            let slot = level.level_idx as usize;
            levels[slot] = Some(level);
        }
        levels
            .into_iter()
            .enumerate()
            .map(|(idx, level)| level.ok_or_else(|| anyhow!("Missing parsed level {}", LEVEL_TAGS[idx])))
            .collect::<Result<Vec<_>>>()
    };
    // Thermodynamic and echo-top products are picked as "latest at or before
    // this scan". Several are published a little after the base level, so they
    // are selected once every level is in, which finds the freshest ones; their
    // download and decode overlap the tail of the level decoding.
    let aux_future = async {
        let _all_downloaded = downloaded
            .acquire_many(LEVEL_TAGS.len() as u32)
            .await
            .context("Level download gate closed")?;
        let downloaded_at = started.elapsed();
        let (thermo, echo) = tokio::join!(
            fetch_thermo_aux_bundle(state, timestamp),
            fetch_echo_top_bundle(state, timestamp),
        );
        Ok::<_, anyhow::Error>((downloaded_at, thermo, echo))
    };

    let joined = tokio::try_join!(levels_future, aux_future);
    if joined.is_err() {
        // Stop levels that have not started decoding; the scan is abandoned.
        for abort in &aborts {
            abort.abort();
        }
    }
    let (levels, (downloaded_at, thermo_aux_bundle, echo_top_bundle)) = joined?;
    let decoded_at = started.elapsed();

    let summary = DualPolSummary {
        zdr_timestamp: dual_pol
            .zdr
            .get()
            .and_then(|source| source.selected_timestamp.clone()),
        zdr_age_seconds: dual_pol.zdr.get().and_then(|source| source.age_seconds),
        rhohv_timestamp: dual_pol
            .rhohv
            .get()
            .and_then(|source| source.selected_timestamp.clone()),
        rhohv_age_seconds: dual_pol.rhohv.get().and_then(|source| source.age_seconds),
    };

    let tile_size = state.cfg.tile_size.max(16);
    let timestamp_owned = timestamp.to_string();
    // Scan assembly is heavy synchronous grid compute (33 per-level
    // score/promote passes plus a full-grid echo-top scan). Run it on the
    // blocking pool so it cannot stall async runtime workers that are
    // concurrently serving HTTP requests and SQS polling.
    let scan = tokio::task::spawn_blocking(move || {
        assemble_scan_snapshot(
            timestamp_owned,
            levels,
            summary,
            thermo_aux_bundle,
            echo_top_bundle,
            tile_size,
        )
    })
    .await
    .context("Join error while assembling MRMS scan snapshot")??;
    info!(
        "Ingest timings for {timestamp}: all levels downloaded after {}ms, decoded after {}ms, assembled after {}ms",
        downloaded_at.as_millis(),
        decoded_at.as_millis(),
        started.elapsed().as_millis(),
    );
    Ok(scan)
}

async fn ingest_level(
    state: AppState,
    timestamp: String,
    level_idx: usize,
    dual_pol: Arc<DualPolSources>,
    downloaded: Arc<Semaphore>,
    ingest_started: Instant,
) -> Result<LevelInputs> {
    let level_tag = LEVEL_TAGS[level_idx];
    let downloaded_signal = DownloadedSignal(downloaded);

    let (reflectivity_zipped, zdr_source, rhohv_source) = tokio::join!(
        fetch_reflectivity_level_bytes(&state, level_tag, &timestamp, ingest_started),
        dual_pol.zdr(&state, &timestamp),
        dual_pol.rhohv(&state, &timestamp),
    );
    let reflectivity_zipped = reflectivity_zipped?;
    drop(downloaded_signal);

    let (zdr_zipped, rhohv_zipped) = tokio::join!(
        fetch_dual_pol_level_zipped(&state, zdr_source, level_idx),
        fetch_dual_pol_level_zipped(&state, rhohv_source, level_idx),
    );

    let permit = state
        .ingest_parse_limiter
        .clone()
        .acquire_owned()
        .await
        .context("Failed to acquire ingest parse limiter permit")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        reduce_level(
            level_idx,
            &timestamp,
            &reflectivity_zipped,
            zdr_zipped.as_deref(),
            rhohv_zipped.as_deref(),
        )
    })
    .await
    .context("Join error while reducing MRMS level")?
}

/// Decodes one level's reflectivity and dual-pol payloads and keeps only what
/// scan assembly needs. The grids are decoded one at a time and dropped as soon
/// as their values are extracted.
fn reduce_level(
    level_idx: usize,
    timestamp: &str,
    reflectivity_zipped: &[u8],
    zdr_zipped: Option<&[u8]>,
    rhohv_zipped: Option<&[u8]>,
) -> Result<LevelInputs> {
    let level_tag = LEVEL_TAGS[level_idx];
    let reflectivity = parse_reflectivity_grib_gzipped(reflectivity_zipped)
        .with_context(|| format!("Failed to decode reflectivity level {level_tag}"))?;
    let ParsedReflectivityField {
        grid,
        dbz_tenths: full_grid_dbz,
    } = reflectivity;
    let point_count = full_grid_dbz.len();

    let mut filtered = FilterResult::new();
    filter_voxels_by_threshold(&full_grid_dbz, STORE_MIN_DBZ_TENTHS, grid.nx, &mut filtered);
    let dbz_tenths: Vec<i16> = filtered
        .indices
        .iter()
        .map(|&idx| full_grid_dbz[idx as usize])
        .collect();
    drop(full_grid_dbz);

    let zdr = reduce_dual_pol_level(
        "ZDR",
        MRMS_ZDR_PRODUCT_PREFIX,
        zdr_zipped,
        &grid,
        point_count,
        &filtered.indices,
        level_tag,
        timestamp,
    );
    let rhohv = reduce_dual_pol_level(
        "RhoHV",
        MRMS_RHOHV_PRODUCT_PREFIX,
        rhohv_zipped,
        &grid,
        point_count,
        &filtered.indices,
        level_tag,
        timestamp,
    );

    Ok(LevelInputs {
        level_idx: level_idx as u8,
        level_tag,
        grid,
        filtered,
        dbz_tenths,
        zdr,
        rhohv,
    })
}

#[allow(clippy::too_many_arguments)]
fn reduce_dual_pol_level(
    product_label: &str,
    product_prefix: &str,
    zipped: Option<&[u8]>,
    reflectivity_grid: &GridDef,
    reflectivity_point_count: usize,
    indices: &[u32],
    level_tag: &str,
    timestamp: &str,
) -> DualPolLevel {
    let Some(zipped) = zipped else {
        return DualPolLevel {
            available: false,
            values: None,
        };
    };
    let field = match parse_aux_grib_gzipped(zipped) {
        Ok(field) => field,
        Err(error) => {
            warn!(
                "{product_prefix} aux unavailable for level {level_tag} at {timestamp}: {error:#}"
            );
            return DualPolLevel {
                available: false,
                values: None,
            };
        }
    };
    if !is_same_grid(&field.grid, reflectivity_grid) {
        warn!(
            "{product_label} aux grid mismatch for level {level_tag} at {timestamp}; using aux fallback for affected voxels"
        );
        return DualPolLevel {
            available: true,
            values: None,
        };
    }
    if field.values.len() != reflectivity_point_count {
        warn!(
            "{product_label} aux point-count mismatch for level {level_tag} at {timestamp}: expected {reflectivity_point_count}, got {}; using aux fallback for affected voxels",
            field.values.len()
        );
        return DualPolLevel {
            available: true,
            values: None,
        };
    }
    DualPolLevel {
        available: true,
        values: Some(field.values.gather(indices)),
    }
}

fn assemble_scan_snapshot(
    timestamp: String,
    levels: Vec<LevelInputs>,
    dual_pol: DualPolSummary,
    thermo_aux_bundle: ThermoAuxBundle,
    echo_top_bundle: EchoTopBundle,
    tile_size: u16,
) -> Result<Arc<ScanSnapshot>> {
    let timestamp = timestamp.as_str();
    let base_grid = levels
        .first()
        .map(|level| level.grid.clone())
        .ok_or_else(|| anyhow!("No parsed MRMS levels"))?;

    for level in levels.iter().skip(1) {
        if !is_same_grid(&level.grid, &base_grid) {
            bail!("MRMS grid mismatch for level {}", level.level_tag);
        }
    }

    let zdr_available_levels = levels.iter().filter(|level| level.zdr.available).count();
    let rhohv_available_levels = levels.iter().filter(|level| level.rhohv.available).count();
    let dual_pol_stale = dual_pol
        .zdr_age_seconds
        .is_some_and(|age| age > DUAL_POL_STALE_THRESHOLD_SECONDS)
        || dual_pol
            .rhohv_age_seconds
            .is_some_and(|age| age > DUAL_POL_STALE_THRESHOLD_SECONDS);
    let dual_pol_incomplete =
        zdr_available_levels < LEVEL_TAGS.len() || rhohv_available_levels < LEVEL_TAGS.len();
    let use_aux_fallback = dual_pol_stale || dual_pol_incomplete;

    let level_km: Vec<f64> = LEVEL_TAGS
        .iter()
        .map(|tag| tag.parse::<f64>().unwrap_or(0.0))
        .collect();
    let level_bounds = compute_level_bounds(&level_km);

    let point_count = base_grid.nx as usize * base_grid.ny as usize;
    let top18_values = validate_echo_top_values(
        echo_top_bundle
            .top18
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_18_PRODUCT,
        timestamp,
    );
    let top30_values = validate_echo_top_values(
        echo_top_bundle
            .top30
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_30_PRODUCT,
        timestamp,
    );
    let top50_values = validate_echo_top_values(
        echo_top_bundle
            .top50
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_50_PRODUCT,
        timestamp,
    );
    let top60_values = validate_echo_top_values(
        echo_top_bundle
            .top60
            .as_ref()
            .map(|(_timestamp, field)| field),
        &base_grid,
        point_count,
        MRMS_ECHO_TOP_60_PRODUCT,
        timestamp,
    );
    let mut echo_tops: Vec<StoredEchoTop> = Vec::new();
    let mut max_top18_feet: Option<u16> = None;
    let mut max_top30_feet: Option<u16> = None;
    let mut max_top50_feet: Option<u16> = None;
    let mut max_top60_feet: Option<u16> = None;
    if top18_values.is_some()
        || top30_values.is_some()
        || top50_values.is_some()
        || top60_values.is_some()
    {
        echo_tops.reserve(point_count / 32);
        let nx = base_grid.nx as usize;
        // Value counts are validated against point_count above, so every
        // value_idx below is in range.
        let sample = |values: Option<&AuxValues>, idx: usize| {
            values.map_or(f32::NAN, |values| values.get(idx).unwrap_or(f32::NAN))
        };
        for value_idx in 0..point_count {
            let raw18 = sample(top18_values, value_idx);
            let raw30 = sample(top30_values, value_idx);
            let raw50 = sample(top50_values, value_idx);
            let raw60 = sample(top60_values, value_idx);

            // Fast path: skip grid points with no positive finite echo-top
            // value (the overwhelming majority of the CONUS grid) before
            // doing any km→feet conversion or per-product tallying.
            let has_signal = (raw18.is_finite() && raw18 > 0.0)
                || (raw30.is_finite() && raw30 > 0.0)
                || (raw50.is_finite() && raw50 > 0.0)
                || (raw60.is_finite() && raw60 > 0.0);
            if !has_signal {
                continue;
            }

            let top18_feet = echo_top_km_to_feet(raw18).unwrap_or(0);
            let top30_feet = echo_top_km_to_feet(raw30).unwrap_or(0);
            let top50_feet = echo_top_km_to_feet(raw50).unwrap_or(0);
            let top60_feet = echo_top_km_to_feet(raw60).unwrap_or(0);

            if top18_feet == 0 && top30_feet == 0 && top50_feet == 0 && top60_feet == 0 {
                continue;
            }

            if top18_feet > 0 {
                max_top18_feet =
                    Some(max_top18_feet.map_or(top18_feet, |value| value.max(top18_feet)));
            }
            if top30_feet > 0 {
                max_top30_feet =
                    Some(max_top30_feet.map_or(top30_feet, |value| value.max(top30_feet)));
            }
            if top50_feet > 0 {
                max_top50_feet =
                    Some(max_top50_feet.map_or(top50_feet, |value| value.max(top50_feet)));
            }
            if top60_feet > 0 {
                max_top60_feet =
                    Some(max_top60_feet.map_or(top60_feet, |value| value.max(top60_feet)));
            }

            echo_tops.push(StoredEchoTop {
                row: (value_idx / nx) as u16,
                col: (value_idx % nx) as u16,
                top18_feet,
                top30_feet,
                top50_feet,
                top60_feet,
            });
        }
    }

    let tile_cols = ((base_grid.nx + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_rows = ((base_grid.ny + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_count = tile_cols as usize * tile_rows as usize;
    let tile_index = |row: u16, col: u16| -> usize {
        (row as usize / tile_size as usize) * tile_cols as usize + col as usize / tile_size as usize
    };

    // Every voxel's tile is known from the filtered positions alone, so tile
    // offsets come from a counting pass and voxels are scattered straight into
    // their final tile-grouped slots — no intermediate copy of all voxels.
    let levels: Vec<LevelInputs> = levels
        .into_iter()
        .filter(|level| level_bounds.get(level.level_idx as usize).is_some())
        .collect();
    let mut tile_counts = vec![0_u32; tile_count];
    for level in &levels {
        for (&row, &col) in level.filtered.rows.iter().zip(&level.filtered.cols) {
            tile_counts[tile_index(row, col)] += 1;
        }
    }
    let mut tile_offsets = Vec::with_capacity(tile_count + 1);
    tile_offsets.push(0_u32);
    let mut running_offset = 0_u32;
    for &count in &tile_counts {
        running_offset += count;
        tile_offsets.push(running_offset);
    }
    let mut tile_cursors: Vec<u32> = tile_offsets[..tile_count].to_vec();
    let mut voxels = vec![StoredVoxel::default(); running_offset as usize];

    let precip_field = thermo_aux_bundle
        .precip_flag
        .as_ref()
        .map(|(_timestamp, field)| field);
    let freezing_field = thermo_aux_bundle
        .freezing_level
        .as_ref()
        .map(|(_timestamp, field)| field);
    let wet_bulb_field = thermo_aux_bundle
        .wet_bulb_temp
        .as_ref()
        .map(|(_timestamp, field)| field);
    let surface_temp_field = thermo_aux_bundle
        .surface_temp
        .as_ref()
        .map(|(_timestamp, field)| field);
    let bright_band_top_field = thermo_aux_bundle
        .bright_band_top
        .as_ref()
        .map(|(_timestamp, field)| field);
    let bright_band_bottom_field = thermo_aux_bundle
        .bright_band_bottom
        .as_ref()
        .map(|(_timestamp, field)| field);
    let rqi_field = thermo_aux_bundle
        .radar_quality_index
        .as_ref()
        .map(|(_timestamp, field)| field);
    let aux_context_available = precip_field.is_some()
        || freezing_field.is_some()
        || wet_bulb_field.is_some()
        || surface_temp_field.is_some()
        || (bright_band_top_field.is_some() && bright_band_bottom_field.is_some())
        || rqi_field.is_some();
    let base_point_count = base_grid.nx as usize * base_grid.ny as usize;
    let precip_values = validate_base_aux_values(
        precip_field,
        &base_grid,
        base_point_count,
        "PrecipFlag_00.00",
        timestamp,
    );
    let freezing_values = validate_base_aux_values(
        freezing_field,
        &base_grid,
        base_point_count,
        "ModelFreezingLevel",
        timestamp,
    );
    let wet_bulb_values = validate_base_aux_values(
        wet_bulb_field,
        &base_grid,
        base_point_count,
        "ModelWetBulbTemp",
        timestamp,
    );
    let surface_temp_values = validate_base_aux_values(
        surface_temp_field,
        &base_grid,
        base_point_count,
        "ModelSurfaceTemp",
        timestamp,
    );
    let bright_band_top_values = validate_base_aux_values(
        bright_band_top_field,
        &base_grid,
        base_point_count,
        "BrightBandTop",
        timestamp,
    );
    let bright_band_bottom_values = validate_base_aux_values(
        bright_band_bottom_field,
        &base_grid,
        base_point_count,
        "BrightBandBottom",
        timestamp,
    );
    let rqi_values = validate_base_aux_values(
        rqi_field,
        &base_grid,
        base_point_count,
        "RadarQualityIndex",
        timestamp,
    );
    let samplers = BaseAuxSamplers {
        precip: AuxFieldSampler::new(precip_field, precip_values, &base_grid),
        freezing: AuxFieldSampler::new(freezing_field, freezing_values, &base_grid),
        wet_bulb: AuxFieldSampler::new(wet_bulb_field, wet_bulb_values, &base_grid),
        surface_temp: AuxFieldSampler::new(surface_temp_field, surface_temp_values, &base_grid),
        bright_band_top: AuxFieldSampler::new(
            bright_band_top_field,
            bright_band_top_values,
            &base_grid,
        ),
        bright_band_bottom: AuxFieldSampler::new(
            bright_band_bottom_field,
            bright_band_bottom_values,
            &base_grid,
        ),
        rqi: AuxFieldSampler::new(rqi_field, rqi_values, &base_grid),
    };

    // Reusable working buffers for the per-level processing loop.
    let mut gathered = GatheredAuxFields::new();
    let mut missing_dual_pol: Vec<f32> = Vec::new();

    let mut dual_missing_voxel_count: u64 = 0;
    let mut thermo_signal_voxel_count: u64 = 0;
    let mut thermo_no_signal_voxel_count: u64 = 0;
    let mut dual_adjusted_voxel_count: u64 = 0;
    let mut dual_suppressed_voxel_count: u64 = 0;
    let mut stale_dual_adjusted_voxel_count: u64 = 0;
    let mut mixed_suppressed_voxel_count: u64 = 0;
    let mut mixed_edge_promoted_voxel_count: u64 = 0;
    let mut precip_snow_forced_voxel_count: u64 = 0;

    for level in levels {
        let level_index = level.level_idx as usize;
        let Some(bounds) = level_bounds.get(level_index) else {
            continue;
        };
        let voxel_mid_feet = (bounds.bottom_feet as f64 + bounds.top_feet as f64) / 2.0;
        let filtered = &level.filtered;
        let voxel_count = filtered.indices.len();
        let mut level_voxels: Vec<LevelPhaseVoxel> = Vec::with_capacity(voxel_count);

        // Pass 2: Gather base-level aux fields into flat f32 arrays (reuses
        // pre-allocated buffers). Dual-pol values were gathered with the level.
        gather_base_aux_fields(filtered, &samplers, &mut gathered);
        if missing_dual_pol.len() < voxel_count
            && (level.zdr.values.is_none() || level.rhohv.values.is_none())
        {
            missing_dual_pol.resize(voxel_count, f32::NAN);
        }
        let zdr_values: &[f32] = match level.zdr.values.as_deref() {
            Some(values) => values,
            None => &missing_dual_pol[..voxel_count],
        };
        let rhohv_values: &[f32] = match level.rhohv.values.as_deref() {
            Some(values) => values,
            None => &missing_dual_pol[..voxel_count],
        };

        // Pass 3: Batch phase scoring
        let voxel_mid_feet_f32 = voxel_mid_feet as f32;
        let batch_result = compute_phase_scores_branchless(
            voxel_mid_feet_f32,
            &gathered.precip_flag,
            &gathered.freezing_level,
            &gathered.wet_bulb,
            &gathered.surface_temp,
            &gathered.bright_band_top,
            &gathered.bright_band_bottom,
            &gathered.rqi,
            zdr_values,
            rhohv_values,
            use_aux_fallback,
        );

        // Pass 4: Tally + Pack (row/col precomputed in Pass 1)
        for out_i in 0..voxel_count {
            let row = filtered.rows[out_i];
            let col = filtered.cols[out_i];

            let f = batch_result.flags[out_i];
            let used_dual = f & FLAG_USED_DUAL != 0;
            let suppressed_dual = f & FLAG_SUPPRESSED_DUAL != 0;

            if used_dual {
                dual_adjusted_voxel_count += 1;
                if use_aux_fallback {
                    stale_dual_adjusted_voxel_count += 1;
                }
            }
            if suppressed_dual {
                dual_suppressed_voxel_count += 1;
            }
            // Dual evidence was missing when neither used nor suppressed
            // (batch scorer only sets these when resolve_dual_pol_evidence returns Some)
            if !used_dual && !suppressed_dual {
                dual_missing_voxel_count += 1;
            }
            if f & FLAG_SUPPRESSED_MIXED != 0 {
                mixed_suppressed_voxel_count += 1;
            }
            if f & FLAG_FORCED_PRECIP_SNOW != 0 {
                precip_snow_forced_voxel_count += 1;
            }
            if batch_result.signal_count[out_i] > 0 {
                thermo_signal_voxel_count += 1;
            } else {
                thermo_no_signal_voxel_count += 1;
            }

            level_voxels.push(LevelPhaseVoxel {
                row,
                col,
                dbz_tenths: level.dbz_tenths[out_i],
                phase: batch_result.phase[out_i],
                surface_phase: batch_result.surface_phase[out_i],
                transition_candidate: f & FLAG_TRANSITION_CANDIDATE != 0,
            });
        }

        mixed_edge_promoted_voxel_count +=
            promote_mixed_transition_edges(&mut level_voxels, level.grid.nx, level.grid.ny);

        // Scatter into tile-grouped order. Levels are visited in order and each
        // level's voxels in row order, so voxels stay level-major within a tile.
        for voxel in level_voxels {
            let cursor = &mut tile_cursors[tile_index(voxel.row, voxel.col)];
            voxels[*cursor as usize] = StoredVoxel {
                row: voxel.row,
                col: voxel.col,
                level_idx: level.level_idx,
                phase: voxel.phase,
                surface_phase: voxel.surface_phase,
                dbz_tenths: voxel.dbz_tenths,
            };
            *cursor += 1;
        }
    }

    let scan_time_ms = parse_timestamp_utc(timestamp)
        .map(|datetime| datetime.timestamp_millis())
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    let mode = if use_aux_fallback {
        if dual_adjusted_voxel_count > 0 {
            "thermo-primary+stale-dual-correction"
        } else {
            "thermo-primary+aux-fallback"
        }
    } else if dual_adjusted_voxel_count > 0 {
        "thermo-primary+dual-correction"
    } else {
        "thermo-primary"
    };
    let detail = format!(
        "aux_fallback={},aux_any={},zdr_levels={}/{},rhohv_levels={}/{},zdr_age_s={},rhohv_age_s={},aux_precip={},aux_freezing={},aux_wetbulb={},aux_surface_temp={},aux_brightband_pair={},aux_rqi={},thermo_signal_voxels={},thermo_no_signal_voxels={},dual_missing_voxels={},dual_adjusted_voxels={},dual_suppressed_voxels={},stale_dual_adjusted_voxels={},mixed_suppressed_voxels={},mixed_edge_promoted_voxels={},precip_snow_forced_voxels={}",
        bool_label(use_aux_fallback),
        bool_label(aux_context_available),
        zdr_available_levels,
        LEVEL_TAGS.len(),
        rhohv_available_levels,
        LEVEL_TAGS.len(),
        format_optional_i64(dual_pol.zdr_age_seconds),
        format_optional_i64(dual_pol.rhohv_age_seconds),
        bool_label(precip_field.is_some()),
        bool_label(freezing_field.is_some()),
        bool_label(wet_bulb_field.is_some()),
        bool_label(surface_temp_field.is_some()),
        bool_label(bright_band_top_field.is_some() && bright_band_bottom_field.is_some()),
        bool_label(rqi_field.is_some()),
        thermo_signal_voxel_count,
        thermo_no_signal_voxel_count,
        dual_missing_voxel_count,
        dual_adjusted_voxel_count,
        dual_suppressed_voxel_count,
        stale_dual_adjusted_voxel_count,
        mixed_suppressed_voxel_count,
        mixed_edge_promoted_voxel_count,
        precip_snow_forced_voxel_count,
    );

    Ok(Arc::new(ScanSnapshot {
        timestamp: timestamp.to_string(),
        generated_at_ms: Utc::now().timestamp_millis(),
        scan_time_ms,
        grid: base_grid,
        tile_size,
        tile_cols,
        tile_rows,
        level_bounds,
        tile_offsets,
        voxels,
        echo_tops,
        echo_top_debug: EchoTopDebugMetadata {
            top18_timestamp: echo_top_bundle
                .top18
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            top30_timestamp: echo_top_bundle
                .top30
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            top50_timestamp: echo_top_bundle
                .top50
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            top60_timestamp: echo_top_bundle
                .top60
                .as_ref()
                .map(|(timestamp, _field)| timestamp.clone()),
            max_top18_feet,
            max_top30_feet,
            max_top50_feet,
            max_top60_feet,
        },
        phase_debug: PhaseDebugMetadata {
            mode: mode.to_string(),
            detail,
            zdr_timestamp: dual_pol.zdr_timestamp,
            rhohv_timestamp: dual_pol.rhohv_timestamp,
            precip_flag_timestamp: thermo_aux_bundle
                .precip_flag
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            freezing_level_timestamp: thermo_aux_bundle
                .freezing_level
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            zdr_age_seconds: dual_pol.zdr_age_seconds,
            rhohv_age_seconds: dual_pol.rhohv_age_seconds,
        },
    }))
}

#[derive(Default)]
struct ThermoAuxBundle {
    precip_flag: Option<(String, ParsedAuxField)>,
    freezing_level: Option<(String, ParsedAuxField)>,
    wet_bulb_temp: Option<(String, ParsedAuxField)>,
    surface_temp: Option<(String, ParsedAuxField)>,
    bright_band_top: Option<(String, ParsedAuxField)>,
    bright_band_bottom: Option<(String, ParsedAuxField)>,
    radar_quality_index: Option<(String, ParsedAuxField)>,
}

#[derive(Default)]
struct EchoTopBundle {
    top18: Option<(String, ParsedAuxField)>,
    top30: Option<(String, ParsedAuxField)>,
    top50: Option<(String, ParsedAuxField)>,
    top60: Option<(String, ParsedAuxField)>,
}

#[derive(Clone, Debug)]
pub(crate) struct AuxFieldSampler<'a> {
    direct_values: Option<&'a AuxValues>,
    sampled_lookup: Option<AuxFieldLookup<'a>>,
}

impl<'a> AuxFieldSampler<'a> {
    fn new(
        field: Option<&'a ParsedAuxField>,
        direct_values: Option<&'a AuxValues>,
        base_grid: &GridDef,
    ) -> Self {
        Self {
            direct_values,
            sampled_lookup: if direct_values.is_none() {
                field.and_then(|field| AuxFieldLookup::build(field, base_grid))
            } else {
                None
            },
        }
    }

    /// Samples every filtered voxel into `out` (`NaN` where the field has no
    /// value for it).
    fn gather(&self, filter: &FilterResult, out: &mut Vec<f32>) {
        if let Some(values) = self.direct_values {
            values.gather_into(&filter.indices, out);
        } else if let Some(lookup) = &self.sampled_lookup {
            out.clear();
            out.extend(filter.rows.iter().zip(&filter.cols).map(|(&row, &col)| {
                lookup
                    .sample(row as usize, col as usize)
                    .unwrap_or(f32::NAN)
            }));
        } else {
            out.clear();
            out.resize(filter.indices.len(), f32::NAN);
        }
    }
}

#[derive(Clone, Debug)]
struct AuxFieldLookup<'a> {
    values: &'a AuxValues,
    nx: u32,
    row_map: Vec<Option<u32>>,
    col_map: Vec<Option<u32>>,
}

impl<'a> AuxFieldLookup<'a> {
    fn build(field: &'a ParsedAuxField, base_grid: &GridDef) -> Option<Self> {
        if field.grid.lat_step_deg.abs() < f64::EPSILON
            || field.grid.lon_step_deg.abs() < f64::EPSILON
        {
            return None;
        }

        let row_map = (0..base_grid.ny)
            .map(|base_row| {
                let lat_deg = base_grid.la1_deg + base_row as f64 * base_grid.lat_step_deg;
                let row = ((lat_deg - field.grid.la1_deg) / field.grid.lat_step_deg).round() as i64;
                if row < 0 || row >= field.grid.ny as i64 {
                    None
                } else {
                    Some(row as u32)
                }
            })
            .collect();

        let col_map = (0..base_grid.nx)
            .map(|base_col| {
                let lon_deg360 =
                    to_lon360(base_grid.lo1_deg360 + base_col as f64 * base_grid.lon_step_deg);
                let col =
                    ((lon_deg360 - field.grid.lo1_deg360) / field.grid.lon_step_deg).round() as i64;
                if col < 0 || col >= field.grid.nx as i64 {
                    None
                } else {
                    Some(col as u32)
                }
            })
            .collect();

        Some(Self {
            values: &field.values,
            nx: field.grid.nx,
            row_map,
            col_map,
        })
    }

    #[inline]
    fn sample(&self, row: usize, col: usize) -> Option<f32> {
        let sample_row = self.row_map.get(row).and_then(|value| *value)?;
        let sample_col = self.col_map.get(col).and_then(|value| *value)?;
        let index = sample_row as usize * self.nx as usize + sample_col as usize;
        self.values.get(index)
    }
}

/// Picks the dual-pol scan for `target_timestamp`: the exact timestamp when its
/// base level is published, otherwise the latest earlier one. The base level
/// fetched while probing is kept for level 0.
async fn select_dual_pol_source(
    state: &AppState,
    product_prefix: &'static str,
    target_timestamp: &str,
) -> DualPolSource {
    let unavailable = || DualPolSource {
        product_prefix,
        selected_timestamp: None,
        age_seconds: None,
        base_level_zipped: StdMutex::new(None),
    };
    let level_zipped = |timestamp: String| async move {
        let date_part = timestamp.split('-').next().unwrap_or_default().to_string();
        let key = build_level_key(product_prefix, MRMS_BASE_LEVEL_TAG, &date_part, &timestamp);
        fetch_mrms_key_bytes(state, &key).await
    };

    let mut selected_timestamp = Some(target_timestamp.to_string());
    let mut base_level_zipped = match level_zipped(target_timestamp.to_string()).await {
        Ok(zipped) => Some(zipped),
        Err(error) => {
            warn!(
                "{product_prefix} exact aux unavailable at {target_timestamp}: {error:#}; searching latest available timestamp"
            );
            None
        }
    };

    if base_level_zipped.is_none() {
        selected_timestamp = find_latest_level_timestamp_at_or_before(
            state,
            product_prefix,
            MRMS_BASE_LEVEL_TAG,
            target_timestamp,
        )
        .await;
        if let Some(selected) = selected_timestamp.as_ref() {
            base_level_zipped = level_zipped(selected.clone())
                .await
                .map_err(|error| {
                    warn!(
                        "{product_prefix} fallback aux fetch failed at {selected}: {error:#}; skipping aux bundle"
                    );
                    error
                })
                .ok();
        }
    }

    let Some(selected_timestamp) = selected_timestamp else {
        return unavailable();
    };
    let age_seconds = timestamp_age_seconds(target_timestamp, &selected_timestamp);
    DualPolSource {
        product_prefix,
        selected_timestamp: Some(selected_timestamp),
        age_seconds,
        base_level_zipped: StdMutex::new(base_level_zipped),
    }
}

/// Compressed dual-pol payload for `level_idx` of the selected scan, or `None`
/// when it is unavailable. A level that is not there yet is awaited briefly,
/// only while the dual-pol scan is still inside its publication window.
async fn fetch_dual_pol_level_zipped(
    state: &AppState,
    source: &DualPolSource,
    level_idx: usize,
) -> Option<Vec<u8>> {
    let selected = source.selected_timestamp.as_deref()?;
    if level_idx == 0 {
        return source.take_base_level_zipped();
    }
    let level_tag = LEVEL_TAGS[level_idx];
    let date_part = selected.split('-').next()?;
    let key = build_level_key(source.product_prefix, level_tag, date_part, selected);
    match fetch_mrms_key_bytes_when_published(
        state,
        &key,
        selected,
        Some(Duration::from_secs(DUAL_POL_PUBLICATION_GRACE_SECONDS)),
    )
    .await
    {
        Ok(zipped) => Some(zipped),
        Err(error) => {
            warn!(
                "{} aux unavailable for level {level_tag} at {selected}: {error:#}",
                source.product_prefix
            );
            None
        }
    }
}

async fn fetch_thermo_aux_bundle(state: &AppState, target_timestamp: &str) -> ThermoAuxBundle {
    let (
        precip_flag,
        freezing_level,
        wet_bulb_temp,
        surface_temp,
        bright_band_top,
        bright_band_bottom,
        radar_quality_index,
    ) = tokio::join!(
        fetch_latest_aux_field_at_or_before(state, MRMS_PRECIP_FLAG_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_MODEL_FREEZING_HEIGHT_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_MODEL_WET_BULB_TEMP_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_MODEL_SURFACE_TEMP_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(state, MRMS_BRIGHT_BAND_TOP_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(
            state,
            MRMS_BRIGHT_BAND_BOTTOM_PRODUCT,
            target_timestamp
        ),
        fetch_latest_aux_field_at_or_before(state, MRMS_RQI_PRODUCT, target_timestamp),
    );

    ThermoAuxBundle {
        precip_flag,
        freezing_level,
        wet_bulb_temp,
        surface_temp,
        bright_band_top,
        bright_band_bottom,
        radar_quality_index,
    }
}

async fn fetch_echo_top_bundle(state: &AppState, target_timestamp: &str) -> EchoTopBundle {
    let (top18, top30, top50, top60) = tokio::join!(
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_18_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_30_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_50_PRODUCT, target_timestamp),
        fetch_latest_aux_field_at_or_before(state, MRMS_ECHO_TOP_60_PRODUCT, target_timestamp),
    );

    EchoTopBundle {
        top18,
        top30,
        top50,
        top60,
    }
}

async fn fetch_latest_aux_field_at_or_before(
    state: &AppState,
    product: &'static str,
    target_timestamp: &str,
) -> Option<(String, ParsedAuxField)> {
    let timestamp =
        find_latest_aux_timestamp_at_or_before(state, product, target_timestamp).await?;
    let date_part = timestamp.split('-').next()?;
    match fetch_aux_field_at_timestamp(state, product, date_part, &timestamp).await {
        Ok(field) => Some((timestamp, field)),
        Err(error) => {
            warn!(
                "Aux context fetch failed for {product} at {timestamp}: {error:#}; continuing without aux field"
            );
            None
        }
    }
}

fn validate_base_aux_values<'a>(
    field: Option<&'a ParsedAuxField>,
    base_grid: &GridDef,
    point_count: usize,
    product_label: &str,
    timestamp: &str,
) -> Option<&'a AuxValues> {
    let field = field?;
    if !is_same_grid(&field.grid, base_grid) {
        warn!(
            "{product_label} aux grid mismatch at {timestamp}; using coordinate-sampled aux fallback"
        );
        return None;
    }
    if field.values.len() != point_count {
        warn!(
            "{product_label} aux point-count mismatch at {timestamp}: expected {point_count}, got {}; using coordinate-sampled aux fallback",
            field.values.len()
        );
        return None;
    }
    Some(&field.values)
}

fn validate_echo_top_values<'a>(
    field: Option<&'a ParsedAuxField>,
    base_grid: &GridDef,
    point_count: usize,
    product_label: &str,
    timestamp: &str,
) -> Option<&'a AuxValues> {
    let field = field?;
    if !is_same_grid(&field.grid, base_grid) {
        warn!(
            "Echo-top aux grid mismatch for {product_label} at {timestamp}; skipping echo-top product"
        );
        return None;
    }
    if field.values.len() != point_count {
        warn!(
            "Echo-top aux point-count mismatch for {product_label} at {timestamp}: expected {point_count}, got {}; skipping echo-top product",
            field.values.len()
        );
        return None;
    }
    Some(&field.values)
}

fn is_same_grid(left: &GridDef, right: &GridDef) -> bool {
    left.nx == right.nx
        && left.ny == right.ny
        && (left.la1_deg - right.la1_deg).abs() <= 1e-6
        && (left.lo1_deg360 - right.lo1_deg360).abs() <= 1e-6
        && (left.di_deg - right.di_deg).abs() <= 1e-6
        && (left.dj_deg - right.dj_deg).abs() <= 1e-6
}

fn compute_level_bounds(level_km: &[f64]) -> Vec<LevelBounds> {
    let mut bounds = Vec::with_capacity(level_km.len());

    for idx in 0..level_km.len() {
        let level = level_km[idx];
        let previous = if idx > 0 {
            Some(level_km[idx - 1])
        } else {
            None
        };
        let next = level_km.get(idx + 1).copied();

        let bottom_km = if let Some(prev) = previous {
            (prev + level) / 2.0
        } else {
            let next_level = next.unwrap_or(level + 0.5);
            (level - (next_level - level) / 2.0).max(0.0)
        };

        let top_km = if let Some(next_level) = next {
            (level + next_level) / 2.0
        } else {
            let prev_level = previous.unwrap_or(level - 0.5);
            level + (level - prev_level) / 2.0
        };

        bounds.push(LevelBounds {
            bottom_feet: round_u16(bottom_km * FEET_PER_KM),
            top_feet: round_u16(top_km * FEET_PER_KM),
        });
    }

    bounds
}

fn echo_top_km_to_feet(value: f32) -> Option<u16> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(round_u16(f64::from(value) * FEET_PER_KM))
}

fn format_optional_i64(value: Option<i64>) -> String {
    value
        .map(|v| v.to_string())
        .unwrap_or_else(|| "n/a".to_string())
}

fn bool_label(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use wide::{i16x8, CmpEq, CmpGt};

    // --- API discovery ---

    #[test]
    fn wide_i16x8_api_discovery() {
        let a = i16x8::new([10, 20, 30, 40, 50, 60, 70, 80]);
        let b = i16x8::splat(50);
        // i16x8 has CmpGt + CmpEq but NOT CmpGe; combine with bitor.
        let cmp = a.simd_gt(b) | a.simd_eq(b);
        let arr = cmp.to_array();
        // True lanes are all-bits-set (-1 for i16), false lanes are 0.
        assert_eq!(arr[0], 0); // 10 < 50
        assert_eq!(arr[1], 0); // 20 < 50
        assert_eq!(arr[2], 0); // 30 < 50
        assert_eq!(arr[3], 0); // 40 < 50
        assert_eq!(arr[4], -1); // 50 >= 50
        assert_eq!(arr[5], -1); // 60 >= 50
        assert_eq!(arr[6], -1); // 70 >= 50
        assert_eq!(arr[7], -1); // 80 >= 50

        // to_bitmask extracts one bit per lane (sign bit)
        let mask = cmp.to_bitmask();
        assert_eq!(mask, 0b11110000);
    }

    // --- Original tests ---

    fn run_filter(dbz: &[i16], threshold: i16, nx: u32) -> FilterResult {
        let mut result = FilterResult::new();
        filter_voxels_by_threshold(dbz, threshold, nx, &mut result);
        result
    }

    #[test]
    fn filter_voxels_by_threshold_selects_above_threshold() {
        let dbz = vec![10_i16, 60, -50, 50, 100, 49, 51];
        let result = run_filter(&dbz, 50, 7);
        assert_eq!(result.indices, vec![1_u32, 3, 4, 6]);
    }

    #[test]
    fn filter_voxels_by_threshold_empty_input() {
        let result = run_filter(&[], 50, 1);
        assert!(result.indices.is_empty());
    }

    #[test]
    fn filter_voxels_by_threshold_all_below() {
        let dbz = vec![10_i16, 20, 30, 40, 49];
        let result = run_filter(&dbz, 50, 5);
        assert!(result.indices.is_empty());
    }

    #[test]
    fn filter_voxels_by_threshold_all_above() {
        let dbz = vec![50_i16, 60, 70, 80];
        let result = run_filter(&dbz, 50, 4);
        assert_eq!(result.indices, vec![0_u32, 1, 2, 3]);
    }

    #[test]
    fn filter_precomputes_row_col() {
        // 3x3 grid: nx=3. Index 5 → row=1, col=2. Index 7 → row=2, col=1.
        let dbz = vec![0_i16, 0, 0, 0, 0, 100, 0, 100, 0];
        let result = run_filter(&dbz, 50, 3);
        assert_eq!(result.indices, vec![5, 7]);
        assert_eq!(result.rows, vec![1, 2]);
        assert_eq!(result.cols, vec![2, 1]);
    }

    #[test]
    fn filter_reuses_buffer_across_calls() {
        let mut result = FilterResult::new();
        filter_voxels_by_threshold(&[100_i16; 8], 50, 8, &mut result);
        assert_eq!(result.len(), 8);
        result.clear();
        filter_voxels_by_threshold(&[100_i16; 4], 50, 4, &mut result);
        assert_eq!(result.len(), 4);
        // Capacity should be >= 8 (from first call, not reallocated)
        assert!(result.indices.capacity() >= 8);
    }

    // --- SIMD equivalence tests ---

    fn filter_scalar_reference(data: &[i16], threshold: i16) -> Vec<u32> {
        data.iter()
            .enumerate()
            .filter(|&(_, v)| *v >= threshold)
            .map(|(i, _)| i as u32)
            .collect()
    }

    #[test]
    fn simd_filter_matches_scalar() {
        let mut result = FilterResult::new();
        for n in [0, 1, 7, 8, 9, 15, 16, 100, 1000, 12_250_000] {
            let data: Vec<i16> = (0..n).map(|i| ((i * 7 + 3) % 200 - 50) as i16).collect();
            let threshold = 50i16;
            let expected = filter_scalar_reference(&data, threshold);
            result.clear();
            filter_voxels_by_threshold(&data, threshold, n.max(1) as u32, &mut result);
            assert_eq!(result.indices, expected, "mismatch at n={n}");
        }
    }

    #[test]
    fn simd_filter_empty() {
        assert!(run_filter(&[], 50, 1).indices.is_empty());
    }

    #[test]
    fn simd_filter_all_pass() {
        let data = vec![100i16; 17];
        assert_eq!(run_filter(&data, 50, 17).len(), 17);
    }

    #[test]
    fn simd_filter_none_pass() {
        let data = vec![10i16; 17];
        assert!(run_filter(&data, 50, 17).indices.is_empty());
    }
}

#[cfg(test)]
mod gather_tests {
    use super::*;

    /// Build a FilterResult from flat indices for a grid `nx` columns wide.
    fn make_filter(indices: &[u32], nx: u32) -> FilterResult {
        let rows: Vec<u16> = indices.iter().map(|&i| (i as usize / nx as usize) as u16).collect();
        let cols: Vec<u16> = indices.iter().map(|&i| (i as usize % nx as usize) as u16).collect();
        FilterResult {
            indices: indices.to_vec(),
            rows,
            cols,
        }
    }

    fn empty_sampler<'a>() -> AuxFieldSampler<'a> {
        AuxFieldSampler {
            direct_values: None,
            sampled_lookup: None,
        }
    }

    fn gather(sampler: &AuxFieldSampler, filter: &FilterResult) -> Vec<f32> {
        let mut out = Vec::new();
        sampler.gather(filter, &mut out);
        out
    }

    #[test]
    fn gather_without_a_field_is_all_nan() {
        let filter = make_filter(&[0, 2, 5], 6);
        let out = gather(&empty_sampler(), &filter);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|v| v.is_nan()));
    }

    #[test]
    fn gather_empty_indices_returns_empty_vec() {
        let filter = make_filter(&[], 6);
        assert!(gather(&empty_sampler(), &filter).is_empty());
    }

    #[test]
    fn gather_direct_values_sampler() {
        let precip_data = AuxValues::Dense(vec![10.0_f32, 20.0, 30.0, 40.0, 50.0, 60.0]);
        let sampler = AuxFieldSampler {
            direct_values: Some(&precip_data),
            sampled_lookup: None,
        };
        let filter = make_filter(&[1, 3, 5], 6);
        assert_eq!(gather(&sampler, &filter), vec![20.0, 40.0, 60.0]);
    }

    #[test]
    fn gather_marks_out_of_range_indices_missing() {
        let data = AuxValues::Dense(vec![1.0_f32, 2.0]);
        let sampler = AuxFieldSampler {
            direct_values: Some(&data),
            sampled_lookup: None,
        };
        let filter = make_filter(&[0, 1, 7], 8);
        let out = gather(&sampler, &filter);
        assert_eq!(&out[..2], &[1.0, 2.0]);
        assert!(out[2].is_nan());
    }

    #[test]
    fn gather_reuses_the_output_buffer() {
        let data = AuxValues::Dense(vec![1.0_f32, 2.0, 3.0, 4.0]);
        let sampler = AuxFieldSampler {
            direct_values: Some(&data),
            sampled_lookup: None,
        };
        let mut out = Vec::new();
        sampler.gather(&make_filter(&[0, 1, 2, 3], 4), &mut out);
        assert_eq!(out.len(), 4);
        sampler.gather(&make_filter(&[3], 4), &mut out);
        assert_eq!(out, vec![4.0]);
    }

    #[test]
    fn packed_values_gather_like_dense_values() {
        // 16-bit samples 0..8 mapped through (R + X * 2^E) * 10^-D, R=-3, E=0, D=1.
        let table: Vec<f32> = (0..=u16::MAX)
            .map(|sample| (-3.0_f32 + sample as f32 * 1.0) * 0.1)
            .collect();
        let samples: Vec<u8> = (0u16..8).flat_map(|s| s.to_be_bytes()).collect();
        let packed = AuxValues::Packed(crate::types::PackedSamples::with_table(samples, 2, table));
        let dense = AuxValues::Dense((0u16..8).map(|s| (-3.0_f32 + s as f32) * 0.1).collect());

        assert_eq!(packed.len(), 8);
        let indices = [7u32, 0, 3, 9, 3];
        let (from_packed, from_dense) = (packed.gather(&indices), dense.gather(&indices));
        for (a, b) in from_packed.iter().zip(&from_dense) {
            assert!(a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()));
        }
        assert!(from_packed[3].is_nan());
        assert_eq!(packed.get(8), None);
        assert_eq!(packed.get(2).unwrap().to_bits(), dense.get(2).unwrap().to_bits());
    }
}
