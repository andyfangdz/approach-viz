import MetalKit
import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

struct ApproachMetalSceneView: View {
    let sceneData: NativeSceneData
    let trafficScene: NativeTrafficScene
    let mrmsScene: NativeMrmsScene?
    let echoTopScene: NativeEchoTopScene?
    let layerState: NativeLayerState
    let trafficDisplayOptions: NativeTrafficDisplayOptions
    let weatherDisplayOptions: NativeWeatherDisplayOptions
    let verticalScale: Double
    let capturesRenderStats: Bool
    @Binding var renderStats: ApproachMetalRenderStats

    @State private var terrainData: TerrainWireframeData?

    var body: some View {
        ApproachMetalViewRepresentable(
            sceneData: sceneData,
            trafficScene: trafficScene,
            mrmsScene: mrmsScene,
            echoTopScene: echoTopScene,
            layerState: layerState,
            trafficDisplayOptions: trafficDisplayOptions,
            weatherDisplayOptions: weatherDisplayOptions,
            terrainData: terrainData,
            verticalScale: verticalScale,
            capturesRenderStats: capturesRenderStats,
            renderStats: $renderStats
        )
        .task(id: "\(sceneData.airport.id)-\(sceneData.selectedApproachID)") {
            do {
                terrainData = try await TerrainWireframeLoader.shared.load(
                    refLat: sceneData.airport.lat,
                    refLon: sceneData.airport.lon
                )
            } catch {
                terrainData = nil
            }
        }
    }
}

#if os(iOS)
private struct ApproachMetalViewRepresentable: UIViewRepresentable {
    let sceneData: NativeSceneData
    let trafficScene: NativeTrafficScene
    let mrmsScene: NativeMrmsScene?
    let echoTopScene: NativeEchoTopScene?
    let layerState: NativeLayerState
    let trafficDisplayOptions: NativeTrafficDisplayOptions
    let weatherDisplayOptions: NativeWeatherDisplayOptions
    let terrainData: TerrainWireframeData?
    let verticalScale: Double
    let capturesRenderStats: Bool
    @Binding var renderStats: ApproachMetalRenderStats

    func makeCoordinator() -> Coordinator {
        Coordinator(renderStats: $renderStats, capturesRenderStats: capturesRenderStats)
    }

    func makeUIView(context: Context) -> MTKView {
        makeMetalView(using: context.coordinator)
    }

    func updateUIView(_ uiView: MTKView, context: Context) {
        updateMetalView(uiView, using: context.coordinator)
    }
}
#elseif os(macOS)
private struct ApproachMetalViewRepresentable: NSViewRepresentable {
    let sceneData: NativeSceneData
    let trafficScene: NativeTrafficScene
    let mrmsScene: NativeMrmsScene?
    let echoTopScene: NativeEchoTopScene?
    let layerState: NativeLayerState
    let trafficDisplayOptions: NativeTrafficDisplayOptions
    let weatherDisplayOptions: NativeWeatherDisplayOptions
    let terrainData: TerrainWireframeData?
    let verticalScale: Double
    let capturesRenderStats: Bool
    @Binding var renderStats: ApproachMetalRenderStats

    func makeCoordinator() -> Coordinator {
        Coordinator(renderStats: $renderStats, capturesRenderStats: capturesRenderStats)
    }

    func makeNSView(context: Context) -> MTKView {
        makeMetalView(using: context.coordinator)
    }

    func updateNSView(_ nsView: MTKView, context: Context) {
        updateMetalView(nsView, using: context.coordinator)
    }
}
#endif

#if os(macOS)
private final class ApproachMetalMacView: MTKView {
    var onTrackpadPan: ((CGSize) -> Void)?

    override func scrollWheel(with event: NSEvent) {
        let isTrackpadPan = event.hasPreciseScrollingDeltas || !event.phase.isEmpty || !event.momentumPhase.isEmpty
        guard isTrackpadPan else {
            super.scrollWheel(with: event)
            return
        }

        onTrackpadPan?(CGSize(width: event.scrollingDeltaX, height: event.scrollingDeltaY))
    }
}
#endif

private extension ApproachMetalViewRepresentable {
    @MainActor
    func makeMetalView(using coordinator: Coordinator) -> MTKView {
        #if os(macOS)
        let view = ApproachMetalMacView(frame: .zero)
        #else
        let view = MTKView(frame: .zero)
        #endif
        view.device = MTLCreateSystemDefaultDevice()
        view.clearColor = MTLClearColor(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0, alpha: 1.0)
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        view.sampleCount = 1
        view.preferredFramesPerSecond = platformMaximumFramesPerSecond()
        view.enableSetNeedsDisplay = true
        view.isPaused = true
        coordinator.attach(to: view)
        coordinator.update(
            sceneData: sceneData,
            trafficScene: trafficScene,
            mrmsScene: mrmsScene,
            echoTopScene: echoTopScene,
            layerState: layerState,
            trafficDisplayOptions: trafficDisplayOptions,
            weatherDisplayOptions: weatherDisplayOptions,
            terrainData: terrainData,
            verticalScale: verticalScale
        )
        return view
    }

    func updateMetalView(_ view: MTKView, using coordinator: Coordinator) {
        coordinator.setRenderStatsCaptureEnabled(capturesRenderStats)
        coordinator.update(
            sceneData: sceneData,
            trafficScene: trafficScene,
            mrmsScene: mrmsScene,
            echoTopScene: echoTopScene,
            layerState: layerState,
            trafficDisplayOptions: trafficDisplayOptions,
            weatherDisplayOptions: weatherDisplayOptions,
            terrainData: terrainData,
            verticalScale: verticalScale
        )
    }
}

