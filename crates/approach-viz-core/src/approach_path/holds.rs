// Split from the original single-file approach_path module; behavior is
// unchanged. Public API is re-exported from this module root.

use crate::coords;

use super::*;

/// Resolve a hold's straight-leg length in NM from what the CIFP publishes.
/// A published distance wins as-is. A published time (or, when neither is
/// published, the standard pattern timing — 1 minute at or below 14,000 ft
/// MSL, 1.5 minutes above) is flown at the FAA maximum holding airspeed for
/// the hold altitude (AIM 5-3-8), converted from indicated to true airspeed
/// with the standard ~2%-per-1,000-ft rule, so a 1-minute hold at altitude
/// renders at the ground distance that timing actually covers.
pub fn resolve_hold_leg_length_nm(
    hold_distance_nm: Option<f64>,
    hold_time_minutes: Option<f64>,
    altitude_feet: f64,
) -> f64 {
    if let Some(distance) =
        hold_distance_nm.filter(|distance| distance.is_finite() && *distance > 0.0)
    {
        return distance;
    }
    let altitude = if altitude_feet.is_finite() {
        altitude_feet.max(0.0)
    } else {
        0.0
    };
    let time_minutes = hold_time_minutes
        .filter(|time| time.is_finite() && *time > 0.0)
        .unwrap_or(if altitude <= HOLD_IAS_MID_CEILING_FT {
            HOLD_STANDARD_TIME_LOW_MIN
        } else {
            HOLD_STANDARD_TIME_HIGH_MIN
        });
    max_holding_tas_kt(altitude) * time_minutes / 60.0
}

/// FAA maximum holding airspeed for the altitude (AIM 5-3-8 tiers), converted
/// from indicated to true airspeed with the standard ~2%-per-1,000-ft rule.
pub(crate) fn max_holding_tas_kt(altitude_feet: f64) -> f64 {
    let altitude = if altitude_feet.is_finite() {
        altitude_feet.max(0.0)
    } else {
        0.0
    };
    let max_ias_kt = if altitude <= HOLD_IAS_LOW_CEILING_FT {
        HOLD_MAX_IAS_LOW_KT
    } else if altitude <= HOLD_IAS_MID_CEILING_FT {
        HOLD_MAX_IAS_MID_KT
    } else {
        HOLD_MAX_IAS_HIGH_KT
    };
    max_ias_kt * (1.0 + HOLD_TAS_FACTOR_PER_1000_FT * altitude / 1000.0)
}

