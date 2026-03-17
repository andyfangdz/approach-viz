import MetalKit
import simd
import SwiftUI
import UIKit

struct ApproachMetalProjectedLabel: Identifiable, Equatable {
    let id: String
    let text: String
    let color: Color
    let x: CGFloat
    let y: CGFloat
    let fontSize: CGFloat
    let visible: Bool
}

private struct MetalVertex {
    var position: SIMD3<Float>
    var color: SIMD4<Float>
}

private struct MetalPointVertex {
    var position: SIMD3<Float>
    var color: SIMD4<Float>
    var size: Float
}

private struct MetalUniforms {
    var viewProjectionMatrix: simd_float4x4
}

private struct CameraState {
    var target = SIMD3<Float>(0, 2, 0)
    var distance: Float = 22.045408
    var yaw: Float = .pi / 4
    var pitch: Float = 1.2951535
}

private struct LabelAnchor {
    let id: String
    let text: String
    let position: SIMD3<Float>
    let color: UIColor
    let fontSize: CGFloat
}

private struct RenderScene {
    var triangleVertices: [MetalVertex] = []
    var lineVertices: [MetalVertex] = []
    var pointVertices: [MetalPointVertex] = []
    var labels: [LabelAnchor] = []
    var bounds = MetalSceneBounds()
    var focusBounds = MetalSceneBounds()
}

private struct MetalSceneBounds {
    var min = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
    var max = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)

    var center: SIMD3<Float> { (min + max) / 2 }
    var span: SIMD3<Float> { max - min }

    mutating func include(_ point: SIMD3<Float>) {
        min = simd_min(min, point)
        max = simd_max(max, point)
    }
}

final class ApproachMetalRenderer: NSObject, MTKViewDelegate {
    private weak var view: MTKView?
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let trianglePipeline: MTLRenderPipelineState
    private let linePipeline: MTLRenderPipelineState
    private let pointPipeline: MTLRenderPipelineState
    private let depthState: MTLDepthStencilState
    private let onLabelsChanged: ([ApproachMetalProjectedLabel]) -> Void

    private var scene = RenderScene()
    private var camera = CameraState()
    private var triangleBuffer: MTLBuffer?
    private var lineBuffer: MTLBuffer?
    private var pointBuffer: MTLBuffer?
    private var lastDrawableSize = CGSize.zero
    private var hasUserInteracted = false

    init?(view: MTKView, onLabelsChanged: @escaping ([ApproachMetalProjectedLabel]) -> Void) {
        guard let device = view.device,
              let commandQueue = device.makeCommandQueue(),
              let library = device.makeDefaultLibrary() else {
            return nil
        }
        self.view = view
        self.device = device
        self.commandQueue = commandQueue
        self.onLabelsChanged = onLabelsChanged

        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .less
        depthDescriptor.isDepthWriteEnabled = true
        guard let depthState = device.makeDepthStencilState(descriptor: depthDescriptor) else {
            return nil
        }
        self.depthState = depthState

        func makePipeline(vertex: String, fragment: String) -> MTLRenderPipelineState? {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: vertex)
            descriptor.fragmentFunction = library.makeFunction(name: fragment)
            descriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
            descriptor.depthAttachmentPixelFormat = view.depthStencilPixelFormat
            descriptor.colorAttachments[0].isBlendingEnabled = true
            descriptor.colorAttachments[0].rgbBlendOperation = .add
            descriptor.colorAttachments[0].alphaBlendOperation = .add
            descriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
            descriptor.colorAttachments[0].sourceAlphaBlendFactor = .sourceAlpha
            descriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
            descriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
            return try? device.makeRenderPipelineState(descriptor: descriptor)
        }

