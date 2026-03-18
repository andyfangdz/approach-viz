import MetalKit
import SwiftUI
import UIKit
import simd

struct ApproachMetalInvalidation: OptionSet {
    let rawValue: Int

    static let geometry = ApproachMetalInvalidation(rawValue: 1 << 0)
    static let camera = ApproachMetalInvalidation(rawValue: 1 << 1)
    static let viewport = ApproachMetalInvalidation(rawValue: 1 << 2)
    static let overlays = ApproachMetalInvalidation(rawValue: 1 << 3)
    static let trafficGeometry = ApproachMetalInvalidation(rawValue: 1 << 4)

    static let all: ApproachMetalInvalidation = [.geometry, .camera, .viewport, .overlays, .trafficGeometry]
}

private final class ApproachMetalPrimitiveLayer<Vertex> {
    private var buffer: MTLBuffer?
    private(set) var count = 0

    func upload(device: MTLDevice, vertices: [Vertex]) {
        count = vertices.count
        if vertices.isEmpty {
            buffer = nil
            return
        }
        buffer = vertices.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else {
                return nil
            }
            return device.makeBuffer(
                bytes: baseAddress,
                length: rawBuffer.count
            )
        }
    }

    func encode(
        _ encoder: MTLRenderCommandEncoder,
        pipeline: MTLRenderPipelineState,
        uniforms: MetalUniforms,
        depthState: MTLDepthStencilState,
        primitiveType: MTLPrimitiveType
    ) {
        guard let buffer, count > 0 else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setVertexBuffer(buffer, offset: 0, index: 0)
        encoder.setVertexBytes([uniforms], length: MemoryLayout<MetalUniforms>.stride, index: 1)
        encoder.setDepthStencilState(depthState)
        encoder.drawPrimitives(type: primitiveType, vertexStart: 0, vertexCount: count)
    }
}

private final class ApproachMetalIndexedLayer {
    private var vertexBuffer: MTLBuffer?
    private var indexBuffer: MTLBuffer?
    private(set) var indexCount = 0

    func upload(device: MTLDevice, vertices: [MetalVertex], indices: [UInt32]) {
        indexCount = indices.count
        guard !vertices.isEmpty, !indices.isEmpty else {
            vertexBuffer = nil
            indexBuffer = nil
            return
        }
        vertexBuffer = device.makeBuffer(bytes: vertices, length: MemoryLayout<MetalVertex>.stride * vertices.count)
        indexBuffer = device.makeBuffer(bytes: indices, length: MemoryLayout<UInt32>.stride * indices.count)
    }

    func encode(
        _ encoder: MTLRenderCommandEncoder,
        pipeline: MTLRenderPipelineState,
        uniforms: MetalUniforms,
        depthState: MTLDepthStencilState,
        primitiveType: MTLPrimitiveType
    ) {
        guard let vertexBuffer, let indexBuffer, indexCount > 0 else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
        encoder.setVertexBytes([uniforms], length: MemoryLayout<MetalUniforms>.stride, index: 1)
        encoder.setDepthStencilState(depthState)
        encoder.drawIndexedPrimitives(
            type: primitiveType,
            indexCount: indexCount,
            indexType: .uint32,
            indexBuffer: indexBuffer,
            indexBufferOffset: 0
        )
    }
}

@MainActor
final class ApproachMetalRenderEngine {
    private weak var view: MTKView?
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let trianglePipeline: MTLRenderPipelineState
    private let linePipeline: MTLRenderPipelineState
    private let pointPipeline: MTLRenderPipelineState
    private let depthState: MTLDepthStencilState
    private let translucentDepthState: MTLDepthStencilState
    private let onLabelsChanged: ([ApproachMetalProjectedLabel]) -> Void
    private let onStatsChanged: (ApproachMetalRenderStats) -> Void

    private var invalidation: ApproachMetalInvalidation = .all
    private var scene = RenderScene()
    private var trafficScene = TrafficRenderScene.empty
    private var cameraController = ApproachMetalCameraController()
    private var lastDrawableSize = CGSize.zero
    private var cachedUniforms = MetalUniforms(viewProjectionMatrix: matrix_identity_float4x4)
    private var cachedLabels: [ApproachMetalProjectedLabel] = []
    private var cachedStats = ApproachMetalRenderStats.empty
    private var hasUserInteracted = false

    private let triangleLayer = ApproachMetalPrimitiveLayer<MetalVertex>()
    private let lineLayer = ApproachMetalPrimitiveLayer<MetalVertex>()
    private let pointLayer = ApproachMetalPrimitiveLayer<MetalPointVertex>()
    private let trafficLineLayer = ApproachMetalPrimitiveLayer<MetalVertex>()
    private let trafficPointLayer = ApproachMetalPrimitiveLayer<MetalPointVertex>()
    private let airspaceTriangleLayer = ApproachMetalIndexedLayer()
    private let airspaceLineLayer = ApproachMetalIndexedLayer()

