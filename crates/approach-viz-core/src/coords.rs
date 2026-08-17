// WGS84 Projection + Earth Curvature coordinate math.
//
// Pure functions ported from `app/scene/approach-path/coordinates.ts`
// with `projection_scales_nm_per_degree` aligned to `services/runtime-rs/src/utils.rs:196-208`.

use std::f64::consts::PI;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEG_TO_RAD: f64 = PI / 180.0;
const METERS_TO_NM: f64 = 1.0 / 1852.0;
const WGS84_SEMI_MAJOR_METERS: f64 = 6_378_137.0;
const WGS84_FLATTENING: f64 = 1.0 / 298.257_223_563;
const WGS84_E2: f64 = WGS84_FLATTENING * (2.0 - WGS84_FLATTENING);
const WGS84_SEMI_MINOR_METERS: f64 = WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_FLATTENING);

/// Feet-to-NM conversion factor used for altitude scaling.
pub const FEET_PER_NM: f64 = 6076.12;
pub const ALTITUDE_SCALE: f64 = 1.0 / FEET_PER_NM;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// WGS84 geocentric radius at the given geodetic latitude, in nautical miles.
///
/// Uses the exact closed-form expression for the geocentric radius on the
/// WGS84 ellipsoid surface.
pub fn geocentric_radius_nm(latitude_deg: f64) -> f64 {
    let phi = latitude_deg * DEG_TO_RAD;
    let cos_phi = phi.cos();
    let sin_phi = phi.sin();

    let a = WGS84_SEMI_MAJOR_METERS;
    let b = WGS84_SEMI_MINOR_METERS;

    let a2_cos = a * a * cos_phi;
    let b2_sin = b * b * sin_phi;
    let numerator = a2_cos * a2_cos + b2_sin * b2_sin;

    let a_cos = a * cos_phi;
    let b_sin = b * sin_phi;
    let denominator = a_cos * a_cos + b_sin * b_sin;

    let radius_meters = (numerator / denominator).sqrt();
    radius_meters * METERS_TO_NM
}

/// Convert a geodetic (lat, lon) position to local scene coordinates
/// relative to a reference point.
///
/// Returns `(x, z)` where `x` = east (NM), `z` = -north (NM).
/// This matches the three.js coordinate convention used by the scene.
pub fn lat_lon_to_local(lat: f64, lon: f64, ref_lat: f64, ref_lon: f64) -> (f64, f64) {
    let phi = ref_lat * DEG_TO_RAD;
    let sin_phi = phi.sin();
    let cos_phi = phi.cos();

    let denom = (1.0 - WGS84_E2 * sin_phi * sin_phi).sqrt();
    let prime_vertical_meters = WGS84_SEMI_MAJOR_METERS / denom;
    let meridional_meters =
        (WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_E2)) / (denom * denom * denom);

    let d_lat_rad = (lat - ref_lat) * DEG_TO_RAD;
    let d_lon_rad = (lon - ref_lon) * DEG_TO_RAD;

    let east_nm = d_lon_rad * prime_vertical_meters * cos_phi * METERS_TO_NM;
    let north_nm = d_lat_rad * meridional_meters * METERS_TO_NM;

    let x = east_nm;
    let z = -north_nm;
    (x, z)
}

/// Scale an altitude in feet to scene Y units.
///
/// `vertical_scale` is the user-adjustable vertical exaggeration factor.
pub fn alt_to_y(alt_feet: f64, vertical_scale: f64) -> f64 {
    alt_feet * ALTITUDE_SCALE * vertical_scale
}

/// Approximate earth-curvature sag at a horizontal range from the
/// reference point, in nautical miles.
///
/// Uses the parabolic approximation `d^2 / (2R)` which is accurate for
/// the ranges encountered in approach visualizations (< ~120 NM).
pub fn earth_curvature_drop_nm(x_nm: f64, z_nm: f64, ref_lat: f64) -> f64 {
    let distance_nm = (x_nm * x_nm + z_nm * z_nm).sqrt();
    let radius_nm = geocentric_radius_nm(ref_lat);
    (distance_nm * distance_nm) / (2.0 * radius_nm)
}

/// Normalize a heading to the range [0, 360).
pub fn normalize_heading(degrees: f64) -> f64 {
    let wrapped = degrees % 360.0;
    if wrapped < 0.0 {
        wrapped + 360.0
    } else {
        wrapped
    }
}

/// Convert a magnetic course to a true heading by applying magnetic variation.
///
/// If `magnetic_variation` is NaN (or non-finite), it is treated as 0.
pub fn magnetic_to_true_heading(magnetic_course: f64, magnetic_variation: f64) -> f64 {
    let mag_var = if magnetic_variation.is_finite() {
        magnetic_variation
    } else {
        0.0
    };
    normalize_heading(magnetic_course + mag_var)
}