        guard let trianglePipeline = makePipeline(vertex: "basicVertex", fragment: "basicFragment"),
              let linePipeline = makePipeline(vertex: "basicVertex", fragment: "basicFragment"),
              let pointPipeline = makePipeline(vertex: "pointVertex", fragment: "pointFragment") else {
            return nil
        }
        self.trianglePipeline = trianglePipeline
        self.linePipeline = linePipeline
        self.pointPipeline = pointPipeline
        super.init()
        view.delegate = self
    }

    func update(sceneData: NativeSceneData, terrainData: TerrainWireframeData?, verticalScale: Double) {
        scene = buildRenderScene(sceneData: sceneData, terrainData: terrainData, verticalScale: verticalScale)
        if !hasUserInteracted {
            resetCameraToScene()
        }
        uploadBuffers()
    }

    func orbit(deltaX: Float, deltaY: Float, state: UIGestureRecognizer.State) {
        let sensitivity: Float = 0.005
        hasUserInteracted = true
        camera.yaw += deltaX * sensitivity
        camera.pitch = min(max(0.08, camera.pitch - deltaY * sensitivity), .pi - 0.08)
    }

    func pan(deltaX: Float, deltaY: Float, viewSize: CGSize, state: UIGestureRecognizer.State) {
        let height = max(1, Float(viewSize.height))
        let aspect = max(0.1, Float(viewSize.width) / height)
        let verticalFov = Float.pi / 3
        let horizontalFov = 2 * atan(tan(verticalFov / 2) * aspect)

        hasUserInteracted = true

        let eye = SIMD3<Float>(
            camera.target.x + cos(camera.yaw) * sin(camera.pitch) * camera.distance,
            camera.target.y + cos(camera.pitch) * camera.distance,
            camera.target.z + sin(camera.yaw) * sin(camera.pitch) * camera.distance
        )
        let forward = simd_normalize(camera.target - eye)
        let right = simd_normalize(simd_cross(forward, SIMD3<Float>(0, 1, 0)))
        let up = simd_normalize(simd_cross(right, forward))
        let worldUnitsPerPointY = (2 * camera.distance * tan(verticalFov / 2)) / height
        let worldUnitsPerPointX = (2 * camera.distance * tan(horizontalFov / 2)) / max(1, Float(viewSize.width))

        camera.target += (-right * deltaX * worldUnitsPerPointX) + (up * deltaY * worldUnitsPerPointY)
    }

    func zoom(scale: Float, state: UIGestureRecognizer.State) {
        hasUserInteracted = true
        camera.distance = min(max(4, camera.distance / max(0.2, scale)), 220)
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        lastDrawableSize = size
    }

    func draw(in view: MTKView) {
        guard let descriptor = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            return
        }

        let uniforms = MetalUniforms(viewProjectionMatrix: makeViewProjectionMatrix(for: view))
        encoder.setDepthStencilState(depthState)

        if let triangleBuffer, !scene.triangleVertices.isEmpty {
            encoder.setRenderPipelineState(trianglePipeline)
            encoder.setVertexBuffer(triangleBuffer, offset: 0, index: 0)
            encoder.setVertexBytes([uniforms], length: MemoryLayout<MetalUniforms>.stride, index: 1)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: scene.triangleVertices.count)
        }

        if let lineBuffer, !scene.lineVertices.isEmpty {
            encoder.setRenderPipelineState(linePipeline)
            encoder.setVertexBuffer(lineBuffer, offset: 0, index: 0)
            encoder.setVertexBytes([uniforms], length: MemoryLayout<MetalUniforms>.stride, index: 1)
            encoder.drawPrimitives(type: .line, vertexStart: 0, vertexCount: scene.lineVertices.count)
        }

        if let pointBuffer, !scene.pointVertices.isEmpty {
            encoder.setRenderPipelineState(pointPipeline)
            encoder.setVertexBuffer(pointBuffer, offset: 0, index: 0)
            encoder.setVertexBytes([uniforms], length: MemoryLayout<MetalUniforms>.stride, index: 1)
            encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: scene.pointVertices.count)
        }

        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
        onLabelsChanged(projectLabels(in: view, matrix: uniforms.viewProjectionMatrix))
    }

    private func uploadBuffers() {
        if !scene.triangleVertices.isEmpty {
            triangleBuffer = device.makeBuffer(bytes: scene.triangleVertices, length: MemoryLayout<MetalVertex>.stride * scene.triangleVertices.count)
        } else {
            triangleBuffer = nil
        }
        if !scene.lineVertices.isEmpty {
            lineBuffer = device.makeBuffer(bytes: scene.lineVertices, length: MemoryLayout<MetalVertex>.stride * scene.lineVertices.count)
        } else {
            lineBuffer = nil
        }
        if !scene.pointVertices.isEmpty {
            pointBuffer = device.makeBuffer(bytes: scene.pointVertices, length: MemoryLayout<MetalPointVertex>.stride * scene.pointVertices.count)
        } else {
            pointBuffer = nil
        }
    }

    private func resetCameraToScene() {
        let center = scene.focusBounds.center
        let span = scene.focusBounds.span
        guard center.x.isFinite, center.y.isFinite, center.z.isFinite,
              span.x.isFinite, span.y.isFinite, span.z.isFinite else {
            return
        }
        camera.target = SIMD3<Float>(center.x, max(1, min(6, center.y)), center.z)

        let drawableSize = lastDrawableSize == .zero ? (view?.drawableSize ?? .zero) : lastDrawableSize
        let aspect = max(0.1, Float(drawableSize.width / max(1, drawableSize.height)))
        let verticalFov = Float.pi / 3
        let horizontalFov = 2 * atan(tan(verticalFov / 2) * aspect)

        let directionToEye = simd_normalize(SIMD3<Float>(
            cos(camera.yaw) * sin(camera.pitch),
            cos(camera.pitch),
            sin(camera.yaw) * sin(camera.pitch)
        ))
        let forward = -directionToEye
        let right = simd_normalize(simd_cross(forward, SIMD3<Float>(0, 1, 0)))
        let up = simd_normalize(simd_cross(right, forward))

        var requiredDistance: Float = 0
        for corner in focusBoundsCorners(scene.focusBounds) {
            let relative = corner - camera.target
            let forwardOffset = simd_dot(relative, forward)
            let horizontalDistance = abs(simd_dot(relative, right)) / tan(horizontalFov / 2)
            let verticalDistance = abs(simd_dot(relative, up)) / tan(verticalFov / 2)
            requiredDistance = max(requiredDistance, horizontalDistance - forwardOffset)
            requiredDistance = max(requiredDistance, verticalDistance - forwardOffset)
        }

        camera.distance = min(96, max(16, requiredDistance * 0.92))
    }

    private func makeViewProjectionMatrix(for view: MTKView) -> simd_float4x4 {
        let aspect = max(0.1, Float(view.drawableSize.width / max(1, view.drawableSize.height)))
        let projection = simd_float4x4.perspective(fovY: .pi / 3, aspect: aspect, nearZ: 0.1, farZ: 500)
        let eye = SIMD3<Float>(
            camera.target.x + cos(camera.yaw) * sin(camera.pitch) * camera.distance,
            camera.target.y + cos(camera.pitch) * camera.distance,
            camera.target.z + sin(camera.yaw) * sin(camera.pitch) * camera.distance
        )
        let viewMatrix = simd_float4x4.lookAt(eye: eye, center: camera.target, up: SIMD3<Float>(0, 1, 0))
        return projection * viewMatrix
    }

    private func projectLabels(in view: MTKView, matrix: simd_float4x4) -> [ApproachMetalProjectedLabel] {
        let width = max(1, Float(view.bounds.width))
        let height = max(1, Float(view.bounds.height))
        return scene.labels.map { label in
            let clip = matrix * SIMD4<Float>(label.position.x, label.position.y, label.position.z, 1)
            guard clip.w > 0 else {
                return ApproachMetalProjectedLabel(id: label.id, text: label.text, color: Color(label.color), x: 0, y: 0, fontSize: label.fontSize, visible: false)
            }
            let ndc = clip / clip.w
            let x = CGFloat((ndc.x * 0.5 + 0.5) * width)
            let y = CGFloat((1 - (ndc.y * 0.5 + 0.5)) * height)
            return ApproachMetalProjectedLabel(
                id: label.id,
                text: label.text,
                color: Color(label.color),
                x: x,
                y: y,
                fontSize: label.fontSize,
                visible: abs(ndc.x) <= 1.0 && abs(ndc.y) <= 1.0 && ndc.z >= -1 && ndc.z <= 1
            )
        }
    }
}

