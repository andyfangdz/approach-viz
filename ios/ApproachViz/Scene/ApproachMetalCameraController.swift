import Foundation
import simd

struct ApproachMetalCameraController {
    private(set) var state = CameraState()

    mutating func orbit(deltaX: Float, deltaY: Float) {
        let sensitivity: Float = 0.005
        state.yaw += deltaX * sensitivity
        state.pitch = min(max(0.08, state.pitch - deltaY * sensitivity), .pi - 0.08)
    }

    mutating func pan(deltaX: Float, deltaY: Float, viewSize: CGSize) {
        let height = max(1, Float(viewSize.height))
        let aspect = max(0.1, Float(viewSize.width) / height)
        let verticalFov = Float.pi / 3
        let horizontalFov = 2 * atan(tan(verticalFov / 2) * aspect)

        let eye = eyePosition
        let forward = simd_normalize(state.target - eye)
        let right = simd_normalize(simd_cross(forward, SIMD3<Float>(0, 1, 0)))
        let up = simd_normalize(simd_cross(right, forward))
        let worldUnitsPerPointY = (2 * state.distance * tan(verticalFov / 2)) / height
        let worldUnitsPerPointX = (2 * state.distance * tan(horizontalFov / 2)) / max(1, Float(viewSize.width))

        state.target += (-right * deltaX * worldUnitsPerPointX) + (up * deltaY * worldUnitsPerPointY)
    }

    mutating func zoom(scale: Float) {
        state.distance = min(max(4, state.distance / max(0.2, scale)), 220)
    }

    mutating func reset(to bounds: MetalSceneBounds, drawableSize: CGSize) {
        let center = bounds.center
        let span = bounds.span
        guard center.x.isFinite, center.y.isFinite, center.z.isFinite,
              span.x.isFinite, span.y.isFinite, span.z.isFinite else {
            return
        }

        state.target = SIMD3<Float>(center.x, max(1, min(6, center.y)), center.z)

        let aspect = max(0.1, Float(drawableSize.width / max(1, drawableSize.height)))
        let verticalFov = Float.pi / 3
        let horizontalFov = 2 * atan(tan(verticalFov / 2) * aspect)
        let directionToEye = simd_normalize(SIMD3<Float>(
            cos(state.yaw) * sin(state.pitch),
            cos(state.pitch),
            sin(state.yaw) * sin(state.pitch)
        ))
        let forward = -directionToEye
        let right = simd_normalize(simd_cross(forward, SIMD3<Float>(0, 1, 0)))
        let up = simd_normalize(simd_cross(right, forward))

        var requiredDistance: Float = 0
        for corner in focusBoundsCorners(bounds) {
            let relative = corner - state.target
            let forwardOffset = simd_dot(relative, forward)
            let horizontalDistance = abs(simd_dot(relative, right)) / tan(horizontalFov / 2)
            let verticalDistance = abs(simd_dot(relative, up)) / tan(verticalFov / 2)
            requiredDistance = max(requiredDistance, horizontalDistance - forwardOffset)
            requiredDistance = max(requiredDistance, verticalDistance - forwardOffset)
        }

        state.distance = min(96, max(16, requiredDistance * 0.92))
    }

    func makeViewProjectionMatrix(drawableSize: CGSize) -> simd_float4x4 {
        let aspect = max(0.1, Float(drawableSize.width / max(1, drawableSize.height)))
        let projection = simd_float4x4.perspective(fovY: .pi / 3, aspect: aspect, nearZ: 0.1, farZ: 500)
        let viewMatrix = simd_float4x4.lookAt(eye: eyePosition, center: state.target, up: SIMD3<Float>(0, 1, 0))
        return projection * viewMatrix
    }

    private var eyePosition: SIMD3<Float> {
        SIMD3<Float>(
            state.target.x + cos(state.yaw) * sin(state.pitch) * state.distance,
            state.target.y + cos(state.pitch) * state.distance,
            state.target.z + sin(state.yaw) * sin(state.pitch) * state.distance
        )
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
