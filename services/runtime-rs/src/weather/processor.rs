use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use chrono::Utc;
use futures::stream::{FuturesUnordered, StreamExt};
use tracing::warn;

use wide::{i16x8, CmpEq, CmpGt};

use super::phase::{promote_mixed_transition_edges, LevelPhaseVoxel};
use super::phase_batch::compute_phase_scores_branchless;
use super::simd_lut::COMPRESS_LUT;
use super::sources::{
    build_level_key, fetch_aux_field_at_timestamp, fetch_level_aux_field_at_timestamp,
    fetch_mrms_key_bytes, find_latest_aux_timestamp_at_or_before,
    find_latest_level_timestamp_at_or_before, parse_reflectivity_grib_with_limit,
    timestamp_age_seconds,
};
use crate::constants::{
    DUAL_POL_STALE_THRESHOLD_SECONDS, FEET_PER_KM, LEVEL_TAGS, MRMS_BASE_LEVEL_TAG,
    MRMS_BRIGHT_BAND_BOTTOM_PRODUCT, MRMS_BRIGHT_BAND_TOP_PRODUCT, MRMS_ECHO_TOP_18_PRODUCT,
    MRMS_ECHO_TOP_30_PRODUCT, MRMS_ECHO_TOP_50_PRODUCT, MRMS_ECHO_TOP_60_PRODUCT,
    MRMS_MODEL_FREEZING_HEIGHT_PRODUCT, MRMS_MODEL_SURFACE_TEMP_PRODUCT,
    MRMS_MODEL_WET_BULB_TEMP_PRODUCT, MRMS_PRECIP_FLAG_PRODUCT, MRMS_PRODUCT_PREFIX,
    MRMS_RHOHV_PRODUCT_PREFIX, MRMS_RQI_PRODUCT, MRMS_ZDR_PRODUCT_PREFIX, STORE_MIN_DBZ_TENTHS,
};
use crate::types::{
    AppState, EchoTopDebugMetadata, GridDef, LevelBounds, ParsedAuxField, ParsedReflectivityField,
    PhaseDebugMetadata, ScanSnapshot, StoredEchoTop, StoredVoxel,
};
use crate::utils::{parse_timestamp_utc, round_u16, to_lon360};

/// Pass 1: Scan dbz_tenths and collect indices of voxels at or above threshold.
///
/// Uses explicit SIMD via `wide::i16x8`: compares 8 i16 lanes per iteration,
/// extracts a bitmask, and uses `COMPRESS_LUT` to gather matching indices
/// without per-element branches. Scalar tail loop handles `n % 8` remainder.
#[inline(never)] // Preserve as named function for LLVM remarks + asm inspection
pub fn filter_voxels_by_threshold(dbz_tenths: &[i16], threshold: i16) -> Vec<u32> {
    let n = dbz_tenths.len();
    let mut out = Vec::with_capacity(n / 3);

    let threshold_v = i16x8::splat(threshold);
    let chunks = n / 8;

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
            out.push(base_u32 + positions[i] as u32);
        }
    }

    // Scalar tail for remaining n % 8 elements
    let tail_start = chunks * 8;
    for i in tail_start..n {
        if dbz_tenths[i] >= threshold {
            out.push(i as u32);
        }
    }

    out
}

/// Flat f32 arrays of aux field values for valid voxel indices.
/// NaN indicates missing/unavailable values.
pub(crate) struct GatheredAuxFields {
    pub(crate) zdr: Vec<f32>,
    pub(crate) rhohv: Vec<f32>,
    pub(crate) precip_flag: Vec<f32>,
    pub(crate) freezing_level: Vec<f32>,
    pub(crate) wet_bulb: Vec<f32>,
    pub(crate) surface_temp: Vec<f32>,
    pub(crate) bright_band_top: Vec<f32>,
    pub(crate) bright_band_bottom: Vec<f32>,
    pub(crate) rqi: Vec<f32>,
}

