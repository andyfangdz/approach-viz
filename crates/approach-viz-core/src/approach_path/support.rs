// Split from the original single-file approach_path module; behavior is
// unchanged. Public API is re-exported from this module root.


use std::collections::HashMap;
use crate::coords;

use super::*;

pub(crate) fn waypoint_map(waypoints: &[ApproachWaypoint]) -> HashMap<String, ApproachWaypoint> {
    waypoints
        .iter()
        .map(|waypoint| (waypoint.id.clone(), waypoint.clone()))
        .collect()
}

pub(crate) fn resolve_waypoint<'a>(
    waypoints: &'a HashMap<String, ApproachWaypoint>,
    waypoint_id: &str,
) -> Option<&'a ApproachWaypoint> {
    if let Some(waypoint) = waypoints.get(waypoint_id) {
        return Some(waypoint);
    }
    waypoint_id
        .rsplit('_')
        .next()
        .and_then(|fallback_id| waypoints.get(fallback_id))
}

pub(crate) fn get_horizontal_distance_nm(
    from_leg: &ApproachPathLeg,
    to_leg: &ApproachPathLeg,
    waypoints: &HashMap<String, ApproachWaypoint>,
    ref_lat: f64,
    ref_lon: f64,
    previous_leg: Option<&ApproachPathLeg>,
    next_leg: Option<&ApproachPathLeg>,
) -> f64 {
    if let Some(distance) = to_leg.distance.filter(|distance| distance.is_finite() && *distance > 0.0)
    {
        return distance;
    }

    let mut start_wp = resolve_waypoint(waypoints, &from_leg.waypoint_id);
    let mut end_wp = resolve_waypoint(waypoints, &to_leg.waypoint_id);
    let previous_wp = previous_leg.and_then(|leg| resolve_waypoint(waypoints, &leg.waypoint_id));
    let next_wp = next_leg.and_then(|leg| resolve_waypoint(waypoints, &leg.waypoint_id));

    if start_wp.is_none() && end_wp.is_some() && previous_wp.is_some() {
        start_wp = previous_wp;
    }
    if start_wp.is_some() && end_wp.is_none() && next_wp.is_some() {
        end_wp = next_wp;
    }
    if start_wp.is_none() && end_wp.is_none() && previous_wp.is_some() && next_wp.is_some() {
        start_wp = previous_wp;
        end_wp = next_wp;
    }

    let Some(start_wp) = start_wp else {
        return 1.0;
    };
    let Some(end_wp) = end_wp else {
        return 1.0;
    };

    let (from_x, from_z) = coords::lat_lon_to_local(start_wp.lat, start_wp.lon, ref_lat, ref_lon);
    let (to_x, to_z) = coords::lat_lon_to_local(end_wp.lat, end_wp.lon, ref_lat, ref_lon);
    let distance = ((to_x - from_x).powi(2) + (to_z - from_z).powi(2)).sqrt();
    if distance > 1e-4 { distance } else { 1.0 }
}


pub(crate) fn is_fix_join_terminator(path_terminator: Option<&str>) -> bool {
    matches!(path_terminator, Some("DF" | "CF" | "TF"))
}

pub(crate) fn is_no_fix_heading_leg(path_terminator: &str) -> bool {
    matches!(path_terminator, "VI" | "VA" | "VR" | "VD" | "VM" | "CI" | "CD")
}

/// Course-from-a-fix legs originate at a named fix and proceed outbound along a
/// published course until reaching an altitude (`FA`), a distance (`FC`), a DME
/// distance (`FD`), or a manual/vector termination (`FM`). They form the
/// outbound leg of a teardrop/course-reversal (paired with a downstream `CI`),
/// so they must be drawn as an outbound segment from the fix rather than
/// collapsing back onto the fix waypoint.
pub(crate) fn is_course_from_fix_leg(path_terminator: &str) -> bool {
    matches!(path_terminator, "FA" | "FC" | "FD" | "FM")
}

pub(crate) fn push_point(points: &mut Vec<Vec3>, point: Vec3) {
    if points
        .last()
        .is_none_or(|previous| previous.distance_sq(point) > 1e-8)
    {
        points.push(point);
    }
}

pub(crate) fn segment_heading_true(from: Vec3, to: Vec3) -> f64 {
    coords::normalize_heading((to.x - from.x).atan2(-(to.z - from.z)).to_degrees())
}