/// Build the hold's protected area per FAA Order 8260.3F (TERPS) chapter 16
/// as closed primary and secondary boundary rings at the hold altitude.
///
/// The pattern number comes from table 16-3-1 (RNAV column) via the AIM 5-3-8
/// maximum-holding-speed tier for the altitude; the primary boundary follows
/// the section 16-6-2 construction sequence (figure 16-6-1) using the table
/// 16-6-1 dimensions: course line A-L-M-G through the fix L, perpendicular
/// offset points B/I at the fix end and E/F/H at the outbound end, a fix-end
/// cap arc about L (radius L-B) joined by a tangent line to E, outbound-end
/// arcs E-F and F-H of radius F-M, the I-H baseline, and an I-B closing arc of
/// radius L-B. When the resolved leg length exceeds the pattern's L-M
/// dimension (long DME/RNAV legs), L-M is stretched by the excess — an
/// approximation of the section 16-13 leg-length areas, which are not
/// embedded. The secondary ring surrounds the primary at the fixed 2 NM width
/// of paragraph 16-2-4.b. The published construction is right-hand; left-hand
/// patterns mirror it (16-6-2).
pub fn build_hold_protected_area(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    leg_length_nm: f64,
    altitude_feet: f64,
    turn_direction: &str,
    vertical_scale: f64,
) -> HoldProtectedArea {
    let altitude = if altitude_feet.is_finite() {
        altitude_feet.max(0.0)
    } else {
        0.0
    };
    let leg_length = if leg_length_nm.is_finite() {
        leg_length_nm.max(0.0)
    } else {
        0.0
    };
    let (_, a_l, l_m, m_g, l_i, m_e, a_b) = *terps_holding_pattern_dimensions(altitude);
    // Long DME/RNAV legs: stretch the pattern body so the outbound end group
    // (M/G/E/H/F) stays beyond the flown leg.
    let l_m = l_m + (leg_length - l_m).max(0.0);

    // Local template frame: fix L at the origin, `s` along the outbound
    // course (L toward M), `t` toward the holding side. The published
    // construction is for right-hand patterns; left-hand mirrors through the
    // course line, which flipping `t` onto the other side accomplishes.
    let point_a = Vec2::new(-a_l, 0.0);
    let point_b = Vec2::new(-a_l, a_b);
    let point_i = Vec2::new(0.0, -l_i);
    let point_m = Vec2::new(l_m, 0.0);
    let point_e = Vec2::new(l_m, m_e);
    let point_h = Vec2::new(l_m, -l_i);
    let point_g = Vec2::new(l_m + m_g, 0.0);
    let point_f = Vec2::new(l_m + m_g, a_b);
    let radius_l = point_b.sub(Vec2::new(0.0, 0.0)).len();
    let radius_m = point_f.sub(point_m).len();
    let _ = point_a;
    let _ = point_g;

    let mut outline: Vec<Vec2> = Vec::new();
    // Fix-end cap: arc about L (radius L-B) from B over the top to the point
    // where the straight line to E leaves tangent (16-6-2.e/f).
    let tangent = tangent_point_from_external(Vec2::new(0.0, 0.0), radius_l, point_e);
    push_arc_between(&mut outline, Vec2::new(0.0, 0.0), point_b, tangent, radius_l);
    outline.push(point_e);
    // Outbound-end cap: arcs E-F and F-H of radius F-M, centers found where
    // circles about the endpoints intersect nearest M (16-6-2.h).
    if let Some(center) = arc_center_between(point_e, point_f, radius_m, point_m) {
        push_arc_between(&mut outline, center, point_e, point_f, radius_m);
    } else {
        outline.push(point_f);
    }
    if let Some(center) = arc_center_between(point_f, point_h, radius_m, point_m) {
        push_arc_between(&mut outline, center, point_f, point_h, radius_m);
    } else {
        outline.push(point_h);
    }
    // Baseline I-H (16-6-2.d), then the I-B closing arc of radius L-B
    // (16-6-2.g).
    outline.push(point_i);
    if let Some(center) = arc_center_between(point_i, point_b, radius_l, Vec2::new(0.0, 0.0)) {
        push_arc_between(&mut outline, center, point_i, point_b, radius_l);
    } else {
        outline.push(point_b);
    }

    // Map the template frame into the scene: `s` along the outbound course,
    // `t` toward the holding side (right of the inbound course for right
    // turns), at the hold altitude.
    let heading_rad = heading_deg.to_radians();
    let inbound = Vec2::new(heading_rad.sin(), -heading_rad.cos());
    let outbound = inbound.scale(-1.0);
    let turn_sign = if turn_direction == "L" { -1.0 } else { 1.0 };
    let holding_side = Vec2::new(inbound.y * -1.0, inbound.x).scale(turn_sign);
    let y = coords::alt_to_y(altitude, vertical_scale);
    let to_scene = |p: Vec2| Point3 {
        x: center_x + outbound.x * p.x + holding_side.x * p.y,
        y,
        z: center_z + outbound.y * p.x + holding_side.y * p.y,
    };

    let mut primary: Vec<Point3> = outline.iter().map(|p| to_scene(*p)).collect();
    if let Some(first) = primary.first().copied() {
        primary.push(first);
    }
    // Secondary area: a 2 NM band surrounding the primary perimeter
    // (16-2-4.b). The primary is convex, so the offset is its support
    // envelope expanded by the band width.
    let secondary_steps = 180;
    let mut secondary = Vec::with_capacity(secondary_steps + 1);
    for step in 0..secondary_steps {
        let theta = step as f64 / secondary_steps as f64 * 2.0 * PI;
        let direction = Vec2::new(theta.cos(), theta.sin());
        let mut best: Option<(f64, Vec2)> = None;
        for p in &outline {
            let support = p.dot(direction);
            if best.as_ref().is_none_or(|(current, _)| support > *current) {
                best = Some((support, *p));
            }
        }
        let (_, p) = best.unwrap();
        secondary.push(to_scene(p.add(direction.scale(HOLD_SECONDARY_WIDTH_NM))));
    }
    if let Some(first) = secondary.first().copied() {
        secondary.push(first);
    }
    HoldProtectedArea { primary, secondary }
}