/// Pass 2: Gather aux field values for valid voxel indices into flat f32 arrays.
///
/// Uses NaN as sentinel for missing values. This separates the Option-chain
/// indirection (AuxFieldSampler lookup) from the compute pass, so the compute
/// pass can operate on flat arrays without branches.
#[inline(never)] // Preserve as named function for LLVM remarks + asm inspection
pub(crate) fn gather_aux_fields(
    valid_indices: &[u32],
    nx: u32,
    zdr_values: Option<&[f32]>,
    rhohv_values: Option<&[f32]>,
    precip_sampler: &AuxFieldSampler,
    freezing_sampler: &AuxFieldSampler,
    wet_bulb_sampler: &AuxFieldSampler,
    surface_temp_sampler: &AuxFieldSampler,
    bright_band_top_sampler: &AuxFieldSampler,
    bright_band_bottom_sampler: &AuxFieldSampler,
    rqi_sampler: &AuxFieldSampler,
) -> GatheredAuxFields {
    let n = valid_indices.len();
    let mut out = GatheredAuxFields {
        zdr: vec![f32::NAN; n],
        rhohv: vec![f32::NAN; n],
        precip_flag: vec![f32::NAN; n],
        freezing_level: vec![f32::NAN; n],
        wet_bulb: vec![f32::NAN; n],
        surface_temp: vec![f32::NAN; n],
        bright_band_top: vec![f32::NAN; n],
        bright_band_bottom: vec![f32::NAN; n],
        rqi: vec![f32::NAN; n],
    };

    for (out_i, &idx) in valid_indices.iter().enumerate() {
        let value_idx = idx as usize;
        let row = value_idx / nx as usize;
        let col = value_idx % nx as usize;

        if let Some(vals) = zdr_values {
            if let Some(&v) = vals.get(value_idx) {
                out.zdr[out_i] = v;
            }
        }
        if let Some(vals) = rhohv_values {
            if let Some(&v) = vals.get(value_idx) {
                out.rhohv[out_i] = v;
            }
        }
        if let Some(v) = precip_sampler.sample(value_idx, row, col) {
            out.precip_flag[out_i] = v;
        }
        if let Some(v) = freezing_sampler.sample(value_idx, row, col) {
            out.freezing_level[out_i] = v;
        }
        if let Some(v) = wet_bulb_sampler.sample(value_idx, row, col) {
            out.wet_bulb[out_i] = v;
        }
        if let Some(v) = surface_temp_sampler.sample(value_idx, row, col) {
            out.surface_temp[out_i] = v;
        }
        if let Some(v) = bright_band_top_sampler.sample(value_idx, row, col) {
            out.bright_band_top[out_i] = v;
        }
        if let Some(v) = bright_band_bottom_sampler.sample(value_idx, row, col) {
            out.bright_band_bottom[out_i] = v;
        }
        if let Some(v) = rqi_sampler.sample(value_idx, row, col) {
            out.rqi[out_i] = v;
        }
    }

    out
}

