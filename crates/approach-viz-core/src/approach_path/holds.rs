// Split from the original single-file approach_path module; behavior is
// unchanged. Public API is re-exported from this module root.

use crate::coords;

use super::*;

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

pub(crate) fn build_hold_points(
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

