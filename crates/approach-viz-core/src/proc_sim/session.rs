// Session orchestrator: owns the aircraft, autopilot, procedure tracker,
// and grader, and advances them one fixed timestep at a time.
//
// The host drives the clock: call [`ProcSimSession::step`] with the
// configured `dt_s` (e.g. from a requestAnimationFrame loop or a worker
// timer). The session is fully deterministic given the same config and
// input sequence.

use crate::proc_sim::autopilot::{ApCommand, Autopilot, NavGuidance};
use crate::proc_sim::grading::{Grader, GraderInput};
use crate::proc_sim::kinematics::{step_position, tas_from_ias, wind_triangle};
use crate::proc_sim::procedure::ProcedureTracker;
use crate::proc_sim::types::{
    AircraftState, AutopilotSettings, Mistake, ProcSimEvent, SimConfig, SimSnapshot, WindState,
};

/// Roll rate toward the AP's bank target, degrees per second.
const ROLL_RATE_DPS: f64 = 15.0;
/// How fast VS slews toward the AP's target, fpm per second.
const VS_SLEW_FPM_PER_S: f64 = 1500.0;

pub struct ProcSimSession {
    state: AircraftState,
    ap: Autopilot,
    procedure: ProcedureTracker,
    grader: Grader,
    wind: WindState,
    assigned_alt_ft: Option<f64>,
    expected_alt_bug_ft: Option<f64>,
    sim_time_s: f64,
    dt_s: f64,
    mistakes: Vec<Mistake>,
    finished: bool,
}

