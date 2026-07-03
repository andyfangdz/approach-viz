//! Shared approach-path engine: altitude resolution, path geometry assembly,
//! and hold-pattern generation. Consumed by web (WASM) and iOS (UniFFI).

use std::f64::consts::PI;

mod altitudes;
mod geometry;
mod holds;
mod support;
mod types;

pub use altitudes::*;
pub use geometry::*;
pub use holds::*;
pub use types::*;

pub(crate) use support::*;

pub(crate) const MISSED_DEFAULT_CLIMB_FT_PER_NM: f64 = 200.0;
pub(crate) const MIN_TURN_RADIUS_NM: f64 = 0.45;
pub(crate) const MAX_COURSE_TO_FIX_TURN_ARC_RAD: f64 = (225.0 * PI) / 180.0;
pub(crate) const EXPLICIT_TURN_DIRECTION_SCORE_BIAS: f64 = 0.35;
pub(crate) const INFERRED_TURN_DIRECTION_SCORE_BIAS: f64 = 0.1;
pub(crate) const MIN_HEADING_TRANSITION_DELTA_DEG: f64 = 6.0;
pub(crate) const MAX_HEADING_TRANSITION_DELTA_DEG: f64 = 210.0;
pub(crate) const MIN_VI_TURN_RADIUS_NM: f64 = 0.55;
pub(crate) const MAX_VI_TURN_RADIUS_NM: f64 = 0.9;
// Fallback outbound length for course-from-fix legs that do not publish a
// distance (`FA`/`FM`), so the outbound leg is still visible.
pub(crate) const COURSE_FROM_FIX_DEFAULT_DISTANCE_NM: f64 = 3.0;
// Upper bound on the inbound (return) leg drawn for a teardrop/course-reversal
// intercept leg, so a long published outbound distance cannot run away.
pub(crate) const MAX_REVERSAL_INBOUND_NM: f64 = 12.0;
// Cap on the outbound apex distance used to shape the teardrop reversal arc, so
// a long published outbound leg does not bulge the loop far past the course fix;
// keeps the rendered teardrop compact (near the course fix's level).
pub(crate) const TEARDROP_MAX_OUTBOUND_NM: f64 = 4.0;
// Acceptance window for the teardrop reversal roll-out circle radius
// (`course_reversal_rollout_point`). The minimum is a degeneracy floor (reject
// near-zero/collapsed circles, not an operational turn radius); the maximum
// rejects runaway tangent circles. The window comfortably contains the real
// reversal radius (~`TEARDROP_MAX_OUTBOUND_NM`/2 .. a few NM).
pub(crate) const ROLLOUT_RADIUS_MIN_NM: f64 = 0.2;
pub(crate) const ROLLOUT_RADIUS_MAX_NM: f64 = 20.0;
// Turn radius for the reversal turn itself. A course reversal is one continuous,
// broad turn on the plate; the tight VI heading-stub radius renders a sharp
// spike instead, so the reversal turn uses its own wider radius band.
pub(crate) const REVERSAL_TURN_MIN_RADIUS_NM: f64 = 1.0;
pub(crate) const REVERSAL_TURN_MAX_RADIUS_NM: f64 = 2.5;
// Turn radius for the lead turn that rolls a DME arc (`AF`/`RF`) out onto the
// inbound course. The chart shows the aircraft leaving the arc at a lead radial
// and rolling out on the inbound course near the terminating fix, rather than
// cornering sharply at the fix; this radius shapes that fillet.
pub(crate) const DME_ARC_LEAD_TURN_RADIUS_NM: f64 = 2.0;
// Procedure-turn (`PI`) rendering. The CIFP publishes the 45° excursion-leg
// course, the remain-within distance limit, and the reversal turn direction;
// the maneuver proportions are standardized here. The outbound leg runs this
// fraction of the remain-within limit before the 45° turn so the whole
// maneuver (outbound + excursion + reversal) stays well inside the limit.
pub(crate) const PROCEDURE_TURN_DEFAULT_LIMIT_NM: f64 = 10.0;
pub(crate) const PROCEDURE_TURN_OUTBOUND_LIMIT_FRACTION: f64 = 0.4;
pub(crate) const PROCEDURE_TURN_MIN_OUTBOUND_NM: f64 = 1.5;
pub(crate) const PROCEDURE_TURN_MAX_OUTBOUND_NM: f64 = 5.0;
// Straight 45° excursion leg between the two turns (~1 minute at approach
// category speeds, matching the charted barb proportions).
pub(crate) const PROCEDURE_TURN_EXCURSION_NM: f64 = 1.6;
pub(crate) const PROCEDURE_TURN_RADIUS_NM: f64 = 0.9;
// Time-based hold sizing (`resolve_hold_leg_length_nm`). Straight-leg length
// for a hold published with a time instead of a distance is derived from the
// FAA maximum holding airspeed for the hold altitude (AIM 5-3-8: 200 KIAS at
// or below 6,000 ft MSL, 230 KIAS through 14,000 ft, 265 KIAS above),
// converted to true airspeed with the standard ~2%-per-1,000-ft rule. Holds
// publishing neither time nor distance use the standard pattern timing:
// 1 minute at or below 14,000 ft MSL, 1.5 minutes above.
pub(crate) const HOLD_MAX_IAS_LOW_KT: f64 = 200.0;
pub(crate) const HOLD_MAX_IAS_MID_KT: f64 = 230.0;
pub(crate) const HOLD_MAX_IAS_HIGH_KT: f64 = 265.0;
pub(crate) const HOLD_IAS_LOW_CEILING_FT: f64 = 6_000.0;
pub(crate) const HOLD_IAS_MID_CEILING_FT: f64 = 14_000.0;
pub(crate) const HOLD_TAS_FACTOR_PER_1000_FT: f64 = 0.02;
pub(crate) const HOLD_STANDARD_TIME_LOW_MIN: f64 = 1.0;
pub(crate) const HOLD_STANDARD_TIME_HIGH_MIN: f64 = 1.5;
// Hold protected-area construction (`build_hold_protected_area`), following
// the TERPS/PANS-OPS holding-template method in simplified form: the nominal
// racetrack is swept by a protection disk that starts at a base fix/flight-
// technical tolerance and grows with an omnidirectional wind allowance over
// the elapsed pattern time (drift can act in any direction, hence a disk),
// flown at the altitude's maximum holding TAS with turns at 25° bank capped
// at 3°/s (standard-rate formula R = 1091·tan(bank)/TAS). The primary
// boundary is the convex envelope of those disks; the secondary area adds a
// fixed-width band. Entry-maneuver protection (the extra area templates add
// on the entry side) is not modeled.
pub(crate) const HOLD_TEMPLATE_BASE_BUFFER_NM: f64 = 2.0;
pub(crate) const HOLD_TEMPLATE_WIND_BASE_KT: f64 = 47.0;
pub(crate) const HOLD_TEMPLATE_WIND_PER_1000_FT_KT: f64 = 2.0;
pub(crate) const HOLD_TEMPLATE_BANK_DEG: f64 = 25.0;
pub(crate) const HOLD_TEMPLATE_MAX_TURN_RATE_DEG_PER_SEC: f64 = 3.0;
pub(crate) const HOLD_SECONDARY_WIDTH_NM: f64 = 2.0;
pub(crate) const HOLD_TEMPLATE_OUTLINE_STEPS: usize = 144;

#[cfg(test)]
mod tests;
