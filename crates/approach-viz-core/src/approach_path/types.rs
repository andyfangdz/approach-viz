// Split from the original single-file approach_path module; behavior is
// unchanged. Public API is re-exported from this module root.

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

/// Closed primary/secondary protected-area boundary rings for a hold (see
/// `build_hold_protected_area`); each ring repeats its first point at the end.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct HoldProtectedArea {
    pub primary: Vec<Point3>,
    pub secondary: Vec<Point3>,
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

pub const APPROACH_SCENE_SEGMENT_TRANSITION: &str = "transition";
pub const APPROACH_SCENE_SEGMENT_FINAL: &str = "final";
pub const APPROACH_SCENE_SEGMENT_MISSED: &str = "missed";

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ComposeApproachSceneParams {
    pub final_legs: Vec<ApproachPathLeg>,
    pub transition_entries: Vec<TransitionLegs>,
    pub missed_legs: Vec<ApproachPathLeg>,
    pub waypoints: Vec<ApproachWaypoint>,
    pub final_altitudes: Vec<f64>,
    pub transition_altitudes: Vec<TransitionAltitudeResult>,
    pub missed_altitudes: Vec<f64>,
    pub missed_path_altitudes: Vec<f64>,
    pub airport_elevation: f64,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ComposedPathSegment {
    /// `"transition"` | `"final"` | `"missed"`.
    pub kind: String,
    pub name: Option<String>,
    pub legs: Vec<ApproachPathLeg>,
    pub resolved_altitudes: Vec<f64>,
    pub show_turn_constraint_labels: bool,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ComposedHoldLeg {
    pub leg: ApproachPathLeg,
    pub altitude_feet: f64,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ComposedApproachScene {
    pub segments: Vec<ComposedPathSegment>,
    pub hold_legs: Vec<ComposedHoldLeg>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Vec2 {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Vec3 {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) z: f64,
}

impl Vec2 {
    pub(crate) fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub(crate) fn add(self, other: Vec2) -> Self {
        Self::new(self.x + other.x, self.y + other.y)
    }

    pub(crate) fn sub(self, other: Vec2) -> Self {
        Self::new(self.x - other.x, self.y - other.y)
    }

    pub(crate) fn scale(self, scalar: f64) -> Self {
        Self::new(self.x * scalar, self.y * scalar)
    }

    pub(crate) fn dot(self, other: Vec2) -> f64 {
        self.x * other.x + self.y * other.y
    }

    pub(crate) fn len(self) -> f64 {
        self.dot(self).sqrt()
    }

    pub(crate) fn normalize(self) -> Self {
        let len = self.len();
        if len <= 1e-9 {
            self
        } else {
            self.scale(1.0 / len)
        }
    }

    pub(crate) fn distance_sq(self, other: Vec2) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }
}

impl Vec3 {
    pub(crate) fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub(crate) fn to_point(self) -> Point3 {
        Point3 {
            x: self.x,
            y: self.y,
            z: self.z,
        }
    }

    pub(crate) fn distance_sq(self, other: Vec3) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        let dz = self.z - other.z;
        dx * dx + dy * dy + dz * dz
    }
}
