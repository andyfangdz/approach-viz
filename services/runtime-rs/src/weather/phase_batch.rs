use crate::constants::{
    MIXED_COMPETING_PROMOTION_GAP_MAX, MIXED_COMPETING_PROMOTION_MARGIN,
    MIXED_COMPETING_PROMOTION_MIN_SCORE, MIXED_COMPETING_RAIN_SNOW_DELTA_MAX,
    MIXED_COMPETING_RAIN_SNOW_MIN_SCORE, MIXED_DUAL_SUPPORT_CONFIDENCE_MIN,
    MIXED_SELECTION_MARGIN, MIXED_SELECTION_MARGIN_TRANSITION, PHASE_MIXED, PHASE_RAIN,
    PHASE_RHOHV_HIGH_CONFIDENCE_MIN, PHASE_RHOHV_LOW_CONFIDENCE_MAX, PHASE_RHOHV_MAX_VALID,
    PHASE_RHOHV_MIN_VALID, PHASE_SNOW, PHASE_ZDR_MAX_VALID_DB, PHASE_ZDR_MIN_VALID_DB,
    PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB, PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB,
    THERMO_STRONG_COLD_WET_BULB_C, THERMO_STRONG_WARM_WET_BULB_C,
};

// f32 versions of f64 constants from constants.rs
const FEET_PER_METER_F32: f32 = 3.28084;
const THERMO_NEAR_FREEZING_FEET_F32: f32 = 1500.0;
const FREEZING_LEVEL_TRANSITION_FEET_F32: f32 = 1500.0;

pub struct BatchPhaseResult {
    pub phase: Vec<u8>,
    pub surface_phase: Vec<u8>,
    pub transition_candidate: Vec<bool>,
    pub signal_count: Vec<u8>,
    pub used_dual: Vec<bool>,
    pub suppressed_dual: Vec<bool>,
    pub suppressed_mixed: Vec<bool>,
    pub forced_precip_snow: Vec<bool>,
}

/// Branchless batch phase scoring on flat f32 arrays.
///
/// Replicates the full scalar pipeline: `resolve_thermo_phase` + `resolve_dual_pol_evidence`
/// + `resolve_phase_from_evidence`. Produces identical phase assignments for all inputs.
///
/// Uses branchless predicated arithmetic for continuous score accumulation to enable
/// LLVM auto-vectorization. Discrete code matching (precip flags, dual-pol branches)
/// uses normal branches since those are not the hot compute path.
#[inline(never)] // Preserve as named function for LLVM remarks + CI vectorization checks
#[allow(clippy::too_many_arguments)]
pub fn compute_phase_scores_branchless(
    voxel_mid_feet: f32,
    precip_flag: &[f32],
    freezing_level: &[f32],
    wet_bulb: &[f32],
    surface_temp: &[f32],
    bright_band_top: &[f32],
    bright_band_bottom: &[f32],
    rqi: &[f32],
    zdr: &[f32],
    rhohv: &[f32],
    use_aux_fallback: bool,
) -> BatchPhaseResult {
    let n = precip_flag.len();
    debug_assert_eq!(freezing_level.len(), n);
    debug_assert_eq!(wet_bulb.len(), n);
    debug_assert_eq!(surface_temp.len(), n);
    debug_assert_eq!(bright_band_top.len(), n);
    debug_assert_eq!(bright_band_bottom.len(), n);
    debug_assert_eq!(rqi.len(), n);
    debug_assert_eq!(zdr.len(), n);
    debug_assert_eq!(rhohv.len(), n);

    let mut phase_out = vec![PHASE_RAIN; n];
    let mut surface_phase_out = vec![PHASE_RAIN; n];
    let mut transition_candidate_out = vec![false; n];
    let mut signal_count_out = vec![0u8; n];
    let mut used_dual_out = vec![false; n];
    let mut suppressed_dual_out = vec![false; n];
    let mut suppressed_mixed_out = vec![false; n];
    let mut forced_precip_snow_out = vec![false; n];

    for i in 0..n {
        let (
            phase,
            surface_phase,
            transition_candidate,
            signal_count,
            used_dual,
            suppressed_dual,
            suppressed_mixed,
            forced_precip_snow,
        ) = score_single_voxel(
            voxel_mid_feet,
            precip_flag[i],
            freezing_level[i],
            wet_bulb[i],
            surface_temp[i],
            bright_band_top[i],
            bright_band_bottom[i],
            rqi[i],
            zdr[i],
            rhohv[i],
            use_aux_fallback,
        );

        phase_out[i] = phase;
        surface_phase_out[i] = surface_phase;
        transition_candidate_out[i] = transition_candidate;
        signal_count_out[i] = signal_count;
        used_dual_out[i] = used_dual;
        suppressed_dual_out[i] = suppressed_dual;
        suppressed_mixed_out[i] = suppressed_mixed;
        forced_precip_snow_out[i] = forced_precip_snow;
    }

    BatchPhaseResult {
        phase: phase_out,
        surface_phase: surface_phase_out,
        transition_candidate: transition_candidate_out,
        signal_count: signal_count_out,
        used_dual: used_dual_out,
        suppressed_dual: suppressed_dual_out,
        suppressed_mixed: suppressed_mixed_out,
        forced_precip_snow: forced_precip_snow_out,
    }
}

