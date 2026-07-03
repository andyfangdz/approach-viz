// Split from the original single-file approach_path module; behavior is
// unchanged. Public API is re-exported from this module root.

use std::collections::HashMap;
use crate::coords;

use super::*;

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

pub(crate) fn build_path_geometry_internal(
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
    let mut skip_next_leg = false;

    for (leg_index, leg) in legs.iter().enumerate() {
        if std::mem::take(&mut skip_next_leg) {
            continue;
        }
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

        if is_course_from_fix_leg(&leg.path_terminator)
            && waypoint.is_some()
            && leg.course.is_some_and(|course| course.is_finite())
        {
            // Outbound course-from-fix leg (teardrop/course-reversal outbound,
            // e.g. KDDC I14 FLACK transition `FC` at OWENJ). Anchor at the fix
            // and project an outbound segment along the published course so the
            // leg is drawn rather than collapsing onto the fix waypoint.
            let fix_wp = waypoint.unwrap();
            let (fix_x, fix_z) = coords::lat_lon_to_local(fix_wp.lat, fix_wp.lon, ref_lat, ref_lon);
            push_point(&mut points, Vec3::new(fix_x, y, fix_z));

            let heading_true = coords::magnetic_to_true_heading(leg.course.unwrap(), mag_var);
            let heading_rad = heading_true.to_radians();
            let distance_nm = leg
                .distance
                .filter(|distance| distance.is_finite() && *distance > 0.0)
                .unwrap_or(COURSE_FROM_FIX_DEFAULT_DISTANCE_NM);
            current_point = Some(Vec3::new(
                fix_x + heading_rad.sin() * distance_nm,
                y,
                fix_z - heading_rad.cos() * distance_nm,
            ));
            last_leg_course_heading_true = Some(heading_true);
        } else if leg.path_terminator == "PI" && waypoint.is_some() {
            // Procedure turn (charted barb PT, e.g. KACK VOR RWY 24 at ACK):
            // outbound on the reciprocal of the inbound course, 45° excursion
            // leg on the published course, 180° reversal, then roll out on the
            // inbound course outbound of the fix. The following course-to-fix
            // leg (`CF` back to the same fix) draws the inbound course itself.
            let fix_wp = waypoint.unwrap();
            let (fix_x, fix_z) = coords::lat_lon_to_local(fix_wp.lat, fix_wp.lon, ref_lat, ref_lon);
            let inbound_leg = legs.get(leg_index + 1).filter(|next_leg| {
                is_fix_join_terminator(Some(next_leg.path_terminator.as_str()))
                    && next_leg.course.is_some_and(|course| course.is_finite())
            });
            let inbound_course_true = inbound_leg
                .map(|next_leg| coords::magnetic_to_true_heading(next_leg.course.unwrap(), mag_var));
            let excursion_course_true = leg
                .course
                .filter(|course| course.is_finite())
                .map(|course| coords::magnetic_to_true_heading(course, mag_var));
            if let Some((turn_points, inbound_true)) = build_procedure_turn_points(
                Vec2::new(fix_x, fix_z),
                excursion_course_true,
                inbound_course_true,
                leg.turn_direction.as_deref(),
                leg.distance,
                inbound_leg.is_none(),
                y,
            ) {
                current_point = turn_points.last().copied();
                heading_transition_points = Some(turn_points);
                last_leg_course_heading_true = Some(inbound_true);
                pending_course_to_fix_turn_heading = None;
                pending_course_to_fix_turn_direction = None;
                pending_course_to_fix_prefers_course_intercept = false;
            } else {
                // No usable course data: keep the pre-existing draw-to-fix
                // behavior rather than fabricating a reversal shape.
                current_point = Some(Vec3::new(fix_x, y, fix_z));
                last_leg_course_heading_true = None;
            }
        } else if let Some(waypoint) = waypoint {
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

            // Teardrop/course-reversal inbound side: an intercept leg (`CI`/`VI`)
            // immediately after a course-from-fix outbound leg, joining a
            // downstream final approach course fix. Render the reversal as a
            // single smooth circular arc through the outbound fix and the
            // outbound apex that rolls out tangent onto the final approach course
            // at an interior point (no straight outbound leg), terminating at
            // that roll-out point (for example `KDDC I14` `FLACK` at OWENJ).
            let previous_is_course_from_fix = leg_index
                .checked_sub(1)
                .and_then(|index| legs.get(index))
                .is_some_and(|previous| is_course_from_fix_leg(&previous.path_terminator));
            let course_reversal_arc = if matches!(leg.path_terminator.as_str(), "CI" | "VI")
                && previous_is_course_from_fix
                && points.len() >= 2
            {
                next_leg
                    .filter(|next_leg| {
                        is_fix_join_terminator(Some(next_leg.path_terminator.as_str()))
                            && next_leg.course.is_some_and(|course| course.is_finite())
                    })
                    .and_then(|localizer_leg| {
                        let localizer_wp = resolve_waypoint(waypoints, &localizer_leg.waypoint_id)?;
                        let (localizer_x, localizer_z) = coords::lat_lon_to_local(
                            localizer_wp.lat,
                            localizer_wp.lon,
                            ref_lat,
                            ref_lon,
                        );
                        let localizer_course_true =
                            coords::magnetic_to_true_heading(localizer_leg.course.unwrap(), mag_var);
                        // Outbound apex (last plotted) and outbound fix (before it).
                        let apex = *points.last().unwrap();
                        let outbound_fix_2 = Vec2::new(points[points.len() - 2].x, points[points.len() - 2].z);
                        // Cap the apex distance so a long outbound leg does not
                        // bulge the loop far past the course fix (keeps the
                        // teardrop compact, near the course fix's level).
                        let outbound_vec = Vec2::new(apex.x, apex.z).sub(outbound_fix_2);
                        let outbound_len = outbound_vec.len();
                        let apex_2 = if outbound_len > 1e-6 {
                            let capped = outbound_len.min(TEARDROP_MAX_OUTBOUND_NM);
                            outbound_fix_2.add(outbound_vec.scale(capped / outbound_len))
                        } else {
                            Vec2::new(apex.x, apex.z)
                        };
                        let rollout = course_reversal_rollout_point(
                            outbound_fix_2,
                            apex_2,
                            Vec2::new(localizer_x, localizer_z),
                            localizer_course_true,
                        )?;
                        Some((
                            build_arc_through_three_points(outbound_fix_2, apex_2, rollout, y),
                            localizer_course_true,
                        ))
                    })
            } else {
                None
            };

            if let Some((arc_points, localizer_course_true)) = course_reversal_arc {
                // Drop the straight outbound apex; the reversal arc starts at the
                // outbound fix and ends at the interior roll-out point.
                points.pop();
                current_point = arc_points.last().copied();
                heading_transition_points = Some(arc_points);
                last_leg_course_heading_true = Some(localizer_course_true);
                pending_course_to_fix_turn_heading = None;
                pending_course_to_fix_turn_direction = None;
                pending_course_to_fix_prefers_course_intercept = false;
                // Terminate the reversal at the roll-out point; the downstream
                // final approach course leg is shown by the final segment.
                skip_next_leg = true;
            } else {
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

                // Fallback when no downstream final approach course is available
                // to roll out onto: a terminal `CI`/`VI` after a course-from-fix
                // outbound leg is still completed as a single broad, continuous
                // turn plus an inbound leg mirroring the outbound distance, so
                // the reversal does not dead-end at a short turn stub.
                //
                // This is deliberately gated on `next_wp.is_none()`: when a client
                // has appended a downstream course leg (`next_wp` is `Some`) the
                // `course_reversal_arc` roll-out above is the intended path. If
                // that roll-out fails (`course_reversal_rollout_point` returns
                // `None` for degenerate geometry — rare for real CIFP teardrops),
                // we intentionally fall through to the standard `CI`/`VI` ->
                // course-intercept join toward that appended fix rather than this
                // no-fix mirror, since the appended course is the better target.
                let reversal_outbound_distance = leg_index
                    .checked_sub(1)
                    .and_then(|index| legs.get(index))
                    .filter(|previous| is_course_from_fix_leg(&previous.path_terminator))
                    .and_then(|previous| previous.distance)
                    .filter(|distance| distance.is_finite() && *distance > 0.0);
                if next_wp.is_none()
                    && matches!(leg.path_terminator.as_str(), "CI" | "VI")
                    && reversal_outbound_distance.is_some()
                {
                    let outbound_distance_nm = reversal_outbound_distance.unwrap();
                    let inbound_length_nm = outbound_distance_nm.clamp(1.0, MAX_REVERSAL_INBOUND_NM);
                    let reversal_radius_nm = (outbound_distance_nm * 0.25)
                        .clamp(REVERSAL_TURN_MIN_RADIUS_NM, REVERSAL_TURN_MAX_RADIUS_NM);
                    let mut reversal_points = last_leg_course_heading_true
                        .map(|outbound_heading_true| {
                            build_heading_transition_arc_points(
                                last_plotted_point,
                                outbound_heading_true,
                                heading_true,
                                y,
                                leg.turn_direction.as_deref(),
                                reversal_radius_nm,
                            )
                        })
                        .unwrap_or_default();
                    let inbound_start =
                        reversal_points.last().copied().unwrap_or(last_plotted_point);
                    let inbound_end = Vec3::new(
                        inbound_start.x + heading_rad.sin() * inbound_length_nm,
                        y,
                        inbound_start.z - heading_rad.cos() * inbound_length_nm,
                    );
                    reversal_points.push(inbound_end);
                    current_point = Some(inbound_end);
                    heading_transition_points = Some(reversal_points);
                }

                pending_course_to_fix_turn_heading = Some(heading_true);
                pending_course_to_fix_turn_direction = if is_fix_join_terminator(next_leg.map(|leg| leg.path_terminator.as_str())) {
                    next_leg.and_then(|leg| leg.turn_direction.clone())
                } else {
                    None
                };
                pending_course_to_fix_prefers_course_intercept = true;
                last_leg_course_heading_true = Some(heading_true);
            }
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
                let arc_center = Vec2::new(center_x, center_z);
                let arc_turn_direction = leg.rf_turn_direction.as_deref().unwrap_or("R");
                // When the arc terminates by joining an inbound course (the next
                // leg is a course-carrying fix leg), roll out of the arc with a
                // lead turn near the fix — matching the charted lead-radial turn —
                // instead of cornering sharply onto the inbound course. The
                // downstream course is then drawn by the segment that owns it, so
                // consume the appended inbound leg here.
                let lead_turn = legs
                    .get(leg_index + 1)
                    .filter(|next_leg| {
                        is_fix_join_terminator(Some(next_leg.path_terminator.as_str()))
                            && next_leg.course.is_some_and(|course| course.is_finite())
                    })
                    .and_then(|inbound_leg| {
                        let inbound_course_true = coords::magnetic_to_true_heading(
                            inbound_leg.course.unwrap(),
                            mag_var,
                        );
                        build_dme_arc_lead_turn(
                            arc_center,
                            Vec2::new(current_point.x, current_point.z),
                            arc_turn_direction,
                            inbound_course_true,
                            DME_ARC_LEAD_TURN_RADIUS_NM,
                            current_point.y,
                        )
                    });
                if let Some((lead_point, fillet_points)) = lead_turn {
                    for arc_point in build_rf_arc_points(
                        previous_point.unwrap(),
                        lead_point,
                        arc_center,
                        arc_turn_direction,
                    ) {
                        push_point(&mut points, arc_point);
                    }
                    for fillet_point in fillet_points {
                        push_point(&mut points, fillet_point);
                    }
                    skip_next_leg = true;
                } else {
                    for arc_point in build_rf_arc_points(
                        previous_point.unwrap(),
                        current_point,
                        arc_center,
                        arc_turn_direction,
                    ) {
                        push_point(&mut points, arc_point);
                    }
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


pub(crate) fn build_rf_arc_points(start: Vec3, end: Vec3, center: Vec2, turn_direction: &str) -> Vec<Vec3> {
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


/// Where an `AF`/`RF` DME-arc leg terminating at `arc_fix` rolls out onto an
/// inbound course, build a tangent lead turn (a fillet of radius
/// `turn_radius_nm`): the path leaves the arc at a lead point and rolls out on
/// the inbound course near the fix, matching the charted lead-radial turn
/// instead of cornering sharply at the fix.
///
/// Returns `(lead_point_on_arc, fillet_points)` where `fillet_points` ends at
/// the roll-out point on the inbound course, or `None` when no valid tangent
/// fillet exists (degenerate geometry — e.g. a near-radial inbound course or a
/// turn radius too large for the arc), so the caller falls back to the full
/// arc. Works in local NM (`Vec2 { x = east, y = local z }`), matching
/// `build_rf_arc_points` (turn direction `"R"` decreases the polar angle, `"L"`
/// increases it; a point at angle `θ` is `(cx + cosθ·r, cy − sinθ·r)`).
pub(crate) fn build_dme_arc_lead_turn(
    arc_center: Vec2,
    arc_fix: Vec2,
    arc_turn_direction: &str,
    inbound_course_true_deg: f64,
    turn_radius_nm: f64,
    y: f64,
) -> Option<(Vec3, Vec<Vec3>)> {
    let r = turn_radius_nm;
    let w = arc_fix.sub(arc_center);
    let arc_radius = w.len();
    if !arc_radius.is_finite() || arc_radius <= r * 1.1 {
        return None;
    }
    let course_rad = inbound_course_true_deg.to_radians();
    // Inbound direction unit vector (east, local z).
    let u = Vec2::new(course_rad.sin(), -course_rad.cos());
    // Unit normal toward the arc center: the component of (center - fix)
    // perpendicular to the inbound course.
    let to_center = arc_center.sub(arc_fix);
    let n_raw = to_center.sub(u.scale(to_center.dot(u)));
    if n_raw.len() < 1e-6 {
        return None; // inbound course is ~radial; the corner is ill-defined
    }
    let n_in = n_raw.normalize();
    let wu = w.dot(u);
    let fix_angle = (-w.y).atan2(w.x);
    let turn_sign = if arc_turn_direction == "R" { -1.0 } else { 1.0 };

    // The lead turn fillet is tangent to both the DME arc and the inbound course
    // line, and must curve the same rotational way the arc is being flown so the
    // path stays smooth at the lead point (no cusp). Its center can sit on either
    // side of the inbound course line (offset `±r·n_in`) and be tangent to the
    // arc internally (`arc_radius − r`) or externally (`arc_radius + r`); which
    // combination is the correct lead turn depends on the arc's approach side and
    // turn direction. Enumerate all four and keep the candidate whose fillet
    // enters tangent to the arc in the travel direction and rolls out established
    // on the inbound course, with the roll-out tightest to the fix.
    let mut best: Option<(f64, Vec3, Vec<Vec3>)> = None;
    for &(normal, target) in &[
        (n_in, arc_radius - r),
        (n_in, arc_radius + r),
        (n_in.scale(-1.0), arc_radius - r),
        (n_in.scale(-1.0), arc_radius + r),
    ] {
        let wn = w.dot(normal);
        // Solve |fix + a·u + r·normal − arc_center| = target for the along-course
        // offset `a` of the fillet center.
        let disc = wu * wu - (arc_radius * arc_radius + r * r + 2.0 * r * wn - target * target);
        if disc < 0.0 {
            continue;
        }
        let sqrt_disc = disc.sqrt();
        for a in [-wu + sqrt_disc, -wu - sqrt_disc] {
            let center = arc_fix.add(u.scale(a)).add(normal.scale(r));
            let center_offset = center.sub(arc_center);
            let center_offset_len = center_offset.len();
            if center_offset_len < 1e-6 {
                continue;
            }
            // Lead point: where the ray arc_center→fillet-center crosses the arc.
            let lead = arc_center.add(center_offset.scale(arc_radius / center_offset_len));
            let lead_offset = lead.sub(arc_center);
            let lead_angle = (-lead_offset.y).atan2(lead_offset.x);
            // Where the lead point sits relative to the fix along the arc, signed
            // by the direction of travel (positive = a true lead before the fix;
            // small negative = a slight overshoot past the fix, still acceptable).
            let mut lead_ahead = turn_sign * (fix_angle - lead_angle);
            while lead_ahead > PI {
                lead_ahead -= 2.0 * PI;
            }
            while lead_ahead < -PI {
                lead_ahead += 2.0 * PI;
            }
            if lead_ahead <= -0.25 || lead_ahead >= PI * 0.75 {
                continue;
            }
            // The arc's travel heading at the lead point (the fillet must enter
            // tangent in this direction to avoid a cusp at the lead point).
            let travel = if arc_turn_direction == "R" {
                Vec2::new(-lead_offset.y, lead_offset.x)
            } else {
                Vec2::new(lead_offset.y, -lead_offset.x)
            };
            // Roll-out point: the foot of the perpendicular from the fillet center
            // to the inbound course line (the center sits `r·normal` off it).
            let rollout = arc_fix.add(u.scale(a));
            let Some((fillet, sweep)) = build_fillet_arc(center, lead, travel, rollout, r, y) else {
                continue;
            };
            // Keep the gentle lead turn: a corner-rounding turn sweeps well under
            // half a circle. Larger sweeps are the wrong-way-around solutions.
            if sweep >= PI * 1.1 {
                continue;
            }
            // The fillet must roll out established on the inbound course (heading
            // `u`), not back onto it from the wrong side.
            if fillet.len() < 2 {
                continue;
            }
            let last = fillet[fillet.len() - 1];
            let prev = fillet[fillet.len() - 2];
            let exit = Vec2::new(last.x - prev.x, last.z - prev.z);
            if exit.len() < 1e-6 || exit.normalize().dot(u) < 0.98 {
                continue;
            }
            let mut fillet = fillet;
            // When the roll-out lands short of the fix (the inbound course line is
            // drawn from the fix onward by the segment that owns it), continue
            // straight to the fix so the lead turn connects to it without a gap.
            if a < -1e-3 {
                fillet.push(Vec3::new(arc_fix.x, y, arc_fix.y));
            }
            // Prefer the gentlest turn (smallest sweep) — the natural lead turn.
            if best.as_ref().is_none_or(|(best_sweep, _, _)| sweep < *best_sweep) {
                best = Some((sweep, Vec3::new(lead.x, y, lead.y), fillet));
            }
        }
    }
    best.map(|(_, lead, fillet)| (lead, fillet))
}

/// Points along the circular arc (radius `r`, center `center`) from `from` to
/// `to`, swept in whichever rotational direction leaves `from` tangent to
/// `initial_heading` (so the arc continues smoothly from an incoming path with
/// that heading), plus the absolute sweep angle (radians). In the
/// `build_rf_arc_points` angle convention a point at angle `θ` is
/// `(cx + cosθ·r, cy − sinθ·r)`. Returns `None` for degenerate input.
fn build_fillet_arc(
    center: Vec2,
    from: Vec2,
    initial_heading: Vec2,
    to: Vec2,
    r: f64,
    y: f64,
) -> Option<(Vec<Vec3>, f64)> {
    let from_offset = from.sub(center);
    let to_offset = to.sub(center);
    if from_offset.len() < 1e-6 || to_offset.len() < 1e-6 || initial_heading.len() < 1e-6 {
        return None;
    }
    let from_angle = (-from_offset.y).atan2(from_offset.x);
    let to_angle = (-to_offset.y).atan2(to_offset.x);
    // Tangent at `from` for increasing polar angle; pick the sweep direction
    // whose tangent agrees with the requested entry heading.
    let tangent_increasing = Vec2::new(-from_angle.sin(), -from_angle.cos());
    let increasing = tangent_increasing.dot(initial_heading) >= 0.0;
    let mut delta = to_angle - from_angle;
    if increasing {
        while delta <= 0.0 {
            delta += 2.0 * PI;
        }
    } else {
        while delta >= 0.0 {
            delta -= 2.0 * PI;
        }
    }
    let steps = ((delta.abs() / (PI / 24.0)).ceil() as usize).max(6);
    let mut points = Vec::with_capacity(steps);
    for step in 1..=steps {
        let t = step as f64 / steps as f64;
        let angle = from_angle + delta * t;
        points.push(Vec3::new(
            center.x + angle.cos() * r,
            y,
            center.y - angle.sin() * r,
        ));
    }
    Some((points, delta.abs()))
}

pub(crate) fn build_course_to_fix_turn_points(
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


/// Build the circular arc that passes through three points (`p0` -> `p1` ->
/// `p2`), sweeping the direction that goes through `p1`. Returned points run
/// from just after `p0` to `p2`. Used to render a teardrop/course-reversal as a
/// single smooth curve (outbound fix -> outbound apex -> roll-out fix) with no
/// straight outbound leg, terminating on the final approach course fix.
pub(crate) fn build_arc_through_three_points(p0: Vec2, p1: Vec2, p2: Vec2, y: f64) -> Vec<Vec3> {
    let d = 2.0 * (p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y));
    if d.abs() < 1e-9 {
        // Degenerate (collinear): fall back to a straight segment.
        return vec![Vec3::new(p1.x, y, p1.y), Vec3::new(p2.x, y, p2.y)];
    }
    let p0_sq = p0.x * p0.x + p0.y * p0.y;
    let p1_sq = p1.x * p1.x + p1.y * p1.y;
    let p2_sq = p2.x * p2.x + p2.y * p2.y;
    let center = Vec2::new(
        (p0_sq * (p1.y - p2.y) + p1_sq * (p2.y - p0.y) + p2_sq * (p0.y - p1.y)) / d,
        (p0_sq * (p2.x - p1.x) + p1_sq * (p0.x - p2.x) + p2_sq * (p1.x - p0.x)) / d,
    );
    let radius = p0.sub(center).len();
    let two_pi = PI * 2.0;
    let normalize_positive = |value: f64| {
        let mut wrapped = value % two_pi;
        if wrapped < 0.0 {
            wrapped += two_pi;
        }
        wrapped
    };
    let start_angle = (p0.y - center.y).atan2(p0.x - center.x);
    let through_ccw = normalize_positive((p1.y - center.y).atan2(p1.x - center.x) - start_angle);
    let end_ccw = normalize_positive((p2.y - center.y).atan2(p2.x - center.x) - start_angle);
    // Sweep counter-clockwise from p0 if the mid point lies on that side,
    // otherwise clockwise; either way the arc passes through p1.
    let (total, counter_clockwise) = if through_ccw <= end_ccw + 1e-9 {
        (end_ccw, true)
    } else {
        (two_pi - end_ccw, false)
    };

    let steps = ((total / (PI / 48.0)).ceil() as usize).max(16);
    let mut points = Vec::with_capacity(steps);
    for step in 1..=steps {
        let t = step as f64 / steps as f64;
        let angle = if counter_clockwise {
            start_angle + total * t
        } else {
            start_angle - total * t
        };
        points.push(Vec3::new(
            center.x + angle.cos() * radius,
            y,
            center.y + angle.sin() * radius,
        ));
    }
    points
}


/// Roll-out point for a teardrop/course-reversal: where the circle through the
/// outbound fix and the outbound apex, tangent to the final approach course line
/// (through `line_point`, heading `line_course_true_deg`), touches that line —
/// an interior point on the course, not the course fix. `None` when no feasible
/// tangent circle exists.
pub(crate) fn course_reversal_rollout_point(
    outbound_fix: Vec2,
    apex: Vec2,
    line_point: Vec2,
    line_course_true_deg: f64,
) -> Option<Vec2> {
    let chord = apex.sub(outbound_fix);
    if chord.len() < 1e-6 {
        return None;
    }
    let perp = Vec2::new(-chord.y, chord.x);
    let mid = Vec2::new((outbound_fix.x + apex.x) * 0.5, (outbound_fix.y + apex.y) * 0.5);
    let line_rad = line_course_true_deg.to_radians();
    let line_dir = Vec2::new(line_rad.sin(), -line_rad.cos());
    let line_normal = Vec2::new(-line_dir.y, line_dir.x);

    let a = mid.sub(outbound_fix);
    let aa = a.dot(a);
    let ap = a.dot(perp);
    let pp = perp.dot(perp);
    let b = mid.sub(line_point);
    let bn = b.dot(line_normal);
    let pn = perp.dot(line_normal);
    let qa = pn * pn - pp;
    let qb = 2.0 * bn * pn - 2.0 * ap;
    let qc = bn * bn - aa;

    let mut best_t: Option<(f64, f64)> = None;
    let mut consider = |t: f64| {
        let center = mid.add(perp.scale(t));
        let radius = center.sub(outbound_fix).len();
        if radius.is_finite()
            && radius > ROLLOUT_RADIUS_MIN_NM
            && radius < ROLLOUT_RADIUS_MAX_NM
            && best_t.is_none_or(|(r, _)| radius < r)
        {
            best_t = Some((radius, t));
        }
    };
    if qa.abs() < 1e-9 {
        if qb.abs() > 1e-9 {
            consider(-qc / qb);
        }
    } else {
        let disc = qb * qb - 4.0 * qa * qc;
        if disc >= 0.0 {
            let root = disc.sqrt();
            consider((-qb + root) / (2.0 * qa));
            consider((-qb - root) / (2.0 * qa));
        }
    }
    let (_, t) = best_t?;
    let center = mid.add(perp.scale(t));
    let along = center.sub(line_point).dot(line_dir);
    Some(line_point.add(line_dir.scale(along)))
}


pub(crate) fn build_heading_to_course_intercept_points(
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


pub(crate) fn build_heading_transition_arc_points(
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


/// Build the points of a charted 45°/180° procedure turn (`PI` leg) anchored at
/// `fix`: outbound on the reciprocal of the inbound course, a 45° turn onto the
/// published excursion (barb) course, a straight excursion leg, a 180° reversal
/// turn, then an intercept back to the inbound course with a tangent roll-out,
/// ending on the course outbound of the fix. The CIFP publishes the excursion
/// course (`excursion_course_true_deg`), the remain-within limit (`limit_nm`),
/// and the reversal turn direction; the inbound course comes from the following
/// course-to-fix leg when available, otherwise it is derived from the excursion
/// course and reversal direction (the excursion leg is 45° off the outbound).
///
/// Returns `(points, inbound_course_true_deg)` — `points` starts at the fix and
/// ends established on the inbound course (extended to the fix itself when
/// `extend_inbound_to_fix` is set, for a `PI` with no following course leg) —
/// or `None` when neither the excursion course nor an inbound course is
/// available to orient the maneuver.
pub(crate) fn build_procedure_turn_points(
    fix: Vec2,
    excursion_course_true_deg: Option<f64>,
    inbound_course_true_deg: Option<f64>,
    reversal_turn_direction: Option<&str>,
    limit_nm: Option<f64>,
    extend_inbound_to_fix: bool,
    y: f64,
) -> Option<(Vec<Vec3>, f64)> {
    let normalize_signed_delta_deg = |delta: f64| {
        let mut normalized = (((delta + 180.0) % 360.0) + 360.0) % 360.0 - 180.0;
        if normalized <= -180.0 {
            normalized += 360.0;
        }
        normalized
    };
    // The excursion leg sits 45° off the outbound course, on the side opposite
    // the reversal turn (left barb pairs with a right reversal and vice versa).
    let excursion_offset_sign = if reversal_turn_direction == Some("L") {
        1.0
    } else {
        -1.0
    };
    let (inbound_true, excursion_true) = match (inbound_course_true_deg, excursion_course_true_deg)
    {
        (Some(inbound), Some(excursion)) => (inbound, excursion),
        (Some(inbound), None) => (
            inbound,
            coords::normalize_heading(inbound + 180.0 + excursion_offset_sign * 45.0),
        ),
        (None, Some(excursion)) => (
            coords::normalize_heading(excursion - excursion_offset_sign * 45.0 + 180.0),
            excursion,
        ),
        (None, None) => return None,
    };
    let outbound_true = coords::normalize_heading(inbound_true + 180.0);
    let initial_delta = normalize_signed_delta_deg(excursion_true - outbound_true);
    if initial_delta.abs() < 5.0 || initial_delta.abs() > 135.0 {
        return None; // excursion course inconsistent with the outbound course
    }
    let initial_turn = if initial_delta >= 0.0 { "R" } else { "L" };
    let reversal_turn = if initial_delta >= 0.0 { "L" } else { "R" };

    let dir_of = |heading_true: f64| {
        let rad = heading_true.to_radians();
        Vec2::new(rad.sin(), -rad.cos())
    };
    let outbound_dir = dir_of(outbound_true);
    let excursion_dir = dir_of(excursion_true);
    let inbound_dir = dir_of(inbound_true);
    let reciprocal_true = coords::normalize_heading(excursion_true + 180.0);
    let reciprocal_dir = dir_of(reciprocal_true);

    let limit = limit_nm
        .filter(|limit| limit.is_finite() && *limit > 0.0)
        .unwrap_or(PROCEDURE_TURN_DEFAULT_LIMIT_NM);
    let outbound_nm = (limit * PROCEDURE_TURN_OUTBOUND_LIMIT_FRACTION)
        .clamp(PROCEDURE_TURN_MIN_OUTBOUND_NM, PROCEDURE_TURN_MAX_OUTBOUND_NM);
    let radius = PROCEDURE_TURN_RADIUS_NM;

    let mut points = vec![Vec3::new(fix.x, y, fix.y)];
    let turn_start = fix.add(outbound_dir.scale(outbound_nm));
    points.push(Vec3::new(turn_start.x, y, turn_start.y));
    points.extend(build_heading_transition_arc_points(
        Vec3::new(turn_start.x, y, turn_start.y),
        outbound_true,
        excursion_true,
        y,
        Some(initial_turn),
        radius,
    ));
    let excursion_start = points.last().copied().unwrap();
    let excursion_end = Vec2::new(excursion_start.x, excursion_start.z)
        .add(excursion_dir.scale(PROCEDURE_TURN_EXCURSION_NM));
    points.push(Vec3::new(excursion_end.x, y, excursion_end.y));
    points.extend(build_heading_transition_arc_points(
        Vec3::new(excursion_end.x, y, excursion_end.y),
        excursion_true,
        reciprocal_true,
        y,
        Some(reversal_turn),
        radius,
    ));
    let reversal_end = points.last().copied().unwrap();

    // Intercept of the post-reversal track with the inbound course line through
    // the fix: reversal_end + t·reciprocal_dir = fix + s·inbound_dir.
    let denominator = reciprocal_dir.x * inbound_dir.y - reciprocal_dir.y * inbound_dir.x;
    if denominator.abs() < 1e-6 {
        return None;
    }
    let delta = fix.sub(Vec2::new(reversal_end.x, reversal_end.z));
    let t = (delta.x * inbound_dir.y - delta.y * inbound_dir.x) / denominator;
    if t <= 0.0 {
        return None; // reversal rolled out past the course line
    }
    let intercept = Vec2::new(reversal_end.x, reversal_end.z).add(reciprocal_dir.scale(t));
    // The roll-out must land outbound of the fix so the inbound course leg that
    // follows still has a run back to the fix.
    if fix.sub(intercept).dot(inbound_dir) <= 0.2 {
        return None;
    }
    let intercept_delta_deg =
        normalize_signed_delta_deg(inbound_true - reciprocal_true).abs();
    let fillet_tangent_nm = radius * (intercept_delta_deg.to_radians() * 0.5).tan();
    if t > fillet_tangent_nm + 0.05 {
        let fillet_start = intercept.sub(reciprocal_dir.scale(fillet_tangent_nm));
        points.push(Vec3::new(fillet_start.x, y, fillet_start.y));
        points.extend(build_heading_transition_arc_points(
            Vec3::new(fillet_start.x, y, fillet_start.y),
            reciprocal_true,
            inbound_true,
            y,
            Some(reversal_turn),
            radius,
        ));
    } else {
        points.push(Vec3::new(intercept.x, y, intercept.y));
    }
    if extend_inbound_to_fix {
        points.push(Vec3::new(fix.x, y, fix.y));
    }
    Some((points, inbound_true))
}

