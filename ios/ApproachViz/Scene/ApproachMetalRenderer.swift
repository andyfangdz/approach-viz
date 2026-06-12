import MetalKit
import simd

@MainActor
final class ApproachMetalRenderer: NSObject, MTKViewDelegate {
    private let engine: ApproachMetalRenderEngine
    // Each rebuild key holds only the layer flags its build function actually
    // reads, so toggling a weather layer never re-triangulates airspace (or
    // resets the pre-interaction camera) and toggling approach/airspace never
    // rebuilds 100k+ weather voxel instances.
    private struct StaticSceneKey: Equatable {
        let sceneData: NativeSceneData
        let terrainData: TerrainWireframeData?
        let verticalScale: Double
        let approachEnabled: Bool
        let airspaceEnabled: Bool
    }

    private struct MrmsSceneKey: Equatable {
        let mrmsScene: NativeMrmsScene?
        let echoTopScene: NativeEchoTopScene?
        let verticalScale: Double
        let mrmsEnabled: Bool
        let echoTopsEnabled: Bool
        let sliceEnabled: Bool
        let guidesEnabled: Bool
        // Only the options that shape geometry directly. Threshold/phase/
        // declutter arrive through a new `mrmsScene` after the Rust
        // re-prepare, so keying on them would rebuild 100k+ instances on
        // every slider tick for nothing.
        let opacity: Double
        let sliceHeadingDeg: Double
        let sliceRangeNm: Double
    }

    private var lastStaticSceneKey: StaticSceneKey?
    private var lastTrafficRenderHash: UInt64?
    private var lastTrafficDisplayOptions: NativeTrafficDisplayOptions?
    private var lastTrafficLayerEnabled: Bool?
    private var lastMrmsSceneKey: MrmsSceneKey?

    init?(
        view: MTKView,
        onStatsChanged: @escaping (ApproachMetalRenderStats) -> Void
    ) {
        guard let engine = ApproachMetalRenderEngine(
            view: view,
            onStatsChanged: onStatsChanged
        ) else {
            return nil
        }
        self.engine = engine
        super.init()
        view.delegate = self
    }

    func update(
        sceneData: NativeSceneData,
        trafficScene: NativeTrafficScene,
        mrmsScene: NativeMrmsScene?,
        echoTopScene: NativeEchoTopScene?,
        layerState: NativeLayerState,
        trafficDisplayOptions: NativeTrafficDisplayOptions,
        weatherDisplayOptions: NativeWeatherDisplayOptions,
        terrainData: TerrainWireframeData?,
        verticalScale: Double
    ) {
        let staticSceneKey = StaticSceneKey(
            sceneData: sceneData,
            terrainData: terrainData,
            verticalScale: verticalScale,
            approachEnabled: layerState.approach,
            airspaceEnabled: layerState.airspace
        )
        let staticSceneChanged = lastStaticSceneKey != staticSceneKey
        if staticSceneChanged {
            engine.updateScene(
                buildRenderStaticScene(
                    sceneData: sceneData,
                    terrainData: terrainData,
                    verticalScale: verticalScale,
                    layerState: layerState
                )
            )
            lastStaticSceneKey = staticSceneKey
        }
        if staticSceneChanged
            || lastTrafficRenderHash != trafficScene.renderHash
            || lastTrafficDisplayOptions != trafficDisplayOptions
            || lastTrafficLayerEnabled != layerState.adsb
        {
            engine.updateTrafficScene(buildTrafficRenderScene(
                trafficScene,
                layerState: layerState,
                trafficDisplayOptions: trafficDisplayOptions
            ))
            lastTrafficRenderHash = trafficScene.renderHash
            lastTrafficDisplayOptions = trafficDisplayOptions
            lastTrafficLayerEnabled = layerState.adsb
        }
        let mrmsSceneKey = MrmsSceneKey(
            mrmsScene: mrmsScene,
            echoTopScene: echoTopScene,
            verticalScale: verticalScale,
            mrmsEnabled: layerState.mrms,
            echoTopsEnabled: layerState.echotops,
            sliceEnabled: layerState.slice,
            guidesEnabled: layerState.guides,
            opacity: weatherDisplayOptions.opacity,
            sliceHeadingDeg: weatherDisplayOptions.crossSectionHeadingDeg,
            sliceRangeNm: weatherDisplayOptions.crossSectionRangeNm
        )
        if lastMrmsSceneKey != mrmsSceneKey {
            engine.updateMrmsScene(buildMrmsRenderScene(
                mrmsScene,
                echoTopScene: echoTopScene,
                layerState: layerState,
                weatherOptions: weatherDisplayOptions,
                verticalScale: verticalScale
            ))
            lastMrmsSceneKey = mrmsSceneKey
        }
    }

    func orbit(deltaX: Float, deltaY: Float) {
        engine.orbit(deltaX: deltaX, deltaY: deltaY)
    }

    func pan(deltaX: Float, deltaY: Float, viewSize: CGSize) {
        engine.pan(deltaX: deltaX, deltaY: deltaY, viewSize: viewSize)
    }

    func zoom(scale: Float) {
        engine.zoom(scale: scale)
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        engine.drawableSizeWillChange(size)
    }

    func draw(in view: MTKView) {
        engine.draw(in: view)
    }
}

