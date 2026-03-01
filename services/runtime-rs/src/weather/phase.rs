use rustc_hash::FxHashMap;

use crate::constants::{
    FEET_PER_METER, FREEZING_LEVEL_TRANSITION_FEET, MIXED_COMPETING_PROMOTION_GAP_MAX,
    MIXED_COMPETING_PROMOTION_MARGIN, MIXED_COMPETING_PROMOTION_MIN_SCORE,
    MIXED_COMPETING_RAIN_SNOW_DELTA_MAX, MIXED_COMPETING_RAIN_SNOW_MIN_SCORE,
    MIXED_DUAL_SUPPORT_CONFIDENCE_MIN, MIXED_SELECTION_MARGIN, MIXED_SELECTION_MARGIN_TRANSITION,
    PHASE_MIXED, PHASE_RAIN, PHASE_RHOHV_HIGH_CONFIDENCE_MIN, PHASE_RHOHV_LOW_CONFIDENCE_MAX,
    PHASE_RHOHV_MAX_VALID, PHASE_RHOHV_MIN_VALID, PHASE_SNOW, PHASE_ZDR_MAX_VALID_DB,
    PHASE_ZDR_MIN_VALID_DB, PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB, PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB,
    THERMO_NEAR_FREEZING_FEET, THERMO_STRONG_COLD_WET_BULB_C, THERMO_STRONG_WARM_WET_BULB_C,
};
#[derive(Clone, Copy, Debug)]
pub struct PhaseScores {
    pub rain: f32,
    pub mixed: f32,
    pub snow: f32,
}

