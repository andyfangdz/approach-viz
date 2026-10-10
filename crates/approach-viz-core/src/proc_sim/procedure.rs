// Procedure tracking: which leg is active, cross-track error, sequencing.
//
// The tracker walks an ordered leg list. A leg is complete when the
// aircraft is within the sequencing radius of its fix (or abeam past it);
// the tracker then advances and reports the new active fix.

use crate::proc_sim::kinematics::{along_track_nm, bearing_deg, cross_track_nm, distance_nm};
use crate::proc_sim::types::ProcedureLeg;

/// How close to a fix (NM) before the leg sequences.
pub const SEQUENCING_RADIUS_NM: f64 = 0.5;

pub struct ProcedureTracker {
    legs: Vec<ProcedureLeg>,
    active: usize,
    finished: bool,
}

impl ProcedureTracker {
    pub fn new(legs: Vec<ProcedureLeg>) -> Self {
        Self {
            legs,
            active: 0,
            finished: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.legs.is_empty()
    }

    pub fn active_leg(&self) -> Option<&ProcedureLeg> {
        if self.finished {
            None
        } else {
            self.legs.get(self.active)
        }
    }

    pub fn active_index(&self) -> Option<usize> {
        if self.finished || self.legs.is_empty() {
            None
        } else {
            Some(self.active)
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Previous fix (or the leg's own fix for the first leg): the course is
    /// defined from the previous fix to the active fix.
    fn leg_start(&self, lat: f64, _lon: f64) -> (f64, f64) {
        if self.active == 0 {
            // First leg: course is defined by the leg's published course
            // projected backward from the fix.
            let leg = &self.legs[0];
            let back = (leg.course_deg_true + 180.0).to_radians();
            // 10 NM back along the reciprocal.
            let dlat = 10.0 * back.cos() / 60.0;
            let dlon = 10.0 * back.sin() / (60.0 * lat.to_radians().cos().max(1e-6));
            (leg.fix_lat_deg + dlat, leg.fix_lon_deg + dlon)
        } else {
            let prev = &self.legs[self.active - 1];
            (prev.fix_lat_deg, prev.fix_lon_deg)
        }
    }

    /// Cross-track error on the active leg, NM (+ = right of course).
    pub fn cross_track_nm(&self, lat: f64, lon: f64) -> Option<f64> {
        let leg = self.active_leg()?;
        let (slat, slon) = self.leg_start(lat, lon);
        Some(cross_track_nm(
            slat,
            slon,
            leg.fix_lat_deg,
            leg.fix_lon_deg,
            lat,
            lon,
        ))
    }

    /// Distance to the active fix, NM.
    pub fn distance_to_fix_nm(&self, lat: f64, lon: f64) -> Option<f64> {
        let leg = self.active_leg()?;
        Some(distance_nm(lat, lon, leg.fix_lat_deg, leg.fix_lon_deg))
    }

    /// Bearing to the active fix, degrees true.
    pub fn bearing_to_fix_deg(&self, lat: f64, lon: f64) -> Option<f64> {
        let leg = self.active_leg()?;
        Some(bearing_deg(lat, lon, leg.fix_lat_deg, leg.fix_lon_deg))
    }

    /// Desired track: the leg course, or a direct-to bearing when far off.
    pub fn desired_track_deg(&self, lat: f64, lon: f64) -> Option<f64> {
        let leg = self.active_leg()?;
        let xtk = self.cross_track_nm(lat, lon).unwrap_or(0.0);
        // Within 0.5 NM: fly the published course. Outside: 30 deg intercept.
        if xtk.abs() < 0.5 {
            Some(leg.course_deg_true)
        } else {
            let dist = self.distance_to_fix_nm(lat, lon).unwrap_or(0.0);
            if dist < 1.0 {
                self.bearing_to_fix_deg(lat, lon)
            } else {
                let intercept = 30.0 * -xtk.signum();
                Some(crate::proc_sim::kinematics::normalize_360(
                    leg.course_deg_true + intercept,
                ))
            }
        }
    }

    /// CDI deflection -1..1 for a 2-dot (1.0 NM) full-scale course.
    pub fn cdi(&self, lat: f64, lon: f64) -> Option<f64> {
        self.cross_track_nm(lat, lon)
            .map(|xtk| (xtk / 1.0).clamp(-1.0, 1.0))
    }

    /// Check sequencing. Returns the new active fix name if advanced.
    /// Call after the state update each step.
    pub fn update(&mut self, lat: f64, lon: f64) -> Option<String> {
        if self.finished || self.legs.is_empty() {
            return None;
        }
        let leg = &self.legs[self.active];
        let dist = distance_nm(lat, lon, leg.fix_lat_deg, leg.fix_lon_deg);
        let (slat, slon) = self.leg_start(lat, lon);
        let along = along_track_nm(slat, slon, leg.fix_lat_deg, leg.fix_lon_deg, lat, lon);
        let leg_len = distance_nm(slat, slon, leg.fix_lat_deg, leg.fix_lon_deg);

        let sequenced = dist < SEQUENCING_RADIUS_NM || along > leg_len;
        if sequenced {
            let fix_name = leg.fix_name.clone();
            if self.active + 1 < self.legs.len() {
                self.active += 1;
            } else {
                self.finished = true;
            }
            Some(fix_name)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc_sim::types::ProcedureLeg;

    fn leg(id: &str, name: &str, lat: f64, lon: f64, course: f64) -> ProcedureLeg {
        ProcedureLeg {
            id: id.into(),
            fix_name: name.into(),
            fix_lat_deg: lat,
            fix_lon_deg: lon,
            course_deg_true: course,
            min_alt_ft: None,
            max_alt_ft: None,
            is_final_approach_fix: false,
        }
    }

    #[test]
    fn sequences_when_close_to_fix() {
        let mut t = ProcedureTracker::new(vec![
            leg("1", "AAA", 28.0, -82.0, 90.0),
            leg("2", "BBB", 28.0, -81.0, 90.0),
        ]);
        assert_eq!(t.active_index(), Some(0));
        // 10 NM west of AAA: no sequence.
        assert_eq!(t.update(28.0, -82.2), None);
        assert_eq!(t.active_index(), Some(0));
        // At AAA: sequences AAA, advancing to BBB.
        assert_eq!(t.update(28.0, -82.0), Some("AAA".into()));
        assert_eq!(t.active_index(), Some(1));
    }

    #[test]
    fn cross_track_zero_on_course() {
        let t = ProcedureTracker::new(vec![leg("1", "AAA", 28.0, -81.0, 90.0)]);
        // Sitting on the 090 course line west of the fix: ~0 XTK.
        let xtk = t.cross_track_nm(28.0, -81.5);
        assert!(xtk.unwrap().abs() < 0.05, "xtk={xtk:?}");
        // 0.1 deg north of course: ~6 NM left (negative).
        let xtk = t.cross_track_nm(28.1, -81.5);
        assert!(xtk.unwrap() < -5.0, "xtk={xtk:?}");
    }

    #[test]
    fn finishes_after_last_leg() {
        let mut t = ProcedureTracker::new(vec![leg("1", "AAA", 28.0, -82.0, 90.0)]);
        t.update(28.0, -82.0);
        assert!(t.is_finished());
        assert_eq!(t.active_leg(), None);
    }
}
