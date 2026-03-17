use crate::{approach_path, coords};

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct LocalPoint {
    pub x_nm: f64,
    pub z_nm: f64,
}

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct ProjectionScale {
    pub east_nm_per_lon_degree: f64,
    pub north_nm_per_lat_degree: f64,
}

#[derive(Debug, Clone, Copy, uniffi::Record)]
pub struct ScenePoint {
    pub x_nm: f64,
    pub y_nm: f64,
    pub z_nm: f64,
}

#[uniffi::export]
pub fn lat_lon_to_local(lat: f64, lon: f64, ref_lat: f64, ref_lon: f64) -> LocalPoint {
    let (x_nm, z_nm) = coords::lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    LocalPoint { x_nm, z_nm }
}

#[uniffi::export]
pub fn alt_to_y(alt_feet: f64, vertical_scale: f64) -> f64 {
    coords::alt_to_y(alt_feet, vertical_scale)
}

#[uniffi::export]
pub fn earth_curvature_drop_nm(x_nm: f64, z_nm: f64, ref_lat: f64) -> f64 {
    coords::earth_curvature_drop_nm(x_nm, z_nm, ref_lat)
}

#[uniffi::export]
pub fn geocentric_radius_nm(latitude_deg: f64) -> f64 {
    coords::geocentric_radius_nm(latitude_deg)
}

#[uniffi::export]
pub fn projection_scales_nm_per_degree(lat_deg: f64) -> ProjectionScale {
    let (east_nm_per_lon_degree, north_nm_per_lat_degree) =
        coords::projection_scales_nm_per_degree(lat_deg);
    ProjectionScale {
        east_nm_per_lon_degree,
        north_nm_per_lat_degree,
    }
}

#[uniffi::export]
pub fn scene_point_from_geodetic(
    lat: f64,
    lon: f64,
    altitude_feet: f64,
    ref_lat: f64,
    ref_lon: f64,
    ref_altitude_feet: f64,
    vertical_scale: f64,
) -> ScenePoint {
    let (x_nm, z_nm) = coords::lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    let relative_altitude_feet = altitude_feet - ref_altitude_feet;
    let y_nm = coords::alt_to_y(relative_altitude_feet, vertical_scale);
    ScenePoint { x_nm, y_nm, z_nm }
}

#[uniffi::export]
pub fn resolve_approach_altitudes(
    params: approach_path::ResolveApproachAltitudesParams,
) -> approach_path::ApproachAltitudeResult {
    approach_path::resolve_approach_altitudes(params)
}

#[uniffi::export]
pub fn build_approach_path_geometry(
    params: approach_path::BuildPathGeometryParams,
) -> approach_path::PathGeometryResult {
    approach_path::build_path_geometry(params)
}

#[uniffi::export]
pub fn build_approach_hold_geometry(
    center_x: f64,
    center_z: f64,
    heading_deg: f64,
    hold_distance_nm: f64,
    altitude_feet: f64,
    turn_direction: String,
    vertical_scale: f64,
) -> Vec<approach_path::Point3> {
    approach_path::build_hold_geometry(
        center_x,
        center_z,
        heading_deg,
        hold_distance_nm,
        altitude_feet,
        &turn_direction,
        vertical_scale,
    )
}