pub(super) async fn ingest_timestamp(state: &AppState, timestamp: &str) -> Result<Arc<ScanSnapshot>> {
    let date_part = timestamp
        .split('-')
        .next()
        .ok_or_else(|| anyhow!("Invalid timestamp format: {timestamp}"))?;

    let (levels_result, mut zdr_bundle, mut rhohv_bundle, thermo_aux_bundle, echo_top_bundle) = tokio::join!(
        parse_reflectivity_levels(state, timestamp, date_part),
        fetch_dual_pol_bundle(state, MRMS_ZDR_PRODUCT_PREFIX, timestamp),
        fetch_dual_pol_bundle(state, MRMS_RHOHV_PRODUCT_PREFIX, timestamp),
        fetch_thermo_aux_bundle(state, timestamp),
        fetch_echo_top_bundle(state, timestamp),
    );
    let levels = levels_result?;

    let base_grid = levels
        .first()
        .map(|(_, _, parsed)| parsed.grid.clone())
        .ok_or_else(|| anyhow!("No parsed MRMS levels"))?;

    for (_, tag, parsed) in levels.iter().skip(1) {
        if !is_same_grid(&parsed.grid, &base_grid) {
            bail!("MRMS grid mismatch for level {tag}");
        }
    }

    if zdr_bundle.fields_by_level.len() != LEVEL_TAGS.len() {
        zdr_bundle
            .fields_by_level
            .resize_with(LEVEL_TAGS.len(), || None);
    }
    if rhohv_bundle.fields_by_level.len() != LEVEL_TAGS.len() {
        rhohv_bundle
            .fields_by_level
            .resize_with(LEVEL_TAGS.len(), || None);
    }

    let dual_pol_stale = zdr_bundle
        .age_seconds
        .is_some_and(|age| age > DUAL_POL_STALE_THRESHOLD_SECONDS)
        || rhohv_bundle
            .age_seconds
            .is_some_and(|age| age > DUAL_POL_STALE_THRESHOLD_SECONDS);
    let dual_pol_incomplete = zdr_bundle.available_level_count() < LEVEL_TAGS.len()
        || rhohv_bundle.available_level_count() < LEVEL_TAGS.len();
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
        for row in 0..base_grid.ny as usize {
            let row_offset = row * base_grid.nx as usize;
            for col in 0..base_grid.nx as usize {
                let value_idx = row_offset + col;
                let top18_feet = top18_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);
                let top30_feet = top30_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);
                let top50_feet = top50_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);
                let top60_feet = top60_values
                    .and_then(|values| values.get(value_idx).copied())
                    .and_then(echo_top_km_to_feet)
                    .unwrap_or(0);

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
                    row: row as u16,
                    col: col as u16,
                    top18_feet,
                    top30_feet,
                    top50_feet,
                    top60_feet,
                });
            }
        }
    }

    let tile_size = state.cfg.tile_size.max(16);
    let tile_cols = ((base_grid.nx + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_rows = ((base_grid.ny + tile_size as u32 - 1) / tile_size as u32) as u16;
    let tile_count = tile_cols as usize * tile_rows as usize;

    let mut buckets: Vec<Vec<StoredVoxel>> = (0..tile_count).map(|_| Vec::new()).collect();

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
    let precip_sampler = AuxFieldSampler::new(precip_field, precip_values, &base_grid);
    let freezing_sampler = AuxFieldSampler::new(freezing_field, freezing_values, &base_grid);
    let wet_bulb_sampler = AuxFieldSampler::new(wet_bulb_field, wet_bulb_values, &base_grid);
    let surface_temp_sampler =
        AuxFieldSampler::new(surface_temp_field, surface_temp_values, &base_grid);
    let bright_band_top_sampler =
        AuxFieldSampler::new(bright_band_top_field, bright_band_top_values, &base_grid);
    let bright_band_bottom_sampler = AuxFieldSampler::new(
        bright_band_bottom_field,
        bright_band_bottom_values,
        &base_grid,
    );
    let rqi_sampler = AuxFieldSampler::new(rqi_field, rqi_values, &base_grid);

    let mut dual_missing_voxel_count: u64 = 0;
    let mut thermo_signal_voxel_count: u64 = 0;
    let mut thermo_no_signal_voxel_count: u64 = 0;
    let mut dual_adjusted_voxel_count: u64 = 0;
    let mut dual_suppressed_voxel_count: u64 = 0;
    let mut stale_dual_adjusted_voxel_count: u64 = 0;
    let mut mixed_suppressed_voxel_count: u64 = 0;
    let mut mixed_edge_promoted_voxel_count: u64 = 0;
    let mut precip_snow_forced_voxel_count: u64 = 0;

    for (level_idx, level_tag, parsed) in &levels {
        let level_index = *level_idx as usize;
        let Some(bounds) = level_bounds.get(level_index) else {
            continue;
        };
        let voxel_mid_feet = (bounds.bottom_feet as f64 + bounds.top_feet as f64) / 2.0;
        let mut level_voxels: Vec<LevelPhaseVoxel> =
            Vec::with_capacity((parsed.grid.nx as usize * parsed.grid.ny as usize) / 4);

        let zdr_values = validate_level_aux_values(
            zdr_bundle.fields_by_level[level_index].as_ref(),
            parsed,
            "ZDR",
            level_tag,
            timestamp,
        );
        let rhohv_values = validate_level_aux_values(
            rhohv_bundle.fields_by_level[level_index].as_ref(),
            parsed,
            "RhoHV",
            level_tag,
            timestamp,
        );

        // Pass 1: Filter
        let valid_indices = filter_voxels_by_threshold(&parsed.dbz_tenths, STORE_MIN_DBZ_TENTHS);

        // Pass 2: Gather aux fields into flat f32 arrays
        let gathered = gather_aux_fields(
            &valid_indices,
            parsed.grid.nx,
            zdr_values,
            rhohv_values,
            &precip_sampler,
            &freezing_sampler,
            &wet_bulb_sampler,
            &surface_temp_sampler,
            &bright_band_top_sampler,
            &bright_band_bottom_sampler,
            &rqi_sampler,
        );

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
            &gathered.zdr,
            &gathered.rhohv,
            use_aux_fallback,
        );

        // Pass 4: Tally + Pack
        let nx = parsed.grid.nx as usize;
        for (out_i, &idx) in valid_indices.iter().enumerate() {
            let value_idx = idx as usize;
            let row = (value_idx / nx) as u16;
            let col = (value_idx % nx) as u16;

            if batch_result.used_dual[out_i] {
                dual_adjusted_voxel_count += 1;
                if use_aux_fallback {
                    stale_dual_adjusted_voxel_count += 1;
                }
            }
            if batch_result.suppressed_dual[out_i] {
                dual_suppressed_voxel_count += 1;
            }
            // Dual evidence was missing when neither used nor suppressed
            // (batch scorer only sets these when resolve_dual_pol_evidence returns Some)
            if !batch_result.used_dual[out_i] && !batch_result.suppressed_dual[out_i] {
                dual_missing_voxel_count += 1;
            }
            if batch_result.suppressed_mixed[out_i] {
                mixed_suppressed_voxel_count += 1;
            }
            if batch_result.forced_precip_snow[out_i] {
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
                dbz_tenths: parsed.dbz_tenths[value_idx],
                phase: batch_result.phase[out_i],
                surface_phase: batch_result.surface_phase[out_i],
                transition_candidate: batch_result.transition_candidate[out_i],
            });
        }

        mixed_edge_promoted_voxel_count +=
            promote_mixed_transition_edges(&mut level_voxels, parsed.grid.nx, parsed.grid.ny);

        for voxel in level_voxels {
            let tile_row = voxel.row as usize / tile_size as usize;
            let tile_col = voxel.col as usize / tile_size as usize;
            let tile_idx = tile_row * tile_cols as usize + tile_col;
            buckets[tile_idx].push(StoredVoxel {
                row: voxel.row,
                col: voxel.col,
                level_idx: *level_idx,
                phase: voxel.phase,
                surface_phase: voxel.surface_phase,
                dbz_tenths: voxel.dbz_tenths,
            });
        }
    }

    let mut tile_offsets = Vec::with_capacity(tile_count + 1);
    tile_offsets.push(0_u32);
    let total_voxel_count: usize = buckets.iter().map(Vec::len).sum();
    let mut voxels = Vec::with_capacity(total_voxel_count);
    for bucket in buckets {
        voxels.extend(bucket);
        tile_offsets.push(voxels.len() as u32);
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
        zdr_bundle.available_level_count(),
        LEVEL_TAGS.len(),
        rhohv_bundle.available_level_count(),
        LEVEL_TAGS.len(),
        format_optional_i64(zdr_bundle.age_seconds),
        format_optional_i64(rhohv_bundle.age_seconds),
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
            zdr_timestamp: zdr_bundle.selected_timestamp,
            rhohv_timestamp: rhohv_bundle.selected_timestamp,
            precip_flag_timestamp: thermo_aux_bundle
                .precip_flag
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            freezing_level_timestamp: thermo_aux_bundle
                .freezing_level
                .as_ref()
                .map(|(ts, _field)| ts.clone()),
            zdr_age_seconds: zdr_bundle.age_seconds,
            rhohv_age_seconds: rhohv_bundle.age_seconds,
        },
    }))
}

