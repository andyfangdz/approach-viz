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
fn course_from_fix_leg_draws_outbound_teardrop_segment() {
    // KDDC I14 FLACK transition shape: a fix-anchored leg (TF to OWENJ) followed
    // by an outbound `FC` course-from-fix leg that forms the outbound side of the
    // teardrop course reversal. The `FC` leg must project outbound from the fix
    // along its published course for its distance rather than collapsing onto the
    // fix waypoint.
    let ref_lat = 40.0;
    let ref_lon = -100.0;
    let legs = vec![
        make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_OWENJ".into(), waypoint_name: "OWENJ".into(), path_terminator: "TF".into(), altitude: Some(4400.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_OWENJ".into(), waypoint_name: "OWENJ".into(), path_terminator: "FC".into(), altitude: Some(4400.0), altitude_constraint: None, course: Some(90.0), distance: Some(6.0), hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
    ];
    let waypoints = vec![local_waypoint("APT_OWENJ", 0.0, 0.0, ref_lat, ref_lon)];
    let result = build_path_geometry(BuildPathGeometryParams {
        legs: legs.clone(),
        waypoints,
        resolved_altitudes: resolved_altitudes(&legs),
        initial_altitude_feet: 4400.0,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var: 0.0,
        show_turn_constraint_labels: false,
    });
    // The fix anchor plus the outbound endpoint must both be present.
    assert_eq!(result.points.len(), 2);
    let fix = result.points[0];
    let outbound = result.points[result.points.len() - 1];
    assert!(fix.x.abs() < 0.05);
    assert!(fix.z.abs() < 0.05);
    // Course 090 true projects due east (+x) for the published 6.0 NM distance.
    assert!((outbound.x - 6.0).abs() < 0.1);
    assert!(outbound.z.abs() < 0.1);
}

#[test]
fn teardrop_intercept_leg_completes_inbound_reversal() {
    // KDDC I14 FLACK teardrop tail: TF to OWENJ, FC outbound, then a terminal
    // `CI` intercept. The `CI` must fly an inbound leg back along its published
    // course (mirroring the outbound distance) instead of dead-ending at a short
    // turn stub.
    let ref_lat = 40.0;
    let ref_lon = -100.0;
    let outbound_nm = 6.0;
    let legs = vec![
        make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_OWENJ".into(), waypoint_name: "OWENJ".into(), path_terminator: "TF".into(), altitude: Some(4400.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_OWENJ".into(), waypoint_name: "OWENJ".into(), path_terminator: "FC".into(), altitude: Some(4400.0), altitude_constraint: None, course: Some(0.0), distance: Some(outbound_nm), hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_".into(), waypoint_name: "".into(), path_terminator: "CI".into(), altitude: Some(4400.0), altitude_constraint: None, course: Some(180.0), distance: None, hold_course: None, hold_distance: None, turn_direction: Some("L".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
    ];
    let waypoints = vec![local_waypoint("APT_OWENJ", 0.0, 0.0, ref_lat, ref_lon)];
    let result = build_path_geometry(BuildPathGeometryParams {
        legs: legs.clone(),
        waypoints,
        resolved_altitudes: resolved_altitudes(&legs),
        initial_altitude_feet: 4400.0,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var: 0.0,
        show_turn_constraint_labels: false,
    });
    // Outbound course 000 projects due north (-z); the path must reach roughly
    // outbound_nm north, then the inbound 180 leg must return a comparable
    // distance back south, ending well below the outbound apex.
    let apex_z = result.points.iter().map(|p| p.z).fold(f64::MAX, f64::min);
    assert!(apex_z <= -(outbound_nm - 0.5), "outbound apex too short z={apex_z}");
    let last = *result.points.last().unwrap();
    // The reversal returns south: the final point sits at least half the
    // outbound length back toward the fix rather than stalling at the apex.
    assert!(last.z > apex_z + outbound_nm * 0.5, "inbound leg too short: last z={}", last.z);
    // The reversal turn is a single broad, continuous turn (not a tight spike):
    // the left turn off the 000 outbound must sweep well past the tight VI stub
    // radius laterally before the inbound leg.
    let widest_x = result.points.iter().map(|p| p.x).fold(f64::MAX, f64::min);
    assert!(widest_x <= -2.0, "reversal turn too tight (spike): widest x={widest_x}");
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

