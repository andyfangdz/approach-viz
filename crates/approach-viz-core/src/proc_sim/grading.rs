// Mistake grader: watches the state vector and procedure progress and
// raises findings when the pilot breaks IFR discipline.
//
// Every latched check requires the condition to persist for its latch
// time before firing, and each kind fires at most once per arming (it
// re-arms after the condition clears for the latch time). This keeps a
// momentary deviation from spamming findings while still catching real
// busts — the same shape the reference trainer uses.

use crate::proc_sim::types::{GradingThresholds, Mistake, MistakeSeverity};

/// What the grader needs each step.
#[derive(Debug, Clone, Copy)]
pub struct GraderInput {
    pub alt_ft: f64,
    pub assigned_alt_ft: Option<f64>,
    /// Active leg minimum altitude, if any.
    pub leg_min_alt_ft: Option<f64>,
    /// Cross-track error, NM (+ = right). None when not tracking.
    pub xtk_nm: Option<f64>,
    /// Altitude bug currently set on the autopilot.
    pub alt_bug_ft: f64,
    /// Altitude the procedure/clearance expects on the AP bug.
    pub expected_alt_bug_ft: Option<f64>,
    pub sim_time_s: f64,
}

struct Latch {
    kind: &'static str,
    title: &'static str,
    severity: MistakeSeverity,
    active_time_s: f64,
    clear_time_s: f64,
    latched: bool,
}

impl Latch {
    fn new(kind: &'static str, title: &'static str, severity: MistakeSeverity) -> Self {
        Self {
            kind,
            title,
            severity,
            active_time_s: 0.0,
            clear_time_s: 0.0,
            latched: false,
        }
    }

    /// Returns true on the step the latch fires.
    fn update(&mut self, condition: bool, latch_s: f64, dt_s: f64) -> bool {
        if condition {
            self.clear_time_s = 0.0;
            if !self.latched {
                self.active_time_s += dt_s;
                if self.active_time_s >= latch_s {
                    self.latched = true;
                    return true;
                }
            }
        } else {
            self.active_time_s = 0.0;
            if self.latched {
                self.clear_time_s += dt_s;
                if self.clear_time_s >= latch_s {
                    self.latched = false;
                    self.clear_time_s = 0.0;
                }
            }
        }
        false
    }
}

pub struct Grader {
    thresholds: GradingThresholds,
    alt_bust: Latch,
    off_course: Latch,
    wrong_alt_bug: Latch,
    below_minimums_fired: bool,
}

impl Grader {
    pub fn new(thresholds: GradingThresholds) -> Self {
        Self {
            thresholds,
            alt_bust: Latch::new(
                "off_assigned_altitude",
                "Off Assigned Altitude",
                MistakeSeverity::Caution,
            ),
            off_course: Latch::new("course_deviation", "Course Deviation", MistakeSeverity::Caution),
            wrong_alt_bug: Latch::new(
                "altitude_not_set_correctly",
                "Altitude Not Set Correctly",
                MistakeSeverity::Advisory,
            ),
            below_minimums_fired: false,
        }
    }

