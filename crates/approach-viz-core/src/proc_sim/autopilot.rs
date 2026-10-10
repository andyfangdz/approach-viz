// Autopilot control laws.
//
// The simulator is flown through the autopilot, like the reference
// trainer: the pilot sets modes and bugs, and the AP flies standard-rate
// turns, tracks courses, and manages vertical speed. There is no yoke.
//
// Conventions (decoded from the reference trainer's client):
// - Lateral:  Off / Heading (bug) / Nav (procedure leg or VOR) / Localizer
// - Vertical: Off / AltitudeHold / VerticalSpeed / GlideSlope

use crate::proc_sim::kinematics::{angle_diff_deg, bank_for_turn_rate};
use crate::proc_sim::types::{AircraftPerformance, AutopilotSettings, LateralMode, VerticalMode};

/// What the autopilot wants the airframe to do this step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ApCommand {
    /// Target bank, degrees (+ = right). The airframe rolls toward it.
    pub target_bank_deg: f64,
    /// Target vertical speed, fpm (+ = climb).
    pub target_vs_fpm: f64,
    /// True when the AP is actively steering laterally.
    pub lateral_active: bool,
    /// True when the AP is actively managing vertical path.
    pub vertical_active: bool,
}

/// Navigation guidance available to the autopilot this step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NavGuidance {
    /// Cross-track error, NM (+ = right of course). None if no course.
    pub xtk_nm: Option<f64>,
    /// Desired track to fly to rejoin/stay on course, degrees true.
    pub desired_track_deg: Option<f64>,
    /// Glideslope deviation, dots (+ = fly up). None if no GS.
    pub gs_dots: Option<f64>,
}

/// Stateless control laws. Internal AP state (capture arms, integrators)
/// lives in [`Autopilot`].
pub struct Autopilot {
    settings: AutopilotSettings,
    perf: AircraftPerformance,
    /// Altitude capture: once armed, VS tapers approaching the bug.
    alt_capture_armed: bool,
}

impl Autopilot {
    pub fn new(settings: AutopilotSettings, perf: AircraftPerformance) -> Self {
        Self {
            settings,
            perf,
            alt_capture_armed: false,
        }
    }