/// Scores a single voxel using branchless predicated arithmetic for continuous score
/// accumulation. Returns (phase, surface_phase, transition_candidate, signal_count,
/// used_dual, suppressed_dual, suppressed_mixed, forced_precip_snow).
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn score_single_voxel(
    voxel_mid_feet: f32,
    precip_flag_raw: f32,
    freezing_level_raw: f32,
    wet_bulb_raw: f32,
    surface_temp_raw: f32,
    bright_band_top_raw: f32,
    bright_band_bottom_raw: f32,
    rqi_raw: f32,
    zdr_raw: f32,
    rhohv_raw: f32,
    use_aux_fallback: bool,
) -> (u8, u8, bool, u8, bool, bool, bool, bool) {
    let mut rain_score: f32 = 1.0;
    let mut mixed_score: f32 = 0.7;
    let mut snow_score: f32 = 1.0;
    let mut signal_count: u8 = 0;
    let mut near_transition = false;

    // ── Precip flag (discrete codes, branches OK) ──────────────────────
    let precip_flag_phase = score_precip_flag(precip_flag_raw);
    if let Some(pfp) = precip_flag_phase {
        signal_count = signal_count.saturating_add(1);
        match pfp {
            PHASE_RAIN => rain_score += 3.0,
            PHASE_SNOW => snow_score += 3.2,
            PHASE_MIXED => {
                mixed_score += 1.8;
                rain_score += 0.8;
            }
            _ => {}
        }
    }

    // ── Freezing level (branchless) ────────────────────────────────────
    let freezing_valid = freezing_level_raw.is_finite() && freezing_level_raw > 0.0;
    let fmask = freezing_valid as u32 as f32; // 0.0 or 1.0
    if freezing_valid {
        signal_count = signal_count.saturating_add(1);
        let freezing_meters = freezing_level_raw;
        let freezing_feet = freezing_meters * FEET_PER_METER_F32;
        let delta_feet = voxel_mid_feet - freezing_feet;

        // Near-transition flag
        if delta_feet.abs() <= THERMO_NEAR_FREEZING_FEET_F32 {
            near_transition = true;
        }

        // Phase from freezing level
        let fl_above = (delta_feet >= FREEZING_LEVEL_TRANSITION_FEET_F32) as u32 as f32;
        let fl_below = (delta_feet <= -FREEZING_LEVEL_TRANSITION_FEET_F32) as u32 as f32;
        snow_score += fmask * (fl_above * 0.6);
        rain_score += fmask * (fl_below * 0.6);
        mixed_score += fmask * ((1.0 - fl_above - fl_below) * 0.6);

        // Altitude-based scoring (branchless)
        let very_cold = (delta_feet >= 2500.0) as u32 as f32;
        let cold =
            ((delta_feet >= THERMO_NEAR_FREEZING_FEET_F32) as u32 as f32) * (1.0 - very_cold);
        let very_warm = (delta_feet <= -2500.0) as u32 as f32;
        let warm =
            ((delta_feet <= -THERMO_NEAR_FREEZING_FEET_F32) as u32 as f32) * (1.0 - very_warm);
        let middle = 1.0 - very_cold - cold - very_warm - warm;
        let mid_cold = (delta_feet >= 0.0) as u32 as f32;

        snow_score += fmask * (very_cold * 2.4 + cold * 1.8 + middle * mid_cold * 0.8);
        rain_score += fmask * (very_warm * 2.4 + warm * 1.8 + middle * (1.0 - mid_cold) * 0.8);
        mixed_score += fmask * (cold * 0.5 + warm * 0.5 + middle * 1.6);
    }

    // ── Wet bulb temperature ───────────────────────────────────────────
    let wet_bulb_c = normalize_temperature_celsius_f32(wet_bulb_raw);
    if let Some(wb) = wet_bulb_c {
        signal_count = signal_count.saturating_add(1);
        if wb <= THERMO_STRONG_COLD_WET_BULB_C {
            snow_score += 2.4;
        } else if wb <= 0.5 {
            near_transition = true;
            mixed_score += 1.1;
            snow_score += 1.0;
        } else if wb >= THERMO_STRONG_WARM_WET_BULB_C {
            rain_score += 2.2;
        } else {
            near_transition = true;
            mixed_score += 1.1;
            rain_score += 1.0;
        }
    }

    // ── Surface temperature ────────────────────────────────────────────
    let surface_temp_c = normalize_temperature_celsius_f32(surface_temp_raw);
    if let Some(st) = surface_temp_c {
        signal_count = signal_count.saturating_add(1);
        // voxel_mid_feet is f32 here; scalar uses f64 but same formula
        let low_level_weight = (8_000.0_f32 - voxel_mid_feet).max(0.0) / 8_000.0_f32;
        if low_level_weight > 0.0 {
            if st <= -0.5 {
                snow_score += 1.2 * low_level_weight;
            } else if st >= 2.0 {
                rain_score += 1.2 * low_level_weight;
            } else {
                near_transition = true;
                mixed_score += 0.8 * low_level_weight;
                if st <= 0.5 {
                    snow_score += 0.4 * low_level_weight;
                } else {
                    rain_score += 0.4 * low_level_weight;
                }
            }
        }
    }

    // ── Bright band ────────────────────────────────────────────────────
    let bb_top_m = normalize_height_meters_f32(bright_band_top_raw);
    let bb_bottom_m = normalize_height_meters_f32(bright_band_bottom_raw);
    if let (Some(top_m), Some(bottom_m)) = (bb_top_m, bb_bottom_m) {
        if top_m >= bottom_m {
            signal_count = signal_count.saturating_add(1);
            let top_feet = top_m * FEET_PER_METER_F32;
            let bottom_feet = bottom_m * FEET_PER_METER_F32;
            if voxel_mid_feet >= bottom_feet - 400.0 && voxel_mid_feet <= top_feet + 400.0 {
                near_transition = true;
                mixed_score += 2.0;
            } else if voxel_mid_feet > top_feet + 800.0 {
                snow_score += 1.2;
            } else if voxel_mid_feet < bottom_feet - 800.0 {
                rain_score += 1.2;
            }
        }
    }

    // ── RQI normalization ──────────────────────────────────────────────
    let rqi_normalized = normalize_rqi_f32(rqi_raw);

    // ── Rank thermo scores ─────────────────────────────────────────────
    let thermo_ranked = rank_phase_scores_f32(rain_score, mixed_score, snow_score);
    let thermo_phase = thermo_ranked[0].0;
    let best_thermo = thermo_ranked[0].1.max(0.0);
    let second_thermo = thermo_ranked[1].1.max(0.0);
    let thermo_confidence = if best_thermo + second_thermo > 0.0 {
        ((best_thermo - second_thermo) / (best_thermo + second_thermo)).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // ── Dual-pol evidence (branches OK — discrete logic) ───────────────
    let dual_evidence = resolve_dual_pol_evidence_f32(zdr_raw, rhohv_raw);

    // ── resolve_phase_from_evidence ────────────────────────────────────
    let mut used_dual = false;
    let mut suppressed_dual = false;
    let mut suppressed_mixed = false;

    let dual_mixed_support = dual_evidence
        .map_or(false, |(phase, confidence)| {
            phase == PHASE_MIXED && confidence >= MIXED_DUAL_SUPPORT_CONFIDENCE_MIN
        });

    if let Some((dual_phase, dual_confidence)) = dual_evidence {
        let stale_weight: f32 = if use_aux_fallback { 0.22 } else { 0.58 };
        let rqi_weight = rqi_normalized
            .map(|v| (0.35 + 0.65 * v).clamp(0.25, 1.0))
            .unwrap_or(0.85);
        let mut dual_weight = stale_weight * rqi_weight * dual_confidence;

        if dual_phase == PHASE_MIXED && !near_transition {
            dual_weight *= 0.55;
        }

        if dual_phase == PHASE_RAIN
            && thermo_phase == PHASE_SNOW
            && thermo_confidence >= 0.35
            && precip_flag_phase == Some(PHASE_SNOW)
        {
            dual_weight *= 0.2;
        }

        if dual_weight >= 0.08 {
            add_score(&mut rain_score, &mut mixed_score, &mut snow_score, dual_phase, dual_weight * 2.2);
            used_dual = true;
        } else {
            suppressed_dual = true;
        }
    }

    // ── Mixed promotion ────────────────────────────────────────────────
    let rain_snow_competing = rain_score >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
        && snow_score >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
        && (rain_score - snow_score).abs() <= MIXED_COMPETING_RAIN_SNOW_DELTA_MAX;
    let rain_snow_promotion = rain_score >= MIXED_COMPETING_PROMOTION_MIN_SCORE
        && snow_score >= MIXED_COMPETING_PROMOTION_MIN_SCORE
        && (rain_score - snow_score).abs() <= MIXED_COMPETING_RAIN_SNOW_DELTA_MAX;
    if rain_snow_promotion
        && (near_transition || dual_mixed_support || signal_count >= 2)
    {
        let rain_snow_peak = rain_score.max(snow_score);
        let mixed_gap = rain_snow_peak - mixed_score;
        if mixed_gap.is_finite()
            && mixed_gap > 0.0
            && mixed_gap <= MIXED_COMPETING_PROMOTION_GAP_MAX
        {
            mixed_score += mixed_gap + MIXED_COMPETING_PROMOTION_MARGIN;
        }
    }

    // ── Final ranking ──────────────────────────────────────────────────
    let ranked = rank_phase_scores_f32(rain_score, mixed_score, snow_score);
    let mut phase = ranked[0].0;

    if phase == PHASE_MIXED {
        let best_non_mixed = if ranked[1].0 == PHASE_MIXED {
            ranked[2]
        } else {
            ranked[1]
        };
        let mixed_advantage = ranked[0].1 - best_non_mixed.1;
        let transition_like = near_transition || rain_snow_competing || dual_mixed_support;
        let required_margin = if transition_like {
            MIXED_SELECTION_MARGIN_TRANSITION
        } else {
            MIXED_SELECTION_MARGIN
        };

        if mixed_advantage < required_margin {
            phase = best_non_mixed.0;
            suppressed_mixed = true;
        }
    }

    // ── Forced precip-snow override ────────────────────────────────────
    let mut forced_precip_snow = false;
    if precip_flag_phase == Some(PHASE_SNOW) && phase != PHASE_SNOW {
        if thermo_phase == PHASE_SNOW || near_transition {
            phase = PHASE_SNOW;
            forced_precip_snow = true;
        }
    }

    // ── Surface phase ──────────────────────────────────────────────────
    let surface_phase = precip_flag_phase.unwrap_or(PHASE_RAIN);

    // ── Transition candidate (matches processor.rs logic) ──────────────
    let thermo_competing_candidate = rain_score >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
        && snow_score >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
        && (rain_score - snow_score).abs() <= MIXED_COMPETING_RAIN_SNOW_DELTA_MAX + 0.45;
    let dual_mixed_candidate = dual_evidence
        .map_or(false, |(p, c)| p == PHASE_MIXED && c >= 0.35);
    let transition_candidate = !forced_precip_snow
        && (near_transition || thermo_competing_candidate || dual_mixed_candidate);

    (
        phase,
        surface_phase,
        transition_candidate,
        signal_count,
        used_dual,
        suppressed_dual,
        suppressed_mixed,
        forced_precip_snow,
    )
}

/// Map precip flag codes to phase. Matches `phase_from_precip_flag` in phase.rs.
#[inline(always)]
fn score_precip_flag(value: f32) -> Option<u8> {
    if !value.is_finite() {
        return None;
    }
    let code = value.round() as i32;
    match code {
        -3 | 0 => None,
        3 => Some(PHASE_SNOW),
        7 => Some(PHASE_MIXED),
        1 | 6 | 10 | 91 | 96 => Some(PHASE_RAIN),
        _ => None,
    }
}

/// Normalize temperature to Celsius. Matches `normalize_temperature_celsius` in phase.rs.
#[inline(always)]
fn normalize_temperature_celsius_f32(value: f32) -> Option<f32> {
    if !value.is_finite() {
        return None;
    }
    if (-90.0..=70.0).contains(&value) {
        return Some(value);
    }
    if (150.0..=340.0).contains(&value) {
        return Some(value - 273.15);
    }
    None
}

/// Normalize height to meters. Matches `normalize_height_meters` in phase.rs.
/// Returns f32 (not f64 like the scalar version) since we work in f32 throughout.
#[inline(always)]
fn normalize_height_meters_f32(value: f32) -> Option<f32> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let mut meters = value;
    if meters < 50.0 {
        meters *= 1000.0;
    }
    if !(100.0..=30_000.0).contains(&meters) {
        return None;
    }
    Some(meters)
}

