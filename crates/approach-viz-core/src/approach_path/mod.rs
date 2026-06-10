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

#[cfg(test)]
mod tests;