    /// Evaluate one step. Returns newly raised mistakes (usually 0 or 1).
    pub fn update(&mut self, input: &GraderInput, dt_s: f64) -> Vec<Mistake> {
        let mut out = Vec::new();
        let t = &self.thresholds;

        // 1. Off assigned altitude.
        if let Some(assigned) = input.assigned_alt_ft {
            let bust = (input.alt_ft - assigned).abs() > t.alt_bust_ft;
            if self.alt_bust.update(bust, t.alt_bust_latch_s, dt_s) {
                out.push(Mistake {
                    kind: self.alt_bust.kind.into(),
                    title: self.alt_bust.title.into(),
                    severity: self.alt_bust.severity,
                    details: format!("{assigned:.0}ft"),
                    solution: format!(
                        "You are off of your assigned altitude of {assigned:.0}. \
                         Your altitude: {:.0}.",
                        input.alt_ft
                    ),
                    sim_time_s: input.sim_time_s,
                });
            }
        }

        // 2. Course deviation.
        if let Some(xtk) = input.xtk_nm {
            let off = xtk.abs() > t.xtk_limit_nm;
            if self.off_course.update(off, t.xtk_latch_s, dt_s) {
                let side = if xtk > 0.0 { "right" } else { "left" };
                out.push(Mistake {
                    kind: self.off_course.kind.into(),
                    title: self.off_course.title.into(),
                    severity: self.off_course.severity,
                    details: format!("{xtk:.1} NM {side} of course"),
                    solution: format!(
                        "You are {xtk:.1} NM {side} of the active course. \
                         Turn back toward the course and re-intercept."
                    ),
                    sim_time_s: input.sim_time_s,
                });
            }
        }

        // 3. Wrong altitude bug.
        if let Some(expected) = input.expected_alt_bug_ft {
            let wrong = (input.alt_bug_ft - expected).abs() > 1.0;
            if self.wrong_alt_bug.update(wrong, t.alt_bust_latch_s, dt_s) {
                out.push(Mistake {
                    kind: self.wrong_alt_bug.kind.into(),
                    title: self.wrong_alt_bug.title.into(),
                    severity: self.wrong_alt_bug.severity,
                    details: format!("{expected:.0}ft"),
                    solution: format!(
                        "It appears that you have selected the wrong altitude on the \
                         autopilot. For this procedure or clearance, the altitude you \
                         should have selected should be {expected:.0}ft."
                    ),
                    sim_time_s: input.sim_time_s,
                });
            }
        }

        // 4. Below segment minimums: immediate, fires once per session.
        if let Some(min_alt) = input.leg_min_alt_ft {
            if !self.below_minimums_fired
                && input.alt_ft < min_alt - t.below_minimums_margin_ft
            {
                self.below_minimums_fired = true;
                out.push(Mistake {
                    kind: "below_minimums".into(),
                    title: "Below Segment Minimum Altitude".into(),
                    severity: MistakeSeverity::Warning,
                    details: format!("{min_alt:.0}ft"),
                    solution: format!(
                        "You descended below the minimum altitude of {min_alt:.0}ft \
                         for this segment. Climb immediately to at least {min_alt:.0}ft."
                    ),
                    sim_time_s: input.sim_time_s,
                });
            }
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(alt: f64, t: f64) -> GraderInput {
        GraderInput {
            alt_ft: alt,
            assigned_alt_ft: Some(3000.0),
            leg_min_alt_ft: Some(2000.0),
            xtk_nm: Some(0.1),
            alt_bug_ft: 3000.0,
            expected_alt_bug_ft: Some(3000.0),
            sim_time_s: t,
        }
    }

    #[test]
    fn altitude_bust_latches_before_firing() {
        let mut g = Grader::new(GradingThresholds::default());
        // 1s of bust: no mistake yet (latch is 5s).
        let m = g.update(&input(3500.0, 1.0), 1.0);
        assert!(m.is_empty());
        // 5 more seconds: fires once.
        let mut fired = 0;
        for i in 2..=7 {
            fired += g.update(&input(3500.0, i as f64), 1.0).len();
        }
        assert_eq!(fired, 1);
        // Still busted: does not refire.
        assert!(g.update(&input(3500.0, 8.0), 1.0).is_empty());
    }

    #[test]
    fn below_minimums_fires_immediately_once() {
        let mut g = Grader::new(GradingThresholds::default());
        let m = g.update(&input(1800.0, 1.0), 1.0);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, "below_minimums");
        assert_eq!(m[0].severity, MistakeSeverity::Warning);
        // Does not refire.
        assert!(g.update(&input(1700.0, 2.0), 1.0).iter().all(|m| m.kind != "below_minimums"));
    }

    #[test]
    fn wrong_alt_bug_detected() {
        let mut g = Grader::new(GradingThresholds::default());
        let mut inp = input(3000.0, 1.0);
        inp.alt_bug_ft = 2700.0;
        let mut fired = 0;
        for i in 1..=6 {
            inp.sim_time_s = i as f64;
            fired += g.update(&inp, 1.0).len();
        }
        assert_eq!(fired, 1);
    }

    #[test]
    fn on_profile_no_mistakes() {
        let mut g = Grader::new(GradingThresholds::default());
        for i in 1..=20 {
            let m = g.update(&input(3000.0, i as f64), 1.0);
            assert!(m.is_empty(), "unexpected: {m:?}");
        }
    }
}