/// Normalize RQI. Matches `normalize_rqi` in phase.rs.
#[inline(always)]
fn normalize_rqi_f32(value: f32) -> Option<f32> {
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    if value <= 1.05 {
        return Some(value.clamp(0.0, 1.0));
    }
    if value <= 100.0 {
        return Some((value / 100.0).clamp(0.0, 1.0));
    }
    None
}

/// Sanitize ZDR value. Matches `sanitize_zdr` in phase.rs.
#[inline(always)]
fn sanitize_zdr_f32(value: f32) -> Option<f32> {
    if !value.is_finite() || !(PHASE_ZDR_MIN_VALID_DB..=PHASE_ZDR_MAX_VALID_DB).contains(&value) {
        return None;
    }
    Some(value)
}

/// Sanitize RhoHV value. Matches `sanitize_rhohv` in phase.rs.
#[inline(always)]
fn sanitize_rhohv_f32(value: f32) -> Option<f32> {
    if !value.is_finite() || !(PHASE_RHOHV_MIN_VALID..=PHASE_RHOHV_MAX_VALID).contains(&value) {
        return None;
    }
    Some(value)
}

/// Resolve dual-pol evidence from ZDR and RhoHV. Returns (phase, confidence).
/// Matches `resolve_dual_pol_evidence` in phase.rs exactly.
#[inline(always)]
fn resolve_dual_pol_evidence_f32(zdr_raw: f32, rhohv_raw: f32) -> Option<(u8, f32)> {
    let zdr = sanitize_zdr_f32(zdr_raw);
    let rhohv = sanitize_rhohv_f32(rhohv_raw);

    match (zdr, rhohv) {
        (Some(zdr), Some(rhohv)) => {
            if rhohv < PHASE_RHOHV_LOW_CONFIDENCE_MAX {
                if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB + 0.1 {
                    Some((PHASE_RAIN, 0.55))
                } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB - 0.15 {
                    Some((PHASE_SNOW, 0.55))
                } else {
                    Some((PHASE_MIXED, 0.45))
                }
            } else if rhohv >= PHASE_RHOHV_HIGH_CONFIDENCE_MIN {
                if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB {
                    Some((PHASE_RAIN, 0.82))
                } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB {
                    Some((PHASE_SNOW, 0.82))
                } else {
                    Some((PHASE_MIXED, 0.35))
                }
            } else if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB {
                Some((PHASE_RAIN, 0.65))
            } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB {
                Some((PHASE_SNOW, 0.65))
            } else {
                Some((PHASE_MIXED, 0.55))
            }
        }
        (Some(zdr), None) => {
            if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB + 0.15 {
                Some((PHASE_RAIN, 0.50))
            } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB - 0.2 {
                Some((PHASE_SNOW, 0.50))
            } else {
                Some((PHASE_MIXED, 0.30))
            }
        }
        (None, Some(rhohv)) => {
            if rhohv < PHASE_RHOHV_LOW_CONFIDENCE_MAX - 0.02 {
                Some((PHASE_MIXED, 0.35))
            } else {
                None
            }
        }
        (None, None) => None,
    }
}

