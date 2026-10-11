// Public API types for the client-side procedure simulator.
//
// All types follow the crate convention: serde camelCase for the `wasm`
// feature and `uniffi::Record` for the `ios` feature, so the simulator core
// stays shared between the web (WASM) and native clients.

/// Live aircraft state, updated every simulation step.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct AircraftState {
    /// Geodetic latitude, degrees.
    pub lat_deg: f64,
    /// Geodetic longitude, degrees.
    pub lon_deg: f64,
    /// Altitude MSL, feet.
    pub alt_ft_msl: f64,
    /// Heading, degrees true.
    pub hdg_deg_true: f64,
    /// Indicated airspeed, knots. The sim flies the bug; no thrust/drag model.
    pub ias_kts: f64,
    /// Vertical speed, feet per minute. Positive climbs.
    pub vs_fpm: f64,
    /// Bank angle, degrees. Positive = right wing down.
    pub bank_deg: f64,
    /// Ground speed, knots (TAS corrected for wind).
    pub gs_kts: f64,
    /// True airspeed, knots (IAS corrected for altitude).
    pub tas_kts: f64,
    /// Magnetic variation applied to nav courses, degrees east positive.
    pub mag_var_deg: f64,
}

/// Ambient wind: direction the wind blows FROM, degrees true.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct WindState {
    pub direction_from_deg_true: f64,
    pub speed_kts: f64,
}

/// Autopilot lateral modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "ios", derive(uniffi::Enum))]
pub enum LateralMode {
    Off,
    /// Track the heading bug at standard rate.
    Heading,
    /// Track the active procedure leg / VOR course.
    Nav,
    /// Track a localizer course with higher gain.
    Localizer,
}

/// Autopilot vertical modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "ios", derive(uniffi::Enum))]
pub enum VerticalMode {
    Off,
    /// Hold current altitude.
    AltitudeHold,
    /// Track the VS bug, capturing the altitude bug.
    VerticalSpeed,
    /// Track the glideslope / glidepath.
    GlideSlope,
}

/// Pilot-facing autopilot controls.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct AutopilotSettings {
    pub lateral: LateralMode,
    pub vertical: VerticalMode,
    pub hdg_bug_deg: f64,
    pub alt_bug_ft: f64,
    pub vs_bug_fpm: f64,
    pub crs_bug_deg: f64,
    pub spd_bug_kts: f64,
}

/// Aircraft performance envelope for the sim. Defaults suit a ~110 KIAS
/// single-engine trainer on an instrument approach.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct AircraftPerformance {
    /// Maximum bank the autopilot will command, degrees.
    pub max_bank_deg: f64,
    /// Standard-rate turn target, degrees per second.
    pub standard_turn_rate_dps: f64,
    /// Maximum vertical speed the autopilot will command, fpm.
    pub max_vs_fpm: f64,
    /// Altitude capture lead, feet (start leveling this far from the bug).
    pub alt_capture_lead_ft: f64,
}

impl Default for AircraftPerformance {
    fn default() -> Self {
        Self {
            max_bank_deg: 25.0,
            standard_turn_rate_dps: 3.0,
            max_vs_fpm: 2000.0,
            alt_capture_lead_ft: 150.0,
        }
    }
}

/// One flyable procedure leg, derived from FAA CIFP legs.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct ProcedureLeg {
    pub id: String,
    pub fix_name: String,
    pub fix_lat_deg: f64,
    pub fix_lon_deg: f64,
    /// Inbound course to the fix, degrees true.
    pub course_deg_true: f64,
    /// Minimum altitude on this leg, feet MSL.
    pub min_alt_ft: Option<f64>,
    /// Maximum altitude on this leg, feet MSL.
    pub max_alt_ft: Option<f64>,
    /// Publish the fix as the final approach fix.
    pub is_final_approach_fix: bool,
}

/// Grading thresholds. All time-based latches require the condition to
/// persist before a mistake is raised, so turbulence-grade noise in the
/// state vector cannot spam findings.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct GradingThresholds {
    /// Altitude deviation that counts as a bust, feet.
    pub alt_bust_ft: f64,
    /// How long the bust must persist before it is raised, seconds.
    pub alt_bust_latch_s: f64,
    /// Cross-track error that counts as off-course, nautical miles.
    pub xtk_limit_nm: f64,
    /// How long the deviation must persist, seconds.
    pub xtk_latch_s: f64,
    /// Flying this far below a segment minimum is an immediate mistake, feet.
    pub below_minimums_margin_ft: f64,
}

impl Default for GradingThresholds {
    fn default() -> Self {
        Self {
            alt_bust_ft: 200.0,
            alt_bust_latch_s: 5.0,
            xtk_limit_nm: 1.0,
            xtk_latch_s: 5.0,
            below_minimums_margin_ft: 100.0,
        }
    }
}

/// Everything the simulator needs to start a session.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct SimConfig {
    pub initial_state: AircraftState,
    pub initial_autopilot: AutopilotSettings,
    pub performance: AircraftPerformance,
    pub wind: WindState,
    /// Ordered legs of the procedure to fly. Empty = free flight, no grading
    /// against a procedure.
    pub legs: Vec<ProcedureLeg>,
    /// ATC-assigned altitude, feet MSL. The grader checks against this.
    pub assigned_alt_ft: Option<f64>,
    pub grading: GradingThresholds,
    /// Fixed simulation timestep the host steps at, seconds. Must be > 0.
    pub dt_s: f64,
}

/// Severity of a grading finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "ios", derive(uniffi::Enum))]
pub enum MistakeSeverity {
    Advisory,
    Caution,
    Warning,
}

/// A grading finding: what went wrong, and how to fix it.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct Mistake {
    pub kind: String,
    pub title: String,
    pub severity: MistakeSeverity,
    pub details: String,
    pub solution: String,
    /// Simulation time when the mistake was raised, seconds.
    pub sim_time_s: f64,
}

/// Events emitted by [`crate::proc_sim::ProcSimSession::step`].
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Enum))]
pub enum ProcSimEvent {
    /// The active procedure leg advanced to the next fix.
    WaypointSequenced { fix_name: String },
    /// A new grading finding.
    MistakeRaised { mistake: Mistake },
    /// All legs complete.
    ProcedureComplete,
}

/// Full snapshot for the UI: state, autopilot, procedure progress, and any
/// latched mistakes.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ios", derive(uniffi::Record))]
pub struct SimSnapshot {
    pub sim_time_s: f64,
    pub state: AircraftState,
    pub autopilot: AutopilotSettings,
    pub active_leg_index: Option<u64>,
    pub active_leg_fix: Option<String>,
    /// Cross-track error on the active leg, NM. Positive = right of course.
    pub xtk_nm: Option<f64>,
    /// Distance to the active fix, NM.
    pub dist_to_fix_nm: Option<f64>,
    /// CDI deflection, -1..1 (None when not tracking a course).
    pub cdi: Option<f64>,
    /// Active leg inbound course, not the intercept steering command.
    pub course_deg_true: Option<f64>,
    /// True when bearing to the fix is within 90 degrees of inbound course.
    pub course_to: Option<bool>,
    pub lateral_active: Option<LateralMode>,
    pub lateral_armed: Option<LateralMode>,
    pub vertical_active: Option<VerticalMode>,
    pub vertical_armed: Option<VerticalMode>,
    pub mistakes: Vec<Mistake>,
}
