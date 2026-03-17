use crate::coords;
use std::collections::HashMap;
use std::f64::consts::PI;

const MISSED_DEFAULT_CLIMB_FT_PER_NM: f64 = 200.0;
const MIN_TURN_RADIUS_NM: f64 = 0.45;
const MAX_COURSE_TO_FIX_TURN_ARC_RAD: f64 = (225.0 * PI) / 180.0;
const EXPLICIT_TURN_DIRECTION_SCORE_BIAS: f64 = 0.35;
const INFERRED_TURN_DIRECTION_SCORE_BIAS: f64 = 0.1;
const MIN_HEADING_TRANSITION_DELTA_DEG: f64 = 6.0;
const MAX_HEADING_TRANSITION_DELTA_DEG: f64 = 210.0;
const MIN_VI_TURN_RADIUS_NM: f64 = 0.55;
const MAX_VI_TURN_RADIUS_NM: f64 = 0.9;

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ApproachWaypoint {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[cfg_attr(feature = "wasm", serde(rename = "type"))]
    pub waypoint_type: String,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ApproachPathLeg {
    pub sequence: i32,
    pub waypoint_id: String,
    pub waypoint_name: String,
    pub path_terminator: String,
    pub altitude: Option<f64>,
    pub altitude_constraint: Option<String>,
    pub course: Option<f64>,
    pub distance: Option<f64>,
    pub hold_course: Option<f64>,
    pub hold_distance: Option<f64>,
    pub turn_direction: Option<String>,
    pub hold_turn_direction: Option<String>,
    pub rf_center_waypoint_id: Option<String>,
    pub rf_turn_direction: Option<String>,
    pub vertical_angle_deg: Option<f64>,
    pub rnp_service_levels: Option<Vec<f64>>,
    pub is_final_approach_fix: bool,
    pub is_initial_fix: bool,
    pub is_final_fix: bool,
    pub is_missed_approach: bool,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct TransitionLegs {
    pub name: String,
    pub legs: Vec<ApproachPathLeg>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ApproachPathMissedApproachClimbRequirement {
    pub feet_per_nm: f64,
    pub target_altitude_feet: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct Point3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct VerticalLine {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct TurnConstraintLabel {
    pub position: Point3,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct PathGeometryResult {
    pub points: Vec<Point3>,
    pub vertical_lines: Vec<VerticalLine>,
    pub turn_constraint_labels: Vec<TurnConstraintLabel>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct TransitionAltitudeResult {
    pub name: String,
    pub altitudes: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ApproachAltitudeResult {
    pub final_altitudes: Vec<f64>,
    pub transition_altitudes: Vec<TransitionAltitudeResult>,
    pub missed_altitudes: Vec<f64>,
    pub missed_path_altitudes: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ResolveApproachAltitudesParams {
    pub final_legs: Vec<ApproachPathLeg>,
    pub transition_entries: Vec<TransitionLegs>,
    pub missed_legs: Vec<ApproachPathLeg>,
    pub waypoints: Vec<ApproachWaypoint>,
    pub ref_lat: f64,
    pub ref_lon: f64,
    pub airport_elevation: f64,
    pub missed_approach_start_altitude_feet: Option<f64>,
    pub missed_approach_climb_requirement: Option<ApproachPathMissedApproachClimbRequirement>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct BuildPathGeometryParams {
    pub legs: Vec<ApproachPathLeg>,
    pub waypoints: Vec<ApproachWaypoint>,
    pub resolved_altitudes: Vec<f64>,
    pub initial_altitude_feet: f64,
    pub vertical_scale: f64,
    pub ref_lat: f64,
    pub ref_lon: f64,
    pub mag_var: f64,
    pub show_turn_constraint_labels: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Vec2 {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Vec3 {
    x: f64,
    y: f64,
    z: f64,
}

impl Vec2 {
    fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    fn add(self, other: Vec2) -> Self {
        Self::new(self.x + other.x, self.y + other.y)
    }

    fn sub(self, other: Vec2) -> Self {
        Self::new(self.x - other.x, self.y - other.y)
    }

    fn scale(self, scalar: f64) -> Self {
        Self::new(self.x * scalar, self.y * scalar)
    }

    fn dot(self, other: Vec2) -> f64 {
        self.x * other.x + self.y * other.y
    }

    fn len(self) -> f64 {
        self.dot(self).sqrt()
    }

    fn normalize(self) -> Self {
        let len = self.len();
        if len <= 1e-9 {
            self
        } else {
            self.scale(1.0 / len)
        }
    }

    fn distance_sq(self, other: Vec2) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }
}

impl Vec3 {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    fn to_point(self) -> Point3 {
        Point3 {
            x: self.x,
            y: self.y,
            z: self.z,
        }
    }

    fn distance_sq(self, other: Vec3) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        let dz = self.z - other.z;
        dx * dx + dy * dy + dz * dz
    }
}

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

pub fn build_path_geometry(params: BuildPathGeometryParams) -> PathGeometryResult {
    let waypoints = waypoint_map(&params.waypoints);
    let resolved_altitudes = params
        .legs
        .iter()
        .enumerate()
        .map(|(index, leg)| {
            params
                .resolved_altitudes
                .get(index)
                .copied()
                .or(leg.altitude)
                .unwrap_or(0.0)
        })
        .collect::<Vec<_>>();

    build_path_geometry_internal(
        &params.legs,
        &waypoints,
        &resolved_altitudes,
        params.initial_altitude_feet,
        params.vertical_scale,
        params.ref_lat,
        params.ref_lon,
        params.mag_var,
        params.show_turn_constraint_labels,
    )
}

pub fn build_hold_geometry(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    hold_distance_nm: f64,
    altitude_feet: f64,
    turn_direction: &str,
    vertical_scale: f64,
) -> Vec<Point3> {
    build_hold_points(
        Vec2::new(center_x, center_z),
        heading_deg,
        hold_distance_nm,
        altitude_feet,
        turn_direction,
        vertical_scale,
    )
}

fn waypoint_map(waypoints: &[ApproachWaypoint]) -> HashMap<String, ApproachWaypoint> {
    waypoints
        .iter()
        .map(|waypoint| (waypoint.id.clone(), waypoint.clone()))
        .collect()
}

fn resolve_waypoint<'a>(
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

fn get_horizontal_distance_nm(
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

fn resolve_segment_altitudes(
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

fn apply_glidepath_inside_faf(
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

fn resolve_missed_approach_altitudes(
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

fn build_path_geometry_internal(
    legs: &[ApproachPathLeg],
    waypoints: &HashMap<String, ApproachWaypoint>,
    resolved_altitudes: &[f64],
    initial_altitude_feet: f64,
    vertical_scale: f64,
    ref_lat: f64,
    ref_lon: f64,
    mag_var: f64,
    show_turn_constraint_labels: bool,
) -> PathGeometryResult {
    let mut points = Vec::<Vec3>::new();
    let mut vertical_lines = Vec::<VerticalLine>::new();
    let mut turn_constraint_labels = Vec::<TurnConstraintLabel>::new();
    let mut last_plotted_altitude_feet = initial_altitude_feet;
    let mut pending_course_to_fix_turn_heading: Option<f64> = None;
    let mut pending_course_to_fix_turn_direction: Option<String> = None;
    let mut pending_course_to_fix_prefers_course_intercept = false;
    let mut last_leg_course_heading_true: Option<f64> = None;

    for (leg_index, leg) in legs.iter().enumerate() {
        let resolved_altitude = resolved_altitudes
            .get(leg_index)
            .copied()
            .or(leg.altitude)
            .unwrap_or(0.0);
        if resolved_altitude <= 0.0 {
            continue;
        }
        let y = coords::alt_to_y(resolved_altitude, vertical_scale);
        let waypoint = resolve_waypoint(waypoints, &leg.waypoint_id);
        let mut current_point: Option<Vec3> = None;
        let mut heading_transition_points: Option<Vec<Vec3>> = None;

        if let Some(waypoint) = waypoint {
            let (x, z) = coords::lat_lon_to_local(waypoint.lat, waypoint.lon, ref_lat, ref_lon);
            current_point = Some(Vec3::new(x, y, z));
            last_leg_course_heading_true = leg
                .course
                .filter(|course| course.is_finite())
                .map(|course| coords::magnetic_to_true_heading(course, mag_var));
        } else if leg.path_terminator == "CA"
            && !points.is_empty()
            && leg.course.is_some_and(|course| course.is_finite())
        {
            let heading_true = coords::magnetic_to_true_heading(leg.course.unwrap(), mag_var);
            let heading_rad = heading_true.to_radians();
            let last_plotted_point = *points.last().unwrap();
            let climb_delta_feet = resolved_altitude - last_plotted_altitude_feet;
            let climb_distance_nm = if climb_delta_feet > 0.0 {
                climb_delta_feet / 200.0
            } else {
                0.0
            };
            let next_leg = legs.get(leg_index + 1);
            let next_wp = next_leg.and_then(|next_leg| resolve_waypoint(waypoints, &next_leg.waypoint_id));
            let published_turn_altitude =
                leg.altitude.filter(|altitude| altitude.is_finite() && *altitude > 0.0);
            let effective_turn_constraint_altitude =
                published_turn_altitude.filter(|altitude| *altitude > last_plotted_altitude_feet + 25.0);

            if is_fix_join_terminator(next_leg.map(|leg| leg.path_terminator.as_str()))
                && next_wp.is_some()
                && next_leg.and_then(|leg| leg.turn_direction.as_ref()).is_some()
                && climb_delta_feet <= 50.0
            {
                if show_turn_constraint_labels {
                    if let Some(altitude) = effective_turn_constraint_altitude {
                        turn_constraint_labels.push(TurnConstraintLabel {
                            position: Point3 {
                                x: last_plotted_point.x,
                                y: y + 0.45,
                                z: last_plotted_point.z,
                            },
                            text: format!("{}'", altitude.round() as i64),
                        });
                    }
                }
                pending_course_to_fix_turn_heading = Some(heading_true);
                pending_course_to_fix_turn_direction =
                    next_leg.and_then(|leg| leg.turn_direction.clone());
                pending_course_to_fix_prefers_course_intercept = false;
                last_leg_course_heading_true = Some(heading_true);
                last_plotted_altitude_feet = resolved_altitude;
                continue;
            }

            let mut distance_nm = if climb_delta_feet > 0.0 {
                climb_distance_nm.clamp(0.3, 8.0)
            } else {
                0.2
            };
            if let Some(next_wp) = next_wp {
                let (next_x, next_z) =
                    coords::lat_lon_to_local(next_wp.lat, next_wp.lon, ref_lat, ref_lon);
                let distance_to_next_fix =
                    ((next_x - last_plotted_point.x).powi(2) + (next_z - last_plotted_point.z).powi(2))
                        .sqrt();
                if distance_to_next_fix > 1e-4 {
                    let next_fix_cap_nm = if climb_delta_feet > 0.0 {
                        (distance_to_next_fix * 0.8).max(0.5)
                    } else {
                        (distance_to_next_fix * 0.05).max(0.1)
                    };
                    distance_nm = distance_nm.min(next_fix_cap_nm);
                }
            }
            let point = Vec3::new(
                last_plotted_point.x + heading_rad.sin() * distance_nm,
                y,
                last_plotted_point.z - heading_rad.cos() * distance_nm,
            );
            current_point = Some(point);
            if is_fix_join_terminator(next_leg.map(|leg| leg.path_terminator.as_str()))
                && next_wp.is_some()
                && next_leg.and_then(|leg| leg.turn_direction.as_ref()).is_some()
            {
                pending_course_to_fix_turn_heading = Some(heading_true);
                pending_course_to_fix_turn_direction =
                    next_leg.and_then(|leg| leg.turn_direction.clone());
                pending_course_to_fix_prefers_course_intercept = false;
                if show_turn_constraint_labels {
                    if let Some(altitude) = effective_turn_constraint_altitude {
                        turn_constraint_labels.push(TurnConstraintLabel {
                            position: Point3 {
                                x: point.x,
                                y: point.y + 0.45,
                                z: point.z,
                            },
                            text: format!("{}'", altitude.round() as i64),
                        });
                    }
                }
            }
            last_leg_course_heading_true = Some(heading_true);
        } else if is_no_fix_heading_leg(&leg.path_terminator)
            && !points.is_empty()
            && leg.course.is_some_and(|course| course.is_finite())
        {
            let heading_true = coords::magnetic_to_true_heading(leg.course.unwrap(), mag_var);
            let heading_rad = heading_true.to_radians();
            let last_plotted_point = *points.last().unwrap();
            let next_leg = legs.get(leg_index + 1);
            let next_wp = next_leg.and_then(|next_leg| resolve_waypoint(waypoints, &next_leg.waypoint_id));
            let mut distance_nm = 0.45;
            if matches!(leg.path_terminator.as_str(), "CD" | "VD")
                && leg.distance.is_some_and(|distance| distance.is_finite() && distance > 0.0)
            {
                distance_nm = (leg.distance.unwrap() * 0.1).max(0.35).min(2.5).max(distance_nm);
            }
            if let Some(next_wp) = next_wp {
                let (next_x, next_z) =
                    coords::lat_lon_to_local(next_wp.lat, next_wp.lon, ref_lat, ref_lon);
                let distance_to_next_fix =
                    ((next_x - last_plotted_point.x).powi(2) + (next_z - last_plotted_point.z).powi(2))
                        .sqrt();
                if distance_to_next_fix > 1e-4 {
                    distance_nm = (distance_to_next_fix * 0.18).clamp(0.25, 1.2);
                }
            }

            if let Some(last_leg_course_heading_true) = last_leg_course_heading_true {
                let vi_turn_radius = (distance_nm * 0.9)
                    .clamp(MIN_VI_TURN_RADIUS_NM, MAX_VI_TURN_RADIUS_NM);
                let arc_points = build_heading_transition_arc_points(
                    last_plotted_point,
                    last_leg_course_heading_true,
                    heading_true,
                    y,
                    leg.turn_direction.as_deref(),
                    vi_turn_radius,
                );
                if !arc_points.is_empty() {
                    current_point = arc_points.last().copied();
                    heading_transition_points = Some(arc_points);
                }
            }
            if current_point.is_none() {
                current_point = Some(Vec3::new(
                    last_plotted_point.x + heading_rad.sin() * distance_nm,
                    y,
                    last_plotted_point.z - heading_rad.cos() * distance_nm,
                ));
            }
            pending_course_to_fix_turn_heading = Some(heading_true);
            pending_course_to_fix_turn_direction = if is_fix_join_terminator(next_leg.map(|leg| leg.path_terminator.as_str())) {
                next_leg.and_then(|leg| leg.turn_direction.clone())
            } else {
                None
            };
            pending_course_to_fix_prefers_course_intercept = true;
            last_leg_course_heading_true = Some(heading_true);
        } else {
            last_leg_course_heading_true = None;
        }

        let Some(current_point) = current_point else {
            continue;
        };
        let previous_point = points.last().copied();
        let should_apply_pending_fix_join_turn = previous_point.is_some()
            && pending_course_to_fix_turn_heading.is_some()
            && waypoint.is_some()
            && is_fix_join_terminator(Some(leg.path_terminator.as_str()));
        let should_apply_pending_course_intercept = should_apply_pending_fix_join_turn
            && pending_course_to_fix_prefers_course_intercept
            && leg.path_terminator == "CF"
            && leg.course.is_some_and(|course| course.is_finite());
        let previous_leg = leg_index.checked_sub(1).and_then(|index| legs.get(index));
        let should_apply_direct_missed_fix_join_turn = !should_apply_pending_fix_join_turn
            && previous_point.is_some()
            && waypoint.is_some()
            && leg.is_missed_approach
            && is_fix_join_terminator(Some(leg.path_terminator.as_str()))
            && leg.turn_direction.is_some()
            && is_fix_join_terminator(previous_leg.map(|previous_leg| previous_leg.path_terminator.as_str()));

        if should_apply_pending_course_intercept {
            let turn_heading = pending_course_to_fix_turn_heading.unwrap();
            let course_heading_true =
                coords::magnetic_to_true_heading(leg.course.unwrap(), mag_var);
            for turn_point in build_heading_to_course_intercept_points(
                previous_point.unwrap(),
                current_point,
                turn_heading,
                course_heading_true,
                pending_course_to_fix_turn_direction.as_deref(),
            ) {
                push_point(&mut points, turn_point);
            }
            pending_course_to_fix_turn_heading = None;
            pending_course_to_fix_turn_direction = None;
            pending_course_to_fix_prefers_course_intercept = false;
        } else if should_apply_pending_fix_join_turn {
            let turn_heading = pending_course_to_fix_turn_heading.unwrap();
            for turn_point in build_course_to_fix_turn_points(
                previous_point.unwrap(),
                current_point,
                turn_heading,
                pending_course_to_fix_turn_direction.as_deref(),
            ) {
                push_point(&mut points, turn_point);
            }
            pending_course_to_fix_turn_heading = None;
            pending_course_to_fix_turn_direction = None;
            pending_course_to_fix_prefers_course_intercept = false;
        } else if should_apply_direct_missed_fix_join_turn {
            let entry_heading_true = if points.len() >= 2 {
                segment_heading_true(points[points.len() - 2], previous_point.unwrap())
            } else if previous_leg.and_then(|leg| leg.course).is_some_and(|course| course.is_finite()) {
                coords::magnetic_to_true_heading(previous_leg.unwrap().course.unwrap(), mag_var)
            } else {
                f64::NAN
            };
            if !entry_heading_true.is_finite() {
                push_point(&mut points, current_point);
            } else if leg.path_terminator == "CF" && leg.course.is_some_and(|course| course.is_finite())
            {
                let course_heading_true =
                    coords::magnetic_to_true_heading(leg.course.unwrap(), mag_var);
                for turn_point in build_heading_to_course_intercept_points(
                    previous_point.unwrap(),
                    current_point,
                    entry_heading_true,
                    course_heading_true,
                    leg.turn_direction.as_deref(),
                ) {
                    push_point(&mut points, turn_point);
                }
            } else {
                for turn_point in build_course_to_fix_turn_points(
                    previous_point.unwrap(),
                    current_point,
                    entry_heading_true,
                    leg.turn_direction.as_deref(),
                ) {
                    push_point(&mut points, turn_point);
                }
            }
            pending_course_to_fix_turn_heading = None;
            pending_course_to_fix_turn_direction = None;
            pending_course_to_fix_prefers_course_intercept = false;
        } else if previous_point.is_some()
            && matches!(leg.path_terminator.as_str(), "RF" | "AF")
            && leg.rf_center_waypoint_id.is_some()
        {
            pending_course_to_fix_turn_heading = None;
            pending_course_to_fix_turn_direction = None;
            pending_course_to_fix_prefers_course_intercept = false;
            if let Some(center_waypoint) =
                leg.rf_center_waypoint_id
                    .as_deref()
                    .and_then(|center_id| resolve_waypoint(waypoints, center_id))
            {
                let (center_x, center_z) =
                    coords::lat_lon_to_local(center_waypoint.lat, center_waypoint.lon, ref_lat, ref_lon);
                for arc_point in build_rf_arc_points(
                    previous_point.unwrap(),
                    current_point,
                    Vec2::new(center_x, center_z),
                    leg.rf_turn_direction.as_deref().unwrap_or("R"),
                ) {
                    push_point(&mut points, arc_point);
                }
            } else {
                push_point(&mut points, current_point);
            }
        } else if let Some(heading_transition_points) = heading_transition_points {
            for point in heading_transition_points {
                push_point(&mut points, point);
            }
        } else {
            push_point(&mut points, current_point);
        }

        vertical_lines.push(VerticalLine {
            x: current_point.x,
            y: current_point.y,
            z: current_point.z,
        });
        last_plotted_altitude_feet = resolved_altitude;
    }

    PathGeometryResult {
        points: points.into_iter().map(Vec3::to_point).collect(),
        vertical_lines,
        turn_constraint_labels,
    }
}

fn is_fix_join_terminator(path_terminator: Option<&str>) -> bool {
    matches!(path_terminator, Some("DF" | "CF" | "TF"))
}

fn is_no_fix_heading_leg(path_terminator: &str) -> bool {
    matches!(path_terminator, "VI" | "VA" | "VR" | "VD" | "VM" | "CI" | "CD")
}

fn push_point(points: &mut Vec<Vec3>, point: Vec3) {
    if points
        .last()
        .is_none_or(|previous| previous.distance_sq(point) > 1e-8)
    {
        points.push(point);
    }
}

fn segment_heading_true(from: Vec3, to: Vec3) -> f64 {
    coords::normalize_heading((to.x - from.x).atan2(-(to.z - from.z)).to_degrees())
}

fn build_hold_points(
    center: Vec2,
    heading_deg: f64,
    hold_distance_nm: f64,
    altitude_feet: f64,
    turn_direction: &str,
    vertical_scale: f64,
) -> Vec<Point3> {
    fn push_hold_local(
        points: &mut Vec<Point3>,
        center: Vec2,
        forward: Vec2,
        right: Vec2,
        y: f64,
        forward_offset: f64,
        right_offset: f64,
    ) {
        points.push(Point3 {
            x: center.x + forward.x * forward_offset + right.x * right_offset,
            y,
            z: center.y + forward.y * forward_offset + right.y * right_offset,
        });
    }

    fn push_hold_arc(
        points: &mut Vec<Point3>,
        center: Vec2,
        forward: Vec2,
        right: Vec2,
        y: f64,
        radius: f64,
        arc_steps: usize,
        center_forward: f64,
        center_right: f64,
        start_angle: f64,
        end_angle: f64,
    ) {
        for step in 0..=arc_steps {
            let t = step as f64 / arc_steps as f64;
            let angle = start_angle + t * (end_angle - start_angle);
            push_hold_local(
                points,
                center,
                forward,
                right,
                y,
                center_forward + radius * angle.cos(),
                center_right + radius * angle.sin(),
            );
        }
    }

    fn push_hold_straight(
        points: &mut Vec<Point3>,
        center: Vec2,
        forward: Vec2,
        right: Vec2,
        y: f64,
        straight_steps: usize,
        start_forward: f64,
        end_forward: f64,
        right_offset: f64,
        include_start: bool,
    ) {
        for step in (if include_start { 0 } else { 1 })..=straight_steps {
            let t = step as f64 / straight_steps as f64;
            let forward_offset = start_forward + t * (end_forward - start_forward);
            push_hold_local(points, center, forward, right, y, forward_offset, right_offset);
        }
    }

    let radius = (hold_distance_nm / 8.0).max(0.6);
    let straight_length = hold_distance_nm.max(1.2);
    let arc_steps = 24;
    let straight_steps = 12;
    let turn_sign = if turn_direction == "L" { -1.0 } else { 1.0 };
    let offset = turn_sign * radius;
    let heading_rad = heading_deg.to_radians();
    let forward = Vec2::new(heading_rad.sin(), -heading_rad.cos());
    let right = Vec2::new(heading_rad.cos(), heading_rad.sin());
    let y = coords::alt_to_y(altitude_feet, vertical_scale);
    let mut points = Vec::new();

    push_hold_local(&mut points, center, forward, right, y, 0.0, 0.0);
    let near_start_angle = if turn_direction == "R" { -PI / 2.0 } else { PI / 2.0 };
    let near_end_angle = -near_start_angle;
    push_hold_arc(
        &mut points,
        center,
        forward,
        right,
        y,
        radius,
        arc_steps,
        0.0,
        offset,
        near_start_angle,
        near_end_angle,
    );
    push_hold_straight(
        &mut points,
        center,
        forward,
        right,
        y,
        straight_steps,
        0.0,
        -straight_length,
        2.0 * offset,
        false,
    );
    let far_start_angle = if turn_direction == "R" { PI / 2.0 } else { -PI / 2.0 };
    let far_end_angle = if turn_direction == "R" {
        3.0 * PI / 2.0
    } else {
        -3.0 * PI / 2.0
    };
    push_hold_arc(
        &mut points,
        center,
        forward,
        right,
        y,
        radius,
        arc_steps,
        -straight_length,
        offset,
        far_start_angle,
        far_end_angle,
    );
    push_hold_straight(
        &mut points,
        center,
        forward,
        right,
        y,
        straight_steps,
        -straight_length,
        0.0,
        0.0,
        false,
    );
    points
}

fn build_rf_arc_points(start: Vec3, end: Vec3, center: Vec2, turn_direction: &str) -> Vec<Vec3> {
    let start_dx = start.x - center.x;
    let start_dz = start.z - center.y;
    let end_dx = end.x - center.x;
    let end_dz = end.z - center.y;
    let start_radius = (start_dx * start_dx + start_dz * start_dz).sqrt();
    let end_radius = (end_dx * end_dx + end_dz * end_dz).sqrt();
    if start_radius < 1e-6 || end_radius < 1e-6 {
        return vec![end];
    }

    let start_angle = (-start_dz).atan2(start_dx);
    let end_angle = (-end_dz).atan2(end_dx);
    let mut delta = end_angle - start_angle;
    if turn_direction == "R" {
        if delta >= 0.0 {
            delta -= PI * 2.0;
        }
    } else if delta <= 0.0 {
        delta += PI * 2.0;
    }

    let steps = ((delta.abs() / (PI / 24.0)).ceil() as usize).max(10);
    let mut points = Vec::with_capacity(steps);
    for step in 1..=steps {
        let t = step as f64 / steps as f64;
        let angle = start_angle + delta * t;
        let radius = start_radius + (end_radius - start_radius) * t;
        let y = start.y + (end.y - start.y) * t;
        points.push(Vec3::new(
            center.x + angle.cos() * radius,
            y,
            center.y - angle.sin() * radius,
        ));
    }
    points
}

fn build_course_to_fix_turn_points(
    start: Vec3,
    end: Vec3,
    start_heading_deg: f64,
    explicit_turn_direction: Option<&str>,
) -> Vec<Vec3> {
    #[derive(Clone)]
    struct Candidate {
        points: Vec<Vec3>,
        score: f64,
        arc_delta: f64,
        turn: &'static str,
    }

    let dx = end.x - start.x;
    let dz = end.z - start.z;
    let horizontal_distance = (dx * dx + dz * dz).sqrt();
    if horizontal_distance < 1e-4 {
        return vec![end];
    }

    let start_heading_rad = start_heading_deg.to_radians();
    let heading_dir = Vec2::new(start_heading_rad.sin(), -start_heading_rad.cos()).normalize();
    let right_normal = Vec2::new(-heading_dir.y, heading_dir.x);
    let left_normal = right_normal.scale(-1.0);
    let end2 = Vec2::new(end.x, end.z);
    let y_delta = end.y - start.y;

    let build_candidate = |turn: &'static str, radius_nm: f64| -> Option<Candidate> {
        let normal = if turn == "R" { right_normal } else { left_normal };
        let center2 = Vec2::new(start.x, start.z).add(normal.scale(radius_nm));
        let center_to_end = end2.sub(center2);
        let d = center_to_end.len();
        if d <= radius_nm + 1e-4 {
            return None;
        }

        let phi = center_to_end.y.atan2(center_to_end.x);
        let alpha = (radius_nm / d).clamp(-1.0, 1.0).acos();
        let candidate_angles = [phi + alpha, phi - alpha];
        let start_angle = (start.z - center2.y).atan2(start.x - center2.x);

        let normalize_positive = |value: f64| {
            let two_pi = PI * 2.0;
            let mut wrapped = value % two_pi;
            if wrapped < 0.0 {
                wrapped += two_pi;
            }
            wrapped
        };

        let mut best: Option<Candidate> = None;
        for tangent_angle in candidate_angles {
            let tangent2 = Vec2::new(
                center2.x + tangent_angle.cos() * radius_nm,
                center2.y + tangent_angle.sin() * radius_nm,
            );
            let to_end2 = end2.sub(tangent2);
            let line_distance = to_end2.len();
            if line_distance < 1e-5 {
                continue;
            }
            let line_dir = to_end2.scale(1.0 / line_distance);
            let circle_tangent_dir = if turn == "R" {
                Vec2::new(-tangent_angle.sin(), tangent_angle.cos())
            } else {
                Vec2::new(tangent_angle.sin(), -tangent_angle.cos())
            };
            if circle_tangent_dir.dot(line_dir) < 0.96 {
                continue;
            }
            let arc_delta = if turn == "R" {
                normalize_positive(tangent_angle - start_angle)
            } else {
                normalize_positive(start_angle - tangent_angle)
            };
            if arc_delta < 1e-4 {
                continue;
            }

            let arc_length = radius_nm * arc_delta;
            let total_length = arc_length + line_distance;
            let arc_steps = ((arc_delta / (PI / 48.0)).ceil() as usize).max(8);
            let line_steps = ((line_distance / 0.25).ceil() as usize).max(2);
            let mut points = Vec::new();

            for step in 1..=arc_steps {
                let t = step as f64 / arc_steps as f64;
                let angle = if turn == "R" {
                    start_angle + arc_delta * t
                } else {
                    start_angle - arc_delta * t
                };
                let x = center2.x + angle.cos() * radius_nm;
                let z = center2.y + angle.sin() * radius_nm;
                let traveled = arc_length * t;
                let y = start.y + (traveled / total_length) * y_delta;
                points.push(Vec3::new(x, y, z));
            }
            let tangent_point = *points.last().unwrap();
            for step in 1..=line_steps {
                let t = step as f64 / line_steps as f64;
                let x = tangent_point.x + (end.x - tangent_point.x) * t;
                let z = tangent_point.z + (end.z - tangent_point.z) * t;
                let traveled = arc_length + line_distance * t;
                let y = start.y + (traveled / total_length) * y_delta;
                points.push(Vec3::new(x, y, z));
            }

            let score = arc_delta + line_distance / horizontal_distance.max(0.01);
            if best.as_ref().is_none_or(|current| score < current.score) {
                best = Some(Candidate {
                    points,
                    score,
                    arc_delta,
                    turn,
                });
            }
        }
        best
    };

    let desired_radius = (horizontal_distance * 0.25).clamp(MIN_TURN_RADIUS_NM, 1.2);
    let reduced_radius = desired_radius.min(horizontal_distance * 0.2).max(0.2);
    let normalize_signed_delta_deg = |delta: f64| {
        let mut normalized = (((delta + 180.0) % 360.0) + 360.0) % 360.0 - 180.0;
        if normalized <= -180.0 {
            normalized += 360.0;
        }
        normalized
    };
    let bearing_to_fix_deg = dx.atan2(-dz).to_degrees();
    let heading_delta = normalize_signed_delta_deg(bearing_to_fix_deg - start_heading_deg);
    let inferred_turn_direction = if heading_delta.abs() >= 2.0 {
        Some(if heading_delta >= 0.0 { "R" } else { "L" })
    } else {
        None
    };
    let preferred_turn_direction = explicit_turn_direction.or(inferred_turn_direction);
    let direction_bias = if explicit_turn_direction.is_some() {
        EXPLICIT_TURN_DIRECTION_SCORE_BIAS
    } else {
        INFERRED_TURN_DIRECTION_SCORE_BIAS
    };
    let radii_to_try = if (desired_radius - reduced_radius).abs() < 1e-4 {
        vec![desired_radius]
    } else {
        vec![desired_radius, reduced_radius]
    };

    let mut all_candidates = Vec::new();
    for turn in ["L", "R"] {
        for radius_nm in &radii_to_try {
            if let Some(candidate) = build_candidate(turn, *radius_nm) {
                all_candidates.push(candidate);
            }
        }
    }
    let mut feasible_candidates = all_candidates
        .into_iter()
        .filter(|candidate| candidate.arc_delta <= MAX_COURSE_TO_FIX_TURN_ARC_RAD)
        .collect::<Vec<_>>();
    if feasible_candidates.is_empty() {
        return vec![end];
    }
    feasible_candidates.sort_by(|a, b| {
        let a_score = a.score
            + if preferred_turn_direction.is_some_and(|preferred| preferred != a.turn) {
                direction_bias
            } else {
                0.0
            };
        let b_score = b.score
            + if preferred_turn_direction.is_some_and(|preferred| preferred != b.turn) {
                direction_bias
            } else {
                0.0
            };
        a_score.partial_cmp(&b_score).unwrap()
    });
    feasible_candidates.remove(0).points
}

fn build_heading_to_course_intercept_points(
    start: Vec3,
    end: Vec3,
    start_heading_deg: f64,
    inbound_course_deg: f64,
    explicit_turn_direction: Option<&str>,
) -> Vec<Vec3> {
    let horizontal_distance = ((end.x - start.x).powi(2) + (end.z - start.z).powi(2)).sqrt();
    if horizontal_distance < 1e-4 {
        return vec![end];
    }

    let start_heading_rad = start_heading_deg.to_radians();
    let inbound_course_rad = inbound_course_deg.to_radians();
    let heading_dir = Vec2::new(start_heading_rad.sin(), -start_heading_rad.cos());
    let inbound_dir = Vec2::new(inbound_course_rad.sin(), -inbound_course_rad.cos());
    let start2 = Vec2::new(start.x, start.z);
    let end2 = Vec2::new(end.x, end.z);

    let mut intercept_candidates = Vec::<Vec2>::new();
    let mut push_intercept_candidate = |candidate: Vec2| {
        if intercept_candidates
            .iter()
            .any(|existing| existing.distance_sq(candidate) <= 1e-6)
        {
            return;
        }
        intercept_candidates.push(candidate);
    };

    let denominator = heading_dir.x * inbound_dir.y - heading_dir.y * inbound_dir.x;
    if denominator.abs() > 1e-6 {
        let delta = end2.sub(start2);
        let t = (delta.x * inbound_dir.y - delta.y * inbound_dir.x) / denominator;
        let u = (delta.x * heading_dir.y - delta.y * heading_dir.x) / denominator;
        if t > 0.1 && u <= -0.05 {
            push_intercept_candidate(start2.add(heading_dir.scale(t)));
        }
    }

    for distance_scale in [0.35, 0.45, 0.6, 0.8, 1.0] {
        let upstream_offset_nm = (horizontal_distance * distance_scale).clamp(0.8, 8.0);
        push_intercept_candidate(end2.add(inbound_dir.scale(-upstream_offset_nm)));
    }

    let mut best_curved_join_points: Option<Vec<Vec3>> = None;
    let mut best_curved_distance_nm = f64::INFINITY;
    let mut best_fallback_join_points: Option<Vec<Vec3>> = None;
    let mut best_fallback_distance_nm = f64::INFINITY;

    for intercept2 in intercept_candidates {
        let to_intercept_distance =
            ((intercept2.x - start.x).powi(2) + (intercept2.y - start.z).powi(2)).sqrt();
        let intercept_fraction = (to_intercept_distance / horizontal_distance).clamp(0.05, 0.95);
        let intercept_y = start.y + (end.y - start.y) * intercept_fraction;
        let intercept3 = Vec3::new(intercept2.x, intercept_y, intercept2.y);
        let join_points =
            build_course_to_fix_turn_points(start, intercept3, start_heading_deg, explicit_turn_direction);
        if join_points.len() > 2 && to_intercept_distance < best_curved_distance_nm {
            best_curved_join_points = Some(join_points);
            best_curved_distance_nm = to_intercept_distance;
        } else if join_points.len() > 1 && to_intercept_distance < best_fallback_distance_nm {
            best_fallback_join_points = Some(join_points);
            best_fallback_distance_nm = to_intercept_distance;
        }
    }

    let mut join_points = best_curved_join_points
        .or(best_fallback_join_points)
        .unwrap_or_else(|| vec![end]);
    if join_points
        .last()
        .is_none_or(|last_join_point| last_join_point.distance_sq(end) > 1e-8)
    {
        join_points.push(end);
    }
    join_points
}

fn build_heading_transition_arc_points(
    start: Vec3,
    start_heading_deg: f64,
    end_heading_deg: f64,
    end_y: f64,
    turn_direction: Option<&str>,
    radius_nm: f64,
) -> Vec<Vec3> {
    let normalize_positive_deg = |value: f64| {
        let wrapped = value % 360.0;
        if wrapped < 0.0 { wrapped + 360.0 } else { wrapped }
    };
    let normalize_signed_delta_deg = |delta: f64| {
        let mut normalized = (((delta + 180.0) % 360.0) + 360.0) % 360.0 - 180.0;
        if normalized <= -180.0 {
            normalized += 360.0;
        }
        normalized
    };

    let start_heading = coords::normalize_heading(start_heading_deg);
    let target_heading = coords::normalize_heading(end_heading_deg);
    let right_delta = normalize_positive_deg(target_heading - start_heading);
    let left_delta = normalize_positive_deg(start_heading - target_heading);
    let (resolved_turn, delta_deg) = if let Some(turn_direction) = turn_direction {
        (
            turn_direction,
            if turn_direction == "R" { right_delta } else { left_delta },
        )
    } else {
        let signed_delta = normalize_signed_delta_deg(target_heading - start_heading);
        (
            if signed_delta >= 0.0 { "R" } else { "L" },
            signed_delta.abs(),
        )
    };
    if !delta_deg.is_finite()
        || delta_deg < MIN_HEADING_TRANSITION_DELTA_DEG
        || delta_deg > MAX_HEADING_TRANSITION_DELTA_DEG
    {
        return Vec::new();
    }

    let start_heading_rad = start_heading.to_radians();
    let heading_dir = Vec2::new(start_heading_rad.sin(), -start_heading_rad.cos()).normalize();
    let right_normal = Vec2::new(-heading_dir.y, heading_dir.x);
    let center2 = Vec2::new(start.x, start.z).add(
        if resolved_turn == "R" {
            right_normal.scale(radius_nm)
        } else {
            right_normal.scale(-radius_nm)
        },
    );
    let start_angle = (start.z - center2.y).atan2(start.x - center2.x);
    let arc_delta = delta_deg.to_radians();
    let steps = ((arc_delta / (PI / 48.0)).ceil() as usize).max(8);
    let mut points = Vec::with_capacity(steps);
    for step in 1..=steps {
        let t = step as f64 / steps as f64;
        let angle = if resolved_turn == "R" {
            start_angle + arc_delta * t
        } else {
            start_angle - arc_delta * t
        };
        points.push(Vec3::new(
            center2.x + angle.cos() * radius_nm,
            start.y + (end_y - start.y) * t,
            center2.y + angle.sin() * radius_nm,
        ));
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_leg(overrides: ApproachPathLeg) -> ApproachPathLeg {
        overrides
    }

    fn local_waypoint(id: &str, east_nm: f64, north_nm: f64, ref_lat: f64, ref_lon: f64) -> ApproachWaypoint {
        let lat = ref_lat + north_nm / 60.0;
        let lon = ref_lon + east_nm / (60.0 * (ref_lat.to_radians()).cos());
        ApproachWaypoint {
            id: id.to_string(),
            name: id.to_string(),
            lat,
            lon,
            waypoint_type: "terminal".to_string(),
        }
    }

    fn resolved_altitudes(legs: &[ApproachPathLeg]) -> Vec<f64> {
        legs.iter()
            .map(|leg| leg.altitude.filter(|alt| alt.is_finite()).unwrap_or(1000.0))
            .collect()
    }

    fn max_turn_degrees(points: &[Point3]) -> f64 {
        let mut max_turn = 0.0;
        for index in 1..points.len().saturating_sub(1) {
            let a = Vec2::new(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
            let b = Vec2::new(points[index + 1].x - points[index].x, points[index + 1].z - points[index].z);
            if a.len() < 1e-6 || b.len() < 1e-6 {
                continue;
            }
            let dot = a.normalize().dot(b.normalize()).clamp(-1.0, 1.0);
            let turn = dot.acos().to_degrees();
            if turn > max_turn {
                max_turn = turn;
            }
        }
        max_turn
    }

    fn segment_heading_degrees(from: Point3, to: Point3) -> f64 {
        ((((to.x - from.x).atan2(-(to.z - from.z)).to_degrees()) % 360.0) + 360.0) % 360.0
    }

    #[test]
    fn direct_cf_path_between_waypoints() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "CF".into(), altitude: Some(1200.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(1600.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        ];
        let waypoints = vec![
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_FIX", 3.0, 0.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams {
            legs: legs.clone(),
            waypoints,
            resolved_altitudes: resolved_altitudes(&legs),
            initial_altitude_feet: 1000.0,
            vertical_scale: 1.0,
            ref_lat,
            ref_lon,
            mag_var: 0.0,
            show_turn_constraint_labels: false,
        });
        assert_eq!(result.points.len(), 2);
        assert!((result.points[0].x - 0.0).abs() < 0.05);
        assert!((result.points[1].x - 3.0).abs() < 0.08);
        assert_eq!(result.vertical_lines.len(), 2);
    }

    #[test]
    fn missed_ca_to_cf_with_explicit_turn_direction_curves() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "CF".into(), altitude: Some(1000.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_".into(), waypoint_name: "".into(), path_terminator: "CA".into(), altitude: Some(1100.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: Some("L".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
        ];
        let waypoints = vec![
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_FIX", -4.0, 0.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams { legs: legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&legs), initial_altitude_feet: 900.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: true });
        assert!(result.points.len() > 25);
        assert!(max_turn_degrees(&result.points) < 20.0);
        assert_eq!(result.turn_constraint_labels.len(), 1);
    }

    #[test]
    fn missed_ca_to_cf_without_turn_direction_stays_linear() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "CF".into(), altitude: Some(1000.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_".into(), waypoint_name: "".into(), path_terminator: "CA".into(), altitude: Some(1100.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
        ];
        let waypoints = vec![
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_FIX", -4.0, 0.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams { legs: legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&legs), initial_altitude_feet: 900.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });
        assert_eq!(result.points.len(), 3);
        assert!(max_turn_degrees(&result.points) > 150.0);
    }

    #[test]
    fn cf_to_cf_right_turn_intercepts_published_course() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "CF".into(), altitude: Some(1000.0), altitude_constraint: None, course: Some(37.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(3000.0), altitude_constraint: None, course: Some(171.0), distance: None, hold_course: None, hold_distance: None, turn_direction: Some("R".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
        ];
        let waypoints = vec![
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_FIX", -6.0, 5.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams { legs: legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&legs), initial_altitude_feet: 900.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });
        assert!(result.points.len() > 15);
        let second_last = result.points[result.points.len() - 2];
        let last = result.points[result.points.len() - 1];
        let final_heading = segment_heading_degrees(second_last, last);
        assert!((final_heading - 171.0).abs() < 8.0);
    }

    #[test]
    fn vi_to_cf_aligns_to_published_course() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "CF".into(), altitude: Some(1000.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_".into(), waypoint_name: "".into(), path_terminator: "VI".into(), altitude: Some(1300.0), altitude_constraint: None, course: Some(330.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(2000.0), altitude_constraint: None, course: Some(0.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
        ];
        let waypoints = vec![
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_FIX", 4.0, 6.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams { legs: legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&legs), initial_altitude_feet: 900.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });
        assert!(result.points.len() > 10);
        let second_last = result.points[result.points.len() - 2];
        let last = result.points[result.points.len() - 1];
        let final_segment_heading = segment_heading_degrees(second_last, last);
        assert!(final_segment_heading < 10.0 || final_segment_heading > 350.0);
    }

    #[test]
    fn vi_leg_carries_downstream_explicit_turn_direction_into_fix_join() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let base_legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "CF".into(), altitude: Some(1000.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_".into(), waypoint_name: "".into(), path_terminator: "VI".into(), altitude: Some(1100.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
        ];
        let waypoints = vec![
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_FIX", -4.0, 0.0, ref_lat, ref_lon),
        ];
        let left_legs = [
            base_legs.clone(),
            vec![make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: Some("L".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true })],
        ]
        .concat();
        let right_legs = [
            base_legs,
            vec![make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: Some("R".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true })],
        ]
        .concat();

        let left_result = build_path_geometry(BuildPathGeometryParams { legs: left_legs.clone(), waypoints: waypoints.clone(), resolved_altitudes: resolved_altitudes(&left_legs), initial_altitude_feet: 900.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });
        let right_result = build_path_geometry(BuildPathGeometryParams { legs: right_legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&right_legs), initial_altitude_feet: 900.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });

        assert!(left_result.points.len() > 25);
        assert!(right_result.points.len() > 25);
        assert!(left_result.points[2].z < 0.0);
        assert!(right_result.points[2].z > 0.0);
    }

    #[test]
    fn vr_no_fix_missed_leg_is_synthesized_before_fix_join() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "CF".into(), altitude: Some(1200.0), altitude_constraint: None, course: Some(250.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_".into(), waypoint_name: "".into(), path_terminator: "VR".into(), altitude: Some(1300.0), altitude_constraint: None, course: Some(250.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "APT_FIX".into(), path_terminator: "CF".into(), altitude: Some(2000.0), altitude_constraint: None, course: Some(200.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
        ];
        let waypoints = vec![
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_FIX", -4.0, -5.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams { legs: legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&legs), initial_altitude_feet: 1000.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });
        assert!(result.points.len() > 3);
        assert!(result.vertical_lines.len() >= 3);
    }

    #[test]
    fn rf_arc_lands_at_target_endpoint() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "ARC_START".into(), waypoint_name: "ARC_START".into(), path_terminator: "CF".into(), altitude: Some(3000.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "ARC_END".into(), waypoint_name: "ARC_END".into(), path_terminator: "RF".into(), altitude: Some(3000.0), altitude_constraint: None, course: Some(180.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: Some("ARC_CENTER".into()), rf_turn_direction: Some("R".into()), vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        ];
        let waypoints = vec![
            local_waypoint("ARC_START", 1.0, 0.0, ref_lat, ref_lon),
            local_waypoint("ARC_END", 0.0, -1.0, ref_lat, ref_lon),
            local_waypoint("ARC_CENTER", 0.0, 0.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams { legs: legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&legs), initial_altitude_feet: 2500.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });
        assert!(result.points.len() > 12);
        let last = result.points[result.points.len() - 1];
        assert!(last.x.abs() < 0.08);
        assert!((last.z - 1.0).abs() < 0.08);
    }

    #[test]
    fn af_arc_lands_at_target_endpoint() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "ARC_START".into(), waypoint_name: "ARC_START".into(), path_terminator: "CF".into(), altitude: Some(3000.0), altitude_constraint: None, course: Some(90.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "ARC_END".into(), waypoint_name: "ARC_END".into(), path_terminator: "AF".into(), altitude: Some(3000.0), altitude_constraint: None, course: Some(180.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: Some("ARC_CENTER".into()), rf_turn_direction: Some("R".into()), vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        ];
        let waypoints = vec![
            local_waypoint("ARC_START", 1.0, 0.0, ref_lat, ref_lon),
            local_waypoint("ARC_END", 0.0, -1.0, ref_lat, ref_lon),
            local_waypoint("ARC_CENTER", 0.0, 0.0, ref_lat, ref_lon),
        ];
        let result = build_path_geometry(BuildPathGeometryParams { legs: legs.clone(), waypoints, resolved_altitudes: resolved_altitudes(&legs), initial_altitude_feet: 2500.0, vertical_scale: 1.0, ref_lat, ref_lon, mag_var: 0.0, show_turn_constraint_labels: false });
        assert!(result.points.len() > 12);
        let last = result.points[result.points.len() - 1];
        assert!(last.x.abs() < 0.08);
        assert!((last.z - 1.0).abs() < 0.08);
    }

    #[test]
    fn hold_geometry_produces_closed_racetrack_points_at_requested_altitude() {
        let points = build_hold_points(Vec2::new(2.0, -1.0), 45.0, 4.0, 4000.0, "R", 1.0);
        assert!(points.len() > 60);
        assert!((points[0].y - (4000.0 / 6076.12)).abs() < 1e-6);
        let last = points[points.len() - 1];
        assert!((points[0].x - last.x).abs() < 0.05);
        assert!((points[0].z - last.z).abs() < 0.05);
    }

    #[test]
    fn missed_profile_honors_published_climb_requirement() {
        let ref_lat = 40.0;
        let ref_lon = -100.0;
        let legs = vec![
            make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_MAP".into(), waypoint_name: "APT_MAP".into(), path_terminator: "TF".into(), altitude: Some(1300.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_KULOC".into(), waypoint_name: "APT_KULOC".into(), path_terminator: "TF".into(), altitude: None, altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FEXUB".into(), waypoint_name: "APT_FEXUB".into(), path_terminator: "RF".into(), altitude: None, altitude_constraint: None, course: Some(135.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
            make_leg(ApproachPathLeg { sequence: 40, waypoint_id: "APT_QUINT".into(), waypoint_name: "APT_QUINT".into(), path_terminator: "TF".into(), altitude: Some(6000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: true }),
        ];
        let waypoints = waypoint_map(&[
            local_waypoint("APT_MAP", 0.0, 0.0, ref_lat, ref_lon),
            local_waypoint("APT_KULOC", -2.6, 4.6, ref_lat, ref_lon),
            local_waypoint("APT_FEXUB", 3.8, 10.2, ref_lat, ref_lon),
            local_waypoint("APT_QUINT", 12.0, -1.0, ref_lat, ref_lon),
        ]);
        let base_altitudes = vec![1300.0, 1300.0, 1300.0, 6000.0];
        let without_requirement =
            resolve_missed_approach_altitudes(&legs, &base_altitudes, &waypoints, ref_lat, ref_lon, Some(1300.0), None);
        let with_requirement = resolve_missed_approach_altitudes(
            &legs,
            &base_altitudes,
            &waypoints,
            ref_lat,
            ref_lon,
            Some(1300.0),
            Some(&ApproachPathMissedApproachClimbRequirement {
                feet_per_nm: 325.0,
                target_altitude_feet: Some(5500.0),
            }),
        );
        assert!(without_requirement[2] < 5000.0);
        assert!(with_requirement[2] >= 5490.0);
        assert!(with_requirement[2] > without_requirement[2] + 800.0);
        assert!(with_requirement[3] >= 6000.0);
    }
}