    pub fn settings(&self) -> AutopilotSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: AutopilotSettings) {
        // Re-arm capture when the pilot dials a new altitude bug.
        if (settings.alt_bug_ft - self.settings.alt_bug_ft).abs() > 1e-6 {
            self.alt_capture_armed = true;
        }
        self.settings = settings;
    }

    /// Compute this step's command from current state and guidance.
    pub fn update(
        &mut self,
        hdg_deg: f64,
        _ias_kts: f64,
        tas_kts: f64,
        alt_ft: f64,
        vs_fpm: f64,
        nav: &NavGuidance,
        dt_s: f64,
    ) -> ApCommand {
        let _ = dt_s;
        let mut cmd = ApCommand {
            target_bank_deg: 0.0,
            target_vs_fpm: vs_fpm,
            lateral_active: false,
            vertical_active: false,
        };

        // ---- lateral ----
        match self.settings.lateral {
            LateralMode::Off => {}
            LateralMode::Heading => {
                cmd.lateral_active = true;
                let diff = angle_diff_deg(hdg_deg, self.settings.hdg_bug_deg);
                // Roll out as we approach the bug: limit bank by remaining turn.
                let max_bank = self.perf.max_bank_deg;
                let rate_bank = bank_for_turn_rate(tas_kts, self.perf.standard_turn_rate_dps);
                let target_bank = rate_bank.min(max_bank);
                // Anticipate rollout: reduce bank inside ~10 deg of the bug.
                let rollout_gain = (diff.abs() / 10.0).min(1.0);
                cmd.target_bank_deg = target_bank * diff.signum() * rollout_gain;
                if diff.abs() < 0.05 {
                    cmd.target_bank_deg = 0.0;
                }
            }
            LateralMode::Nav | LateralMode::Localizer => {
                if let (Some(xtk), Some(desired)) = (nav.xtk_nm, nav.desired_track_deg) {
                    cmd.lateral_active = true;
                    // Steer toward the desired track; gain is higher for LOC.
                    let gain = match self.settings.lateral {
                        LateralMode::Localizer => 2.5,
                        _ => 1.5,
                    };
                    let track_err = angle_diff_deg(hdg_deg, desired);
                    // Bank proportional to track error, capped; plus a small
                    // XTK correction so we actually rejoin instead of paralleling.
                    let xtk_corr = (xtk * 8.0).clamp(-15.0, 15.0);
                    let raw = track_err * gain + xtk_corr;
                    let max_bank = self.perf.max_bank_deg.min(25.0);
                    cmd.target_bank_deg = raw.clamp(-max_bank, max_bank);
                }
            }
        }

        // ---- vertical ----
        match self.settings.vertical {
            VerticalMode::Off => {}
            VerticalMode::AltitudeHold => {
                cmd.vertical_active = true;
                // Proportional hold on the bug; gentle.
                let err = self.settings.alt_bug_ft - alt_ft;
                cmd.target_vs_fpm = (err * 2.0).clamp(-1000.0, 1000.0);
            }
            VerticalMode::VerticalSpeed => {
                cmd.vertical_active = true;
                let mut target = self
                    .settings
                    .vs_bug_fpm
                    .clamp(-self.perf.max_vs_fpm, self.perf.max_vs_fpm);
                let err = self.settings.alt_bug_ft - alt_ft;
                // Moving away from the bug (VS and error disagree in sign):
                // hold the bug VS, no capture attempt.
                let moving_away = (target > 0.0 && err < 0.0) || (target < 0.0 && err > 0.0);
                if !moving_away {
                    if err.abs() < 5.0 {
                        // At the bug: level off.
                        target = 0.0;
                    } else if err.abs() < self.perf.alt_capture_lead_ft {
                        // Capture: scale the bug VS linearly from full at the
                        // lead boundary to zero at the bug.
                        let t = err.abs() / self.perf.alt_capture_lead_ft;
                        target = target * t;
                    }
                }
                cmd.target_vs_fpm = target;
            }
            VerticalMode::GlideSlope => {
                if let Some(dots) = nav.gs_dots {
                    cmd.vertical_active = true;
                    // 1 dot ~ 700 fpm correction at approach speeds; clamp.
                    cmd.target_vs_fpm =
                        (dots * 700.0).clamp(-self.perf.max_vs_fpm, self.perf.max_vs_fpm);
                }
            }
        }

        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc_sim::types::{AutopilotSettings, LateralMode, VerticalMode};

    fn settings() -> AutopilotSettings {
        AutopilotSettings {
            lateral: LateralMode::Heading,
            vertical: VerticalMode::VerticalSpeed,
            hdg_bug_deg: 90.0,
            alt_bug_ft: 3000.0,
            vs_bug_fpm: -500.0,
            crs_bug_deg: 90.0,
            spd_bug_kts: 110.0,
        }
    }

    fn no_nav() -> NavGuidance {
        NavGuidance {
            xtk_nm: None,
            desired_track_deg: None,
            gs_dots: None,
        }
    }

    #[test]
    fn hdg_mode_banks_right_for_right_turn() {
        let mut ap = Autopilot::new(settings(), AircraftPerformance::default());
        let cmd = ap.update(0.0, 110.0, 115.0, 3000.0, 0.0, &no_nav(), 0.1);
        assert!(cmd.lateral_active);
        assert!(cmd.target_bank_deg > 10.0, "bank={}", cmd.target_bank_deg);
    }

    #[test]
    fn hdg_mode_rolls_out_approaching_bug() {
        let mut ap = Autopilot::new(settings(), AircraftPerformance::default());
        // 2 deg from the bug: bank should be small.
        let cmd = ap.update(88.0, 110.0, 115.0, 3000.0, 0.0, &no_nav(), 0.1);
        assert!(
            cmd.target_bank_deg.abs() < 5.0,
            "bank={}",
            cmd.target_bank_deg
        );
    }

    #[test]
    fn vs_mode_tracks_bug_and_captures() {
        let mut ap = Autopilot::new(settings(), AircraftPerformance::default());
        // Far from bug: full VS.
        let cmd = ap.update(90.0, 110.0, 115.0, 4000.0, -500.0, &no_nav(), 0.1);
        assert!((cmd.target_vs_fpm + 500.0).abs() < 1e-6);
        // Inside capture lead: tapering.
        let cmd = ap.update(90.0, 110.0, 115.0, 3080.0, -500.0, &no_nav(), 0.1);
        assert!(cmd.target_vs_fpm > -500.0 && cmd.target_vs_fpm < 0.0);
        // At the bug: level.
        let cmd = ap.update(90.0, 110.0, 115.0, 3002.0, -100.0, &no_nav(), 0.1);
        assert_eq!(cmd.target_vs_fpm, 0.0);
    }

    #[test]
    fn alt_hold_corrects_gently() {
        let mut s = settings();
        s.vertical = VerticalMode::AltitudeHold;
        let mut ap = Autopilot::new(s, AircraftPerformance::default());
        let cmd = ap.update(90.0, 110.0, 115.0, 3100.0, 0.0, &no_nav(), 0.1);
        assert!(cmd.target_vs_fpm < 0.0 && cmd.target_vs_fpm >= -1000.0);
    }
}