async fn parse_reflectivity_levels(
    state: &AppState,
    timestamp: &str,
    date_part: &str,
) -> Result<Vec<(u8, String, ParsedReflectivityField)>> {
    let mut futures = FuturesUnordered::new();
    for (level_idx, level_tag) in LEVEL_TAGS.iter().enumerate() {
        let state = state.clone();
        let level_tag = level_tag.to_string();
        let timestamp = timestamp.to_string();
        let date_part = date_part.to_string();
        futures.push(async move {
            let reflectivity_key =
                build_level_key(MRMS_PRODUCT_PREFIX, &level_tag, &date_part, &timestamp);
            let reflectivity_zipped = fetch_mrms_key_bytes(&state, &reflectivity_key).await?;
            let reflectivity =
                parse_reflectivity_grib_with_limit(&state, reflectivity_zipped).await?;
            Ok::<_, anyhow::Error>((level_idx, level_tag, reflectivity))
        });
    }

    let mut parsed_levels: Vec<Option<(String, ParsedReflectivityField)>> =
        vec![None; LEVEL_TAGS.len()];
    while let Some(result) = futures.next().await {
        let (level_idx, level_tag, reflectivity) = result?;
        parsed_levels[level_idx] = Some((level_tag, reflectivity));
    }

    let mut levels = Vec::with_capacity(parsed_levels.len());
    for (idx, item) in parsed_levels.into_iter().enumerate() {
        let (level_tag, reflectivity) =
            item.ok_or_else(|| anyhow!("Missing parsed level {}", LEVEL_TAGS[idx]))?;
        levels.push((idx as u8, level_tag, reflectivity));
    }
    levels.sort_by_key(|(idx, _, _)| *idx);
    Ok(levels)
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
struct AuxFieldSampler<'a> {
    direct_values: Option<&'a [f32]>,
    sampled_lookup: Option<AuxFieldLookup<'a>>,
}

