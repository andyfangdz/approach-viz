import Foundation
import simd

enum ApproachPolylineKind: Sendable {
    case transition
    case final
    case missed
}

struct ApproachPolyline: Sendable {
    let kind: ApproachPolylineKind
    let points: [SIMD3<Float>]
    let verticalLines: [SIMD3<Float>]
    let turnConstraintLabels: [ApproachPathLabel]
    let color: SIMD4<Float>
    let dashedBelowAltitudeFeet: Double?
    let dashedBelowLabel: String?
}

struct ApproachPathLabel: Sendable {
    let text: String
    let position: SIMD3<Float>
}

struct SharedApproachAltitudeData {
    let sharedWaypoints: [ApproachWaypoint]
    let finalAltitudesBySequence: [Int: Double]
    let transitionAltitudesByName: [String: [Int: Double]]
    let missedAltitudesBySequence: [Int: Double]
    let missedPathAltitudesBySequence: [Int: Double]
}

enum ApproachPathGeometry {
    static func buildPolylines(
        sceneData: NativeSceneData,
        verticalScale: Double
    ) -> [ApproachPolyline] {
        guard let approach = sceneData.currentApproach else {
            return []
        }

        guard let altitudeData = resolveSharedApproachAltitudeData(sceneData: sceneData) else {
            return []
        }
        let missedApproachStartAltitudeFeet =
            sceneData.minimumsSummary?.da?.altitude ??
            sceneData.minimumsSummary?.mda?.altitude

        // A transition that ends in a no-fix course-reversal intercept leg
        // (`CI`/`VI`, e.g. the KDDC I14 FLACK teardrop) has nothing downstream to
        // intercept, so the reversal would dead-end / run parallel to the final
        // approach course instead of rejoining it. Append the final approach's
        // first course-carrying fix leg (the FAF/localizer leg) so the intercept
        // turns back onto the final approach course and merges with the final.
        let reversalInterceptTerminators: Set<String> = ["CI", "VI"]
        let courseReversalJoinLeg = approach.finalLegs.first { ($0.course?.isFinite ?? false) }
        let transitionPolylines = approach.transitions.compactMap { transition -> ApproachPolyline? in
            var transitionLegs = transition.legs
            if let lastLeg = transitionLegs.last,
               reversalInterceptTerminators.contains(lastLeg.pathTerminator),
               let courseReversalJoinLeg {
                transitionLegs.append(courseReversalJoinLeg)
            }
            return polyline(
                for: transitionLegs,
                resolvedAltitudes: altitudeValues(
                    for: transitionLegs,
                    altitudesBySequence: altitudeData.transitionAltitudesByName[transition.name] ?? [:]
                ),
                sceneData: sceneData,
                sharedWaypoints: altitudeData.sharedWaypoints,
                verticalScale: verticalScale,
                color: SIMD4(1.0, 0.67, 0.0, 1.0),
                dashedBelowAltitudeFeet: nil,
                dashedBelowLabel: nil,
                showTurnConstraintLabels: false,
                kind: .transition
            )
        }

        let finalDisplay = finalDisplayLegs(
            finalLegs: approach.finalLegs,
            missedLegs: approach.missedLegs,
            sharedWaypointIDs: Set(altitudeData.sharedWaypoints.map(\.id)),
            finalAltitudes: altitudeValues(
                for: approach.finalLegs,
                altitudesBySequence: altitudeData.finalAltitudesBySequence
            ),
            missedAltitudes: altitudeValues(
                for: approach.missedLegs,
                altitudesBySequence: altitudeData.missedAltitudesBySequence
            )
        )

        let finalPolyline = polyline(
            for: finalDisplay.legs,
            resolvedAltitudes: finalDisplay.altitudes,
            sceneData: sceneData,
            sharedWaypoints: altitudeData.sharedWaypoints,
            verticalScale: verticalScale,
            color: SIMD4(0.0, 1.0, 0.53, 1.0),
            dashedBelowAltitudeFeet: missedApproachStartAltitudeFeet,
            dashedBelowLabel: sceneData.minimumsSummary?.da != nil ? "DA" : (sceneData.minimumsSummary?.mda != nil ? "MDA" : nil),
            showTurnConstraintLabels: false,
            kind: .final
        )

        let missedPolyline = polyline(
            for: approach.missedLegs,
            resolvedAltitudes: altitudeValues(
                for: approach.missedLegs,
                altitudesBySequence: altitudeData.missedPathAltitudesBySequence
            ),
            sceneData: sceneData,
            sharedWaypoints: altitudeData.sharedWaypoints,
            verticalScale: verticalScale,
            color: SIMD4(1.0, 0.27, 0.27, 1.0),
            dashedBelowAltitudeFeet: nil,
            dashedBelowLabel: nil,
            showTurnConstraintLabels: true,
            kind: .missed
        )

        return transitionPolylines + [finalPolyline, missedPolyline].compactMap { $0 }
    }
    private static func finalDisplayLegs(
        finalLegs: [ApproachLeg],
        missedLegs: [ApproachLeg],
        sharedWaypointIDs: Set<String>,
        finalAltitudes: [Double],
        missedAltitudes: [Double]
    ) -> (legs: [ApproachLeg], altitudes: [Double]) {
        guard let mapLeg = missedLegs.first else {
            return (finalLegs, finalAltitudes)
        }
        let resolvedWaypointID = mapLeg.waypointId.split(separator: "_").last.map(String.init) ?? mapLeg.waypointId
        guard sharedWaypointIDs.contains(mapLeg.waypointId) || sharedWaypointIDs.contains(resolvedWaypointID) else {
            return (finalLegs, finalAltitudes)
        }
        guard let mapAltitude = missedAltitudes.first, mapAltitude.isFinite, mapAltitude > 0 else {
            return (finalLegs, finalAltitudes)
        }
        return (finalLegs + [mapLeg], finalAltitudes + [mapAltitude])
    }