    init?(
        view: MTKView,
        onLabelsChanged: @escaping ([ApproachMetalProjectedLabel]) -> Void,
        onStatsChanged: @escaping (ApproachMetalRenderStats) -> Void
    ) {
        guard let device = view.device,
              let commandQueue = device.makeCommandQueue(),
              let library = device.makeDefaultLibrary() else {
            return nil
        }
        self.view = view
        self.device = device
        self.commandQueue = commandQueue
        self.onLabelsChanged = onLabelsChanged
        self.onStatsChanged = onStatsChanged

        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .less
        depthDescriptor.isDepthWriteEnabled = true
        guard let depthState = device.makeDepthStencilState(descriptor: depthDescriptor) else {
            return nil
        }
        self.depthState = depthState

        let translucentDepthDescriptor = MTLDepthStencilDescriptor()
        translucentDepthDescriptor.depthCompareFunction = .lessEqual
        translucentDepthDescriptor.isDepthWriteEnabled = false
        guard let translucentDepthState = device.makeDepthStencilState(descriptor: translucentDepthDescriptor) else {
            return nil
        }
        self.translucentDepthState = translucentDepthState

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
    }

    func updateScene(_ scene: RenderScene) {
        self.scene = scene
        invalidation.formUnion([.geometry, .overlays])
        if !hasUserInteracted {
            let drawableSize = currentDrawableSize
            cameraController.reset(to: scene.focusBounds, drawableSize: drawableSize)
            invalidation.formUnion([.camera, .overlays])
        }
        requestRedraw()
    }

    func updateTrafficScene(_ trafficScene: TrafficRenderScene) {
        self.trafficScene = trafficScene
        invalidation.formUnion([.trafficGeometry, .overlays])
        requestRedraw()
    }

    func orbit(deltaX: Float, deltaY: Float) {
        hasUserInteracted = true
        cameraController.orbit(deltaX: deltaX, deltaY: deltaY)
        invalidation.formUnion([.camera, .overlays])
        requestRedraw()
    }

    func pan(deltaX: Float, deltaY: Float, viewSize: CGSize) {
        hasUserInteracted = true
        cameraController.pan(deltaX: deltaX, deltaY: deltaY, viewSize: viewSize)
        invalidation.formUnion([.camera, .overlays])
        requestRedraw()
    }

    func zoom(scale: Float) {
        hasUserInteracted = true
        cameraController.zoom(scale: scale)
        invalidation.formUnion([.camera, .overlays])
        requestRedraw()
    }

    func drawableSizeWillChange(_ size: CGSize) {
        lastDrawableSize = size
        invalidation.formUnion([.viewport, .camera, .overlays])
        requestRedraw()
    }

    func draw(in view: MTKView) {
        let drawStart = DispatchTime.now().uptimeNanoseconds
        guard let descriptor = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            return
        }

        let drawInvalidation = invalidation
        let (syncCPUms, uploadCPUms, labelCPUms) = syncFrameState(for: view)
        var drawCallCount = 0

