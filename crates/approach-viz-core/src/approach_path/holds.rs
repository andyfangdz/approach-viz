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

/// Build the TERPS-style protected area for a hold as closed primary and
/// secondary boundary rings at the hold altitude. The nominal racetrack (same
/// shape as `build_hold_geometry`: fix-anchored, inbound along `heading_deg`)
/// is swept by a protection disk that starts at `HOLD_TEMPLATE_BASE_BUFFER_NM`
/// when crossing the fix and grows with the omnidirectional wind allowance
/// (`HOLD_TEMPLATE_WIND_BASE_KT` + `HOLD_TEMPLATE_WIND_PER_1000_FT_KT`·alt)
/// over elapsed pattern time at the altitude's maximum holding TAS; turns use
/// 25° bank capped at 3°/s. The primary ring is the convex envelope of those
/// disks (via its support function); the secondary ring adds
/// `HOLD_SECONDARY_WIDTH_NM`. Entry-maneuver protection is not modeled.
pub fn build_hold_protected_area(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    leg_length_nm: f64,
    altitude_feet: f64,
    turn_direction: &str,
    vertical_scale: f64,
) -> HoldProtectedArea {
    let leg_length = if leg_length_nm.is_finite() {
        leg_length_nm.max(0.5)
    } else {
        4.0
    };
    let altitude = if altitude_feet.is_finite() {
        altitude_feet.max(0.0)
    } else {
        0.0
    };
    let tas_kt = max_holding_tas_kt(altitude);
    let wind_kt = HOLD_TEMPLATE_WIND_BASE_KT + HOLD_TEMPLATE_WIND_PER_1000_FT_KT * altitude / 1000.0;
    // Standard turn-performance formula: rate (deg/s) = 1091·tan(bank)/TAS,
    // capped at the standard rate.
    let turn_rate_deg_per_sec = (1091.0 * HOLD_TEMPLATE_BANK_DEG.to_radians().tan() / tas_kt)
        .min(HOLD_TEMPLATE_MAX_TURN_RATE_DEG_PER_SEC);
    let leg_time_hr = leg_length / tas_kt;
    let turn_time_hr = (180.0 / turn_rate_deg_per_sec) / 3600.0;

    // Nominal FLOWN racetrack (fix at the origin, inbound along `forward`),
    // with cumulative time-from-fix per sample. Unlike the compact display
    // racetrack, the swept pattern uses the true turn radius at holding speed
    // (radius = TAS / (20π·rate)), so the protected area offsets clearly to
    // the holding side and the turn direction is visible in the envelope.
    let heading_rad = heading_deg.to_radians();
    let forward = Vec2::new(heading_rad.sin(), -heading_rad.cos());
    let right = Vec2::new(heading_rad.cos(), heading_rad.sin());
    let turn_sign = if turn_direction == "L" { -1.0 } else { 1.0 };
    let radius = tas_kt / (20.0 * PI * turn_rate_deg_per_sec);
    let offset = turn_sign * radius;
    let world = |forward_offset: f64, right_offset: f64| {
        Vec2::new(
            center_x + forward.x * forward_offset + right.x * right_offset,
            center_z + forward.y * forward_offset + right.y * right_offset,
        )
    };

    let steps_per_segment = 16;
    let mut samples: Vec<(Vec2, f64)> = Vec::with_capacity(4 * (steps_per_segment + 1));
    let near_start = if turn_direction == "R" { -PI / 2.0 } else { PI / 2.0 };
    let far_start = -near_start;
    for step in 0..=steps_per_segment {
        let t = step as f64 / steps_per_segment as f64;
        // Near (fix-side) turn: fix to the outbound leg.
        let angle = near_start + t * (-2.0 * near_start);
        samples.push((
            world(radius * angle.cos(), offset + radius * angle.sin()),
            t * turn_time_hr,
        ));
        // Outbound leg.
        samples.push((world(-t * leg_length, 2.0 * offset), turn_time_hr + t * leg_time_hr));
        // Far (outbound-end) turn.
        let angle = far_start + t * (-2.0 * far_start);
        samples.push((
            world(-leg_length - radius * angle.cos(), offset + radius * angle.sin()),
            turn_time_hr + leg_time_hr + t * turn_time_hr,
        ));
        // Inbound leg back to the fix: the aircraft is re-established on
        // course guidance converging on the fix, so instead of continuing the
        // dead-reckoning growth, the protection tapers back down to the base
        // fix tolerance at fix passage (negative time encodes the taper; see
        // the protection computation below).
        samples.push((world(-leg_length + t * leg_length, 0.0), -(1.0 - t)));
    }
    // Peak dead-reckoning drift: accumulated through the near turn, outbound
    // leg, and far turn (the unguided portion of the circuit).
    let peak_time_hr = 2.0 * turn_time_hr + leg_time_hr;

    // Convex envelope of the protection disks via the support function: for
    // each outline direction, the farthest disk in that direction contributes
    // its tangent point.
    let y = coords::alt_to_y(altitude, vertical_scale);
    let mut primary = Vec::with_capacity(HOLD_TEMPLATE_OUTLINE_STEPS + 1);
    let mut secondary = Vec::with_capacity(HOLD_TEMPLATE_OUTLINE_STEPS + 1);
    for step in 0..HOLD_TEMPLATE_OUTLINE_STEPS {
        let theta = step as f64 / HOLD_TEMPLATE_OUTLINE_STEPS as f64 * 2.0 * PI;
        let direction = Vec2::new(theta.cos(), theta.sin());
        let mut best: Option<(f64, Vec2, f64)> = None;
        for (disk_center, time_hr) in &samples {
            // Non-negative times are elapsed dead-reckoning hours from the
            // fix; negative values encode the inbound-leg taper fraction from
            // the peak drift back down to the base fix tolerance.
            let protection = if *time_hr >= 0.0 {
                HOLD_TEMPLATE_BASE_BUFFER_NM + wind_kt * time_hr
            } else {
                HOLD_TEMPLATE_BASE_BUFFER_NM + wind_kt * peak_time_hr * (-time_hr)
            };
            let support = disk_center.dot(direction) + protection;
            if best.as_ref().is_none_or(|(current, _, _)| support > *current) {
                best = Some((support, *disk_center, protection));
            }
        }
        let (_, disk_center, protection) = best.unwrap();
        primary.push(Point3 {
            x: disk_center.x + direction.x * protection,
            y,
            z: disk_center.y + direction.y * protection,
        });
        secondary.push(Point3 {
            x: disk_center.x + direction.x * (protection + HOLD_SECONDARY_WIDTH_NM),
            y,
            z: disk_center.y + direction.y * (protection + HOLD_SECONDARY_WIDTH_NM),
        });
    }
    // Close the rings for straightforward polyline rendering.
    if let Some(first) = primary.first().copied() {
        primary.push(first);
    }
    if let Some(first) = secondary.first().copied() {
        secondary.push(first);
    }
    HoldProtectedArea { primary, secondary }
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

