// Scene composition: FAF/localizer roll-out append, final-through-MAP, and
// hold listing. Path sampling stays in `geometry`; this only decides which
// legs each renderer segment receives.

use super::*;

pub fn compose_approach_scene(params: ComposeApproachSceneParams) -> ComposedApproachScene {
    let waypoints = waypoint_map(&params.waypoints);
    let inbound = params
        .final_legs
        .iter()
        .find(|leg| leg.course.filter(|course| course.is_finite()).is_some())
        .cloned();

    let mut segments = Vec::new();
    let mut hold_legs = Vec::new();

    collect_holds(
        &params.final_legs,
        &params.final_altitudes,
        params.airport_elevation,
        &mut hold_legs,
    );

    for transition in &params.transition_entries {
        let altitudes = altitudes_for_named(&transition.name, &params.transition_altitudes);
        collect_holds(
            &transition.legs,
            &altitudes,
            params.airport_elevation,
            &mut hold_legs,
        );
        let (legs, resolved_altitudes) =
            append_roll_out_join(&transition.legs, &altitudes, inbound.as_ref());
        if legs.is_empty() {
            continue;
        }
        segments.push(ComposedPathSegment {
            kind: APPROACH_SCENE_SEGMENT_TRANSITION.to_string(),
            name: Some(transition.name.clone()),
            legs,
            resolved_altitudes,
            show_turn_constraint_labels: false,
        });
    }

    collect_holds(
        &params.missed_legs,
        &params.missed_altitudes,
        params.airport_elevation,
        &mut hold_legs,
    );

    let (final_legs, final_altitudes) = extend_final_through_map(
        &params.final_legs,
        &params.final_altitudes,
        &params.missed_legs,
        &params.missed_altitudes,
        &waypoints,
    );
    if !final_legs.is_empty() {
        segments.push(ComposedPathSegment {
            kind: APPROACH_SCENE_SEGMENT_FINAL.to_string(),
            name: None,
            legs: final_legs,
            resolved_altitudes: final_altitudes,
            show_turn_constraint_labels: false,
        });
    }

    if !params.missed_legs.is_empty() {
        let missed_len = params.missed_legs.len();
        segments.push(ComposedPathSegment {
            kind: APPROACH_SCENE_SEGMENT_MISSED.to_string(),
            name: None,
            legs: params.missed_legs,
            resolved_altitudes: altitudes_aligned(missed_len, &params.missed_path_altitudes),
            show_turn_constraint_labels: true,
        });
    }

    ComposedApproachScene {
        segments,
        hold_legs,
    }
}

fn is_roll_out_terminator(path_terminator: &str) -> bool {
    matches!(path_terminator, "CI" | "VI" | "AF" | "RF")
}

fn is_hold_terminator(path_terminator: &str) -> bool {
    matches!(path_terminator, "HM" | "HF" | "HA")
}

fn altitudes_aligned(len: usize, altitudes: &[f64]) -> Vec<f64> {
    (0..len)
        .map(|index| altitudes.get(index).copied().unwrap_or(0.0))
        .collect()
}

fn altitudes_for_named(name: &str, results: &[TransitionAltitudeResult]) -> Vec<f64> {
    results
        .iter()
        .find(|result| result.name == name)
        .map(|result| result.altitudes.clone())
        .unwrap_or_default()
}

fn append_roll_out_join(
    legs: &[ApproachPathLeg],
    altitudes: &[f64],
    inbound: Option<&ApproachPathLeg>,
) -> (Vec<ApproachPathLeg>, Vec<f64>) {
    let mut out_legs = legs.to_vec();
    let mut out_altitudes = altitudes_aligned(legs.len(), altitudes);
    let Some(last) = legs.last() else {
        return (out_legs, out_altitudes);
    };
    if !is_roll_out_terminator(&last.path_terminator) {
        return (out_legs, out_altitudes);
    }
    let Some(inbound) = inbound else {
        return (out_legs, out_altitudes);
    };
    let mut join = inbound.clone();
    join.is_missed_approach = false;
    out_altitudes.push(
        join.altitude
            .filter(|altitude| altitude.is_finite())
            .unwrap_or(0.0),
    );
    out_legs.push(join);
    (out_legs, out_altitudes)
}

fn extend_final_through_map(
    final_legs: &[ApproachPathLeg],
    final_altitudes: &[f64],
    missed_legs: &[ApproachPathLeg],
    missed_altitudes: &[f64],
    waypoints: &std::collections::HashMap<String, ApproachWaypoint>,
) -> (Vec<ApproachPathLeg>, Vec<f64>) {
    let mut legs = final_legs.to_vec();
    let mut altitudes = altitudes_aligned(final_legs.len(), final_altitudes);
    if legs.is_empty() {
        return (legs, altitudes);
    }
    let Some(map_leg) = missed_legs.first() else {
        return (legs, altitudes);
    };
    if resolve_waypoint(waypoints, &map_leg.waypoint_id).is_none() {
        return (legs, altitudes);
    }
    legs.push(map_leg.clone());
    altitudes.push(missed_altitudes.first().copied().unwrap_or(0.0));
    (legs, altitudes)
}

fn collect_holds(
    legs: &[ApproachPathLeg],
    altitudes: &[f64],
    airport_elevation: f64,
    out: &mut Vec<ComposedHoldLeg>,
) {
    for (index, leg) in legs.iter().enumerate() {
        if !is_hold_terminator(&leg.path_terminator) {
            continue;
        }
        let altitude_feet = altitudes
            .get(index)
            .copied()
            .or(leg.altitude)
            .filter(|altitude| altitude.is_finite())
            .unwrap_or(airport_elevation);
        out.push(ComposedHoldLeg {
            leg: leg.clone(),
            altitude_feet,
        });
    }
}
