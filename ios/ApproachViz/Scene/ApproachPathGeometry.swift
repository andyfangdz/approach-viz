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
        let composed = composeApproachScene(
            params: ComposeApproachSceneParams(
                finalLegs: approach.finalLegs.map(bridgeLeg),
                transitionEntries: approach.transitions.map { transition in
                    TransitionLegs(name: transition.name, legs: transition.legs.map(bridgeLeg))
                },
                missedLegs: approach.missedLegs.map(bridgeLeg),
                waypoints: sharedWaypoints,
                finalAltitudes: altitudeResult.finalAltitudes,
                transitionAltitudes: altitudeResult.transitionAltitudes,
                missedAltitudes: altitudeResult.missedAltitudes,
                missedPathAltitudes: altitudeResult.missedPathAltitudes,
                airportElevation: sceneData.airport.elevation
            )
        )

        return composed.segments.compactMap { segment -> ApproachPolyline? in
            let kind: ApproachPolylineKind
            let color: SIMD4<Float>
            let dashedBelowAltitudeFeet: Double?
            let dashedBelowLabel: String?
            switch segment.kind {
            case "transition":
                kind = .transition
                color = SIMD4(1.0, 0.67, 0.0, 1.0)
                dashedBelowAltitudeFeet = nil
                dashedBelowLabel = nil
            case "final":
                kind = .final
                color = SIMD4(0.0, 1.0, 0.53, 1.0)
                dashedBelowAltitudeFeet = missedApproachStartAltitudeFeet
                dashedBelowLabel = sceneData.minimumsSummary?.da != nil ? "DA" : (sceneData.minimumsSummary?.mda != nil ? "MDA" : nil)
            case "missed":
                kind = .missed
                color = SIMD4(1.0, 0.27, 0.27, 1.0)
                dashedBelowAltitudeFeet = nil
                dashedBelowLabel = nil
            default:
                return nil
            }
            return polyline(
                for: segment.legs,
                resolvedAltitudes: segment.resolvedAltitudes,
                sceneData: sceneData,
                sharedWaypoints: sharedWaypoints,
                verticalScale: verticalScale,
                color: color,
                dashedBelowAltitudeFeet: dashedBelowAltitudeFeet,
                dashedBelowLabel: dashedBelowLabel,
                showTurnConstraintLabels: segment.showTurnConstraintLabels,
                kind: kind
            )
        }
    }

    private static func polyline(
        for legs: [ApproachPathLeg],
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
                legs: legs,
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
