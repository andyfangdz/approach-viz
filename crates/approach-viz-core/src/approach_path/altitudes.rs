// Split from the original single-file approach_path module; behavior is
// unchanged. Public API is re-exported from this module root.


use std::collections::HashMap;

use super::*;

pub fn resolve_approach_altitudes(
    params: ResolveApproachAltitudesParams,
) -> ApproachAltitudeResult {
    let waypoints = waypoint_map(&params.waypoints);

    let final_base =
        resolve_segment_altitudes(&params.final_legs, &waypoints, params.ref_lat, params.ref_lon);
    let transition_altitudes = params
        .transition_entries
        .iter()
        .map(|entry| TransitionAltitudeResult {
            name: entry.name.clone(),
            altitudes: resolve_segment_altitudes(
                &entry.legs,
                &waypoints,
                params.ref_lat,
                params.ref_lon,
            ),
        })
        .collect::<Vec<_>>();
    let missed_base =
        resolve_segment_altitudes(&params.missed_legs, &waypoints, params.ref_lat, params.ref_lon);

    let (final_altitudes, missed_altitudes) = apply_glidepath_inside_faf(
        &params.final_legs,
        &params.missed_legs,
        &final_base,
        &missed_base,
        &waypoints,
        params.ref_lat,
        params.ref_lon,
        params.airport_elevation,
    );

    let missed_path_altitudes = resolve_missed_approach_altitudes(
        &params.missed_legs,
        &missed_altitudes,
        &waypoints,
        params.ref_lat,
        params.ref_lon,
        params.missed_approach_start_altitude_feet,
        params.missed_approach_climb_requirement.as_ref(),
    );

    ApproachAltitudeResult {
        final_altitudes,
        transition_altitudes,
        missed_altitudes,
        missed_path_altitudes,
    }
}

pub(crate) fn resolve_segment_altitudes(
    legs: &[ApproachPathLeg],
    waypoints: &HashMap<String, ApproachWaypoint>,
    ref_lat: f64,
    ref_lon: f64,
) -> Vec<f64> {
    let mut altitudes = vec![0.0; legs.len()];
    let mut known_indices = Vec::new();

    for (index, leg) in legs.iter().enumerate() {
        if let Some(altitude) = leg.altitude.filter(|alt| *alt > 0.0) {
            altitudes[index] = altitude;
            known_indices.push(index);
        }
    }

    if known_indices.is_empty() {
        return altitudes;
    }

    let first_known_index = known_indices[0];
    let first_known_altitude = altitudes[first_known_index];
    for altitude in &mut altitudes[..first_known_index] {
        *altitude = first_known_altitude;
    }

    for pair in known_indices.windows(2) {
        let start_index = pair[0];
        let end_index = pair[1];
        let start_altitude = altitudes[start_index];
        let end_altitude = altitudes[end_index];
        if end_index - start_index <= 1 {
            continue;
        }

        let mut distance_from_start = vec![0.0; legs.len()];
        let mut cumulative_distance = 0.0;
        for index in (start_index + 1)..=end_index {
            cumulative_distance += get_horizontal_distance_nm(
                &legs[index - 1],
                &legs[index],
                waypoints,
                ref_lat,
                ref_lon,
                if index >= 2 { Some(&legs[index - 2]) } else { None },
                legs.get(index + 1),
            );
            distance_from_start[index] = cumulative_distance;
        }

        let total_distance = distance_from_start[end_index];
        for index in (start_index + 1)..end_index {
            let fallback_fraction = (index - start_index) as f64 / (end_index - start_index) as f64;
            let fraction = if total_distance > 1e-4 {
                distance_from_start[index] / total_distance
            } else {
                fallback_fraction
            };
            altitudes[index] = start_altitude + (end_altitude - start_altitude) * fraction;
        }
    }

    let last_known_index = *known_indices.last().unwrap();
    let last_known_altitude = altitudes[last_known_index];
    for altitude in &mut altitudes[(last_known_index + 1)..] {
        *altitude = last_known_altitude;
    }

    altitudes
}

