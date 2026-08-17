//! Shared approach-path engine: altitude resolution, scene composition,
//! path geometry assembly, and hold-pattern generation. Consumed by web
//! (WASM) and iOS (UniFFI).

use std::f64::consts::PI;

mod altitudes;
mod compose;
mod geometry;
mod holds;
mod support;
mod types;

pub use altitudes::*;
pub use compose::*;
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
// FAA Order 8260.3F (TERPS) chapter 16: pattern number selected from table
// 16-3-1 (RNAV column, per its note 2) by the AIM 5-3-8 maximum-holding-speed
// tier and holding altitude; primary-area boundary built per the section
// 16-6-2 construction sequence (figure 16-6-1) from the table 16-6-1
// dimensions; and a 2 NM secondary area surrounding the primary perimeter in
// all cases (paragraph 16-2-4.b).
//
// Table 16-6-1 "Holding Pattern Dimensions (NM)": per pattern number the
// course-line distances A-L, L-M, M-G and the perpendicular offsets
// L-I (= M-H, non-holding side), M-E (holding side at the outbound end), and
// A-B (= G-F, holding side at the course-line ends). The published table
// prints L-I/M-H and A-B/G-F as single shared columns; row checksums against
// its Total Length (A-L + L-M + M-G) and Total Width (M-E + M-H) columns
// validate the transcription.
pub(crate) const TERPS_HOLDING_PATTERN_DIMENSIONS: &[(u8, f64, f64, f64, f64, f64, f64)] = &[
    // (pattern, A-L, L-M, M-G, L-I = M-H, M-E, A-B = G-F)
    (4, 4.5, 4.3, 5.6, 3.5, 5.3, 1.5),
    (5, 4.9, 4.5, 6.1, 3.8, 5.7, 1.7),
    (6, 5.6, 4.8, 6.5, 4.2, 6.4, 2.0),
    (7, 6.0, 6.6, 8.2, 4.6, 7.2, 2.2),
    (8, 6.5, 6.8, 9.3, 4.9, 7.7, 2.3),
    (9, 7.0, 7.0, 9.7, 5.3, 8.3, 2.5),
    (10, 7.6, 7.3, 10.4, 5.7, 8.9, 2.7),
    (11, 8.0, 7.5, 11.1, 6.2, 9.6, 2.9),
    (12, 8.7, 7.8, 11.7, 6.5, 10.2, 3.1),
    (13, 9.2, 8.6, 12.1, 7.0, 10.9, 3.3),
    (14, 9.9, 8.9, 12.8, 7.5, 11.6, 3.6),
    (15, 10.4, 9.6, 13.1, 7.7, 12.1, 3.8),
    (16, 11.1, 9.9, 13.7, 8.2, 12.8, 4.0),
    (17, 11.9, 10.1, 14.8, 8.6, 13.6, 4.3),
    (18, 12.7, 10.5, 15.7, 9.2, 14.6, 4.5),
    (19, 13.8, 11.1, 16.8, 9.9, 15.7, 4.8),
    (20, 14.5, 11.5, 18.0, 10.5, 16.5, 5.2),
    (21, 15.5, 11.8, 18.8, 11.2, 17.6, 5.5),
    (22, 16.5, 12.1, 21.2, 11.9, 18.8, 5.9),
    (23, 17.6, 12.4, 21.6, 12.7, 20.1, 6.3),
    (24, 19.2, 12.9, 23.4, 13.7, 21.7, 6.9),
    (25, 21.2, 13.3, 25.5, 14.7, 23.4, 7.4),
    (26, 22.9, 13.8, 27.6, 16.1, 25.7, 8.1),
    (27, 24.6, 14.4, 29.5, 17.3, 27.3, 8.8),
    (28, 26.9, 15.2, 32.6, 18.9, 30.2, 9.6),
    (29, 28.0, 15.8, 34.6, 20.1, 32.0, 10.0),
    (30, 29.2, 16.4, 35.3, 21.3, 33.2, 10.4),
    (31, 30.9, 17.0, 37.0, 22.5, 34.5, 11.0),
];
// Table 16-3-1 "Holding Pattern Selection Chart", 15-29.9 NM / RNAV column
// (note 2: that column determines RNAV pattern numbers), as
// (max holding altitude ft, pattern number) rows per speed section. The speed
// section is chosen by the same AIM 5-3-8 tiers used for hold-leg sizing.
pub(crate) const TERPS_HOLDING_SELECTION_200_KIAS: &[(f64, u8)] =
    &[(2_000.0, 4), (4_000.0, 5), (6_000.0, 6)];
pub(crate) const TERPS_HOLDING_SELECTION_230_KIAS: &[(f64, u8)] =
    &[(8_000.0, 9), (10_000.0, 10), (12_000.0, 10), (14_000.0, 11)];
pub(crate) const TERPS_HOLDING_SELECTION_265_KIAS: &[(f64, u8)] = &[
    (16_000.0, 16),
    (18_000.0, 17),
    (20_000.0, 18),
    (22_000.0, 19),
    (24_000.0, 20),
    (26_000.0, 21),
    (28_000.0, 22),
    (30_000.0, 23),
    (32_000.0, 24),
    (34_000.0, 25),
    (36_000.0, 26),
    (38_000.0, 27),
    (40_000.0, 28),
    (42_000.0, 29),
    (44_000.0, 29),
    (46_000.0, 30),
    (48_000.0, 31),
];
// Secondary area width surrounding the primary perimeter (8260.3F 16-2-4.b).
pub(crate) const HOLD_SECONDARY_WIDTH_NM: f64 = 2.0;

#[cfg(test)]
mod tests;