/// Projection scale factors at a given latitude, in NM per degree.
///
/// Returns `(east_nm_per_lon_deg, north_nm_per_lat_deg)`.
///
/// This is aligned with `services/runtime-rs/src/utils.rs:projection_scales_nm_per_degree`.
pub fn projection_scales_nm_per_degree(lat_deg: f64) -> (f64, f64) {
    let phi = lat_deg * DEG_TO_RAD;
    let sin_phi = phi.sin();
    let cos_phi = phi.cos();

    let denom = (1.0 - WGS84_E2 * sin_phi * sin_phi).sqrt();
    let prime_vertical_meters = WGS84_SEMI_MAJOR_METERS / denom;
    let meridional_meters =
        (WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_E2)) / (denom * denom * denom);

    (
        (PI / 180.0) * prime_vertical_meters * cos_phi * METERS_TO_NM,
        (PI / 180.0) * meridional_meters * METERS_TO_NM,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geocentric_radius_at_equator() {
        let r = geocentric_radius_nm(0.0);
        assert!(
            (r - 3443.9).abs() < 0.1,
            "equator radius {r} NM not within 0.1 of 3443.9"
        );
    }

    #[test]
    fn geocentric_radius_at_pole() {
        let r = geocentric_radius_nm(90.0);
        assert!(
            (r - 3432.4).abs() < 0.1,
            "pole radius {r} NM not within 0.1 of 3432.4"
        );
    }

    #[test]
    fn lat_lon_to_local_identity_at_ref() {
        let (x, z) = lat_lon_to_local(40.0, -74.0, 40.0, -74.0);
        assert!(
            x.abs() < 1e-10 && z.abs() < 1e-10,
            "expected (0, 0) at ref, got ({x}, {z})"
        );
    }

    #[test]
    fn lat_lon_to_local_one_degree_north() {
        let (_, z) = lat_lon_to_local(41.0, -74.0, 40.0, -74.0);
        // 1 degree north at lat 40 is ~60 NM; z is -north so z ~ -60
        assert!(
            (z - (-60.0)).abs() < 1.0,
            "one degree north: z = {z}, expected ~-60"
        );
    }

    #[test]
    fn lat_lon_to_local_one_degree_east() {
        let (x, _) = lat_lon_to_local(40.0, -73.0, 40.0, -74.0);
        // 1 degree east at lat 40 is ~46.6 NM
        assert!(
            (x - 46.6).abs() < 1.0,
            "one degree east at lat 40: x = {x}, expected ~46.6"
        );
    }

    #[test]
    fn alt_to_y_scales_correctly() {
        let y = alt_to_y(1000.0, 1.0);
        let expected = 1000.0 / 6076.12;
        assert!(
            (y - expected).abs() < 1e-6,
            "alt_to_y(1000, 1.0) = {y}, expected ~{expected}"
        );
        // ~0.1646
        assert!(
            (y - 0.1646).abs() < 0.001,
            "alt_to_y(1000, 1.0) = {y}, expected ~0.1646"
        );
    }

    #[test]
    fn earth_curvature_drop_at_60nm() {
        let drop = earth_curvature_drop_nm(60.0, 0.0, 40.0);
        assert!(
            (drop - 0.52).abs() < 0.05,
            "curvature drop at 60 NM = {drop}, expected ~0.52"
        );
    }

    #[test]
    fn normalize_heading_wraps() {
        assert!(
            (normalize_heading(370.0) - 10.0).abs() < 1e-10,
            "370 should wrap to 10"
        );
        assert!(
            (normalize_heading(-10.0) - 350.0).abs() < 1e-10,
            "-10 should wrap to 350"
        );
        assert!(
            normalize_heading(0.0).abs() < 1e-10,
            "0 should stay 0"
        );
    }

    #[test]
    fn magnetic_to_true_applies_variation() {
        let true_hdg = magnetic_to_true_heading(350.0, 15.0);
        assert!(
            (true_hdg - 5.0).abs() < 1e-10,
            "350 + 15 = 5 (wrapped), got {true_hdg}"
        );
    }

    #[test]
    fn magnetic_to_true_handles_nan_variation() {
        let true_hdg = magnetic_to_true_heading(90.0, f64::NAN);
        assert!(
            (true_hdg - 90.0).abs() < 1e-10,
            "NaN variation should be treated as 0, got {true_hdg}"
        );
    }

    #[test]
    fn projection_scales_match_lat_lon_to_local() {
        // At lat 40, verify that projection_scales_nm_per_degree is consistent
        // with lat_lon_to_local for a 1-degree displacement.
        let lat = 40.0;
        let (east_scale, north_scale) = projection_scales_nm_per_degree(lat);

        // 1 degree east
        let (x, _) = lat_lon_to_local(lat, -73.0, lat, -74.0);
        assert!(
            (x - east_scale).abs() < 0.01,
            "east scale mismatch: lat_lon_to_local gave x={x}, projection_scales gave {east_scale}"
        );

        // 1 degree north (z is -north)
        let (_, z) = lat_lon_to_local(lat + 1.0, -74.0, lat, -74.0);
        let north_from_local = -z; // convert back to positive north
        assert!(
            (north_from_local - north_scale).abs() < 0.01,
            "north scale mismatch: lat_lon_to_local gave north={north_from_local}, projection_scales gave {north_scale}"
        );
    }
}