pub(crate) fn apply_glidepath_inside_faf(
    final_legs: &[ApproachPathLeg],
    missed_legs: &[ApproachPathLeg],
    final_base_altitudes: &[f64],
    missed_base_altitudes: &[f64],
    waypoints: &HashMap<String, ApproachWaypoint>,
    ref_lat: f64,
    ref_lon: f64,
    tdze_feet: f64,
) -> (Vec<f64>, Vec<f64>) {
    let mut adjusted_final = final_base_altitudes.to_vec();
    let mut adjusted_missed = missed_base_altitudes.to_vec();
    if final_legs.is_empty() || missed_legs.is_empty() {
        return (adjusted_final, adjusted_missed);
    }

    let map_leg = &missed_legs[0];
    if resolve_waypoint(waypoints, &map_leg.waypoint_id).is_none() {
        return (adjusted_final, adjusted_missed);
    }

    let Some(faf_index) = final_legs.iter().enumerate().find_map(|(index, leg)| {
        let altitude = adjusted_final[index];
        if leg.is_final_approach_fix && altitude > 0.0 {
            Some(index)
        } else {
            None
        }
    }) else {
        return (adjusted_final, adjusted_missed);
    };

    let faf_leg = &final_legs[faf_index];
    let Some(vertical_angle_deg) =
        faf_leg.vertical_angle_deg.filter(|angle| angle.is_finite() && *angle > 0.0)
    else {
        return (adjusted_final, adjusted_missed);
    };

    let faf_altitude = adjusted_final[faf_index];
    if faf_altitude <= 0.0 {
        return (adjusted_final, adjusted_missed);
    }

    let glide_leg_count = final_legs.len() - faf_index + 1;
    let mut distance_to_threshold = vec![0.0; glide_leg_count];
    let mut cumulative_distance = 0.0;
    for reverse_index in (0..(glide_leg_count - 1)).rev() {
        let from_leg = if reverse_index + faf_index < final_legs.len() {
            &final_legs[reverse_index + faf_index]
        } else {
            map_leg
        };
        let to_leg = if reverse_index + faf_index + 1 < final_legs.len() {
            &final_legs[reverse_index + faf_index + 1]
        } else {
            map_leg
        };
        let previous_leg = if reverse_index + faf_index >= 1 {
            Some(&final_legs[reverse_index + faf_index - 1])
        } else {
            None
        };
        let next_leg = if reverse_index + faf_index + 2 < final_legs.len() {
            Some(&final_legs[reverse_index + faf_index + 2])
        } else {
            None
        };
        cumulative_distance +=
            get_horizontal_distance_nm(from_leg, to_leg, waypoints, ref_lat, ref_lon, previous_leg, next_leg);
        distance_to_threshold[reverse_index] = cumulative_distance;
    }

    let gradient_feet_per_nm = (vertical_angle_deg.to_radians()).tan() * 6076.12;
    let map_altitude = map_leg.altitude.filter(|altitude| altitude.is_finite() && *altitude > 0.0);
    let threshold_crossing_altitude = if let Some(map_altitude) = map_altitude {
        map_altitude
    } else {
        let faf_distance_to_threshold = distance_to_threshold[0];
        faf_altitude - gradient_feet_per_nm * faf_distance_to_threshold
    };
    if !threshold_crossing_altitude.is_finite() {
        return (adjusted_final, adjusted_missed);
    }

    let tch_feet = (threshold_crossing_altitude - tdze_feet).max(0.0);
    let reference_threshold_altitude = tdze_feet + tch_feet;
    let candidate_altitudes = (0..glide_leg_count)
        .map(|index| reference_threshold_altitude + gradient_feet_per_nm * distance_to_threshold[index])
        .collect::<Vec<_>>();

    let glidepath_climbs_after_faf = candidate_altitudes
        .get(1)
        .copied()
        .is_some_and(|altitude| altitude > faf_altitude + 50.0);
    if glidepath_climbs_after_faf {
        if let Some(map_altitude) = map_altitude {
            let faf_distance_to_threshold = distance_to_threshold[0];
            if faf_distance_to_threshold > 1e-4 {
                for glide_index in 1..glide_leg_count {
                    let leg_distance_to_threshold = distance_to_threshold[glide_index];
                    let fraction =
                        ((faf_distance_to_threshold - leg_distance_to_threshold) / faf_distance_to_threshold)
                            .clamp(0.0, 1.0);
                    let resolved_altitude =
                        faf_altitude + (map_altitude - faf_altitude) * fraction;
                    if glide_index < final_legs.len() - faf_index {
                        adjusted_final[faf_index + glide_index] = resolved_altitude;
                    } else if !adjusted_missed.is_empty() {
                        adjusted_missed[0] = resolved_altitude;
                    }
                }
            }
            return (adjusted_final, adjusted_missed);
        }
    }

    for glide_index in 1..glide_leg_count {
        let resolved_altitude = candidate_altitudes[glide_index];
        if glide_index < final_legs.len() - faf_index {
            adjusted_final[faf_index + glide_index] = resolved_altitude;
        } else if !adjusted_missed.is_empty() {
            adjusted_missed[0] = resolved_altitude;
        }
    }

    (adjusted_final, adjusted_missed)
}