private func buildRenderStaticScene(
    sceneData: NativeSceneData,
    terrainData: TerrainWireframeData?,
    verticalScale: Double,
    layerState: NativeLayerState
) -> RenderScene {
    var scene = RenderScene()
    let pathPolylines = layerState.approach
        ? ApproachPathGeometry.buildPolylines(sceneData: sceneData, verticalScale: verticalScale)
        : []
    let waypointPoints = layerState.approach
        ? buildWaypointRenderPoints(sceneData: sceneData, verticalScale: verticalScale)
        : []
    let runwaySegments = layerState.approach
        ? buildMetalRunwaySegments(sceneData: sceneData, verticalScale: verticalScale)
        : []

    if let terrainData {
        let vertices = terrainData.vertices.map {
            SIMD3<Float>(
                Float($0.eastNm),
                Float(metalSceneY(mslAltitudeFeet: $0.elevationFeet, verticalScale: verticalScale)),
                Float(-$0.northNm)
            )
        }
        appendTerrain(vertices: vertices, rows: terrainData.rows, columns: terrainData.columns, into: &scene)
    }

    if layerState.airspace {
        appendAirspace(sceneData.airspace, airport: sceneData.airport, verticalScale: verticalScale, into: &scene)
    }
    if layerState.approach {
        appendRunways(runwaySegments, into: &scene)
        appendPaths(
            pathPolylines,
            verticalScale: verticalScale,
            into: &scene
        )
        appendHoldPatterns(sceneData: sceneData, verticalScale: verticalScale, into: &scene)
        appendWaypoints(waypointPoints, into: &scene)
    }
    return scene
}

private func buildTrafficRenderScene(
    _ trafficScene: NativeTrafficScene,
    layerState: NativeLayerState,
    trafficDisplayOptions: NativeTrafficDisplayOptions
) -> TrafficRenderScene {
    var scene = TrafficRenderScene()
    guard layerState.adsb else {
        return scene
    }
    appendTraffic(trafficScene, trafficDisplayOptions: trafficDisplayOptions, into: &scene)
    return scene
}

private func appendTerrain(vertices: [SIMD3<Float>], rows: Int, columns: Int, into scene: inout RenderScene) {
    guard vertices.count == rows * columns else { return }
    let fillColor = SIMD4<Float>(12.0 / 255.0, 26.0 / 255.0, 47.0 / 255.0, 0.12)
    let wireColor = SIMD4<Float>(78.0 / 255.0, 160.0 / 255.0, 219.0 / 255.0, 0.58)

    func vertex(_ row: Int, _ column: Int) -> SIMD3<Float> {
        vertices[row * columns + column]
    }

    for row in 0..<(rows - 1) {
        for column in 0..<(columns - 1) {
            let a = vertex(row, column) + SIMD3<Float>(0, -0.02, 0)
            let b = vertex(row, column + 1) + SIMD3<Float>(0, -0.02, 0)
            let c = vertex(row + 1, column) + SIMD3<Float>(0, -0.02, 0)
            let d = vertex(row + 1, column + 1) + SIMD3<Float>(0, -0.02, 0)
            appendTriangle(a, c, b, color: fillColor, into: &scene.triangleVertices)
            appendTriangle(b, c, d, color: fillColor, into: &scene.triangleVertices)
            let wireA = vertex(row, column) + SIMD3<Float>(0, -0.005, 0)
            let wireB = vertex(row, column + 1) + SIMD3<Float>(0, -0.005, 0)
            let wireC = vertex(row + 1, column) + SIMD3<Float>(0, -0.005, 0)
            appendLine(wireA, wireB, color: wireColor, into: &scene.lineVertices)
            appendLine(wireA, wireC, color: wireColor, into: &scene.lineVertices)
            appendLine(wireB, wireC, color: wireColor, into: &scene.lineVertices)
        }
    }
}

private func appendAirspace(
    _ features: [AirspaceFeatureRecord],
    airport: AirportRecord,
    verticalScale: Double,
    into scene: inout RenderScene
) {
    for feature in features {
        guard let color = airspaceColor(for: feature.airspaceClass) else { continue }
        let lowerAlt = resolveAirspaceLowerAltitudeFeet(feature.lowerAlt, airportElevationFeet: airport.elevation)
        let upperAlt = feature.upperAlt
        guard upperAlt > lowerAlt else { continue }

        let wallColor = SIMD4<Float>(color.x, color.y, color.z, 0.06)
        let edgeColor = SIMD4<Float>(color.x, color.y, color.z, 0.56)
        let showBottomOutline = !shouldHideAirspaceBottomOutline(lowerAltFeet: feature.lowerAlt)

        for ring in feature.coordinates where ring.count >= 3 {
            let lowerPoints = sanitizedAirspaceRing(ring.map {
                metalScenePoint(
                    lat: $0.lat,
                    lon: $0.lon,
                    altitudeFeet: lowerAlt,
                    airport: airport,
                    verticalScale: verticalScale
                )
            })
            guard lowerPoints.count >= 3 else { continue }
            let upperY = Float(metalSceneY(mslAltitudeFeet: upperAlt, verticalScale: verticalScale))
            let upperPoints = lowerPoints.map { SIMD3<Float>($0.x, upperY, $0.z) }
            let triangleLowerBaseIndex = UInt32(scene.airspaceTriangleVertices.count)
            scene.airspaceTriangleVertices.append(contentsOf: lowerPoints.map { MetalVertex(position: $0, color: wallColor) })
            let triangleUpperBaseIndex = UInt32(scene.airspaceTriangleVertices.count)
            scene.airspaceTriangleVertices.append(contentsOf: upperPoints.map { MetalVertex(position: $0, color: wallColor) })
            let lineLowerBaseIndex = UInt32(scene.airspaceLineVertices.count)
            scene.airspaceLineVertices.append(contentsOf: lowerPoints.map { MetalVertex(position: $0, color: edgeColor) })
            let lineUpperBaseIndex = UInt32(scene.airspaceLineVertices.count)
            scene.airspaceLineVertices.append(contentsOf: upperPoints.map { MetalVertex(position: $0, color: edgeColor) })

            appendAirspaceCap(
                points: upperPoints,
                flipWinding: false,
                baseIndex: triangleUpperBaseIndex,
                into: &scene.airspaceTriangleIndices
            )
            if showBottomOutline {
                appendAirspaceCap(
                    points: lowerPoints,
                    flipWinding: true,
                    baseIndex: triangleLowerBaseIndex,
                    into: &scene.airspaceTriangleIndices
                )
            }

            for index in lowerPoints.indices {
                let nextIndex = (index + 1) % lowerPoints.count
                let triangleBottomA = triangleLowerBaseIndex + UInt32(index)
                let triangleBottomB = triangleLowerBaseIndex + UInt32(nextIndex)
                let triangleTopA = triangleUpperBaseIndex + UInt32(index)
                let triangleTopB = triangleUpperBaseIndex + UInt32(nextIndex)

                scene.airspaceTriangleIndices.append(contentsOf: [triangleBottomA, triangleTopA, triangleBottomB])
                scene.airspaceTriangleIndices.append(contentsOf: [triangleBottomB, triangleTopA, triangleTopB])

                let lineBottomA = lineLowerBaseIndex + UInt32(index)
                let lineBottomB = lineLowerBaseIndex + UInt32(nextIndex)
                let lineTopA = lineUpperBaseIndex + UInt32(index)
                let lineTopB = lineUpperBaseIndex + UInt32(nextIndex)
                scene.airspaceLineIndices.append(contentsOf: [lineTopA, lineTopB, lineBottomA, lineTopA])
                if showBottomOutline {
                    scene.airspaceLineIndices.append(contentsOf: [lineBottomA, lineBottomB])
                }
            }

            for point in lowerPoints + upperPoints {
                scene.bounds.include(point)
            }
        }
    }
}