impl<'a> AuxFieldSampler<'a> {
    fn new(
        field: Option<&'a ParsedAuxField>,
        direct_values: Option<&'a [f32]>,
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

    #[inline]
    fn sample(&self, value_idx: usize, row: usize, col: usize) -> Option<f32> {
        if let Some(values) = self.direct_values {
            return values.get(value_idx).copied();
        }
        self.sampled_lookup
            .as_ref()
            .and_then(|lookup| lookup.sample(row, col))
    }
}

#[derive(Clone, Debug)]
struct AuxFieldLookup<'a> {
    values: &'a [f32],
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
            values: field.values.as_slice(),
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
        self.values.get(index).copied()
    }
}

struct DualPolBundle {
    selected_timestamp: Option<String>,
    age_seconds: Option<i64>,
    fields_by_level: Vec<Option<ParsedAuxField>>,
}

impl DualPolBundle {
    fn available_level_count(&self) -> usize {
        self.fields_by_level
            .iter()
            .filter(|field| field.is_some())
            .count()
    }
}

async fn fetch_dual_pol_bundle(
    state: &AppState,
    product_prefix: &'static str,
    target_timestamp: &str,
) -> DualPolBundle {
    let target_date_part = match target_timestamp.split('-').next() {
        Some(value) => value,
        None => {
            warn!("Invalid timestamp for aux selection: {target_timestamp}");
            return DualPolBundle {
                selected_timestamp: None,
                age_seconds: None,
                fields_by_level: vec![None; LEVEL_TAGS.len()],
            };
        }
    };

    let mut selected_timestamp = Some(target_timestamp.to_string());
    let mut base_level_field: Option<ParsedAuxField> = match fetch_level_aux_field_at_timestamp(
        state,
        product_prefix,
        MRMS_BASE_LEVEL_TAG,
        target_date_part,
        target_timestamp,
    )
    .await
    {
        Ok(field) => Some(field),
        Err(error) => {
            warn!(
                "{product_prefix} exact aux unavailable at {target_timestamp}: {error:#}; searching latest available timestamp"
            );
            None
        }
    };

    if base_level_field.is_none() {
        selected_timestamp = find_latest_level_timestamp_at_or_before(
            state,
            product_prefix,
            MRMS_BASE_LEVEL_TAG,
            target_timestamp,
        )
        .await;
        if let Some(selected) = selected_timestamp.as_ref() {
            let date_part = match selected.split('-').next() {
                Some(value) => value,
                None => {
                    warn!(
                        "Invalid fallback aux timestamp for {product_prefix}: {selected}; skipping aux bundle"
                    );
                    return DualPolBundle {
                        selected_timestamp: None,
                        age_seconds: None,
                        fields_by_level: vec![None; LEVEL_TAGS.len()],
                    };
                }
            };
            base_level_field = fetch_level_aux_field_at_timestamp(
                state,
                product_prefix,
                MRMS_BASE_LEVEL_TAG,
                date_part,
                selected,
            )
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

    let Some(selected_timestamp_value) = selected_timestamp else {
        return DualPolBundle {
            selected_timestamp: None,
            age_seconds: None,
            fields_by_level: vec![None; LEVEL_TAGS.len()],
        };
    };

    let selected_date_part = match selected_timestamp_value.split('-').next() {
        Some(value) => value.to_string(),
        None => {
            warn!(
                "Invalid selected aux timestamp for {product_prefix}: {selected_timestamp_value}"
            );
            return DualPolBundle {
                selected_timestamp: None,
                age_seconds: None,
                fields_by_level: vec![None; LEVEL_TAGS.len()],
            };
        }
    };

    let mut fields_by_level = vec![None; LEVEL_TAGS.len()];
    fields_by_level[0] = base_level_field.take();
    let mut futures = FuturesUnordered::new();

    for (level_idx, level_tag) in LEVEL_TAGS.iter().enumerate().skip(1) {
        let state = state.clone();
        let level_tag = level_tag.to_string();
        let product_prefix = product_prefix.to_string();
        let date_part = selected_date_part.clone();
        let selected_timestamp_value = selected_timestamp_value.clone();

        futures.push(async move {
            let field = fetch_level_aux_field_at_timestamp(
                &state,
                &product_prefix,
                &level_tag,
                &date_part,
                &selected_timestamp_value,
            )
            .await
            .map_err(|error| {
                warn!(
                    "{product_prefix} aux unavailable for level {level_tag} at {selected_timestamp_value}: {error:#}"
                );
                error
            })
            .ok();
            (level_idx, field)
        });
    }

    while let Some((level_idx, field)) = futures.next().await {
        fields_by_level[level_idx] = field;
    }

    let age_seconds = timestamp_age_seconds(target_timestamp, &selected_timestamp_value);
    DualPolBundle {
        selected_timestamp: Some(selected_timestamp_value),
        age_seconds,
        fields_by_level,
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

fn validate_level_aux_values<'a>(
    field: Option<&'a ParsedAuxField>,
    reflectivity: &ParsedReflectivityField,
    product_label: &str,
    level_tag: &str,
    timestamp: &str,
) -> Option<&'a [f32]> {
    let field = field?;
    if !is_same_grid(&field.grid, &reflectivity.grid) {
        warn!(
            "{product_label} aux grid mismatch for level {level_tag} at {timestamp}; using aux fallback for affected voxels"
        );
        return None;
    }
    if field.values.len() != reflectivity.dbz_tenths.len() {
        warn!(
            "{product_label} aux point-count mismatch for level {level_tag} at {timestamp}: expected {}, got {}; using aux fallback for affected voxels",
            reflectivity.dbz_tenths.len(),
            field.values.len()
        );
        return None;
    }
    Some(field.values.as_slice())
}

fn validate_base_aux_values<'a>(
    field: Option<&'a ParsedAuxField>,
    base_grid: &GridDef,
    point_count: usize,
    product_label: &str,
    timestamp: &str,
) -> Option<&'a [f32]> {
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
    Some(field.values.as_slice())
}