/// Add score to the appropriate phase bucket.
#[inline(always)]
fn add_score(rain: &mut f32, mixed: &mut f32, snow: &mut f32, phase: u8, weight: f32) {
    if !weight.is_finite() || weight <= 0.0 {
        return;
    }
    match phase {
        PHASE_RAIN => *rain += weight,
        PHASE_MIXED => *mixed += weight,
        PHASE_SNOW => *snow += weight,
        _ => {}
    }
}

/// Rank three phase scores descending. Matches `rank_phase_scores` in phase.rs.
#[inline(always)]
fn rank_phase_scores_f32(rain: f32, mixed: f32, snow: f32) -> [(u8, f32); 3] {
    let mut first = (PHASE_RAIN, rain);
    let mut second = (PHASE_MIXED, mixed);
    let mut third = (PHASE_SNOW, snow);

    if second.1 > first.1 {
        std::mem::swap(&mut first, &mut second);
    }
    if third.1 > second.1 {
        std::mem::swap(&mut second, &mut third);
    }
    if second.1 > first.1 {
        std::mem::swap(&mut first, &mut second);
    }

    [first, second, third]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::weather::resolve_thermo_phase;

    // Minimal LCG RNG (same as benches/fixtures.rs)
    struct SimpleRng(u64);

    impl SimpleRng {
        fn new(seed: u64) -> Self {
            Self(seed)
        }

        fn next_u64(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1);
            self.0
        }

        fn next_f32(&mut self) -> f32 {
            (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
        }

        fn next_bool(&mut self, probability: f32) -> bool {
            self.next_f32() < probability
        }
    }

    fn lerp(lo: f32, hi: f32, t: f32) -> f32 {
        lo + (hi - lo) * t
    }

    fn nan_to_option(v: f32) -> Option<f32> {
        if v.is_finite() { Some(v) } else { None }
    }

    /// Generate random voxel aux values with the same distribution as benchmark fixtures.
    /// Returns (precip_flag, freezing_level, wet_bulb, surface_temp, bb_top, bb_bottom, rqi, zdr, rhohv)
    fn generate_random_voxel(rng: &mut SimpleRng) -> [f32; 9] {
        let precip_flag_choices: [f32; 4] = [0.0, 1.0, 3.0, 7.0];

        let precip_flag = if rng.next_bool(0.80) {
            let pick = (rng.next_f32() * 4.0) as usize;
            precip_flag_choices[pick.min(3)]
        } else {
            f32::NAN
        };

        let freezing_level = if rng.next_bool(0.80) {
            lerp(2000.0, 5000.0, rng.next_f32())
        } else {
            f32::NAN
        };

        let wet_bulb = if rng.next_bool(0.80) {
            lerp(-5.0, 5.0, rng.next_f32())
        } else {
            f32::NAN
        };

        let surface_temp = if rng.next_bool(0.80) {
            lerp(-2.0, 4.0, rng.next_f32())
        } else {
            f32::NAN
        };

        let bb_top = if rng.next_bool(0.80) {
            lerp(3000.0, 5000.0, rng.next_f32())
        } else {
            f32::NAN
        };

        let bb_bottom = if rng.next_bool(0.80) {
            lerp(2500.0, 4500.0, rng.next_f32())
        } else {
            f32::NAN
        };

        let rqi_val = if rng.next_bool(0.80) {
            rng.next_f32()
        } else {
            f32::NAN
        };

        let zdr_val = if rng.next_bool(0.90) {
            lerp(-2.0, 3.0, rng.next_f32())
        } else {
            f32::NAN
        };

        let rhohv_val = if rng.next_bool(0.90) {
            lerp(0.85, 1.01, rng.next_f32())
        } else {
            f32::NAN
        };

        [precip_flag, freezing_level, wet_bulb, surface_temp, bb_top, bb_bottom, rqi_val, zdr_val, rhohv_val]
    }

    #[test]
    fn branchless_matches_scalar() {
        let n = 10_000;
        let voxel_mid_feet: f32 = 15_000.0;
        let mut rng = SimpleRng::new(0xBEEF_CAFE_1234_5678);

        let mut precip_flags = Vec::with_capacity(n);
        let mut freezing_levels = Vec::with_capacity(n);
        let mut wet_bulbs = Vec::with_capacity(n);
        let mut surface_temps = Vec::with_capacity(n);
        let mut bb_tops = Vec::with_capacity(n);
        let mut bb_bottoms = Vec::with_capacity(n);
        let mut rqis = Vec::with_capacity(n);
        let mut zdrs = Vec::with_capacity(n);
        let mut rhohvs = Vec::with_capacity(n);

        for _ in 0..n {
            let vals = generate_random_voxel(&mut rng);
            precip_flags.push(vals[0]);
            freezing_levels.push(vals[1]);
            wet_bulbs.push(vals[2]);
            surface_temps.push(vals[3]);
            bb_tops.push(vals[4]);
            bb_bottoms.push(vals[5]);
            rqis.push(vals[6]);
            zdrs.push(vals[7]);
            rhohvs.push(vals[8]);
        }

        // Run branchless batch version
        let batch = compute_phase_scores_branchless(
            voxel_mid_feet,
            &precip_flags,
            &freezing_levels,
            &wet_bulbs,
            &surface_temps,
            &bb_tops,
            &bb_bottoms,
            &rqis,
            &zdrs,
            &rhohvs,
            false, // use_aux_fallback
        );

        // Run scalar version for each voxel and compare
        let mut mismatches = 0;
        for i in 0..n {
            // Scalar pipeline: resolve_thermo_phase -> resolve_dual_pol_evidence -> resolve_phase_from_evidence
            let thermo = resolve_thermo_phase(
                voxel_mid_feet as f64,
                nan_to_option(precip_flags[i]),
                nan_to_option(freezing_levels[i]),
                nan_to_option(wet_bulbs[i]),
                nan_to_option(surface_temps[i]),
                nan_to_option(bb_tops[i]),
                nan_to_option(bb_bottoms[i]),
                nan_to_option(rqis[i]),
            );

            let dual = crate::weather::phase::resolve_dual_pol_evidence(
                nan_to_option(zdrs[i]),
                nan_to_option(rhohvs[i]),
            );

            let resolution = crate::weather::phase::resolve_phase_from_evidence(
                thermo,
                dual,
                false,
            );

            if batch.phase[i] != resolution.phase {
                mismatches += 1;
            }

            // Also verify surface_phase, used_dual, suppressed_dual, suppressed_mixed, forced_precip_snow
            let expected_surface_phase = thermo.precip_flag_phase.unwrap_or(PHASE_RAIN);
            assert_eq!(
                batch.surface_phase[i], expected_surface_phase,
                "surface_phase mismatch at index {i}"
            );
            assert_eq!(
                batch.used_dual[i], resolution.used_dual,
                "used_dual mismatch at index {i}"
            );
            assert_eq!(
                batch.suppressed_dual[i], resolution.suppressed_dual,
                "suppressed_dual mismatch at index {i}"
            );
            assert_eq!(
                batch.suppressed_mixed[i], resolution.suppressed_mixed,
                "suppressed_mixed mismatch at index {i}: branchless={}, scalar={}",
                batch.suppressed_mixed[i], resolution.suppressed_mixed,
            );
            assert_eq!(
                batch.forced_precip_snow[i], resolution.forced_precip_snow,
                "forced_precip_snow mismatch at index {i}"
            );
            assert_eq!(
                batch.signal_count[i], thermo.signal_count,
                "signal_count mismatch at index {i}"
            );
        }

        // Phase must match exactly (no tolerance for edge cases since voxel_mid_feet=15000
        // is well away from threshold boundaries)
        assert_eq!(
            mismatches, 0,
            "{mismatches}/{n} phase mismatches between branchless and scalar"
        );
    }

    #[test]
    fn branchless_matches_scalar_with_aux_fallback() {
        let n = 5_000;
        let voxel_mid_feet: f32 = 15_000.0;
        let mut rng = SimpleRng::new(0xCAFE_DEAD_5678_1234);

        let mut precip_flags = Vec::with_capacity(n);
        let mut freezing_levels = Vec::with_capacity(n);
        let mut wet_bulbs = Vec::with_capacity(n);
        let mut surface_temps = Vec::with_capacity(n);
        let mut bb_tops = Vec::with_capacity(n);
        let mut bb_bottoms = Vec::with_capacity(n);
        let mut rqis = Vec::with_capacity(n);
        let mut zdrs = Vec::with_capacity(n);
        let mut rhohvs = Vec::with_capacity(n);

        for _ in 0..n {
            let vals = generate_random_voxel(&mut rng);
            precip_flags.push(vals[0]);
            freezing_levels.push(vals[1]);
            wet_bulbs.push(vals[2]);
            surface_temps.push(vals[3]);
            bb_tops.push(vals[4]);
            bb_bottoms.push(vals[5]);
            rqis.push(vals[6]);
            zdrs.push(vals[7]);
            rhohvs.push(vals[8]);
        }

        let batch = compute_phase_scores_branchless(
            voxel_mid_feet,
            &precip_flags,
            &freezing_levels,
            &wet_bulbs,
            &surface_temps,
            &bb_tops,
            &bb_bottoms,
            &rqis,
            &zdrs,
            &rhohvs,
            true, // use_aux_fallback = true
        );

        let mut mismatches = 0;
        for i in 0..n {
            let thermo = resolve_thermo_phase(
                voxel_mid_feet as f64,
                nan_to_option(precip_flags[i]),
                nan_to_option(freezing_levels[i]),
                nan_to_option(wet_bulbs[i]),
                nan_to_option(surface_temps[i]),
                nan_to_option(bb_tops[i]),
                nan_to_option(bb_bottoms[i]),
                nan_to_option(rqis[i]),
            );

            let dual = crate::weather::phase::resolve_dual_pol_evidence(
                nan_to_option(zdrs[i]),
                nan_to_option(rhohvs[i]),
            );

            let resolution = crate::weather::phase::resolve_phase_from_evidence(
                thermo,
                dual,
                true, // use_aux_fallback = true
            );

            if batch.phase[i] != resolution.phase {
                mismatches += 1;
            }
        }

        assert_eq!(
            mismatches, 0,
            "{mismatches}/{n} phase mismatches with aux_fallback=true"
        );
    }
}
