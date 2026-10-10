//! Strict conversion of the existing FAA approach-path input contract.
use super::{
    ProcedureLeg,
    kinematics::{bearing_deg, distance_nm},
};
use crate::approach_path::{ApproachPathLeg, ApproachWaypoint};
use crate::coords::magnetic_to_true_heading;

#[derive(Debug, Clone)]
#[cfg_attr(feature = "wasm", derive(serde::Deserialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
pub struct ProcedureInput {
    pub legs: Vec<ApproachPathLeg>,
    pub waypoints: Vec<ApproachWaypoint>,
    pub mag_var: f64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "wasm", derive(serde::Serialize))]
#[cfg_attr(feature = "wasm", serde(rename_all = "camelCase"))]
pub struct PreparedProcedure {
    pub legs: Vec<ProcedureLeg>,
    pub start_lat: f64,
    pub start_lon: f64,
    pub start_heading: f64,
    pub mag_var: f64,
}

pub fn prepare_procedure(mut input: ProcedureInput) -> Result<PreparedProcedure, String> {
    // Shared transition/final seam: retain one copy of a repeated initial fix.
    let mut joined: Vec<ApproachPathLeg> = Vec::new();
    for leg in input.legs {
        if leg.path_terminator == "IF"
            && joined
                .last()
                .is_some_and(|previous| previous.waypoint_id == leg.waypoint_id)
        {
            continue;
        }
        joined.push(leg);
    }
    input.legs = joined;
    if !input.mag_var.is_finite() {
        return Err("Missing or malformed magnetic variation".into());
    }
    if input.legs.len() < 2 {
        return Err("Select a procedure with at least two fixes".into());
    }
    let mut fixes = Vec::new();
    for (index, leg) in input.legs.iter().enumerate() {
        if leg.is_missed_approach
            || !matches!(leg.path_terminator.as_str(), "IF" | "TF" | "CF")
            || (index > 0 && leg.path_terminator == "IF")
        {
            return Err(format!(
                "{}: {} legs are not supported by this simulator",
                leg.waypoint_name, leg.path_terminator
            ));
        }
        let fix = input
            .waypoints
            .iter()
            .find(|fix| fix.id == leg.waypoint_id)
            .ok_or_else(|| format!("Missing FAA fix {}", leg.waypoint_id))?;
        if !fix.lat.is_finite()
            || !fix.lon.is_finite()
            || fix.lat.abs() > 90.0
            || fix.lon.abs() > 180.0
        {
            return Err(format!("Malformed FAA fix {}", fix.id));
        }
        if leg.altitude.is_some_and(|alt| !alt.is_finite())
            || leg.course.is_some_and(|course| !course.is_finite())
        {
            return Err(format!("Malformed FAA leg {}", leg.waypoint_name));
        }
        if leg.altitude_constraint.as_deref() == Some("between") {
            return Err(format!(
                "{}: incomplete between-altitude constraint",
                leg.waypoint_name
            ));
        }
        fixes.push(fix);
    }
    let mut legs = Vec::new();
    for index in 1..input.legs.len() {
        let source = &input.legs[index];
        let fix = fixes[index];
        let previous = fixes[index - 1];
        if distance_nm(previous.lat, previous.lon, fix.lat, fix.lon) < 0.5 {
            return Err(format!(
                "{}: fixes are inside the simulator's 0.5 NM sequencing radius",
                fix.name
            ));
        }
        let course = if source.path_terminator == "CF" {
            magnetic_to_true_heading(
                source
                    .course
                    .ok_or_else(|| format!("Missing CF course at {}", fix.name))?,
                input.mag_var,
            )
        } else {
            bearing_deg(previous.lat, previous.lon, fix.lat, fix.lon)
        };
        let (min_alt_ft, max_alt_ft) =
            match (source.altitude, source.altitude_constraint.as_deref()) {
                (None, _) => (None, None),
                (Some(alt), Some("+")) => (Some(alt), None),
                (Some(alt), Some("-")) => (None, Some(alt)),
                (Some(alt), Some("at") | None) => (Some(alt), Some(alt)),
                _ => return Err(format!("Malformed altitude constraint at {}", fix.name)),
            };
        legs.push(ProcedureLeg {
            id: format!("{}:{}", source.sequence, fix.id),
            fix_name: source.waypoint_name.clone(),
            fix_lat_deg: fix.lat,
            fix_lon_deg: fix.lon,
            course_deg_true: course,
            min_alt_ft,
            max_alt_ft,
            is_final_approach_fix: source.is_final_approach_fix,
        });
    }
    Ok(PreparedProcedure {
        start_lat: fixes[0].lat,
        start_lon: fixes[0].lon,
        start_heading: legs[0].course_deg_true,
        mag_var: input.mag_var,
        legs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> ProcedureInput {
        let leg = |sequence, id: &str, terminator: &str| ApproachPathLeg {
            sequence,
            waypoint_id: id.into(),
            waypoint_name: id.into(),
            path_terminator: terminator.into(),
            altitude: Some(2000.0),
            altitude_constraint: Some("+".into()),
            course: Some(80.0),
            distance: None,
            hold_course: None,
            hold_distance: None,
            turn_direction: None,
            hold_turn_direction: None,
            rf_center_waypoint_id: None,
            rf_turn_direction: None,
            vertical_angle_deg: None,
            rnp_service_levels: None,
            is_final_approach_fix: true,
            is_initial_fix: sequence == 1,
            is_final_fix: false,
            is_missed_approach: false,
        };
        ProcedureInput {
            legs: vec![leg(1, "A", "IF"), leg(2, "B", "CF"), leg(3, "C", "TF")],
            waypoints: vec![
                ApproachWaypoint {
                    id: "A".into(),
                    name: "A".into(),
                    lat: 28.0,
                    lon: -81.2,
                    waypoint_type: "terminal".into(),
                },
                ApproachWaypoint {
                    id: "B".into(),
                    name: "B".into(),
                    lat: 28.0,
                    lon: -81.0,
                    waypoint_type: "terminal".into(),
                },
                ApproachWaypoint {
                    id: "C".into(),
                    name: "C".into(),
                    lat: 28.2,
                    lon: -81.0,
                    waypoint_type: "terminal".into(),
                },
            ],
            mag_var: 10.0,
        }
    }
    #[test]
    fn preserves_fixes_constraints_and_true_courses() {
        let mut source = input();
        source.legs[2].altitude_constraint = Some("-".into());
        let prepared = prepare_procedure(source).unwrap();
        assert_eq!(prepared.start_lat, 28.0);
        assert_eq!(prepared.start_lon, -81.2);
        assert_eq!(prepared.legs.len(), 2);
        assert_eq!(prepared.legs[0].course_deg_true, 90.0);
        assert_eq!(prepared.legs[0].min_alt_ft, Some(2000.0));
        assert_eq!(prepared.legs[0].max_alt_ft, None);
        assert!(prepared.legs[0].is_final_approach_fix);
        assert!(prepared.legs[1].course_deg_true.abs() < 1e-6);
        assert_eq!(prepared.legs[1].min_alt_ft, None);
        assert_eq!(prepared.legs[1].max_alt_ft, Some(2000.0));
    }
    #[test]
    fn joins_repeated_if_without_discarding_other_leg_types() {
        let mut source = input();
        let mut repeated = source.legs[0].clone();
        repeated.sequence = 2;
        source.legs.insert(1, repeated);
        assert_eq!(prepare_procedure(source).unwrap().legs.len(), 2);
        let mut source = input();
        source.legs[1].waypoint_id = source.legs[0].waypoint_id.clone();
        assert!(
            prepare_procedure(source)
                .unwrap_err()
                .contains("sequencing radius")
        );
    }

    #[test]
    fn rejects_missing_malformed_and_unsupported_input() {
        let mut missing = input();
        missing.waypoints.pop();
        assert!(
            prepare_procedure(missing)
                .unwrap_err()
                .contains("Missing FAA fix")
        );
        let mut malformed = input();
        malformed.waypoints[1].lat = f64::NAN;
        assert!(
            prepare_procedure(malformed)
                .unwrap_err()
                .contains("Malformed FAA fix")
        );
        for terminator in ["RF", "AF", "HF", "PI", "CA", "DF"] {
            let mut unsupported = input();
            unsupported.legs[1].path_terminator = terminator.into();
            assert!(
                prepare_procedure(unsupported)
                    .unwrap_err()
                    .contains("not supported")
            );
        }
        let mut course = input();
        course.legs[1].course = None;
        assert!(
            prepare_procedure(course)
                .unwrap_err()
                .contains("Missing CF course")
        );
        let mut between = input();
        between.legs[1].altitude_constraint = Some("between".into());
        assert!(
            prepare_procedure(between)
                .unwrap_err()
                .contains("between-altitude")
        );
        let mut missed = input();
        missed.legs[1].is_missed_approach = true;
        assert!(prepare_procedure(missed).is_err());
    }
}

/// Trainer setup is explicit user input; performance/grading remain owned by Rust.
pub fn procedure_config(
    input: ProcedureInput,
    altitude_ft: f64,
    speed_kts: f64,
) -> Result<super::SimConfig, String> {
    use super::*;
    let prepared = prepare_procedure(input)?;
    let heading = prepared.start_heading;
    let tas = kinematics::tas_from_ias(speed_kts, altitude_ft);
    Ok(SimConfig {
        initial_state: AircraftState {
            lat_deg: prepared.start_lat,
            lon_deg: prepared.start_lon,
            alt_ft_msl: altitude_ft,
            hdg_deg_true: heading,
            ias_kts: speed_kts,
            vs_fpm: 0.0,
            bank_deg: 0.0,
            gs_kts: tas,
            tas_kts: tas,
            mag_var_deg: prepared.mag_var,
        },
        initial_autopilot: AutopilotSettings {
            lateral: LateralMode::Heading,
            vertical: VerticalMode::AltitudeHold,
            hdg_bug_deg: heading,
            alt_bug_ft: altitude_ft,
            vs_bug_fpm: 0.0,
            crs_bug_deg: heading,
            spd_bug_kts: speed_kts,
        },
        performance: AircraftPerformance::default(),
        wind: WindState {
            direction_from_deg_true: 0.0,
            speed_kts: 0.0,
        },
        legs: prepared.legs,
        assigned_alt_ft: Some(altitude_ft),
        grading: GradingThresholds::default(),
        dt_s: 0.1,
    })
}