impl PhaseScores {
    fn add(&mut self, phase: u8, weight: f32) {
        if !weight.is_finite() || weight <= 0.0 {
            return;
        }
        match phase {
            PHASE_RAIN => self.rain += weight,
            PHASE_MIXED => self.mixed += weight,
            PHASE_SNOW => self.snow += weight,
            _ => {}
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ThermoPhaseEvidence {
    pub scores: PhaseScores,
    pub phase: u8,
    pub confidence: f32,
    pub signal_count: u8,
    pub near_transition: bool,
    pub precip_flag_phase: Option<u8>,
    pub rqi: Option<f32>,
}

#[derive(Clone, Copy, Debug)]
pub struct DualPolEvidence {
    pub phase: u8,
    pub confidence: f32,
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub(super) struct PhaseResolution {
    pub(super) phase: u8,
    pub(super) used_dual: bool,
    pub(super) suppressed_dual: bool,
    pub(super) suppressed_mixed: bool,
    pub(super) forced_precip_snow: bool,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct LevelPhaseVoxel {
    pub(super) row: u16,
    pub(super) col: u16,
    pub(super) dbz_tenths: i16,
    pub(super) phase: u8,
    pub(super) surface_phase: u8,
    pub(super) transition_candidate: bool,
}

// Scalar pipeline below is retained for equivalence testing against phase_batch.rs.
// Production code now uses compute_phase_scores_branchless in phase_batch.rs.
#[allow(dead_code)]
pub(super) fn resolve_dual_pol_evidence(
    zdr_value: Option<f32>,
    rhohv_value: Option<f32>,
) -> Option<DualPolEvidence> {
    let zdr = zdr_value.and_then(sanitize_zdr);
    let rhohv = rhohv_value.and_then(sanitize_rhohv);

    match (zdr, rhohv) {
        (Some(zdr), Some(rhohv)) => {
            if rhohv < PHASE_RHOHV_LOW_CONFIDENCE_MAX {
                if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB + 0.1 {
                    Some(DualPolEvidence {
                        phase: PHASE_RAIN,
                        confidence: 0.55,
                    })
                } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB - 0.15 {
                    Some(DualPolEvidence {
                        phase: PHASE_SNOW,
                        confidence: 0.55,
                    })
                } else {
                    Some(DualPolEvidence {
                        phase: PHASE_MIXED,
                        confidence: 0.45,
                    })
                }
            } else if rhohv >= PHASE_RHOHV_HIGH_CONFIDENCE_MIN {
                if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB {
                    Some(DualPolEvidence {
                        phase: PHASE_RAIN,
                        confidence: 0.82,
                    })
                } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB {
                    Some(DualPolEvidence {
                        phase: PHASE_SNOW,
                        confidence: 0.82,
                    })
                } else {
                    Some(DualPolEvidence {
                        phase: PHASE_MIXED,
                        confidence: 0.35,
                    })
                }
            } else if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB {
                Some(DualPolEvidence {
                    phase: PHASE_RAIN,
                    confidence: 0.65,
                })
            } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB {
                Some(DualPolEvidence {
                    phase: PHASE_SNOW,
                    confidence: 0.65,
                })
            } else {
                Some(DualPolEvidence {
                    phase: PHASE_MIXED,
                    confidence: 0.55,
                })
            }
        }
        (Some(zdr), None) => {
            if zdr >= PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB + 0.15 {
                Some(DualPolEvidence {
                    phase: PHASE_RAIN,
                    confidence: 0.50,
                })
            } else if zdr <= PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB - 0.2 {
                Some(DualPolEvidence {
                    phase: PHASE_SNOW,
                    confidence: 0.50,
                })
            } else {
                Some(DualPolEvidence {
                    phase: PHASE_MIXED,
                    confidence: 0.30,
                })
            }
        }
        (None, Some(rhohv)) => {
            if rhohv < PHASE_RHOHV_LOW_CONFIDENCE_MAX - 0.02 {
                Some(DualPolEvidence {
                    phase: PHASE_MIXED,
                    confidence: 0.35,
                })
            } else {
                None
            }
        }
        (None, None) => None,
    }
}

#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub fn resolve_thermo_phase(
    voxel_mid_feet: f64,
    precip_flag_value: Option<f32>,
    freezing_level_value: Option<f32>,
    wet_bulb_value: Option<f32>,
    surface_temp_value: Option<f32>,
    bright_band_top_value: Option<f32>,
    bright_band_bottom_value: Option<f32>,
    rqi_value: Option<f32>,
) -> ThermoPhaseEvidence {
    let mut scores = PhaseScores {
        rain: 1.0,
        mixed: 0.7,
        snow: 1.0,
    };
    let mut signal_count = 0_u8;
    let mut near_transition = false;

    let precip_flag_phase = precip_flag_value.and_then(phase_from_precip_flag);
    if let Some(phase) = precip_flag_phase {
        signal_count = signal_count.saturating_add(1);
        match phase {
            PHASE_RAIN => scores.add(PHASE_RAIN, 3.0),
            PHASE_SNOW => scores.add(PHASE_SNOW, 3.2),
            PHASE_MIXED => {
                scores.add(PHASE_MIXED, 1.8);
                scores.add(PHASE_RAIN, 0.8);
            }
            _ => {}
        }
    }

    if let Some(freezing_meters) = freezing_level_value
        .map(|value| value as f64)
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        signal_count = signal_count.saturating_add(1);
        if let Some(phase) = phase_from_freezing_level(voxel_mid_feet, freezing_meters) {
            scores.add(phase, 0.6);
        }
        let freezing_feet = freezing_meters * FEET_PER_METER;
        let delta_feet = voxel_mid_feet - freezing_feet;
        if delta_feet.abs() <= THERMO_NEAR_FREEZING_FEET {
            near_transition = true;
        }

        if delta_feet >= 2_500.0 {
            scores.add(PHASE_SNOW, 2.4);
        } else if delta_feet >= THERMO_NEAR_FREEZING_FEET {
            scores.add(PHASE_SNOW, 1.8);
            scores.add(PHASE_MIXED, 0.5);
        } else if delta_feet <= -2_500.0 {
            scores.add(PHASE_RAIN, 2.4);
        } else if delta_feet <= -THERMO_NEAR_FREEZING_FEET {
            scores.add(PHASE_RAIN, 1.8);
            scores.add(PHASE_MIXED, 0.5);
        } else {
            scores.add(PHASE_MIXED, 1.6);
            if delta_feet >= 0.0 {
                scores.add(PHASE_SNOW, 0.8);
            } else {
                scores.add(PHASE_RAIN, 0.8);
            }
        }
    }

    if let Some(wet_bulb_c) = wet_bulb_value.and_then(normalize_temperature_celsius) {
        signal_count = signal_count.saturating_add(1);
        if wet_bulb_c <= THERMO_STRONG_COLD_WET_BULB_C {
            scores.add(PHASE_SNOW, 2.4);
        } else if wet_bulb_c <= 0.5 {
            near_transition = true;
            scores.add(PHASE_MIXED, 1.1);
            scores.add(PHASE_SNOW, 1.0);
        } else if wet_bulb_c >= THERMO_STRONG_WARM_WET_BULB_C {
            scores.add(PHASE_RAIN, 2.2);
        } else {
            near_transition = true;
            scores.add(PHASE_MIXED, 1.1);
            scores.add(PHASE_RAIN, 1.0);
        }
    }

    if let Some(surface_temp_c) = surface_temp_value.and_then(normalize_temperature_celsius) {
        signal_count = signal_count.saturating_add(1);
        let low_level_weight = ((8_000.0 - voxel_mid_feet).max(0.0) / 8_000.0) as f32;
        if low_level_weight > 0.0 {
            if surface_temp_c <= -0.5 {
                scores.add(PHASE_SNOW, 1.2 * low_level_weight);
            } else if surface_temp_c >= 2.0 {
                scores.add(PHASE_RAIN, 1.2 * low_level_weight);
            } else {
                near_transition = true;
                scores.add(PHASE_MIXED, 0.8 * low_level_weight);
                if surface_temp_c <= 0.5 {
                    scores.add(PHASE_SNOW, 0.4 * low_level_weight);
                } else {
                    scores.add(PHASE_RAIN, 0.4 * low_level_weight);
                }
            }
        }
    }

    if let (Some(top_m), Some(bottom_m)) = (
        bright_band_top_value.and_then(normalize_height_meters),
        bright_band_bottom_value.and_then(normalize_height_meters),
    ) {
        if top_m >= bottom_m {
            signal_count = signal_count.saturating_add(1);
            let top_feet = top_m * FEET_PER_METER;
            let bottom_feet = bottom_m * FEET_PER_METER;
            if voxel_mid_feet >= bottom_feet - 400.0 && voxel_mid_feet <= top_feet + 400.0 {
                near_transition = true;
                scores.add(PHASE_MIXED, 2.0);
            } else if voxel_mid_feet > top_feet + 800.0 {
                scores.add(PHASE_SNOW, 1.2);
            } else if voxel_mid_feet < bottom_feet - 800.0 {
                scores.add(PHASE_RAIN, 1.2);
            }
        }
    }

    let rqi = rqi_value.and_then(normalize_rqi);

    let ranked = rank_phase_scores(scores);
    let best_score = ranked[0].1.max(0.0);
    let second_score = ranked[1].1.max(0.0);
    let confidence = if best_score + second_score > 0.0 {
        (best_score - second_score) / (best_score + second_score)
    } else {
        0.0
    };

    ThermoPhaseEvidence {
        scores,
        phase: ranked[0].0,
        confidence: confidence.clamp(0.0, 1.0),
        signal_count,
        near_transition,
        precip_flag_phase,
        rqi,
    }
}

#[allow(dead_code)]
pub(super) fn resolve_phase_from_evidence(
    thermo: ThermoPhaseEvidence,
    dual: Option<DualPolEvidence>,
    use_aux_fallback: bool,
) -> PhaseResolution {
    let mut scores = thermo.scores;
    let mut used_dual = false;
    let mut suppressed_dual = false;
    let mut suppressed_mixed = false;
    let dual_mixed_support = dual.is_some_and(|sample| {
        sample.phase == PHASE_MIXED && sample.confidence >= MIXED_DUAL_SUPPORT_CONFIDENCE_MIN
    });

    if let Some(dual) = dual {
        let stale_weight = if use_aux_fallback { 0.22 } else { 0.58 };
        let rqi_weight = thermo
            .rqi
            .map(|value| (0.35 + 0.65 * value).clamp(0.25, 1.0))
            .unwrap_or(0.85);
        let mut dual_weight = stale_weight * rqi_weight * dual.confidence;

        if dual.phase == PHASE_MIXED && !thermo.near_transition {
            dual_weight *= 0.55;
        }

        if dual.phase == PHASE_RAIN
            && thermo.phase == PHASE_SNOW
            && thermo.confidence >= 0.35
            && thermo.precip_flag_phase == Some(PHASE_SNOW)
        {
            dual_weight *= 0.2;
        }

        if dual_weight >= 0.08 {
            scores.add(dual.phase, dual_weight * 2.2);
            used_dual = true;
        } else {
            suppressed_dual = true;
        }
    }

    let rain_snow_competing = scores.rain >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
        && scores.snow >= MIXED_COMPETING_RAIN_SNOW_MIN_SCORE
        && (scores.rain - scores.snow).abs() <= MIXED_COMPETING_RAIN_SNOW_DELTA_MAX;
    let rain_snow_promotion = scores.rain >= MIXED_COMPETING_PROMOTION_MIN_SCORE
        && scores.snow >= MIXED_COMPETING_PROMOTION_MIN_SCORE
        && (scores.rain - scores.snow).abs() <= MIXED_COMPETING_RAIN_SNOW_DELTA_MAX;
    if rain_snow_promotion
        && (thermo.near_transition || dual_mixed_support || thermo.signal_count >= 2)
    {
        let rain_snow_peak = scores.rain.max(scores.snow);
        let mixed_gap = rain_snow_peak - scores.mixed;
        if mixed_gap.is_finite()
            && mixed_gap > 0.0
            && mixed_gap <= MIXED_COMPETING_PROMOTION_GAP_MAX
        {
            scores.add(PHASE_MIXED, mixed_gap + MIXED_COMPETING_PROMOTION_MARGIN);
        }
    }

    let ranked = rank_phase_scores(scores);
    let mut phase = ranked[0].0;
    if phase == PHASE_MIXED {
        let best_non_mixed = if ranked[1].0 == PHASE_MIXED {
            ranked[2]
        } else {
            ranked[1]
        };
        let mixed_advantage = ranked[0].1 - best_non_mixed.1;
        let transition_like = thermo.near_transition || rain_snow_competing || dual_mixed_support;
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

    let mut forced_precip_snow = false;
    if thermo.precip_flag_phase == Some(PHASE_SNOW) && phase != PHASE_SNOW {
        if thermo.phase == PHASE_SNOW || thermo.near_transition {
            phase = PHASE_SNOW;
            forced_precip_snow = true;
        }
    }

    PhaseResolution {
        phase,
        used_dual,
        suppressed_dual,
        suppressed_mixed,
        forced_precip_snow,
    }
}

pub(super) fn promote_mixed_transition_edges(
    records: &mut [LevelPhaseVoxel],
    grid_nx: u32,
    grid_ny: u32,
) -> u64 {
    if records.is_empty() || grid_nx == 0 || grid_ny == 0 {
        return 0;
    }

    let mut position_to_index: FxHashMap<u32, usize> =
        FxHashMap::with_capacity_and_hasher(records.len(), Default::default());
    for (idx, record) in records.iter().enumerate() {
        let key = record.row as u32 * grid_nx + record.col as u32;
        position_to_index.insert(key, idx);
    }

    let mut promote_indices = Vec::new();
    for (idx, record) in records.iter().enumerate() {
        if !record.transition_candidate
            || (record.phase != PHASE_RAIN && record.phase != PHASE_SNOW)
        {
            continue;
        }
        let opposite_phase = if record.phase == PHASE_RAIN {
            PHASE_SNOW
        } else {
            PHASE_RAIN
        };

        let row = record.row as i32;
        let col = record.col as i32;
        let mut has_opposite_neighbor = false;
        for row_delta in -1..=1 {
            for col_delta in -1..=1 {
                if row_delta == 0 && col_delta == 0 {
                    continue;
                }
                let neighbor_row = row + row_delta;
                let neighbor_col = col + col_delta;
                if neighbor_row < 0
                    || neighbor_col < 0
                    || neighbor_row >= grid_ny as i32
                    || neighbor_col >= grid_nx as i32
                {
                    continue;
                }

                let key = neighbor_row as u32 * grid_nx + neighbor_col as u32;
                if let Some(neighbor_idx) = position_to_index.get(&key) {
                    if records[*neighbor_idx].phase == opposite_phase {
                        has_opposite_neighbor = true;
                        break;
                    }
                }
            }
            if has_opposite_neighbor {
                break;
            }
        }

        if has_opposite_neighbor {
            promote_indices.push(idx);
        }
    }

    for idx in promote_indices.iter().copied() {
        records[idx].phase = PHASE_MIXED;
    }

    promote_indices.len() as u64
}

fn rank_phase_scores(scores: PhaseScores) -> [(u8, f32); 3] {
    let mut first = (PHASE_RAIN, scores.rain);
    let mut second = (PHASE_MIXED, scores.mixed);
    let mut third = (PHASE_SNOW, scores.snow);

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

fn sanitize_zdr(value: f32) -> Option<f32> {
    if !value.is_finite() || !(PHASE_ZDR_MIN_VALID_DB..=PHASE_ZDR_MAX_VALID_DB).contains(&value) {
        return None;
    }
    Some(value)
}

fn sanitize_rhohv(value: f32) -> Option<f32> {
    if !value.is_finite() || !(PHASE_RHOHV_MIN_VALID..=PHASE_RHOHV_MAX_VALID).contains(&value) {
        return None;
    }
    Some(value)
}

fn phase_from_precip_flag(value: f32) -> Option<u8> {
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

fn phase_from_freezing_level(voxel_mid_feet: f64, freezing_level_meters_msl: f64) -> Option<u8> {
    if !voxel_mid_feet.is_finite() || !freezing_level_meters_msl.is_finite() {
        return None;
    }

    let freezing_level_feet = freezing_level_meters_msl * FEET_PER_METER;
    if !freezing_level_feet.is_finite() || freezing_level_feet <= 0.0 {
        return None;
    }

    if voxel_mid_feet >= freezing_level_feet + FREEZING_LEVEL_TRANSITION_FEET {
        Some(PHASE_SNOW)
    } else if voxel_mid_feet <= freezing_level_feet - FREEZING_LEVEL_TRANSITION_FEET {
        Some(PHASE_RAIN)
    } else {
        Some(PHASE_MIXED)
    }
}

fn normalize_temperature_celsius(value: f32) -> Option<f32> {
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

fn normalize_height_meters(value: f32) -> Option<f64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let mut meters = value as f64;
    if meters < 50.0 {
        meters *= 1000.0;
    }
    if !(100.0..=30_000.0).contains(&meters) {
        return None;
    }
    Some(meters)
}

fn normalize_rqi(value: f32) -> Option<f32> {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolve_dual_pol_evidence_prefers_snow_when_rhohv_high_and_zdr_low() {
        let evidence = resolve_dual_pol_evidence(Some(0.1), Some(0.99)).expect("dual-pol evidence");
        assert_eq!(evidence.phase, PHASE_SNOW);
        assert!(evidence.confidence >= 0.8);
    }

    #[test]
    fn resolve_dual_pol_evidence_keeps_low_rhohv_mixed_confidence_low() {
        let evidence = resolve_dual_pol_evidence(Some(0.4), Some(0.93)).expect("dual-pol evidence");
        assert_eq!(evidence.phase, PHASE_MIXED);
        assert!(evidence.confidence < 0.5);
    }

    #[test]
    fn resolve_dual_pol_evidence_returns_none_for_missing_or_invalid_inputs() {
        assert!(resolve_dual_pol_evidence(None, None).is_none());
        assert!(resolve_dual_pol_evidence(Some(99.0), Some(-1.0)).is_none());
    }

    #[test]
    fn resolve_phase_from_evidence_prefers_thermo_snow_over_weak_dual_mixed() {
        let thermo = ThermoPhaseEvidence {
            scores: PhaseScores {
                rain: 1.0,
                mixed: 1.2,
                snow: 6.0,
            },
            phase: PHASE_SNOW,
            confidence: 0.65,
            signal_count: 3,
            near_transition: false,
            precip_flag_phase: Some(PHASE_SNOW),
            rqi: Some(0.9),
        };
        let dual = Some(DualPolEvidence {
            phase: PHASE_MIXED,
            confidence: 0.45,
        });
        let resolution = resolve_phase_from_evidence(thermo, dual, false);
        assert_eq!(resolution.phase, PHASE_SNOW);
        assert!(resolution.used_dual);
    }

    #[test]
    fn resolve_phase_from_evidence_suppresses_mixed_when_not_near_transition() {
        let thermo = ThermoPhaseEvidence {
            scores: PhaseScores {
                rain: 3.0,
                mixed: 3.2,
                snow: 1.0,
            },
            phase: PHASE_MIXED,
            confidence: 0.03,
            signal_count: 1,
            near_transition: false,
            precip_flag_phase: None,
            rqi: None,
        };
        let resolution = resolve_phase_from_evidence(thermo, None, false);
        assert_eq!(resolution.phase, PHASE_RAIN);
        assert!(resolution.suppressed_mixed);
    }

    #[test]
    fn resolve_phase_from_evidence_keeps_mixed_when_rain_and_snow_compete() {
        let thermo = ThermoPhaseEvidence {
            scores: PhaseScores {
                rain: 2.6,
                mixed: 2.85,
                snow: 2.4,
            },
            phase: PHASE_MIXED,
            confidence: 0.07,
            signal_count: 2,
            near_transition: false,
            precip_flag_phase: None,
            rqi: Some(0.8),
        };
        let resolution = resolve_phase_from_evidence(thermo, None, false);
        assert_eq!(resolution.phase, PHASE_MIXED);
        assert!(!resolution.suppressed_mixed);
    }

    #[test]
    fn resolve_phase_from_evidence_promotes_mixed_when_rain_and_snow_compete() {
        let thermo = ThermoPhaseEvidence {
            scores: PhaseScores {
                rain: 4.1,
                mixed: 3.2,
                snow: 4.0,
            },
            phase: PHASE_RAIN,
            confidence: 0.02,
            signal_count: 3,
            near_transition: false,
            precip_flag_phase: None,
            rqi: Some(0.8),
        };
        let resolution = resolve_phase_from_evidence(thermo, None, false);
        assert_eq!(resolution.phase, PHASE_MIXED);
        assert!(!resolution.suppressed_mixed);
    }

    #[test]
    fn resolve_phase_from_evidence_avoids_mixed_promotion_when_gap_is_large() {
        let thermo = ThermoPhaseEvidence {
            scores: PhaseScores {
                rain: 4.8,
                mixed: 2.6,
                snow: 4.6,
            },
            phase: PHASE_RAIN,
            confidence: 0.03,
            signal_count: 3,
            near_transition: true,
            precip_flag_phase: None,
            rqi: Some(0.85),
        };
        let resolution = resolve_phase_from_evidence(thermo, None, false);
        assert_eq!(resolution.phase, PHASE_RAIN);
    }

    #[test]
    fn promote_mixed_transition_edges_marks_adjacent_rain_and_snow() {
        let mut records = vec![
            LevelPhaseVoxel {
                row: 10,
                col: 10,
                dbz_tenths: 180,
                phase: PHASE_RAIN,
                surface_phase: PHASE_RAIN,
                transition_candidate: true,
            },
            LevelPhaseVoxel {
                row: 10,
                col: 11,
                dbz_tenths: 170,
                phase: PHASE_SNOW,
                surface_phase: PHASE_SNOW,
                transition_candidate: true,
            },
            LevelPhaseVoxel {
                row: 20,
                col: 20,
                dbz_tenths: 160,
                phase: PHASE_SNOW,
                surface_phase: PHASE_SNOW,
                transition_candidate: true,
            },
        ];
        let promoted = promote_mixed_transition_edges(&mut records, 200, 200);
        assert_eq!(promoted, 2);
        assert_eq!(records[0].phase, PHASE_MIXED);
        assert_eq!(records[1].phase, PHASE_MIXED);
        assert_eq!(records[2].phase, PHASE_SNOW);
    }

    #[test]
    fn promote_mixed_transition_edges_skips_non_candidates() {
        let mut records = vec![
            LevelPhaseVoxel {
                row: 15,
                col: 15,
                dbz_tenths: 150,
                phase: PHASE_RAIN,
                surface_phase: PHASE_RAIN,
                transition_candidate: false,
            },
            LevelPhaseVoxel {
                row: 15,
                col: 16,
                dbz_tenths: 150,
                phase: PHASE_SNOW,
                surface_phase: PHASE_SNOW,
                transition_candidate: false,
            },
        ];
        let promoted = promote_mixed_transition_edges(&mut records, 200, 200);
        assert_eq!(promoted, 0);
        assert_eq!(records[0].phase, PHASE_RAIN);
        assert_eq!(records[1].phase, PHASE_SNOW);
    }

    #[test]
    fn rank_phase_scores_orders_descending_and_keeps_tie_order() {
        let scores = PhaseScores {
            rain: 2.0,
            mixed: 2.0,
            snow: 1.0,
        };
        let ranked = rank_phase_scores(scores);
        assert_eq!(ranked[0], (PHASE_RAIN, 2.0));
        assert_eq!(ranked[1], (PHASE_MIXED, 2.0));
        assert_eq!(ranked[2], (PHASE_SNOW, 1.0));
    }

    #[test]
    fn normalize_temperature_celsius_supports_kelvin_inputs() {
        let kelvin = 273.15_f32;
        let normalized = normalize_temperature_celsius(kelvin).expect("temp");
        assert!(normalized.abs() < 0.01);
    }

    #[test]
    fn phase_from_precip_flag_maps_known_codes() {
        assert_eq!(phase_from_precip_flag(3.0), Some(PHASE_SNOW));
        assert_eq!(phase_from_precip_flag(7.0), Some(PHASE_MIXED));
        assert_eq!(phase_from_precip_flag(0.0), None);
    }

    #[test]
    fn phase_from_freezing_level_respects_transition_zone() {
        // 1,000 m MSL ~= 3,281 ft
        assert_eq!(
            phase_from_freezing_level(5_200.0, 1_000.0),
            Some(PHASE_SNOW)
        );
        assert_eq!(
            phase_from_freezing_level(1_200.0, 1_000.0),
            Some(PHASE_RAIN)
        );
    }
}