    private static func polyline(
        for legs: [ApproachLeg],
        resolvedAltitudes: [Double],
        sceneData: NativeSceneData,
        sharedWaypoints: [ApproachWaypoint],
        verticalScale: Double,
        color: SIMD4<Float>,
        dashedBelowAltitudeFeet: Double?,
        dashedBelowLabel: String?,
        showTurnConstraintLabels: Bool,
        kind: ApproachPolylineKind
    ) -> ApproachPolyline? {
        guard !legs.isEmpty else {
            return nil
        }

        let geometry = buildApproachPathGeometry(
            params: BuildPathGeometryParams(
                legs: legs.map(bridgeLeg),
                waypoints: sharedWaypoints,
                resolvedAltitudes: resolvedAltitudes,
                initialAltitudeFeet: sceneData.airport.elevation,
                verticalScale: verticalScale,
                refLat: sceneData.airport.lat,
                refLon: sceneData.airport.lon,
                magVar: sceneData.airport.magneticVariation,
                showTurnConstraintLabels: showTurnConstraintLabels
            )
        )
        let points = geometry.points.map { point in
            SIMD3<Float>(Float(point.x), Float(point.y), Float(point.z))
        }
        let verticalLines = geometry.verticalLines.map { line in
            SIMD3<Float>(Float(line.x), Float(line.y), Float(line.z))
        }
        let turnConstraintLabels = geometry.turnConstraintLabels.map { label in
            ApproachPathLabel(
                text: label.text,
                position: SIMD3<Float>(
                    Float(label.position.x),
                    Float(label.position.y),
                    Float(label.position.z)
                )
            )
        }
        guard points.count > 1 else {
            return nil
        }
        return ApproachPolyline(
            kind: kind,
            points: points,
            verticalLines: verticalLines,
            turnConstraintLabels: turnConstraintLabels,
            color: color,
            dashedBelowAltitudeFeet: dashedBelowAltitudeFeet,
            dashedBelowLabel: dashedBelowLabel
        )
    }
}