fn validate_echo_top_values<'a>(
    field: Option<&'a ParsedAuxField>,
    base_grid: &GridDef,
    point_count: usize,
    product_label: &str,
    timestamp: &str,
) -> Option<&'a [f32]> {
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
    Some(field.values.as_slice())
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

    #[test]
    fn filter_voxels_by_threshold_selects_above_threshold() {
        let dbz = vec![10_i16, 60, -50, 50, 100, 49, 51];
        let threshold = 50_i16;
        let result = filter_voxels_by_threshold(&dbz, threshold);
        assert_eq!(result, vec![1_u32, 3, 4, 6]);
    }

    #[test]
    fn filter_voxels_by_threshold_empty_input() {
        let result = filter_voxels_by_threshold(&[], 50);
        assert!(result.is_empty());
    }

    #[test]
    fn filter_voxels_by_threshold_all_below() {
        let dbz = vec![10_i16, 20, 30, 40, 49];
        let result = filter_voxels_by_threshold(&dbz, 50);
        assert!(result.is_empty());
    }

    #[test]
    fn filter_voxels_by_threshold_all_above() {
        let dbz = vec![50_i16, 60, 70, 80];
        let result = filter_voxels_by_threshold(&dbz, 50);
        assert_eq!(result, vec![0_u32, 1, 2, 3]);
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
        for n in [0, 1, 7, 8, 9, 15, 16, 100, 1000] {
            let data: Vec<i16> = (0..n).map(|i| ((i * 7 + 3) % 200 - 50) as i16).collect();
            let threshold = 50i16;
            let expected = filter_scalar_reference(&data, threshold);
            let actual = filter_voxels_by_threshold(&data, threshold);
            assert_eq!(actual, expected, "mismatch at n={n}");
        }
    }

    #[test]
    fn simd_filter_empty() {
        assert!(filter_voxels_by_threshold(&[], 50).is_empty());
    }

    #[test]
    fn simd_filter_all_pass() {
        let data = vec![100i16; 17];
        assert_eq!(filter_voxels_by_threshold(&data, 50).len(), 17);
    }

    #[test]
    fn simd_filter_none_pass() {
        let data = vec![10i16; 17];
        assert!(filter_voxels_by_threshold(&data, 50).is_empty());
    }
}