#if os(iOS)
private typealias PlatformGestureRecognizerDelegate = UIGestureRecognizerDelegate
#elseif os(macOS)
private typealias PlatformGestureRecognizerDelegate = NSGestureRecognizerDelegate
#endif

@MainActor
private final class Coordinator: NSObject, PlatformGestureRecognizerDelegate {
    private var renderer: ApproachMetalRenderer?
    private var renderStats: Binding<ApproachMetalRenderStats>
    private var capturesRenderStats: Bool

    init(renderStats: Binding<ApproachMetalRenderStats>, capturesRenderStats: Bool) {
        self.renderStats = renderStats
        self.capturesRenderStats = capturesRenderStats
    }

    func setRenderStatsCaptureEnabled(_ enabled: Bool) {
        capturesRenderStats = enabled
        if !enabled, renderStats.wrappedValue != .empty {
            renderStats.wrappedValue = .empty
        }
    }

    func attach(to view: MTKView) {
        renderer = ApproachMetalRenderer(
            view: view,
            onStatsChanged: { [weak self] stats in
                guard let self, self.capturesRenderStats else { return }
                if self.renderStats.wrappedValue != stats {
                    self.renderStats.wrappedValue = stats
                }
            }
        )
        installGestures(on: view)
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
        renderer?.update(
            sceneData: sceneData,
            trafficScene: trafficScene,
            mrmsScene: mrmsScene,
            echoTopScene: echoTopScene,
            layerState: layerState,
            trafficDisplayOptions: trafficDisplayOptions,
            weatherDisplayOptions: weatherDisplayOptions,
            terrainData: terrainData,
            verticalScale: verticalScale
        )
    }

    #if os(iOS)
    private func installGestures(on view: MTKView) {
        let orbitPan = UIPanGestureRecognizer(target: self, action: #selector(handleOrbitPan(_:)))
        orbitPan.minimumNumberOfTouches = 1
        orbitPan.maximumNumberOfTouches = 1
        orbitPan.delegate = self
        view.addGestureRecognizer(orbitPan)

        let scenePan = UIPanGestureRecognizer(target: self, action: #selector(handleScenePan(_:)))
        scenePan.minimumNumberOfTouches = 2
        scenePan.maximumNumberOfTouches = 2
        scenePan.delegate = self
        view.addGestureRecognizer(scenePan)

        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        pinch.delegate = self
        view.addGestureRecognizer(pinch)
    }

    @objc private func handleOrbitPan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: gesture.view)
        renderer?.orbit(deltaX: Float(translation.x), deltaY: Float(translation.y))
        if gesture.state == .changed || gesture.state == .ended {
            gesture.setTranslation(.zero, in: gesture.view)
        }
    }

    @objc private func handleScenePan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: gesture.view)
        let viewSize = gesture.view?.bounds.size ?? .zero
        renderer?.pan(deltaX: Float(translation.x), deltaY: Float(translation.y), viewSize: viewSize)
        if gesture.state == .changed || gesture.state == .ended {
            gesture.setTranslation(.zero, in: gesture.view)
        }
    }

    @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
        renderer?.zoom(scale: Float(gesture.scale))
        if gesture.state == .changed || gesture.state == .ended {
            gesture.scale = 1
        }
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        let recognizers = [gestureRecognizer, otherGestureRecognizer]
        return recognizers.contains { $0 is UIPinchGestureRecognizer }
    }
    #elseif os(macOS)
    private func installGestures(on view: MTKView) {
        let orbitPan = NSPanGestureRecognizer(target: self, action: #selector(handleOrbitPan(_:)))
        orbitPan.buttonMask = 0x1
        orbitPan.delegate = self
        view.addGestureRecognizer(orbitPan)

        let magnification = NSMagnificationGestureRecognizer(target: self, action: #selector(handleMagnification(_:)))
        magnification.delegate = self
        view.addGestureRecognizer(magnification)

        (view as? ApproachMetalMacView)?.onTrackpadPan = { [weak self, weak view] delta in
            guard let self, let view else { return }
            self.handleTrackpadPan(delta, in: view)
        }
    }

    @objc private func handleOrbitPan(_ gesture: NSPanGestureRecognizer) {
        let translation = gesture.translation(in: gesture.view)
        renderer?.orbit(deltaX: Float(translation.x), deltaY: -Float(translation.y))
        if gesture.state == .changed || gesture.state == .ended {
            gesture.setTranslation(.zero, in: gesture.view)
        }
    }

    private func handleTrackpadPan(_ delta: CGSize, in view: MTKView) {
        renderer?.pan(
            deltaX: Float(delta.width),
            deltaY: Float(delta.height),
            viewSize: view.bounds.size
        )
    }

    @objc private func handleMagnification(_ gesture: NSMagnificationGestureRecognizer) {
        renderer?.zoom(scale: 1 + Float(gesture.magnification))
        if gesture.state == .changed || gesture.state == .ended {
            gesture.magnification = 0
        }
    }

    func gestureRecognizer(
        _ gestureRecognizer: NSGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: NSGestureRecognizer
    ) -> Bool {
        let recognizers = [gestureRecognizer, otherGestureRecognizer]
        return recognizers.contains { $0 is NSMagnificationGestureRecognizer }
    }
    #endif
}