func resolveSharedApproachAltitudeData(sceneData: NativeSceneData) -> SharedApproachAltitudeData? {
    guard let approach = sceneData.currentApproach else {
        return nil
    }
    let sharedWaypoints = sharedApproachWaypoints(sceneData: sceneData)
    let missedApproachStartAltitudeFeet =
        sceneData.minimumsSummary?.da?.altitude ??
        sceneData.minimumsSummary?.mda?.altitude
    let altitudeResult = resolveApproachAltitudes(
        params: ResolveApproachAltitudesParams(
            finalLegs: approach.finalLegs.map(bridgeLeg),
            transitionEntries: approach.transitions.map { transition in
                TransitionLegs(name: transition.name, legs: transition.legs.map(bridgeLeg))
            },
            missedLegs: approach.missedLegs.map(bridgeLeg),
            waypoints: sharedWaypoints,
            refLat: sceneData.airport.lat,
            refLon: sceneData.airport.lon,
            airportElevation: sceneData.airport.elevation,
            missedApproachStartAltitudeFeet: missedApproachStartAltitudeFeet,
            missedApproachClimbRequirement: bridgeMissedApproachClimbRequirement(
                sceneData.missedApproachClimbRequirement
            )
        )
    )
    return SharedApproachAltitudeData(
        sharedWaypoints: sharedWaypoints,
        finalAltitudesBySequence: altitudeMap(for: approach.finalLegs, altitudes: altitudeResult.finalAltitudes),
        transitionAltitudesByName: Dictionary(
            uniqueKeysWithValues: zip(approach.transitions, altitudeResult.transitionAltitudes).map { pair in
                let (transition, result) = pair
                return (transition.name, altitudeMap(for: transition.legs, altitudes: result.altitudes))
            }
        ),
        missedAltitudesBySequence: altitudeMap(for: approach.missedLegs, altitudes: altitudeResult.missedAltitudes),
        missedPathAltitudesBySequence: altitudeMap(for: approach.missedLegs, altitudes: altitudeResult.missedPathAltitudes)
    )
}

private func altitudeMap(for legs: [ApproachLeg], altitudes: [Double]) -> [Int: Double] {
    Dictionary(uniqueKeysWithValues: zip(legs, altitudes).map { ($0.sequence, $1) })
}

private func altitudeValues(for legs: [ApproachLeg], altitudesBySequence: [Int: Double]) -> [Double] {
    legs.map { altitudesBySequence[$0.sequence] ?? $0.altitude ?? 0 }
}

private func sharedApproachWaypoints(sceneData: NativeSceneData) -> [ApproachWaypoint] {
    let waypointRecords = sceneData.waypoints.map {
        ApproachWaypoint(
            id: $0.id,
            name: $0.name,
            lat: $0.lat,
            lon: $0.lon,
            waypointType: $0.type
        )
    }
    let runwayWaypoints = sceneData.runways.map {
        ApproachWaypoint(
            id: "RW\($0.id)",
            name: $0.id,
            lat: $0.lat,
            lon: $0.lon,
            waypointType: "runway"
        )
    }
    return waypointRecords + runwayWaypoints
}

private func bridgeLeg(_ leg: ApproachLeg) -> ApproachPathLeg {
    ApproachPathLeg(
        sequence: Int32(leg.sequence),
        waypointId: leg.waypointId,
        waypointName: leg.waypointName,
        pathTerminator: leg.pathTerminator,
        altitude: leg.altitude,
        altitudeConstraint: leg.altitudeConstraint,
        course: leg.course,
        distance: leg.distance,
        holdCourse: leg.holdCourse,
        holdDistance: leg.holdDistance,
        turnDirection: leg.turnDirection,
        holdTurnDirection: leg.holdTurnDirection,
        rfCenterWaypointId: leg.rfCenterWaypointId,
        rfTurnDirection: leg.rfTurnDirection,
        verticalAngleDeg: leg.verticalAngleDeg,
        rnpServiceLevels: leg.rnpServiceLevels,
        isFinalApproachFix: leg.isFinalApproachFix,
        isInitialFix: leg.isInitialFix,
        isFinalFix: leg.isFinalFix,
        isMissedApproach: leg.isMissedApproach
    )
}

private func bridgeMissedApproachClimbRequirement(
    _ requirement: MissedApproachClimbRequirement?
) -> ApproachPathMissedApproachClimbRequirement? {
    guard let requirement else {
        return nil
    }
    return ApproachPathMissedApproachClimbRequirement(
        feetPerNm: requirement.feetPerNm,
        targetAltitudeFeet: requirement.targetAltitudeFeet
    )
}

func buildHoldPoints(
    center: SIMD2<Double>,
    headingDegrees: Double,
    holdDistanceNm: Double,
    altitudeFeet: Double,
    turnDirection: Character,
    verticalScale: Double
) -> [SIMD3<Double>] {
    buildApproachHoldGeometry(
        centerX: center.x,
        centerZ: center.y,
        headingDeg: headingDegrees,
        holdDistanceNm: holdDistanceNm,
        altitudeFeet: altitudeFeet,
        turnDirection: String(turnDirection),
        verticalScale: verticalScale
    ).map { point in
        SIMD3(point.x, point.y, point.z)
    }
}