private func focusBoundsCorners(_ bounds: MetalSceneBounds) -> [SIMD3<Float>] {
    [
        SIMD3<Float>(bounds.min.x, bounds.min.y, bounds.min.z),
        SIMD3<Float>(bounds.min.x, bounds.min.y, bounds.max.z),
        SIMD3<Float>(bounds.min.x, bounds.max.y, bounds.min.z),
        SIMD3<Float>(bounds.min.x, bounds.max.y, bounds.max.z),
        SIMD3<Float>(bounds.max.x, bounds.min.y, bounds.min.z),
        SIMD3<Float>(bounds.max.x, bounds.min.y, bounds.max.z),
        SIMD3<Float>(bounds.max.x, bounds.max.y, bounds.min.z),
        SIMD3<Float>(bounds.max.x, bounds.max.y, bounds.max.z),
    ]
}

private func buildRenderScene(
    sceneData: NativeSceneData,
    terrainData: TerrainWireframeData?,
    verticalScale: Double
) -> RenderScene {
    var scene = RenderScene()
    let pathPolylines = ApproachPathGeometry.buildPolylines(sceneData: sceneData, verticalScale: verticalScale)
    let waypointPoints = buildWaypointRenderPoints(sceneData: sceneData, verticalScale: verticalScale)
    let runwaySegments = buildMetalRunwaySegments(sceneData: sceneData)

    if let terrainData {
        let vertices = terrainData.vertices.map {
            SIMD3<Float>(
                Float($0.eastNm),
                Float(altToY(altFeet: $0.elevationFeet, verticalScale: verticalScale)),
                Float(-$0.northNm)
            )
        }
        appendTerrain(vertices: vertices, rows: terrainData.rows, columns: terrainData.columns, into: &scene)
    }

    appendRunways(runwaySegments, into: &scene)
    appendPaths(
        pathPolylines,
        verticalScale: verticalScale,
        into: &scene
    )
    appendHoldPatterns(sceneData: sceneData, verticalScale: verticalScale, into: &scene)
    appendWaypoints(waypointPoints, into: &scene)
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

private func appendPaths(
    _ polylines: [ApproachPolyline],
    verticalScale: Double,
    into scene: inout RenderScene
) {
    for polyline in polylines {
        let thresholdY = polyline.dashedBelowAltitudeFeet.map { Float(altToY(altFeet: $0, verticalScale: verticalScale)) }
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
                fontSize: 11
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
                    color: UIColor(
                        red: CGFloat(polyline.color.x),
                        green: CGFloat(polyline.color.y),
                        blue: CGFloat(polyline.color.z),
                        alpha: 1
                    ),
                    fontSize: 10
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
        scene.labels.append(LabelAnchor(id: point.labelText, text: point.labelText, position: point.position + SIMD3<Float>(0, 0.18, 0), color: .white, fontSize: 11))
        scene.bounds.include(point.position)
    }
}

private struct MetalRunwaySegment {
    let label: String
    let x: Double
    let z: Double
    let length: Double
    let rotationY: Double
}

private func appendRunways(_ segments: [MetalRunwaySegment], into scene: inout RenderScene) {
    let baseColor = SIMD4<Float>(1, 0, 1, 0.85)
    let centerColor = SIMD4<Float>(1, 1, 1, 1)
    for segment in segments {
        let center = SIMD3<Float>(Float(segment.x), 0.02, Float(segment.z))
        appendBox(center: center, size: SIMD3<Float>(0.12, 0.04, Float(segment.length)), rotationY: Float(segment.rotationY), color: baseColor, into: &scene.triangleVertices)
        appendBox(center: SIMD3<Float>(center.x, center.y + 0.022, center.z), size: SIMD3<Float>(0.02, 0.01, Float(segment.length * 0.95)), rotationY: Float(segment.rotationY), color: centerColor, into: &scene.triangleVertices)
        scene.labels.append(LabelAnchor(
            id: segment.label,
            text: segment.label,
            position: center + SIMD3<Float>(0, 0.20, 0),
            color: UIColor(red: 1, green: 0, blue: 1, alpha: 1),
            fontSize: 11
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

private func buildMetalRunwaySegments(sceneData: NativeSceneData) -> [MetalRunwaySegment] {
    let thresholds = sceneData.runways.map { runway -> (id: String, x: Double, z: Double) in
        let point = metalScenePoint(
            lat: runway.lat,
            lon: runway.lon,
            altitudeFeet: sceneData.airport.elevation,
            airport: sceneData.airport,
            verticalScale: 1
        )
        return (runway.id.hasPrefix("RW") ? runway.id : "RW\(runway.id)", Double(point.x), Double(point.z))
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
            z: runway.z + dz / 2,
            length: 1.0,
            rotationY: atan2(dx, dz)
        ))
    }
    return segments
}

private func metalReciprocalRunwayID(_ id: String) -> String? {
    let identifier = id.replacingOccurrences(of: "RW", with: "")
    let pattern = try! NSRegularExpression(pattern: #"^(\d{1,2})([LRC]?)$"#)
    let range = NSRange(location: 0, length: identifier.utf16.count)
    guard let match = pattern.firstMatch(in: identifier, range: range),
          let numberRange = Range(match.range(at: 1), in: identifier) else { return nil }
    let number = Int(identifier[numberRange]) ?? 0
    let reciprocalNumber = ((number + 17) % 36) + 1
    let suffixRange = Range(match.range(at: 2), in: identifier)
    let suffix = suffixRange.map { String(identifier[$0]) } ?? ""
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
    return LabelAnchor(id: text, text: text, position: position, color: UIColor(red: 111.0 / 255.0, green: 123.0 / 255.0, blue: 1.0, alpha: 1.0), fontSize: 11)
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

private extension simd_float4x4 {
    static func perspective(fovY: Float, aspect: Float, nearZ: Float, farZ: Float) -> simd_float4x4 {
        let y = 1 / tan(fovY * 0.5)
        let x = y / aspect
        let z = farZ / (nearZ - farZ)
        return simd_float4x4(
            SIMD4<Float>(x, 0, 0, 0),
            SIMD4<Float>(0, y, 0, 0),
            SIMD4<Float>(0, 0, z, -1),
            SIMD4<Float>(0, 0, z * nearZ, 0)
        )
    }

    static func lookAt(eye: SIMD3<Float>, center: SIMD3<Float>, up: SIMD3<Float>) -> simd_float4x4 {
        let z = simd_normalize(eye - center)
        let x = simd_normalize(simd_cross(up, z))
        let y = simd_cross(z, x)
        return simd_float4x4(
            SIMD4<Float>(x.x, y.x, z.x, 0),
            SIMD4<Float>(x.y, y.y, z.y, 0),
            SIMD4<Float>(x.z, y.z, z.z, 0),
            SIMD4<Float>(-simd_dot(x, eye), -simd_dot(y, eye), -simd_dot(z, eye), 1)
        )
    }
}
