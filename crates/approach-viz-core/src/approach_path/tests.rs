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
fn teardrop_renders_as_single_smooth_arc_to_rollout_fix() {
    // Teardrop with a downstream final approach course fix (the IF/roll-out fix):
    // TF to a fix, FC outbound, CI intercept, then CF onto the roll-out fix. The
    // whole reversal must render as a single smooth circular arc through the
    // outbound fix and the outbound apex, terminating at the roll-out fix, with
    // no long straight outbound leg.
    let ref_lat = 40.0;
    let ref_lon = -100.0;
    let legs = vec![
        make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_O".into(), waypoint_name: "O".into(), path_terminator: "TF".into(), altitude: Some(4400.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_O".into(), waypoint_name: "O".into(), path_terminator: "FC".into(), altitude: Some(4400.0), altitude_constraint: None, course: Some(300.0), distance: Some(4.0), hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_".into(), waypoint_name: "".into(), path_terminator: "CI".into(), altitude: Some(4400.0), altitude_constraint: None, course: Some(200.0), distance: None, hold_course: None, hold_distance: None, turn_direction: Some("L".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 40, waypoint_id: "APT_IF".into(), waypoint_name: "IF".into(), path_terminator: "CF".into(), altitude: Some(4400.0), altitude_constraint: None, course: Some(180.0), distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
    ];
    let roll_out = (-2.0_f64, 4.0_f64); // IF (east, north)
    let waypoints = vec![
        local_waypoint("APT_O", 3.0, 6.0, ref_lat, ref_lon),
        local_waypoint("APT_IF", roll_out.0, roll_out.1, ref_lat, ref_lon),
    ];
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
    let n = result.points.len();
    assert!(n > 20, "reversal arc not produced (n={n})");
    // The reversal is a single smooth arc (no sharp intercept corner): the only
    // junction is the tangent roll-out onto the course, which stays smooth.
    assert!(max_turn_degrees(&result.points) < 20.0, "reversal is not a smooth arc");
    // No straight outbound leg: the curved reversal (everything up to the tangent
    // roll-out, here roughly the first 80% of points) is finely subdivided, so
    // its largest gap stays well under the 4 NM outbound distance a straight leg
    // would produce. (The final roll-out -> inbound-fix segment is straight.)
    let arc_end = (n * 4) / 5;
    let max_gap_arc = (1..arc_end)
        .map(|i| ((result.points[i].x - result.points[i - 1].x).powi(2) + (result.points[i].z - result.points[i - 1].z).powi(2)).sqrt())
        .fold(0.0_f64, f64::max);
    assert!(max_gap_arc < 1.0, "straight outbound leg still present (max gap {max_gap_arc} NM)");
    // Rolls out onto the course and heads inbound, terminating at the downstream
    // fix (not at the reversal apex).
    let last = result.points[n - 1];
    assert!((last.x - roll_out.0).abs() < 0.2, "did not reach the inbound fix: x={}", last.x);
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

#[test]
fn dme_arc_lead_turn_rolls_out_onto_inbound_course() {
    // A DME arc (`AF`) terminating at a fix, followed by an inbound course leg
    // (as the scene composition appends), should roll out of the arc with a
    // smooth lead turn onto the inbound course near the fix instead of a sharp
    // corner. Synthetic geometry: a 10 NM arc centered at the origin, an initial
    // fix due east of the center, an arc fix due north of it, and an inbound
    // course running due south (heading inward, through the center).
    let ref_lat = 40.0;
    let ref_lon = -100.0;
    let waypoints = vec![
        local_waypoint("CTR", 0.0, 0.0, ref_lat, ref_lon),
        local_waypoint("IAF", 10.0, 0.0, ref_lat, ref_lon),
        local_waypoint("ARCFIX", 0.0, 10.0, ref_lat, ref_lon),
        // Inbound target down a 225 deg (south-west) course from the arc fix —
        // clearly off the radial so the lead turn corner is well defined.
        local_waypoint("TGT", -3.54, 6.46, ref_lat, ref_lon),
    ];
    let leg = |id: &str, pt: &str, course: Option<f64>, rf_center: Option<&str>, rf_turn: Option<&str>| {
        make_leg(ApproachPathLeg {
            sequence: 0,
            waypoint_id: id.into(),
            waypoint_name: id.into(),
            path_terminator: pt.into(),
            altitude: Some(4000.0),
            altitude_constraint: None,
            course,
            distance: None,
            hold_course: None,
            hold_distance: None,
            turn_direction: None,
            hold_turn_direction: None,
            rf_center_waypoint_id: rf_center.map(|s| s.to_string()),
            rf_turn_direction: rf_turn.map(|s| s.to_string()),
            vertical_angle_deg: None,
            rnp_service_levels: None,
            is_final_approach_fix: false,
            is_initial_fix: false,
            is_final_fix: false,
            is_missed_approach: false,
        })
    };
    // Arc travels counter-clockwise (east fix -> north fix), then joins a course
    // of 225 deg (south-west) — the appended inbound leg.
    let legs = vec![
        leg("IAF", "IF", None, None, None),
        leg("ARCFIX", "AF", None, Some("CTR"), Some("L")),
        leg("TGT", "CF", Some(225.0), None, None),
    ];
    let result = build_path_geometry(BuildPathGeometryParams {
        resolved_altitudes: resolved_altitudes(&legs),
        legs,
        waypoints,
        initial_altitude_feet: 4000.0,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var: 0.0,
        show_turn_constraint_labels: false,
    });

    // The corner is smoothed: no single bend approaches the ~90 deg sharp turn
    // that a plain arc-then-straight-leg join would produce.
    assert!(
        max_turn_degrees(&result.points) < 25.0,
        "expected a smooth lead turn, got max bend {} deg",
        max_turn_degrees(&result.points)
    );
    // The path rolls out established on the inbound course (225 deg) near the
    // arc fix rather than cornering at it.
    let last = result.points[result.points.len() - 1];
    let second_last = result.points[result.points.len() - 2];
    let rollout_heading = segment_heading_degrees(second_last, last);
    assert!(
        (rollout_heading - 225.0).abs() < 12.0,
        "expected roll-out heading ~225 deg, got {} deg",
        rollout_heading
    );
    let arc_fix_z = -10.0;
    assert!(
        ((last.x).powi(2) + (last.z - arc_fix_z).powi(2)).sqrt() < 5.0,
        "expected roll-out near the arc fix, got ({}, {})",
        last.x,
        last.z
    );
}

#[test]
fn procedure_turn_leg_renders_charted_reversal() {
    // KACK VOR RWY 24 shape: IF at the VOR, a `PI` procedure turn (45° excursion
    // course published, remain within 10 NM, right-hand reversal), then a `CF`
    // back to the same fix on the inbound course. The PT must render the full
    // charted maneuver — outbound on the reciprocal, 45° barb excursion, 180°
    // reversal, roll-out on the inbound course — instead of collapsing onto the
    // fix as a zero-length segment.
    let ref_lat = 41.0;
    let ref_lon = -70.0;
    let inbound_course = 240.0;
    let legs = vec![
        make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_ACK".into(), waypoint_name: "ACK".into(), path_terminator: "IF".into(), altitude: Some(1800.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: true, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_ACK".into(), waypoint_name: "ACK".into(), path_terminator: "PI".into(), altitude: Some(1800.0), altitude_constraint: None, course: Some(15.0), distance: Some(10.0), hold_course: None, hold_distance: None, turn_direction: Some("R".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_ACK".into(), waypoint_name: "ACK".into(), path_terminator: "CF".into(), altitude: Some(800.0), altitude_constraint: None, course: Some(inbound_course), distance: Some(6.0), hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
    ];
    let waypoints = vec![local_waypoint("APT_ACK", 0.0, 0.0, ref_lat, ref_lon)];
    let result = build_path_geometry(BuildPathGeometryParams {
        legs: legs.clone(),
        waypoints,
        resolved_altitudes: resolved_altitudes(&legs),
        initial_altitude_feet: 1800.0,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var: 0.0,
        show_turn_constraint_labels: false,
    });
    let n = result.points.len();
    assert!(n > 30, "procedure turn not drawn (n={n})");
    // Starts at the fix and (via the CF) returns to it.
    let first = result.points[0];
    let last = result.points[n - 1];
    assert!(first.x.abs() < 0.05 && first.z.abs() < 0.05);
    assert!(last.x.abs() < 0.05 && last.z.abs() < 0.05);
    // Remains within the published distance limit but actually flies outbound.
    let max_excursion = result
        .points
        .iter()
        .map(|p| (p.x * p.x + p.z * p.z).sqrt())
        .fold(0.0_f64, f64::max);
    assert!(max_excursion <= 10.0, "PT exceeds remain-within limit: {max_excursion} NM");
    assert!(max_excursion >= 3.0, "PT maneuver too small: {max_excursion} NM");
    // The excursion (barb) lies left of the outbound track: with inbound 240 the
    // outbound is 060, whose right normal points southeast; the loop must bulge
    // to the northwest (negative right-normal cross-track).
    let outbound_rad = (inbound_course - 180.0_f64).to_radians();
    let dir = (outbound_rad.sin(), -outbound_rad.cos());
    let right_normal = (-dir.1, dir.0);
    let min_cross_track = result
        .points
        .iter()
        .map(|p| p.x * right_normal.0 + p.z * right_normal.1)
        .fold(f64::MAX, f64::min);
    assert!(min_cross_track < -0.5, "barb on the wrong side: {min_cross_track}");
    // Before the final run to the fix, the path is established on the inbound
    // course line outbound of the fix (the roll-out point).
    let inbound_rad = inbound_course.to_radians();
    let inbound_dir = (inbound_rad.sin(), -inbound_rad.cos());
    let rollout = result.points[n - 2];
    let along = rollout.x * inbound_dir.0 + rollout.z * inbound_dir.1;
    let cross = rollout.x * -inbound_dir.1 + rollout.z * inbound_dir.0;
    assert!(cross.abs() < 0.15, "roll-out not on the inbound course: {cross}");
    assert!(along < -0.5, "roll-out not outbound of the fix: {along}");
}

#[test]
fn procedure_turn_mirrors_for_left_reversal() {
    // Left-hand reversal: the 45° excursion course sits right of the outbound
    // course, so the loop must bulge to the right of the outbound track.
    let ref_lat = 41.0;
    let ref_lon = -70.0;
    let legs = vec![
        make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "IF".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: true, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "PI".into(), altitude: Some(2000.0), altitude_constraint: None, course: Some(105.0), distance: Some(10.0), hold_course: None, hold_distance: None, turn_direction: Some("L".into()), hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "CF".into(), altitude: Some(1000.0), altitude_constraint: None, course: Some(240.0), distance: Some(6.0), hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
    ];
    let waypoints = vec![local_waypoint("APT_FIX", 0.0, 0.0, ref_lat, ref_lon)];
    let result = build_path_geometry(BuildPathGeometryParams {
        legs: legs.clone(),
        waypoints,
        resolved_altitudes: resolved_altitudes(&legs),
        initial_altitude_feet: 2000.0,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var: 0.0,
        show_turn_constraint_labels: false,
    });
    assert!(result.points.len() > 30);
    let outbound_rad = 60.0_f64.to_radians();
    let dir = (outbound_rad.sin(), -outbound_rad.cos());
    let right_normal = (-dir.1, dir.0);
    let max_cross_track = result
        .points
        .iter()
        .map(|p| p.x * right_normal.0 + p.z * right_normal.1)
        .fold(f64::MIN, f64::max);
    assert!(max_cross_track > 0.5, "left-reversal barb on the wrong side: {max_cross_track}");
}

#[test]
fn procedure_turn_without_course_data_keeps_fix_anchor() {
    // A `PI` with no published excursion course and no following course leg has
    // nothing to orient the maneuver; it must keep the pre-existing draw-to-fix
    // behavior (no fabricated reversal, no panic).
    let ref_lat = 41.0;
    let ref_lon = -70.0;
    let legs = vec![
        make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "IF".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: true, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "PI".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: Some(10.0), hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
    ];
    let waypoints = vec![local_waypoint("APT_FIX", 0.0, 0.0, ref_lat, ref_lon)];
    let result = build_path_geometry(BuildPathGeometryParams {
        legs: legs.clone(),
        waypoints,
        resolved_altitudes: resolved_altitudes(&legs),
        initial_altitude_feet: 2000.0,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var: 0.0,
        show_turn_constraint_labels: false,
    });
    assert!(!result.points.is_empty());
    for p in &result.points {
        assert!(p.x.abs() < 0.05 && p.z.abs() < 0.05, "unexpected fabricated geometry");
    }
}

#[test]
fn procedure_turn_with_contradictory_turn_direction_keeps_fix_anchor() {
    // Both courses are published and imply a right-hand reversal (excursion 45°
    // left of the outbound), but the record publishes a left reversal. The
    // contradiction marks the record malformed: keep the draw-to-fix fallback
    // instead of rendering a possibly mirror-imaged maneuver.
    let ref_lat = 41.0;
    let ref_lon = -70.0;
    let legs = vec![
        make_leg(ApproachPathLeg { sequence: 10, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "IF".into(), altitude: Some(2000.0), altitude_constraint: None, course: None, distance: None, hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: true, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 20, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "PI".into(), altitude: Some(2000.0), altitude_constraint: None, course: Some(15.0), distance: Some(10.0), turn_direction: Some("L".into()), hold_course: None, hold_distance: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
        make_leg(ApproachPathLeg { sequence: 30, waypoint_id: "APT_FIX".into(), waypoint_name: "FIX".into(), path_terminator: "CF".into(), altitude: Some(1000.0), altitude_constraint: None, course: Some(240.0), distance: Some(6.0), hold_course: None, hold_distance: None, turn_direction: None, hold_turn_direction: None, rf_center_waypoint_id: None, rf_turn_direction: None, vertical_angle_deg: None, rnp_service_levels: None, is_final_approach_fix: false, is_initial_fix: false, is_final_fix: false, is_missed_approach: false }),
    ];
    let waypoints = vec![local_waypoint("APT_FIX", 0.0, 0.0, ref_lat, ref_lon)];
    let result = build_path_geometry(BuildPathGeometryParams {
        legs: legs.clone(),
        waypoints,
        resolved_altitudes: resolved_altitudes(&legs),
        initial_altitude_feet: 2000.0,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var: 0.0,
        show_turn_constraint_labels: false,
    });
    assert!(!result.points.is_empty());
    for p in &result.points {
        assert!(p.x.abs() < 0.05 && p.z.abs() < 0.05, "unexpected fabricated geometry");
    }
}

#[test]
fn hold_leg_length_prefers_published_distance() {
    assert_eq!(resolve_hold_leg_length_nm(Some(10.0), Some(1.0), 12000.0), 10.0);
    assert_eq!(resolve_hold_leg_length_nm(Some(4.0), None, 500.0), 4.0);
}

#[test]
fn hold_leg_length_derives_time_based_holds_from_max_holding_speed() {
    // 1-minute hold at 2,700 ft: 200 KIAS tier, TAS ≈ 200 × 1.054 → ~3.5 NM.
    let low = resolve_hold_leg_length_nm(None, Some(1.0), 2700.0);
    assert!((low - 3.51).abs() < 0.05, "low-tier length {low}");
    // Same timing higher up rides the faster tiers and the TAS correction.
    let mid = resolve_hold_leg_length_nm(None, Some(1.0), 10000.0);
    assert!((mid - 4.6).abs() < 0.05, "mid-tier length {mid}");
    let high = resolve_hold_leg_length_nm(None, Some(1.0), 17000.0);
    assert!((high - 5.9).abs() < 0.1, "high-tier length {high}");
    assert!(low < mid && mid < high);
}

#[test]
fn hold_leg_length_defaults_to_standard_pattern_timing() {
    // Neither time nor distance published: standard 1-minute pattern below
    // 14,000 ft, 1.5 minutes above.
    let low = resolve_hold_leg_length_nm(None, None, 4400.0);
    assert!((low - resolve_hold_leg_length_nm(None, Some(1.0), 4400.0)).abs() < 1e-9);
    let high = resolve_hold_leg_length_nm(None, None, 16000.0);
    assert!((high - resolve_hold_leg_length_nm(None, Some(1.5), 16000.0)).abs() < 1e-9);
    // Degenerate altitude input clamps instead of poisoning the result.
    assert!(resolve_hold_leg_length_nm(None, None, f64::NAN).is_finite());
}

#[test]
fn hold_protected_area_encloses_racetrack_with_growing_downwind_buffer() {
    let heading = 356.0;
    let leg_nm = resolve_hold_leg_length_nm(None, Some(1.0), 4400.0);
    let racetrack = build_hold_points(Vec2::new(0.0, 0.0), heading, leg_nm, 4400.0, "R", 1.0);
    let area = build_hold_protected_area(0.0, 0.0, heading, leg_nm, 4400.0, "R", 1.0);

    // Closed rings at the hold altitude.
    assert!(area.primary.len() > 100);
    assert_eq!(area.primary.first(), area.primary.last());
    assert_eq!(area.secondary.first(), area.secondary.last());
    assert!((area.primary[0].y - crate::coords::alt_to_y(4400.0, 1.0)).abs() < 1e-9);

    // Every racetrack point sits at least the base buffer inside the primary
    // ring: its distance to the nearest ring point exceeds a coarse bound and
    // the ring's support in every direction clears the point by the buffer.
    let support = |ring: &[Point3], dir: (f64, f64)| {
        ring.iter()
            .map(|p| p.x * dir.0 + p.z * dir.1)
            .fold(f64::MIN, f64::max)
    };
    for step in 0..24 {
        let theta = step as f64 / 24.0 * std::f64::consts::TAU;
        let dir = (theta.cos(), theta.sin());
        let racetrack_support = racetrack
            .iter()
            .map(|p| p.x * dir.0 + p.z * dir.1)
            .fold(f64::MIN, f64::max);
        let primary_support = support(&area.primary, dir);
        assert!(
            primary_support >= racetrack_support + HOLD_TEMPLATE_BASE_BUFFER_NM - 0.05,
            "primary boundary hugs the racetrack too closely along {theta}"
        );
        // Secondary ring is the primary plus the fixed secondary width.
        let secondary_support = support(&area.secondary, dir);
        assert!((secondary_support - primary_support - HOLD_SECONDARY_WIDTH_NM).abs() < 0.05);
    }

    // The buffer grows with elapsed pattern time, so the boundary reaches
    // farther on the outbound end (flown last before returning to the fix)
    // than the base buffer alone.
    let outbound_dir_rad = (heading + 180.0_f64).to_radians();
    let outbound = (outbound_dir_rad.sin(), -outbound_dir_rad.cos());
    let racetrack_outbound = racetrack
        .iter()
        .map(|p| p.x * outbound.0 + p.z * outbound.1)
        .fold(f64::MIN, f64::max);
    assert!(
        support(&area.primary, outbound) > racetrack_outbound + HOLD_TEMPLATE_BASE_BUFFER_NM + 0.3,
        "no downwind growth on the outbound end"
    );
}

#[test]
fn hold_protected_area_mirrors_with_turn_direction() {
    let leg_nm = 4.0;
    let right = build_hold_protected_area(0.0, 0.0, 0.0, leg_nm, 3000.0, "R", 1.0);
    let left = build_hold_protected_area(0.0, 0.0, 0.0, leg_nm, 3000.0, "L", 1.0);
    // Inbound course 000 true: right turns put the racetrack east (+x), left
    // turns put it west; the protected areas must lean the same way. Support
    // sampling emits unevenly spaced vertices, so use the polygon (shoelace)
    // centroid, which depends only on the boundary geometry.
    let area_centroid_x = |ring: &[Point3]| {
        let mut area2 = 0.0;
        let mut moment_x = 0.0;
        for pair in ring.windows(2) {
            let cross = pair[0].x * pair[1].z - pair[1].x * pair[0].z;
            area2 += cross;
            moment_x += (pair[0].x + pair[1].x) * cross;
        }
        moment_x / (3.0 * area2)
    };
    let right_cx = area_centroid_x(&right.primary);
    let left_cx = area_centroid_x(&left.primary);
    // The swept pattern uses the true holding-speed turn radius, so the
    // envelope leans clearly to the holding side.
    assert!(right_cx > left_cx + 0.6, "no lean: right {right_cx}, left {left_cx}");
    assert!((right_cx + left_cx).abs() < 1e-6, "mirror not symmetric");
}