pub(crate) fn resolve_missed_approach_altitudes(
    missed_legs: &[ApproachPathLeg],
    base_altitudes: &[f64],
    waypoints: &HashMap<String, ApproachWaypoint>,
    ref_lat: f64,
    ref_lon: f64,
    start_altitude_feet: Option<f64>,
    missed_approach_climb_requirement: Option<&ApproachPathMissedApproachClimbRequirement>,
) -> Vec<f64> {
    let mut adjusted = base_altitudes.to_vec();
    if missed_legs.is_empty() {
        return adjusted;
    }

    let fallback_start_altitude = base_altitudes
        .first()
        .copied()
        .filter(|altitude| altitude.is_finite() && *altitude > 0.0)
        .or_else(|| missed_legs[0].altitude);
    let Some(computed_start_altitude) = start_altitude_feet
        .filter(|altitude| altitude.is_finite() && *altitude > 0.0)
        .or(fallback_start_altitude)
    else {
        return adjusted;
    };

    let mut provisional_altitudes = vec![computed_start_altitude; missed_legs.len()];
    for index in 1..missed_legs.len() {
        if let Some(published_altitude) = missed_legs[index]
            .altitude
            .filter(|altitude| altitude.is_finite() && *altitude > 0.0)
        {
            provisional_altitudes[index] = provisional_altitudes[index - 1].max(published_altitude);
        } else {
            provisional_altitudes[index] = provisional_altitudes[index - 1];
        }
    }

    let mut cumulative_distance_nm = vec![0.0; missed_legs.len()];
    let mut cumulative_distance = 0.0;
    for index in 1..missed_legs.len() {
        let leg = &missed_legs[index];
        let previous_leg = &missed_legs[index - 1];
        let leg_wp = resolve_waypoint(waypoints, &leg.waypoint_id);
        let mut segment_distance = get_horizontal_distance_nm(
            previous_leg,
            leg,
            waypoints,
            ref_lat,
            ref_lon,
            if index >= 2 { Some(&missed_legs[index - 2]) } else { None },
            missed_legs.get(index + 1),
        );
        if leg.path_terminator == "CA" && leg_wp.is_none() {
            let climb_delta_feet = provisional_altitudes[index] - provisional_altitudes[index - 1];
            segment_distance = if climb_delta_feet > 0.0 {
                (climb_delta_feet / 200.0).clamp(0.2, 3.0)
            } else {
                0.15
            };
        }
        cumulative_distance += segment_distance;
        cumulative_distance_nm[index] = cumulative_distance;
    }

    let climb_requirement_feet_per_nm = missed_approach_climb_requirement
        .map(|requirement| requirement.feet_per_nm)
        .filter(|value| value.is_finite() && *value > 0.0);
    let climb_requirement_target_altitude_feet = missed_approach_climb_requirement
        .and_then(|requirement| requirement.target_altitude_feet)
        .filter(|value| value.is_finite() && *value > computed_start_altitude);

    let mut anchors = vec![(0usize, computed_start_altitude)];
    for (index, leg) in missed_legs.iter().enumerate().skip(1) {
        if let Some(published_altitude) = leg.altitude.filter(|altitude| altitude.is_finite() && *altitude > 0.0) {
            if published_altitude > anchors.last().unwrap().1 {
                anchors.push((index, published_altitude));
            }
        }
    }

    let mut profile = vec![computed_start_altitude; missed_legs.len()];
    if anchors.len() == 1 {
        for index in 1..missed_legs.len() {
            profile[index] =
                computed_start_altitude + cumulative_distance_nm[index] * MISSED_DEFAULT_CLIMB_FT_PER_NM;
        }
    } else {
        for pair in anchors.windows(2) {
            let (from_index, from_altitude) = pair[0];
            let (to_index, to_altitude) = pair[1];
            let from_distance = cumulative_distance_nm[from_index];
            let to_distance = cumulative_distance_nm[to_index];
            let span_distance = (to_distance - from_distance).max(1e-4);
            for index in from_index..=to_index {
                let fraction = ((cumulative_distance_nm[index] - from_distance) / span_distance).clamp(0.0, 1.0);
                profile[index] = from_altitude + (to_altitude - from_altitude) * fraction;
            }
        }
        let (last_anchor_index, last_anchor_altitude) = *anchors.last().unwrap();
        for index in (last_anchor_index + 1)..missed_legs.len() {
            profile[index] =
                last_anchor_altitude + (cumulative_distance_nm[index] - cumulative_distance_nm[last_anchor_index]) * MISSED_DEFAULT_CLIMB_FT_PER_NM;
        }
    }

    if let Some(climb_requirement_feet_per_nm) = climb_requirement_feet_per_nm {
        for index in 1..missed_legs.len() {
            let requirement_altitude =
                computed_start_altitude + cumulative_distance_nm[index] * climb_requirement_feet_per_nm;
            if let Some(target_altitude_feet) = climb_requirement_target_altitude_feet {
                profile[index] = profile[index].max(requirement_altitude.min(target_altitude_feet));
            } else {
                profile[index] = profile[index].max(requirement_altitude);
            }
        }
    }

    for (index, altitude) in profile.into_iter().enumerate() {
        adjusted[index] = altitude.max(adjusted[index]);
    }
    adjusted
}