/// Table 16-3-1 pattern number (RNAV column) for the holding altitude, then
/// its table 16-6-1 dimension row. Altitudes select the smallest listed level
/// at or above the hold altitude within the AIM 5-3-8 speed tier; above the
/// last listed level the largest pattern is used.
pub(crate) fn terps_holding_pattern_dimensions(
    altitude_feet: f64,
) -> &'static (u8, f64, f64, f64, f64, f64, f64) {
    let selection: &[(f64, u8)] = if altitude_feet <= HOLD_IAS_LOW_CEILING_FT {
        TERPS_HOLDING_SELECTION_200_KIAS
    } else if altitude_feet <= HOLD_IAS_MID_CEILING_FT {
        TERPS_HOLDING_SELECTION_230_KIAS
    } else {
        TERPS_HOLDING_SELECTION_265_KIAS
    };
    let pattern = selection
        .iter()
        .find(|(level, _)| altitude_feet <= *level)
        .map(|(_, pattern)| *pattern)
        .unwrap_or(selection.last().unwrap().1);
    TERPS_HOLDING_PATTERN_DIMENSIONS
        .iter()
        .find(|(number, ..)| *number == pattern)
        .expect("selection chart only references published pattern numbers")
}

/// Tangent point on circle(center, radius) for the tangent line running to an
/// external point, choosing the holding-side (upper) tangent the construction
/// sequence uses. Falls back to the nearest circle point when the external
/// point is inside the circle (degenerate stretch).
fn tangent_point_from_external(center: Vec2, radius: f64, external: Vec2) -> Vec2 {
    let offset = external.sub(center);
    let distance = offset.len();
    if distance <= radius + 1e-9 {
        return center.add(offset.normalize().scale(radius));
    }
    let base_angle = offset.y.atan2(offset.x);
    let spread = (radius / distance).clamp(-1.0, 1.0).acos();
    let upper = Vec2::new(
        center.x + radius * (base_angle + spread).cos(),
        center.y + radius * (base_angle + spread).sin(),
    );
    let lower = Vec2::new(
        center.x + radius * (base_angle - spread).cos(),
        center.y + radius * (base_angle - spread).sin(),
    );
    if upper.y >= lower.y { upper } else { lower }
}

/// Center for the connecting arc of `radius` through both endpoints, taken at
/// the circle-circle intersection nearer `toward` so the arc bulges away from
/// the pattern body (16-6-2.g/h compass construction). `None` when the radius
/// cannot span the endpoints.
fn arc_center_between(from: Vec2, to: Vec2, radius: f64, toward: Vec2) -> Option<Vec2> {
    let chord = to.sub(from);
    let half = chord.len() / 2.0;
    if half < 1e-9 || radius < half {
        return None;
    }
    let mid = Vec2::new((from.x + to.x) / 2.0, (from.y + to.y) / 2.0);
    let rise = (radius * radius - half * half).sqrt();
    let normal = Vec2::new(-chord.y, chord.x).normalize();
    let candidate_a = mid.add(normal.scale(rise));
    let candidate_b = mid.sub(normal.scale(rise));
    if candidate_a.distance_sq(toward) <= candidate_b.distance_sq(toward) {
        Some(candidate_a)
    } else {
        Some(candidate_b)
    }
}

/// Append the arc of `radius` about `center` from `from` to `to`, sweeping the
/// short way (the connecting arcs of the construction all span less than a
/// half circle). The starting point is included.
fn push_arc_between(outline: &mut Vec<Vec2>, center: Vec2, from: Vec2, to: Vec2, radius: f64) {
    let start_angle = (from.y - center.y).atan2(from.x - center.x);
    let end_angle = (to.y - center.y).atan2(to.x - center.x);
    let mut delta = end_angle - start_angle;
    while delta > PI {
        delta -= 2.0 * PI;
    }
    while delta < -PI {
        delta += 2.0 * PI;
    }
    let steps = ((delta.abs() / (PI / 60.0)).ceil() as usize).max(2);
    for step in 0..=steps {
        let angle = start_angle + delta * step as f64 / steps as f64;
        outline.push(Vec2::new(
            center.x + radius * angle.cos(),
            center.y + radius * angle.sin(),
        ));
    }
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