private func appendAirspaceCap(
    points: [SIMD3<Float>],
    flipWinding: Bool,
    baseIndex: UInt32,
    into indices: inout [UInt32]
) {
    let sanitizedPoints = sanitizedAirspaceRing(points)
    guard sanitizedPoints.count >= 3 else { return }

    let triangles = triangulateAirspaceRing(sanitizedPoints)
    guard !triangles.isEmpty else { return }

    for triangle in triangles {
        let a = baseIndex + UInt32(triangle.0)
        let b = baseIndex + UInt32(triangle.1)
        let c = baseIndex + UInt32(triangle.2)
        if flipWinding {
            indices.append(contentsOf: [a, c, b])
        } else {
            indices.append(contentsOf: [a, b, c])
        }
    }
}

func sanitizedAirspaceRing(_ points: [SIMD3<Float>]) -> [SIMD3<Float>] {
    guard !points.isEmpty else { return [] }
    var sanitized: [SIMD3<Float>] = []
    for point in points {
        if let last = sanitized.last,
           simd_length_squared(point - last) <= 1e-8 {
            continue
        }
        sanitized.append(point)
    }
    if sanitized.count >= 2,
       simd_length_squared(sanitized[0] - sanitized[sanitized.count - 1]) <= 1e-8 {
        sanitized.removeLast()
    }
    return sanitized
}

func triangulateAirspaceRing(_ points: [SIMD3<Float>]) -> [(Int, Int, Int)] {
    guard points.count >= 3 else { return [] }

    var vertexIndices = Array(points.indices)
    var triangles: [(Int, Int, Int)] = []
    let isCounterClockwise = signedAirspaceArea(points) > 0

    while vertexIndices.count > 3 {
        var earFound = false
        for offset in vertexIndices.indices {
            let previousIndex = vertexIndices[(offset - 1 + vertexIndices.count) % vertexIndices.count]
            let currentIndex = vertexIndices[offset]
            let nextIndex = vertexIndices[(offset + 1) % vertexIndices.count]

            let previous = points[previousIndex]
            let current = points[currentIndex]
            let next = points[nextIndex]

            if !isAirspaceEarConvex(previous: previous, current: current, next: next, isCounterClockwise: isCounterClockwise) {
                continue
            }

            var containsOtherPoint = false
            for candidateIndex in vertexIndices where candidateIndex != previousIndex && candidateIndex != currentIndex && candidateIndex != nextIndex {
                if airspaceTriangleContainsPoint(
                    point: points[candidateIndex],
                    a: previous,
                    b: current,
                    c: next
                ) {
                    containsOtherPoint = true
                    break
                }
            }
            if containsOtherPoint {
                continue
            }

            triangles.append((previousIndex, currentIndex, nextIndex))
            vertexIndices.remove(at: offset)
            earFound = true
            break
        }

        if !earFound {
            return []
        }
    }

    if vertexIndices.count == 3 {
        triangles.append((vertexIndices[0], vertexIndices[1], vertexIndices[2]))
    }
    return triangles
}

private func signedAirspaceArea(_ points: [SIMD3<Float>]) -> Float {
    guard points.count >= 3 else { return 0 }
    var area: Float = 0
    for index in points.indices {
        let nextIndex = (index + 1) % points.count
        area += points[index].x * points[nextIndex].z - points[nextIndex].x * points[index].z
    }
    return area * 0.5
}

private func isAirspaceEarConvex(
    previous: SIMD3<Float>,
    current: SIMD3<Float>,
    next: SIMD3<Float>,
    isCounterClockwise: Bool
) -> Bool {
    let cross = (current.x - previous.x) * (next.z - current.z)
        - (current.z - previous.z) * (next.x - current.x)
    return isCounterClockwise ? cross > 1e-6 : cross < -1e-6
}