impl ProcSimSession {
    /// Build a session. Fails loudly on invalid config (non-positive dt,
    /// empty legs are allowed = free flight, but NaN inputs are rejected).
    pub fn new(config: SimConfig) -> Result<Self, String> {
        if !config.dt_s.is_finite() || config.dt_s <= 0.0 || config.dt_s > 1.0 {
            return Err(format!("dt_s must be in (0, 1], got {}", config.dt_s));
        }
        validate_state(&config.initial_state)?;
        validate_autopilot(&config.initial_autopilot)?;
        validate_wind(&config.wind)?;
        validate_assigned_altitude(config.assigned_alt_ft)?;
        let perf = config.performance;
        if ![
            perf.max_bank_deg,
            perf.standard_turn_rate_dps,
            perf.max_vs_fpm,
            perf.alt_capture_lead_ft,
        ]
        .iter()
        .all(|v| v.is_finite() && *v > 0.0)
            || perf.max_bank_deg >= 90.0
        {
            return Err("Invalid aircraft performance".into());
        }
        let grading = config.grading;
        if ![
            grading.alt_bust_ft,
            grading.alt_bust_latch_s,
            grading.xtk_limit_nm,
            grading.xtk_latch_s,
            grading.below_minimums_margin_ft,
        ]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.0)
        {
            return Err("Invalid grading thresholds".into());
        }
        for leg in &config.legs {
            if leg.id.is_empty()
                || leg.fix_name.is_empty()
                || ![leg.fix_lat_deg, leg.fix_lon_deg, leg.course_deg_true]
                    .iter()
                    .all(|v| v.is_finite())
                || leg.fix_lat_deg.abs() > 90.0
                || leg.fix_lon_deg.abs() > 180.0
                || leg.min_alt_ft.is_some_and(|v| !v.is_finite())
                || leg.max_alt_ft.is_some_and(|v| !v.is_finite())
                || matches!((leg.min_alt_ft, leg.max_alt_ft), (Some(min), Some(max)) if min > max)
            {
                return Err(format!("Invalid procedure leg {}", leg.id));
            }
        }
        let mut state = config.initial_state;
        state.tas_kts = tas_from_ias(state.ias_kts, state.alt_ft_msl);
        state.gs_kts = wind_triangle(
            state.tas_kts,
            state.hdg_deg_true,
            config.wind.direction_from_deg_true,
            config.wind.speed_kts,
        )
        .0;
        let ap = Autopilot::new(config.initial_autopilot, config.performance);
        let procedure = ProcedureTracker::new(config.legs);
        let grader = Grader::new(config.grading);
        Ok(Self {
            state,
            ap,
            procedure,
            grader,
            wind: config.wind,
            assigned_alt_ft: config.assigned_alt_ft,
            expected_alt_bug_ft: config.assigned_alt_ft,
            sim_time_s: 0.0,
            dt_s: config.dt_s,
            mistakes: Vec::new(),
            finished: false,
        })
    }

    pub fn set_autopilot(&mut self, settings: AutopilotSettings) -> Result<(), String> {
        validate_autopilot(&settings)?;
        self.ap.set_settings(settings);
        Ok(())
    }

    pub fn set_wind(&mut self, wind: WindState) -> Result<(), String> {
        validate_wind(&wind)?;
        self.wind = wind;
        Ok(())
    }

    /// ATC clearance update: what altitude the grader holds the pilot to.
    pub fn set_assigned_altitude(&mut self, alt_ft: Option<f64>) -> Result<(), String> {
        validate_assigned_altitude(alt_ft)?;
        self.assigned_alt_ft = alt_ft;
        self.expected_alt_bug_ft = alt_ft;
        Ok(())
    }

    pub fn snapshot(&self) -> SimSnapshot {
        let (xtk, dist, cdi) = if self.procedure.is_empty() || self.finished {
            (None, None, None)
        } else {
            (
                self.procedure
                    .cross_track_nm(self.state.lat_deg, self.state.lon_deg),
                self.procedure
                    .distance_to_fix_nm(self.state.lat_deg, self.state.lon_deg),
                self.procedure.cdi(self.state.lat_deg, self.state.lon_deg),
            )
        };
        SimSnapshot {
            sim_time_s: self.sim_time_s,
            state: self.state,
            autopilot: self.ap.settings(),
            active_leg_index: self.procedure.active_index().map(|index| index as u64),
            active_leg_fix: self.procedure.active_leg().map(|l| l.fix_name.clone()),
            xtk_nm: xtk,
            dist_to_fix_nm: dist,
            cdi,
            mistakes: self.mistakes.clone(),
        }
    }

    /// Advance the simulation one fixed step. Returns events for the host
    /// (waypoint sequencing, new mistakes, procedure completion).
    pub fn step(&mut self) -> Vec<ProcSimEvent> {
        let dt = self.dt_s;
        self.step_inner(dt)
    }

    /// Advance by an arbitrary delta, internally quantized to dt_s steps.
    /// The final partial step is dropped to keep the trajectory on the
    /// fixed grid (deterministic regardless of host frame rate).
    pub fn advance(&mut self, delta_s: f64) -> Vec<ProcSimEvent> {
        let mut events = Vec::new();
        if !delta_s.is_finite() || delta_s <= 0.0 {
            return events;
        }
        let n = (delta_s / self.dt_s).floor() as usize;
        for _ in 0..n {
            events.extend(self.step_inner(self.dt_s));
        }
        events
    }

    fn step_inner(&mut self, dt: f64) -> Vec<ProcSimEvent> {
        let mut events = Vec::new();
        if self.finished {
            return events;
        }
        self.sim_time_s += dt;

        // --- navigation guidance for the AP ---
        let nav = self.nav_guidance();

        // --- autopilot ---
        let tas = tas_from_ias(self.state.ias_kts, self.state.alt_ft_msl);
        let cmd: ApCommand = self.ap.update(
            self.state.hdg_deg_true,
            self.state.ias_kts,
            tas,
            self.state.alt_ft_msl,
            self.state.vs_fpm,
            &nav,
            dt,
        );

        // --- airframe response: roll toward target bank ---
        let bank_err = cmd.target_bank_deg - self.state.bank_deg;
        let max_roll = ROLL_RATE_DPS * dt;
        self.state.bank_deg += bank_err.clamp(-max_roll, max_roll);

        // --- heading integrates the actual bank ---
        // Coordinated turn: rate = g * tan(bank) / v.
        let bank_rad = self.state.bank_deg.to_radians();
        let v_nm_per_s = tas / 3600.0;
        // g in NM/s^2.
        const G_NM_PER_S2: f64 = 9.80665 / 1852.0;
        let rate_rps = if v_nm_per_s > 1e-6 {
            (G_NM_PER_S2 * bank_rad.tan() / v_nm_per_s).clamp(-0.2, 0.2)
        } else {
            0.0
        };
        self.state.hdg_deg_true = crate::proc_sim::kinematics::normalize_360(
            self.state.hdg_deg_true + rate_rps.to_degrees() * dt,
        );

        // --- vertical: slew VS toward target, integrate altitude ---
        let vs_err = cmd.target_vs_fpm - self.state.vs_fpm;
        let max_slew = VS_SLEW_FPM_PER_S * dt;
        self.state.vs_fpm += vs_err.clamp(-max_slew, max_slew);
        self.state.alt_ft_msl += self.state.vs_fpm * dt / 60.0;
        if self.state.alt_ft_msl < 0.0 {
            self.state.alt_ft_msl = 0.0;
            self.state.vs_fpm = self.state.vs_fpm.max(0.0);
        }

        // --- position: wind triangle then rhumb-line step ---
        let (gs, track) = wind_triangle(
            tas,
            self.state.hdg_deg_true,
            self.wind.direction_from_deg_true,
            self.wind.speed_kts,
        );
        self.state.tas_kts = tas;
        self.state.gs_kts = gs;
        let (lat, lon) = step_position(self.state.lat_deg, self.state.lon_deg, track, gs, dt);
        self.state.lat_deg = lat;
        self.state.lon_deg = lon;
        // Speed is bug-driven (no thrust/drag model in v1).
        self.state.ias_kts = self.ap.settings().spd_bug_kts;

        // --- procedure sequencing ---
        if !self.procedure.is_empty() {
            if let Some(fix) = self
                .procedure
                .update(self.state.lat_deg, self.state.lon_deg)
            {
                events.push(ProcSimEvent::WaypointSequenced { fix_name: fix });
            }
            if self.procedure.is_finished() && !self.finished {
                self.finished = true;
                events.push(ProcSimEvent::ProcedureComplete);
            }
        }

        // --- grading ---
        let leg_min = self.procedure.active_leg().and_then(|l| l.min_alt_ft);
        let xtk = self
            .procedure
            .cross_track_nm(self.state.lat_deg, self.state.lon_deg);
        let input = GraderInput {
            alt_ft: self.state.alt_ft_msl,
            assigned_alt_ft: self.assigned_alt_ft,
            leg_min_alt_ft: leg_min,
            xtk_nm: xtk,
            alt_bug_ft: self.ap.settings().alt_bug_ft,
            expected_alt_bug_ft: self.expected_alt_bug_ft,
            sim_time_s: self.sim_time_s,
        };
        for m in self.grader.update(&input, dt) {
            events.push(ProcSimEvent::MistakeRaised { mistake: m.clone() });
            self.mistakes.push(m);
        }

        events
    }

    fn nav_guidance(&self) -> NavGuidance {
        use crate::proc_sim::types::LateralMode;
        match self.ap.settings().lateral {
            LateralMode::Nav | LateralMode::Localizer => {
                if self.procedure.is_empty() || self.finished {
                    return NavGuidance {
                        xtk_nm: None,
                        desired_track_deg: None,
                        gs_dots: None,
                    };
                }
                NavGuidance {
                    xtk_nm: self
                        .procedure
                        .cross_track_nm(self.state.lat_deg, self.state.lon_deg),
                    desired_track_deg: self
                        .procedure
                        .desired_track_deg(self.state.lat_deg, self.state.lon_deg),
                    gs_dots: None,
                }
            }
            _ => NavGuidance {
                xtk_nm: None,
                desired_track_deg: None,
                gs_dots: None,
            },
        }
    }
}

