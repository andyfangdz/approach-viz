// Pure kinematic helpers for the procedure simulator.
//
// Everything here is a deterministic function of its inputs: no state, no
// I/O. Angles are degrees, distances nautical miles unless noted.

use std::f64::consts::PI;

const DEG_TO_RAD: f64 = PI / 180.0;
const RAD_TO_DEG: f64 = 180.0 / PI;
const EARTH_RADIUS_NM: f64 = 3440.065;

/// Normalize to [0, 360).
pub fn normalize_360(deg: f64) -> f64 {
    let mut d = deg % 360.0;
    if d < 0.0 {
        d += 360.0;
    }
    // Avoid returning exactly 360.0 for inputs like 720.0.
    if d >= 360.0 {
        d -= 360.0;
    }
    d
}

/// Signed smallest angle from `from` to `to`, in (-180, 180].
pub fn angle_diff_deg(from: f64, to: f64) -> f64 {
    let mut d = normalize_360(to) - normalize_360(from);
    if d > 180.0 {
        d -= 360.0;
    } else if d <= -180.0 {
        d += 360.0;
    }
    d
}

/// Bank angle (degrees, positive = right) for a coordinated turn at the
/// given true airspeed and turn rate: tan(bank) = v * omega / g.
pub fn bank_for_turn_rate(tas_kts: f64, rate_dps: f64) -> f64 {
    // g = 9.80665 m/s^2 -> NM/h^2.
    const G_NM_PER_H2: f64 = 9.80665 * 3600.0 * 3600.0 / 1852.0;
    let v_nm_per_h = tas_kts;
    let omega_rad_per_h = rate_dps * DEG_TO_RAD * 3600.0;
    (v_nm_per_h * omega_rad_per_h / G_NM_PER_H2).atan() * RAD_TO_DEG
}

/// Step a heading toward a target at up to `max_rate_dps`.
///
/// Returns `(new_heading, actual_rate_dps)` with the sign of the turn taken.
pub fn turn_toward_heading(current: f64, target: f64, max_rate_dps: f64, dt_s: f64) -> (f64, f64) {
    let diff = angle_diff_deg(current, target);
    let max_step = max_rate_dps * dt_s;
    if diff.abs() <= max_step {
        (normalize_360(target), diff / dt_s.max(1e-9))
    } else {
        let step = max_step * diff.signum();
        (normalize_360(current + step), step / dt_s.max(1e-9))
    }
}

/// Advance a lat/lon along a rhumb line at `track_deg` and `gs_kts`.
pub fn step_position(lat_deg: f64, lon_deg: f64, track_deg: f64, gs_kts: f64, dt_s: f64) -> (f64, f64) {
    let dist_nm = gs_kts * dt_s / 3600.0;
    let track = track_deg * DEG_TO_RAD;
    let lat1 = lat_deg * DEG_TO_RAD;
    let lon1 = lon_deg * DEG_TO_RAD;

    let d_lat = dist_nm * track.cos() / EARTH_RADIUS_NM;
    // Meridional correction for the longitude step.
    let lat2 = lat1 + d_lat;
    let mean_lat = (lat1 + lat2) / 2.0;
    let d_lon = dist_nm * track.sin() / (EARTH_RADIUS_NM * mean_lat.cos().max(1e-6));

    (lat2 * RAD_TO_DEG, (lon1 + d_lon) * RAD_TO_DEG)
}

/// Great-circle distance between two points, nautical miles.
pub fn distance_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let p1 = lat1 * DEG_TO_RAD;
    let p2 = lat2 * DEG_TO_RAD;
    let dp = (lat2 - lat1) * DEG_TO_RAD;
    let dl = (lon2 - lon1) * DEG_TO_RAD;
    let h = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_NM * h.sqrt().asin()
}

/// Initial great-circle bearing from point 1 to point 2, degrees true.
pub fn bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let p1 = lat1 * DEG_TO_RAD;
    let p2 = lat2 * DEG_TO_RAD;
    let dl = (lon2 - lon1) * DEG_TO_RAD;
    let y = dl.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos();
    normalize_360(y.atan2(x) * RAD_TO_DEG)
}

/// Cross-track error of `pos` from the great-circle path through `a`->`b`,
/// nautical miles. Positive = right of the a->b course.
pub fn cross_track_nm(
    a_lat: f64,
    a_lon: f64,
    b_lat: f64,
    b_lon: f64,
    p_lat: f64,
    p_lon: f64,
) -> f64 {
    let dist_ap = distance_nm(a_lat, a_lon, p_lat, p_lon);
    if dist_ap < 1e-9 {
        return 0.0;
    }
    let brg_ap = bearing_deg(a_lat, a_lon, p_lat, p_lon) * DEG_TO_RAD;
    let brg_ab = bearing_deg(a_lat, a_lon, b_lat, b_lon) * DEG_TO_RAD;
    ((dist_ap / EARTH_RADIUS_NM).sin() * (brg_ap - brg_ab).sin()).asin() * EARTH_RADIUS_NM
}