private func airspaceTriangleContainsPoint(
    point: SIMD3<Float>,
    a: SIMD3<Float>,
    b: SIMD3<Float>,
    c: SIMD3<Float>
) -> Bool {
    let area = abs(airspaceTriangleArea(a, b, c))
    guard area > 1e-6 else { return false }
    let a1 = abs(airspaceTriangleArea(point, b, c))
    let a2 = abs(airspaceTriangleArea(a, point, c))
    let a3 = abs(airspaceTriangleArea(a, b, point))
    return abs(area - (a1 + a2 + a3)) <= 1e-4
}

private func airspaceTriangleArea(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>) -> Float {
    ((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) * 0.5
}

private func appendPaths(
    _ polylines: [ApproachPolyline],
    verticalScale: Double,
    into scene: inout RenderScene
) {
    for polyline in polylines {
        let thresholdY = polyline.dashedBelowAltitudeFeet.map {
            Float(metalSceneY(mslAltitudeFeet: $0, verticalScale: verticalScale))
        }
        let splitPath = thresholdY.map { splitPointsAtAltitude(polyline.points, thresholdY: $0) }
        let solidPoints = splitPath?.solidPoints ?? polyline.points
        let dashedPoints = splitPath?.dashedLinePoints

        for (start, end) in zip(solidPoints, solidPoints.dropFirst()) {
            appendSegmentPrism(start: start, end: end, thickness: 0.12, color: polyline.color, into: &scene.triangleVertices)
        }
        if let dashedPoints, dashedPoints.count >= 2 {
            appendDashedPrismPolyline(
                dashedPoints,
                thickness: 0.05,
                color: polyline.color,
                into: &scene.triangleVertices
            )
        }
        if let dashedPoints, let thresholdAltitudeFeet = polyline.dashedBelowAltitudeFeet, let dashedBelowLabel = polyline.dashedBelowLabel, let crossing = dashedPoints.first {
            scene.pointVertices.append(MetalPointVertex(
                position: crossing,
                color: SIMD4<Float>(1, 1, 1, 1),
                size: 10
            ))
            scene.labels.append(LabelAnchor(
                id: "\(dashedBelowLabel)-\(Int(thresholdAltitudeFeet.rounded()))",
                text: "\(dashedBelowLabel) \(Int(thresholdAltitudeFeet.rounded()))'",
                position: crossing + SIMD3<Float>(0, 0.30, 0),
                color: .white,
                fontSize: 11,
                declutterable: false
            ))
        }
        let guideColor = SIMD4<Float>(polyline.color.x, polyline.color.y, polyline.color.z, 0.26)
        for point in polyline.verticalLines where abs(point.y) > 0.02 {
            appendLine(SIMD3<Float>(point.x, 0, point.z), point, color: guideColor, into: &scene.lineVertices)
            scene.bounds.include(point)
            scene.focusBounds.include(point)
        }
        for label in polyline.turnConstraintLabels {
            scene.labels.append(
                LabelAnchor(
                    id: "turn-\(label.text)-\(label.position.x)-\(label.position.y)-\(label.position.z)",
                    text: label.text,
                    position: label.position,
                    color: platformColor(
                        red: CGFloat(polyline.color.x),
                        green: CGFloat(polyline.color.y),
                        blue: CGFloat(polyline.color.z),
                        alpha: 1
                    ),
                    fontSize: 10,
                    declutterable: false
                )
            )
        }
        for point in polyline.points {
            scene.bounds.include(point)
            if polyline.kind != .transition {
                scene.focusBounds.include(point)
            }
        }
    }
}

private func splitPointsAtAltitude(
    _ points: [SIMD3<Float>],
    thresholdY: Float
) -> (solidPoints: [SIMD3<Float>], dashedLinePoints: [SIMD3<Float>]?) {
    guard points.count >= 2 else {
        return (points, nil)
    }

    var splitIndex = -1
    for (index, point) in points.enumerated() {
        if point.y < thresholdY - 1e-6 {
            splitIndex = index
            break
        }
    }

    if splitIndex == -1 {
        return (points, nil)
    }
    if splitIndex == 0 {
        return ([], points)
    }

    let above = points[splitIndex - 1]
    let below = points[splitIndex]
    let denominator = below.y - above.y
    let t = denominator.magnitude > 1e-6 ? max(0, min(1, (thresholdY - above.y) / denominator)) : 0
    let crossing = above + (below - above) * t

    var solid = Array(points.prefix(splitIndex))
    solid.append(crossing)

    var dashed = [crossing]
    dashed.append(contentsOf: points.suffix(from: splitIndex))
    return (solid, dashed)
}

private func appendHoldPatterns(
    sceneData: NativeSceneData,
    verticalScale: Double,
    into scene: inout RenderScene
) {
    guard let approach = sceneData.currentApproach else { return }
    guard let altitudeData = resolveSharedApproachAltitudeData(sceneData: sceneData) else {
        return
    }
    let holdColor = SIMD4<Float>(111.0 / 255.0, 123.0 / 255.0, 1.0, 0.95)
    let holdLegs = (approach.transitions.flatMap(\.legs) + approach.finalLegs + approach.missedLegs).filter {
        ["HM", "HF", "HA"].contains($0.pathTerminator)
    }
    let waypointsByID = Dictionary(uniqueKeysWithValues: sceneData.waypoints.map { ($0.id, $0) })

    var holdAltitudesBySequence = altitudeData.finalAltitudesBySequence
    for transition in approach.transitions {
        for (sequence, altitude) in altitudeData.transitionAltitudesByName[transition.name] ?? [:] {
            holdAltitudesBySequence[sequence] = altitude
        }
    }
    for (sequence, altitude) in altitudeData.missedAltitudesBySequence {
        holdAltitudesBySequence[sequence] = altitude
    }

    for leg in holdLegs {
        guard let waypoint = resolveMetalWaypoint(id: leg.waypointId, waypointsByID: waypointsByID, runways: sceneData.runways),
              let holdCourse = leg.holdCourse ?? leg.course else { continue }
        let altitudeFeet = holdAltitudesBySequence[leg.sequence] ?? leg.altitude ?? sceneData.airport.elevation
        let center = metalScenePoint(
            lat: waypoint.lat,
            lon: waypoint.lon,
            altitudeFeet: altitudeFeet,
            airport: sceneData.airport,
            verticalScale: verticalScale
        )
        let holdPoints = buildHoldPoints(
            center: SIMD2(Double(center.x), Double(center.z)),
            headingDegrees: normalizeHeadingDegrees(holdCourse + sceneData.airport.magneticVariation),
            holdDistanceNm: leg.holdDistance ?? leg.distance ?? 4,
            altitudeFeet: altitudeFeet,
            turnDirection: leg.holdTurnDirection?.first ?? "R",
            verticalScale: verticalScale
        ).map { SIMD3<Float>(Float($0.x), Float($0.y), Float($0.z)) }

        appendDashedPrismPolyline(
            holdPoints,
            thickness: 0.04,
            color: holdColor,
            into: &scene.triangleVertices
        )
        for point in holdPoints {
            scene.bounds.include(point)
            if leg.isMissedApproach {
                scene.focusBounds.include(point)
            }
        }
        let label = makeHoldLabel(leg: leg, magneticVariation: sceneData.airport.magneticVariation)
        if let label {
            scene.labels.append(labelAnchor(for: label, center: center, course: holdCourse + sceneData.airport.magneticVariation, distance: leg.holdDistance ?? leg.distance ?? 4, turnDirection: leg.holdTurnDirection ?? "R"))
        }
    }
}

private func appendWaypoints(_ points: [MetalWaypointRenderPoint], into scene: inout RenderScene) {
    for point in points {
        scene.pointVertices.append(MetalPointVertex(position: point.position, color: point.color, size: point.size))
        scene.labels.append(LabelAnchor(id: point.labelText, text: point.labelText, position: point.position + SIMD3<Float>(0, 0.18, 0), color: .white, fontSize: 11, declutterable: false))
        scene.bounds.include(point.position)
    }
}

private func appendTraffic(
    _ trafficScene: NativeTrafficScene,
    trafficDisplayOptions: NativeTrafficDisplayOptions,
    into scene: inout TrafficRenderScene
) {
    let activeMarkerColor = SIMD4<Float>(103.0 / 255.0, 242.0 / 255.0, 1.0, 1.0)
    let departedMarkerColor = SIMD4<Float>(77.0 / 255.0, 162.0 / 255.0, 1.0, 0.76)
    let groundMarkerColor = SIMD4<Float>(1.0, 196.0 / 255.0, 118.0 / 255.0, 0.92)
    let activeTrailColor = SIMD4<Float>(21.0 / 255.0, 208.0 / 255.0, 1.0, 0.52)
    let departedTrailColor = SIMD4<Float>(21.0 / 255.0, 208.0 / 255.0, 1.0, 0.22)
    let headingColor = SIMD4<Float>(155.0 / 255.0, 247.0 / 255.0, 1.0, 0.9)

    for track in trafficScene.tracks {
        let marker = SIMD3<Float>(
            Float(track.markerPosition.x),
            Float(track.markerPosition.y),
            Float(track.markerPosition.z)
        )
        let markerColor = if track.isOnGround {
            groundMarkerColor
        } else if track.isCurrentlyPresent {
            activeMarkerColor
        } else {
            departedMarkerColor
        }
        scene.pointVertices.append(MetalPointVertex(
            position: marker,
            color: markerColor,
            size: track.isCurrentlyPresent ? 11 : 8
        ))

        if track.isCurrentlyPresent {
            let headingRadians = Float(track.headingDegrees * .pi / 180.0)
            let headingVector = SIMD3<Float>(sin(headingRadians), 0, -cos(headingRadians)) * 0.22
            appendLine(marker, marker + headingVector, color: headingColor, into: &scene.lineVertices)
        }

        let trailColor = track.isCurrentlyPresent ? activeTrailColor : departedTrailColor
        let trailPoints = track.trailPoints.map {
            SIMD3<Float>(Float($0.x), Float($0.y), Float($0.z))
        }
        for (start, end) in zip(trailPoints, trailPoints.dropFirst()) {
            appendLine(start, end, color: trailColor, into: &scene.lineVertices)
        }

        if trafficDisplayOptions.showCallsignLabels,
           track.isCurrentlyPresent,
           let callsignLabel = track.callsignLabel,
           !(trafficDisplayOptions.hideGroundCallsignLabels && track.isOnGround) {
            scene.labels.append(LabelAnchor(
                id: "traffic-\(track.hex)",
                text: callsignLabel,
                position: marker + SIMD3<Float>(0, 0.28, 0),
                color: platformColor(
                    red: CGFloat(activeMarkerColor.x),
                    green: CGFloat(activeMarkerColor.y),
                    blue: CGFloat(activeMarkerColor.z),
                    alpha: 1
                ),
                fontSize: 10,
                declutterable: true
            ))
        }
    }
}

private struct MetalRunwaySegment {
    let label: String
    let x: Double
    let y: Double
    let z: Double
    let length: Double
    let rotationY: Double
}

private func appendRunways(_ segments: [MetalRunwaySegment], into scene: inout RenderScene) {
    let baseColor = SIMD4<Float>(1, 0, 1, 0.85)
    let centerColor = SIMD4<Float>(1, 1, 1, 1)
    for segment in segments {
        let center = SIMD3<Float>(Float(segment.x), Float(segment.y) + 0.03, Float(segment.z))
        appendBox(center: center, size: SIMD3<Float>(0.12, 0.04, Float(segment.length)), rotationY: Float(segment.rotationY), color: baseColor, into: &scene.triangleVertices)
        appendBox(center: SIMD3<Float>(center.x, center.y + 0.022, center.z), size: SIMD3<Float>(0.02, 0.01, Float(segment.length * 0.95)), rotationY: Float(segment.rotationY), color: centerColor, into: &scene.triangleVertices)
        scene.labels.append(LabelAnchor(
            id: segment.label,
            text: segment.label,
            position: center + SIMD3<Float>(0, 0.20, 0),
            color: platformColor(red: 1, green: 0, blue: 1, alpha: 1),
            fontSize: 11,
            declutterable: false
        ))
        scene.bounds.include(center)
    }
}

private func appendTriangle(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, color: SIMD4<Float>, into vertices: inout [MetalVertex]) {
    vertices.append(MetalVertex(position: a, color: color))
    vertices.append(MetalVertex(position: b, color: color))
    vertices.append(MetalVertex(position: c, color: color))
}

private func appendLine(_ start: SIMD3<Float>, _ end: SIMD3<Float>, color: SIMD4<Float>, into vertices: inout [MetalVertex]) {
    vertices.append(MetalVertex(position: start, color: color))
    vertices.append(MetalVertex(position: end, color: color))
}

private func appendDashedPrismPolyline(
    _ points: [SIMD3<Float>],
    thickness: Float,
    color: SIMD4<Float>,
    into vertices: inout [MetalVertex]
) {
    guard points.count >= 2 else { return }
    let dashLength: Float = 0.4
    let gapLength: Float = 0.2
    let pattern = dashLength + gapLength
    var offset: Float = 0

    for (start, end) in zip(points, points.dropFirst()) {
        let delta = end - start
        let length = simd_length(delta)
        guard length > 0.0001 else { continue }
        let dir = delta / length
        var traversed: Float = 0
        while traversed < length - 1e-4 {
            let patternOffset = offset.truncatingRemainder(dividingBy: pattern)
            let inDash = patternOffset < dashLength
            let distanceToBoundary = (inDash ? dashLength : pattern) - patternOffset
            let step = min(length - traversed, max(0.0001, distanceToBoundary))
            if inDash {
                let dashStart = start + dir * traversed
                let dashEnd = start + dir * (traversed + step)
                appendSegmentPrism(
                    start: dashStart,
                    end: dashEnd,
                    thickness: thickness,
                    color: color,
                    into: &vertices
                )
            }
            traversed += step
            offset += step
        }
    }
}

private func appendBox(center: SIMD3<Float>, size: SIMD3<Float>, rotationY: Float, color: SIMD4<Float>, into vertices: inout [MetalVertex]) {
    let hx = size.x / 2
    let hy = size.y / 2
    let hz = size.z / 2
    let corners = [
        SIMD3<Float>(-hx, -hy, -hz),
        SIMD3<Float>( hx, -hy, -hz),
        SIMD3<Float>( hx,  hy, -hz),
        SIMD3<Float>(-hx,  hy, -hz),
        SIMD3<Float>(-hx, -hy,  hz),
        SIMD3<Float>( hx, -hy,  hz),
        SIMD3<Float>( hx,  hy,  hz),
        SIMD3<Float>(-hx,  hy,  hz),
    ].map { rotateY($0, angle: rotationY) + center }

    let faces: [((Int, Int, Int), (Int, Int, Int))] = [
        ((0, 1, 2), (0, 2, 3)),
        ((4, 6, 5), (4, 7, 6)),
        ((0, 4, 5), (0, 5, 1)),
        ((1, 5, 6), (1, 6, 2)),
        ((2, 6, 7), (2, 7, 3)),
        ((3, 7, 4), (3, 4, 0)),
    ]
    for pair in faces {
        appendTriangle(corners[pair.0.0], corners[pair.0.1], corners[pair.0.2], color: color, into: &vertices)
        appendTriangle(corners[pair.1.0], corners[pair.1.1], corners[pair.1.2], color: color, into: &vertices)
    }
}

private func appendSegmentPrism(
    start: SIMD3<Float>,
    end: SIMD3<Float>,
    thickness: Float,
    color: SIMD4<Float>,
    into vertices: inout [MetalVertex]
) {
    let delta = end - start
    let length = simd_length(delta)
    guard length > 1e-4 else { return }

    let forward = delta / length
    let referenceUp = abs(simd_dot(forward, SIMD3<Float>(0, 1, 0))) > 0.95
        ? SIMD3<Float>(1, 0, 0)
        : SIMD3<Float>(0, 1, 0)
    let right = simd_normalize(simd_cross(referenceUp, forward))
    let up = simd_normalize(simd_cross(forward, right))
    let halfWidth = thickness / 2
    let halfLength = length / 2
    let center = (start + end) / 2
    let rightOffset = right * halfWidth
    let upOffset = up * halfWidth
    let forwardOffset = forward * halfLength

    let frontCenter = center - forwardOffset
    let backCenter = center + forwardOffset
    let bottomFrontLeft = frontCenter - rightOffset - upOffset
    let bottomFrontRight = frontCenter + rightOffset - upOffset
    let topFrontRight = frontCenter + rightOffset + upOffset
    let topFrontLeft = frontCenter - rightOffset + upOffset
    let bottomBackLeft = backCenter - rightOffset - upOffset
    let bottomBackRight = backCenter + rightOffset - upOffset
    let topBackRight = backCenter + rightOffset + upOffset
    let topBackLeft = backCenter - rightOffset + upOffset
    let corners: [SIMD3<Float>] = [
        bottomFrontLeft,
        bottomFrontRight,
        topFrontRight,
        topFrontLeft,
        bottomBackLeft,
        bottomBackRight,
        topBackRight,
        topBackLeft,
    ]

    let faces: [((Int, Int, Int), (Int, Int, Int))] = [
        ((0, 1, 2), (0, 2, 3)),
        ((4, 6, 5), (4, 7, 6)),
        ((0, 4, 5), (0, 5, 1)),
        ((1, 5, 6), (1, 6, 2)),
        ((2, 6, 7), (2, 7, 3)),
        ((3, 7, 4), (3, 4, 0)),
    ]

    for face in faces {
        appendTriangle(corners[face.0.0], corners[face.0.1], corners[face.0.2], color: color, into: &vertices)
        appendTriangle(corners[face.1.0], corners[face.1.1], corners[face.1.2], color: color, into: &vertices)
    }
}

private func rotateY(_ point: SIMD3<Float>, angle: Float) -> SIMD3<Float> {
    let c = cos(angle)
    let s = sin(angle)
    return SIMD3<Float>(
        point.x * c + point.z * s,
        point.y,
        -point.x * s + point.z * c
    )
}

private func buildMetalRunwaySegments(sceneData: NativeSceneData, verticalScale: Double) -> [MetalRunwaySegment] {
    let thresholds = sceneData.runways.map { runway -> (id: String, x: Double, y: Double, z: Double) in
        let point = metalScenePoint(
            lat: runway.lat,
            lon: runway.lon,
            altitudeFeet: sceneData.airport.elevation,
            airport: sceneData.airport,
            verticalScale: verticalScale
        )
        return (
            runway.id.hasPrefix("RW") ? runway.id : "RW\(runway.id)",
            Double(point.x),
            Double(point.y),
            Double(point.z)
        )
    }
    let byID = Dictionary(uniqueKeysWithValues: thresholds.map { ($0.id, $0) })
    var visited = Set<String>()
    var segments: [MetalRunwaySegment] = []

    for runway in thresholds {
        if visited.contains(runway.id) { continue }
        visited.insert(runway.id)
        let reciprocal = metalReciprocalRunwayID(runway.id)
        let opposite = reciprocal.flatMap { byID[$0] }
        if let opposite, !visited.contains(opposite.id) {
            visited.insert(opposite.id)
            let dx = opposite.x - runway.x
            let dz = opposite.z - runway.z
            segments.append(MetalRunwaySegment(
                label: "\(runway.id)/\(opposite.id.replacingOccurrences(of: "RW", with: ""))",
                x: (runway.x + opposite.x) / 2,
                y: max(runway.y, opposite.y),
                z: (runway.z + opposite.z) / 2,
                length: max(0.2, hypot(dx, dz)),
                rotationY: atan2(dx, dz)
            ))
            continue
        }

        let identifier = runway.id.replacingOccurrences(of: "RW", with: "")
        guard let match = identifier.firstMatch(of: /^(\d{1,2})([LRC]?)$/),
              let number = Int(String(match.output.1)) else {
            continue
        }
        let headingRadians = Double(number * 10) * .pi / 180.0
        let dx = sin(headingRadians)
        let dz = -cos(headingRadians)
        segments.append(MetalRunwaySegment(
            label: runway.id,
            x: runway.x + dx / 2,
            y: runway.y,
            z: runway.z + dz / 2,
            length: 1.0,
            rotationY: atan2(dx, dz)
        ))
    }
    return segments
}

func metalReciprocalRunwayID(_ id: String) -> String? {
    // Compile-time validated regex literal, so runway-ID parsing has no runtime
    // pattern-compilation failure mode. Kept function-local because Regex is
    // not Sendable, so a global `let` is rejected under strict concurrency.
    let metalReciprocalRunwayRegex = /^(\d{1,2})([LRC]?)$/
    let identifier = id.replacingOccurrences(of: "RW", with: "")
    guard let match = identifier.wholeMatch(of: metalReciprocalRunwayRegex),
          let number = Int(match.1) else { return nil }
    let reciprocalNumber = ((number + 17) % 36) + 1
    let suffix = String(match.2)
    let reciprocalSuffix: String
    switch suffix {
    case "L": reciprocalSuffix = "R"
    case "R": reciprocalSuffix = "L"
    default: reciprocalSuffix = suffix
    }
    return String(format: "RW%02d%@", reciprocalNumber, reciprocalSuffix)
}

private struct MetalWaypointRenderPoint {
    let position: SIMD3<Float>
    let color: SIMD4<Float>
    let size: Float
    let labelText: String
}

private func buildWaypointRenderPoints(sceneData: NativeSceneData, verticalScale: Double) -> [MetalWaypointRenderPoint] {
    guard let approach = sceneData.currentApproach else { return [] }
    let waypointsByID = Dictionary(uniqueKeysWithValues: sceneData.waypoints.map { ($0.id, $0) })
    guard let altitudeData = resolveSharedApproachAltitudeData(sceneData: sceneData) else {
        return []
    }

    var points: [MetalWaypointRenderPoint] = []
    var seen = Set<String>()

    func append(legs: [ApproachLeg], altitudes: [Int: Double]) {
        for leg in legs {
            let resolvedAltitude = altitudes[leg.sequence] ?? leg.altitude
            guard let resolvedAltitude, resolvedAltitude > 0,
                  let waypoint = resolveMetalWaypoint(id: leg.waypointId, waypointsByID: waypointsByID, runways: sceneData.runways) else {
                continue
            }
            let key = "\(waypoint.id)-\(Int(resolvedAltitude.rounded()))"
            guard seen.insert(key).inserted else { continue }
            let labelName = leg.waypointName.isEmpty ? waypoint.name : leg.waypointName
            let labelText = (leg.altitude ?? 0) > 0 ? "\(labelName) \(Int((leg.altitude ?? 0).rounded()))'" : labelName
            points.append(MetalWaypointRenderPoint(
                position: metalScenePoint(
                    lat: waypoint.lat,
                    lon: waypoint.lon,
                    altitudeFeet: resolvedAltitude,
                    airport: sceneData.airport,
                    verticalScale: verticalScale
                ),
                color: waypoint.type == "runway" ? SIMD4<Float>(1, 0, 1, 1) : SIMD4<Float>(1, 1, 1, 1),
                size: waypoint.type == "runway" ? 14 : 11,
                labelText: labelText
            ))
        }
    }

    append(legs: approach.finalLegs, altitudes: altitudeData.finalAltitudesBySequence)
    for transition in approach.transitions {
        append(
            legs: transition.legs,
            altitudes: altitudeData.transitionAltitudesByName[transition.name] ?? [:]
        )
    }
    append(legs: approach.missedLegs, altitudes: altitudeData.missedAltitudesBySequence)
    return points
}

private func resolveMetalWaypoint(id: String, waypointsByID: [String: WaypointRecord], runways: [RunwayRecord]) -> WaypointRecord? {
    if let exact = waypointsByID[id] {
        return exact
    }
    if let fallback = id.split(separator: "_").last.flatMap({ waypointsByID[String($0)] }) {
        return fallback
    }
    if let runway = runways.first(where: { $0.id == id || "RW\($0.id)" == id }) {
        return WaypointRecord(id: runway.id, name: runway.id, lat: runway.lat, lon: runway.lon, type: "runway")
    }
    return nil
}

private func airspaceColor(for airspaceClass: String) -> SIMD3<Float>? {
    switch airspaceClass {
    case "B":
        return SIMD3<Float>(0.0, 102.0 / 255.0, 1.0)
    case "C":
        return SIMD3<Float>(1.0, 0.0, 1.0)
    case "D":
        return SIMD3<Float>(0.0, 153.0 / 255.0, 1.0)
    default:
        return nil
    }
}

private func resolveAirspaceLowerAltitudeFeet(_ lowerAltFeet: Double, airportElevationFeet: Double) -> Double {
    guard lowerAltFeet <= 0, airportElevationFeet.isFinite else {
        return lowerAltFeet
    }
    return max(lowerAltFeet, airportElevationFeet)
}

private func shouldHideAirspaceBottomOutline(lowerAltFeet: Double) -> Bool {
    lowerAltFeet <= 100
}

private func metalSceneY(mslAltitudeFeet: Double, verticalScale: Double) -> Double {
    altToY(altFeet: mslAltitudeFeet, verticalScale: verticalScale)
}

private func metalScenePoint(lat: Double, lon: Double, altitudeFeet: Double, airport: AirportRecord, verticalScale: Double) -> SIMD3<Float> {
    let point = scenePointFromGeodetic(
        lat: lat,
        lon: lon,
        altitudeFeet: altitudeFeet,
        refLat: airport.lat,
        refLon: airport.lon,
        refAltitudeFeet: 0,
        verticalScale: verticalScale
    )
    return SIMD3<Float>(Float(point.xNm), Float(point.yNm), Float(point.zNm))
}

private func makeHoldLabel(leg: ApproachLeg, magneticVariation: Double) -> String? {
    let magneticHeading = normalizeHeadingDegrees(leg.holdCourse ?? leg.course ?? 0)
    let trueHeading = normalizeHeadingDegrees(magneticHeading + magneticVariation)
    let holdDistance = leg.holdDistance ?? leg.distance ?? 4
    let turnDirection = (leg.holdTurnDirection ?? "R") == "R" ? "RIGHT" : "LEFT"
    return "HOLD \(Int(magneticHeading.rounded()))°M/\(Int(trueHeading.rounded()))°T \(formatHoldDistance(holdDistance)) \(turnDirection) TURNS"
}

private func labelAnchor(for text: String, center: SIMD3<Float>, course: Double, distance: Double, turnDirection: String) -> LabelAnchor {
    let headingRadians = Float(normalizeHeadingDegrees(course) * .pi / 180)
    let forward = SIMD3<Float>(sin(headingRadians), 0, -cos(headingRadians))
    let right = SIMD3<Float>(cos(headingRadians), 0, sin(headingRadians))
    let lateralSign: Float = turnDirection == "R" ? 1 : -1
    let position = center + right * max(1.4, Float(distance) * 0.45) * lateralSign - forward * max(0.8, Float(distance) * 0.2) + SIMD3<Float>(0, 0.9, 0)
    return LabelAnchor(
        id: text,
        text: text,
        position: position,
        color: platformColor(red: 111.0 / 255.0, green: 123.0 / 255.0, blue: 1.0, alpha: 1.0),
        fontSize: 11,
        declutterable: false
    )
}

private func normalizeHeadingDegrees(_ degrees: Double) -> Double {
    let wrapped = degrees.truncatingRemainder(dividingBy: 360.0)
    return wrapped < 0 ? wrapped + 360.0 : wrapped
}

private func formatHoldDistance(_ distanceNm: Double) -> String {
    let rounded = (distanceNm * 10).rounded() / 10
    if abs(rounded.rounded() - rounded) < 0.05 {
        return "\(Int(rounded.rounded()))NM"
    }
    return "\(rounded.formatted(.number.precision(.fractionLength(1))))NM"
}