#[cfg(test)]
mod gather_tests {
    use super::*;

    #[test]
    fn gather_uses_nan_for_missing_zdr() {
        let valid_indices = vec![0_u32, 2, 5];
        let zdr = vec![1.0_f32, f32::NAN, 2.0, 3.0, 4.0, 5.0];
        // Empty samplers (no direct values, no lookup)
        let empty_sampler = AuxFieldSampler {
            direct_values: None,
            sampled_lookup: None,
        };

        let result = gather_aux_fields(
            &valid_indices,
            6,
            Some(&zdr),
            None,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
        );

        assert_eq!(result.zdr[0], 1.0);
        assert_eq!(result.zdr[1], 2.0);
        assert_eq!(result.zdr[2], 5.0);
        // All other fields should be NaN
        assert!(result.rhohv[0].is_nan());
        assert!(result.precip_flag[0].is_nan());
    }

    #[test]
    fn gather_empty_indices_returns_empty_vecs() {
        let empty_sampler = AuxFieldSampler {
            direct_values: None,
            sampled_lookup: None,
        };

        let result = gather_aux_fields(
            &[],
            6,
            None,
            None,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
        );

        assert!(result.zdr.is_empty());
        assert!(result.rhohv.is_empty());
        assert!(result.precip_flag.is_empty());
    }

    #[test]
    fn gather_direct_values_sampler() {
        let precip_data = vec![10.0_f32, 20.0, 30.0, 40.0, 50.0, 60.0];
        let precip_sampler = AuxFieldSampler {
            direct_values: Some(&precip_data),
            sampled_lookup: None,
        };
        let empty_sampler = AuxFieldSampler {
            direct_values: None,
            sampled_lookup: None,
        };

        let valid_indices = vec![1_u32, 3, 5];
        let result = gather_aux_fields(
            &valid_indices,
            6,
            None,
            None,
            &precip_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
            &empty_sampler,
        );

        assert_eq!(result.precip_flag[0], 20.0);
        assert_eq!(result.precip_flag[1], 40.0);
        assert_eq!(result.precip_flag[2], 60.0);
        // zdr should be NaN since no zdr_values provided
        assert!(result.zdr[0].is_nan());
    }
}
