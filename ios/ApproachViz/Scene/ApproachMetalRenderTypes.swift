import Foundation
import simd

struct ApproachMetalProjectedLabel: Identifiable, Equatable {
    let id: String
    let text: String
    let color: SIMD4<Float>
    let x: CGFloat
    let y: CGFloat
    let fontSize: CGFloat
    let declutterable: Bool
    let visible: Bool
}

struct ApproachMetalRenderStats: Equatable {
    let invalidationSummary: String
    let drawCPUms: Double
    let syncCPUms: Double
    let uploadCPUms: Double
    let labelCPUms: Double
    let triangleCount: Int
    let lineCount: Int
    let pointCount: Int
    let labelCount: Int
    let drawCallCount: Int

    static let empty = ApproachMetalRenderStats(
        invalidationSummary: "none",
        drawCPUms: 0,
        syncCPUms: 0,
        uploadCPUms: 0,
        labelCPUms: 0,
        triangleCount: 0,
        lineCount: 0,
        pointCount: 0,
        labelCount: 0,
        drawCallCount: 0
    )
}

struct MetalVertex {
    var position: SIMD3<Float>
    var color: SIMD4<Float>
}

struct MetalPointVertex {
    var position: SIMD3<Float>
    var color: SIMD4<Float>
    var size: Float
}

struct MetalUniforms {
    var viewProjectionMatrix: simd_float4x4
}

struct MetalTextVertex {
    var position: SIMD2<Float>
    var texCoord: SIMD2<Float>
    var color: SIMD4<Float>
}

struct CameraState {
    var target = SIMD3<Float>(0, 2, 0)
    var distance: Float = 22.045408
    var yaw: Float = .pi / 4
    var pitch: Float = 1.2951535
}

struct LabelAnchor {
    let id: String
    let text: String
    let position: SIMD3<Float>
    let color: PlatformColor
    let fontSize: CGFloat
    let declutterable: Bool
}

struct RenderScene {
    var triangleVertices: [MetalVertex] = []
    var lineVertices: [MetalVertex] = []
    var airspaceTriangleVertices: [MetalVertex] = []
    var airspaceTriangleIndices: [UInt32] = []
    var airspaceLineVertices: [MetalVertex] = []
    var airspaceLineIndices: [UInt32] = []
    var pointVertices: [MetalPointVertex] = []
    var labels: [LabelAnchor] = []
    var bounds = MetalSceneBounds()
    var focusBounds = MetalSceneBounds()
}

struct TrafficRenderScene {
    var lineVertices: [MetalVertex] = []
    var pointVertices: [MetalPointVertex] = []
    var labels: [LabelAnchor] = []

    static let empty = TrafficRenderScene()
}

struct MetalSceneBounds {
    var min = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
    var max = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)

    var center: SIMD3<Float> { (min + max) / 2 }
    var span: SIMD3<Float> { max - min }

    mutating func include(_ point: SIMD3<Float>) {
        min = simd_min(min, point)
        max = simd_max(max, point)
    }
}

extension simd_float4x4 {
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
