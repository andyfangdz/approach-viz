// Client-side instrument procedure simulator.
//
// A deterministic, host-driven flight model for flying FAA instrument
// procedures: the host owns the clock and calls
// [`ProcSimSession::step`] at a fixed timestep (10-20 Hz works well).
// There is no networking, no wall-clock, and no randomness; the same
// inputs always produce the same trajectory.
//
// The design is informed by a clean-room protocol analysis of an online
// instrument trainer: the aircraft is flown through the autopilot (no
// yoke), the server-style mistake grader runs locally, and the state
// vector is the single source of truth for the UI.
//
// Layout:
// - [`types`] — public API types (serde/uniffi conventions per crate rules).
// - [`kinematics`] — pure math: turns, wind triangle, great-circle helpers.
// - [`autopilot`] — HDG/NAV/LOC + ALT/VS/GS control laws.
// - [`procedure`] — leg sequencing and cross-track bookkeeping.
// - [`grading`] — mistake detection with persistence latches.
// - [`session`] — the orchestrator: [`ProcSimSession`].

pub mod autopilot;
pub mod grading;
pub mod kinematics;
pub mod procedure;
pub mod session;
pub mod types;

pub use session::ProcSimSession;
pub use types::{
    AircraftPerformance, AircraftState, AutopilotSettings, GradingThresholds, LateralMode,
    Mistake, MistakeSeverity, ProcedureLeg, ProcSimEvent, SimConfig, SimSnapshot, VerticalMode,
    WindState,
};