fn validate_state(state: &AircraftState) -> Result<(), String> {
    if ![
        state.lat_deg,
        state.lon_deg,
        state.alt_ft_msl,
        state.hdg_deg_true,
        state.ias_kts,
        state.vs_fpm,
        state.bank_deg,
        state.gs_kts,
        state.tas_kts,
        state.mag_var_deg,
    ]
    .iter()
    .all(|v| v.is_finite())
        || state.lat_deg.abs() > 90.0
        || state.lon_deg.abs() > 180.0
        || state.alt_ft_msl < 0.0
        || state.ias_kts <= 0.0
        || state.bank_deg.abs() >= 90.0
    {
        return Err("Invalid aircraft state".into());
    }
    Ok(())
}
fn validate_autopilot(ap: &AutopilotSettings) -> Result<(), String> {
    if ![
        ap.hdg_bug_deg,
        ap.alt_bug_ft,
        ap.vs_bug_fpm,
        ap.crs_bug_deg,
        ap.spd_bug_kts,
    ]
    .iter()
    .all(|v| v.is_finite())
        || ap.spd_bug_kts <= 0.0
        || ap.alt_bug_ft < 0.0
    {
        return Err("Invalid autopilot settings".into());
    }
    Ok(())
}
fn validate_wind(wind: &WindState) -> Result<(), String> {
    if !wind.direction_from_deg_true.is_finite()
        || !wind.speed_kts.is_finite()
        || wind.speed_kts < 0.0
    {
        return Err("Invalid wind".into());
    }
    Ok(())
}
fn validate_assigned_altitude(alt: Option<f64>) -> Result<(), String> {
    if alt.is_some_and(|v| !v.is_finite() || v < 0.0) {
        return Err("Invalid assigned altitude".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc_sim::types::*;

    fn test_config() -> SimConfig {
        SimConfig {
            initial_state: AircraftState {
                lat_deg: 28.0,
                lon_deg: -81.2,
                alt_ft_msl: 3000.0,
                hdg_deg_true: 90.0,
                ias_kts: 110.0,
                vs_fpm: 0.0,
                bank_deg: 0.0,
                gs_kts: 110.0,
                tas_kts: 110.0,
                mag_var_deg: 0.0,
            },
            initial_autopilot: AutopilotSettings {
                lateral: LateralMode::Nav,
                vertical: VerticalMode::AltitudeHold,
                hdg_bug_deg: 90.0,
                alt_bug_ft: 3000.0,
                vs_bug_fpm: 0.0,
                crs_bug_deg: 90.0,
                spd_bug_kts: 110.0,
            },
            performance: AircraftPerformance::default(),
            wind: WindState {
                direction_from_deg_true: 0.0,
                speed_kts: 0.0,
            },
            legs: vec![ProcedureLeg {
                id: "1".into(),
                fix_name: "FIXA".into(),
                fix_lat_deg: 28.0,
                fix_lon_deg: -81.0,
                course_deg_true: 90.0,
                min_alt_ft: Some(2000.0),
                max_alt_ft: None,
                is_final_approach_fix: false,
            }],
            assigned_alt_ft: Some(3000.0),
            grading: GradingThresholds::default(),
            dt_s: 0.1,
        }
    }

    #[test]
    fn rejects_invalid_config_and_preserves_state_on_bad_controls() {
        let mut config = test_config();
        config.wind.speed_kts = f64::NAN;
        assert!(ProcSimSession::new(config).is_err());
        let mut config = test_config();
        config.performance.max_bank_deg = 90.0;
        assert!(ProcSimSession::new(config).is_err());
        let mut config = test_config();
        config.legs[0].fix_lon_deg = 181.0;
        assert!(ProcSimSession::new(config).is_err());
        let mut session = ProcSimSession::new(test_config()).unwrap();
        let initial = session.snapshot();
        let mut ap = initial.autopilot;
        ap.hdg_bug_deg = f64::NAN;
        assert!(session.set_autopilot(ap).is_err());
        assert!(
            session
                .set_wind(WindState {
                    direction_from_deg_true: 0.0,
                    speed_kts: -1.0
                })
                .is_err()
        );
        assert!(session.set_assigned_altitude(Some(f64::INFINITY)).is_err());
        assert_eq!(session.snapshot(), initial);
        session.step();
        assert!(session.snapshot().state.lat_deg.is_finite());
    }

    #[test]
    fn rejects_bad_dt() {
        let mut c = test_config();
        c.dt_s = 0.0;
        assert!(ProcSimSession::new(c).is_err());
    }

    #[test]
    fn flies_straight_and_holds_altitude() {
        let mut s = ProcSimSession::new(test_config()).unwrap();
        for _ in 0..100 {
            s.step();
        }
        let snap = s.snapshot();
        // Still eastbound, still 3000.
        assert!((snap.state.hdg_deg_true - 90.0).abs() < 2.0);
        assert!((snap.state.alt_ft_msl - 3000.0).abs() < 25.0);
        assert!(snap.mistakes.is_empty(), "{:?}", snap.mistakes);
        // Moving east toward the fix.
        assert!(snap.state.lon_deg > -81.2);
    }

    #[test]
    fn sequences_waypoint_and_completes() {
        let mut s = ProcSimSession::new(test_config()).unwrap();
        let mut sequenced = false;
        let mut complete = false;
        for _ in 0..5000 {
            for e in s.step() {
                match e {
                    ProcSimEvent::WaypointSequenced { .. } => sequenced = true,
                    ProcSimEvent::ProcedureComplete => complete = true,
                    _ => {}
                }
            }
            if complete {
                break;
            }
        }
        assert!(sequenced && complete);
    }

    #[test]
    fn altitude_bust_raises_mistake() {
        let mut c = test_config();
        c.initial_autopilot.vertical = VerticalMode::VerticalSpeed;
        c.initial_autopilot.vs_bug_fpm = -1000.0;
        c.initial_autopilot.alt_bug_ft = 2000.0;
        let mut s = ProcSimSession::new(c).unwrap();
        for _ in 0..2000 {
            s.step();
        }
        let snap = s.snapshot();
        assert!(
            snap.mistakes
                .iter()
                .any(|m| m.kind == "off_assigned_altitude"),
            "mistakes: {:?}",
            snap.mistakes.iter().map(|m| &m.kind).collect::<Vec<_>>()
        );
    }
}
