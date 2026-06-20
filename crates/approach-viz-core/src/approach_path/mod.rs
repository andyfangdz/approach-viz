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
pub(crate) const DME_ARC_LEAD_TURN_RADIUS_NM: f64 = 1.0;

#[cfg(test)]
mod tests;