/// Along-track distance from `a` toward `b` for the projection of `p`,
/// nautical miles. Negative = behind `a`.
pub fn along_track_nm(
    a_lat: f64,
    a_lon: f64,
    b_lat: f64,
    b_lon: f64,
    p_lat: f64,
    p_lon: f64,
) -> f64 {
    let xtk = cross_track_nm(a_lat, a_lon, b_lat, b_lon, p_lat, p_lon);
    let dist_ap = distance_nm(a_lat, a_lon, p_lat, p_lon);
    let along_sq = dist_ap * dist_ap - xtk * xtk;
    let along = along_sq.max(0.0).sqrt();
    // Sign: is the projection ahead of a along the a->b direction?
    let brg_ap = bearing_deg(a_lat, a_lon, p_lat, p_lon);
    let brg_ab = bearing_deg(a_lat, a_lon, b_lat, b_lon);
    if angle_diff_deg(brg_ab, brg_ap).abs() > 90.0 {
        -along
    } else {
        along
    }
}

/// True airspeed from indicated, correcting for altitude (rough 2%/1000 ft).
pub fn tas_from_ias(ias_kts: f64, alt_ft: f64) -> f64 {
    ias_kts * (1.0 + 0.02 * alt_ft / 1000.0)
}

/// Ground speed and drift-corrected track from TAS, heading, and wind.
pub fn wind_triangle(
    tas_kts: f64,
    hdg_deg_true: f64,
    wind_from_deg: f64,
    wind_kts: f64,
) -> (f64, f64) {
    let hdg = hdg_deg_true * DEG_TO_RAD;
    // Wind vector: direction wind blows TOWARD.
    let wind_to = (wind_from_deg + 180.0) * DEG_TO_RAD;
    let wx = wind_kts * wind_to.sin();
    let wy = wind_kts * wind_to.cos();
    let ax = tas_kts * hdg.sin();
    let ay = tas_kts * hdg.cos();
    let gx = ax + wx;
    let gy = ay + wy;
    let gs = (gx * gx + gy * gy).sqrt();
    let track = normalize_360(gx.atan2(gy) * RAD_TO_DEG);
    (gs, track)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angle_diff_wraps() {
        assert!((angle_diff_deg(350.0, 10.0) - 20.0).abs() < 1e-9);
        assert!((angle_diff_deg(10.0, 350.0) + 20.0).abs() < 1e-9);
        assert!((angle_diff_deg(90.0, 270.0) - 180.0).abs() < 1e-9);
    }

    #[test]
    fn bank_for_standard_rate_turn() {
        // 110 KTAS at 3 deg/s should need ~17 deg of bank (matches the
        // textbook standard-rate turn and the REA-measured sim behavior).
        let bank = bank_for_turn_rate(110.0, 3.0);
        assert!((bank - 16.8).abs() < 0.5, "bank={bank}");
    }

    #[test]
    fn turn_toward_caps_rate() {
        let (hdg, rate) = turn_toward_heading(0.0, 90.0, 3.0, 1.0);
        assert!((hdg - 3.0).abs() < 1e-9);
        assert!((rate - 3.0).abs() < 1e-9);
        // Short hop: snaps to target, reports the smaller rate.
        let (hdg, _) = turn_toward_heading(0.0, 1.0, 3.0, 1.0);
        assert!((hdg - 1.0).abs() < 1e-9);
        // Takes the short way around.
        let (hdg, rate) = turn_toward_heading(10.0, 350.0, 3.0, 1.0);
        assert!((hdg - 7.0).abs() < 1e-9);
        assert!(rate < 0.0);
    }

    #[test]
    fn step_position_moves_down_track() {
        let (lat, lon) = step_position(28.0, -82.0, 90.0, 120.0, 30.0);
        // 120 kts for 30 s = 1 NM due east.
        assert!((lat - 28.0).abs() < 1e-6);
        let moved = distance_nm(28.0, -82.0, lat, lon);
        assert!((moved - 1.0).abs() < 1e-6, "moved={moved}");
    }

    #[test]
    fn cross_track_sign_convention() {
        // Course 090 from (28,-82) to (28,-81). A point 0.1 deg north
        // (lat 28.1) is LEFT of an eastbound course -> negative xtk.
        let xtk = cross_track_nm(28.0, -82.0, 28.0, -81.0, 28.1, -81.5);
        assert!(xtk < -5.0 && xtk > -7.0, "xtk={xtk}");
        let xtk = cross_track_nm(28.0, -82.0, 28.0, -81.0, 27.9, -81.5);
        assert!(xtk > 5.0 && xtk < 7.0, "xtk={xtk}");
    }

    #[test]
    fn wind_triangle_headwind() {
        // 100 KTAS heading 090, 20 kt wind from 090 (headwind): GS = 80.
        let (gs, track) = wind_triangle(100.0, 90.0, 90.0, 20.0);
        assert!((gs - 80.0).abs() < 1e-9, "gs={gs}");
        assert!((track - 90.0).abs() < 1e-9);
    }
}