        triangleLayer.encode(
            encoder,
            pipeline: trianglePipeline,
            uniforms: cachedUniforms,
            depthState: depthState,
            primitiveType: .triangle
        )
        if triangleLayer.count > 0 { drawCallCount += 1 }
        airspaceTriangleLayer.encode(
            encoder,
            pipeline: trianglePipeline,
            uniforms: cachedUniforms,
            depthState: translucentDepthState,
            primitiveType: .triangle
        )
        if airspaceTriangleLayer.indexCount > 0 { drawCallCount += 1 }
        lineLayer.encode(
            encoder,
            pipeline: linePipeline,
            uniforms: cachedUniforms,
            depthState: translucentDepthState,
            primitiveType: .line
        )
        if lineLayer.count > 0 { drawCallCount += 1 }
        trafficLineLayer.encode(
            encoder,
            pipeline: linePipeline,
            uniforms: cachedUniforms,
            depthState: translucentDepthState,
            primitiveType: .line
        )
        if trafficLineLayer.count > 0 { drawCallCount += 1 }
        airspaceLineLayer.encode(
            encoder,
            pipeline: linePipeline,
            uniforms: cachedUniforms,
            depthState: translucentDepthState,
            primitiveType: .line
        )
        if airspaceLineLayer.indexCount > 0 { drawCallCount += 1 }
        pointLayer.encode(
            encoder,
            pipeline: pointPipeline,
            uniforms: cachedUniforms,
            depthState: translucentDepthState,
            primitiveType: .point
        )
        if pointLayer.count > 0 { drawCallCount += 1 }
        trafficPointLayer.encode(
            encoder,
            pipeline: pointPipeline,
            uniforms: cachedUniforms,
            depthState: translucentDepthState,
            primitiveType: .point
        )
        if trafficPointLayer.count > 0 { drawCallCount += 1 }

        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
        onLabelsChanged(cachedLabels)
        cachedStats = ApproachMetalRenderStats(
            invalidationSummary: drawInvalidation.summary,
            drawCPUms: elapsedMillis(since: drawStart),
            syncCPUms: syncCPUms,
            uploadCPUms: uploadCPUms,
            labelCPUms: labelCPUms,
            triangleCount: triangleLayer.count / 3 + airspaceTriangleLayer.indexCount / 3,
            lineCount: lineLayer.count / 2 + trafficLineLayer.count / 2 + airspaceLineLayer.indexCount / 2,
            pointCount: pointLayer.count + trafficPointLayer.count,
            labelCount: cachedLabels.filter(\.visible).count,
            drawCallCount: drawCallCount
        )
        onStatsChanged(cachedStats)
    }

    private func syncFrameState(for view: MTKView) -> (syncCPUms: Double, uploadCPUms: Double, labelCPUms: Double) {
        let syncStart = DispatchTime.now().uptimeNanoseconds
        var uploadCPUms = 0.0
        var labelCPUms = 0.0

        if invalidation.contains(.geometry) {
            let uploadStart = DispatchTime.now().uptimeNanoseconds
            triangleLayer.upload(device: device, vertices: scene.triangleVertices)
            lineLayer.upload(device: device, vertices: scene.lineVertices)
            pointLayer.upload(device: device, vertices: scene.pointVertices)
            airspaceTriangleLayer.upload(
                device: device,
                vertices: scene.airspaceTriangleVertices,
                indices: scene.airspaceTriangleIndices
            )
            airspaceLineLayer.upload(
                device: device,
                vertices: scene.airspaceLineVertices,
                indices: scene.airspaceLineIndices
            )
            uploadCPUms = elapsedMillis(since: uploadStart)
        }

        if invalidation.contains(.trafficGeometry) {
            let uploadStart = DispatchTime.now().uptimeNanoseconds
            trafficLineLayer.upload(device: device, vertices: trafficScene.lineVertices)
            trafficPointLayer.upload(device: device, vertices: trafficScene.pointVertices)
            uploadCPUms += elapsedMillis(since: uploadStart)
        }

        if invalidation.intersection([.camera, .viewport]).isEmpty == false {
            cachedUniforms = MetalUniforms(
                viewProjectionMatrix: cameraController.makeViewProjectionMatrix(drawableSize: currentDrawableSize)
            )
        }

        if invalidation.intersection([.geometry, .camera, .viewport, .overlays]).isEmpty == false {
            let labelStart = DispatchTime.now().uptimeNanoseconds
            cachedLabels = projectLabels(in: view, matrix: cachedUniforms.viewProjectionMatrix)
            labelCPUms = elapsedMillis(since: labelStart)
        }

        invalidation = []
        return (elapsedMillis(since: syncStart), uploadCPUms, labelCPUms)
    }

    private func projectLabels(in view: MTKView, matrix: simd_float4x4) -> [ApproachMetalProjectedLabel] {
        let width = max(1, Float(view.bounds.width))
        let height = max(1, Float(view.bounds.height))
        let labels = scene.labels + trafficScene.labels
        return labels.map { label in
            let clip = matrix * SIMD4<Float>(label.position.x, label.position.y, label.position.z, 1)
            guard clip.w > 0 else {
                return ApproachMetalProjectedLabel(
                    id: label.id,
                    text: label.text,
                    color: Color(label.color),
                    x: 0,
                    y: 0,
                    fontSize: label.fontSize,
                    visible: false
                )
            }
            let ndc = clip / clip.w
            return ApproachMetalProjectedLabel(
                id: label.id,
                text: label.text,
                color: Color(label.color),
                x: CGFloat((ndc.x * 0.5 + 0.5) * width),
                y: CGFloat((1 - (ndc.y * 0.5 + 0.5)) * height),
                fontSize: label.fontSize,
                visible: abs(ndc.x) <= 1.0 && abs(ndc.y) <= 1.0 && ndc.z >= -1 && ndc.z <= 1
            )
        }
    }

    private var currentDrawableSize: CGSize {
        if lastDrawableSize != .zero {
            return lastDrawableSize
        }
        return view?.drawableSize ?? CGSize(width: 1, height: 1)
    }

    private func requestRedraw() {
        view?.setNeedsDisplay()
    }
}

private extension ApproachMetalInvalidation {
    var summary: String {
        if isEmpty {
            return "none"
        }
        var parts: [String] = []
        if contains(.geometry) { parts.append("geometry") }
        if contains(.camera) { parts.append("camera") }
        if contains(.viewport) { parts.append("viewport") }
        if contains(.overlays) { parts.append("overlays") }
        if contains(.trafficGeometry) { parts.append("traffic") }
        return parts.joined(separator: "+")
    }
}

private func elapsedMillis(since start: UInt64) -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
}
