import MetalKit
import SwiftUI
import UIKit

struct ApproachMetalSceneView: View {
    let sceneData: NativeSceneData
    let trafficScene: NativeTrafficScene
    let layerState: NativeLayerState
    let trafficDisplayOptions: NativeTrafficDisplayOptions
    let verticalScale: Double
    let capturesRenderStats: Bool
    @Binding var renderStats: ApproachMetalRenderStats

    @State private var terrainData: TerrainWireframeData?

    var body: some View {
        ApproachMetalViewRepresentable(
            sceneData: sceneData,
            trafficScene: trafficScene,
            layerState: layerState,
            trafficDisplayOptions: trafficDisplayOptions,
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

private struct ApproachMetalViewRepresentable: UIViewRepresentable {
    let sceneData: NativeSceneData
    let trafficScene: NativeTrafficScene
    let layerState: NativeLayerState
    let trafficDisplayOptions: NativeTrafficDisplayOptions
    let terrainData: TerrainWireframeData?
    let verticalScale: Double
    let capturesRenderStats: Bool
    @Binding var renderStats: ApproachMetalRenderStats

    func makeCoordinator() -> Coordinator {
        Coordinator(renderStats: $renderStats, capturesRenderStats: capturesRenderStats)
    }

    func makeUIView(context: Context) -> ApproachMetalContainerView {
        let container = ApproachMetalContainerView(frame: .zero)
        let view = container.metalView
        view.device = MTLCreateSystemDefaultDevice()
        view.clearColor = MTLClearColor(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0, alpha: 1.0)
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        view.sampleCount = 1
        view.preferredFramesPerSecond = UIScreen.main.maximumFramesPerSecond
        view.enableSetNeedsDisplay = true
        view.isPaused = true
        context.coordinator.attach(to: container)
        context.coordinator.update(
            sceneData: sceneData,
            trafficScene: trafficScene,
            layerState: layerState,
            trafficDisplayOptions: trafficDisplayOptions,
            terrainData: terrainData,
            verticalScale: verticalScale
        )
        return container
    }

    func updateUIView(_ uiView: ApproachMetalContainerView, context: Context) {
        context.coordinator.setRenderStatsCaptureEnabled(capturesRenderStats)
        context.coordinator.update(
            sceneData: sceneData,
            trafficScene: trafficScene,
            layerState: layerState,
            trafficDisplayOptions: trafficDisplayOptions,
            terrainData: terrainData,
            verticalScale: verticalScale
        )
    }

        @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
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

        func attach(to container: ApproachMetalContainerView) {
            renderer = ApproachMetalRenderer(
                view: container.metalView,
                onStatsChanged: { [weak self] stats in
                    guard let self, self.capturesRenderStats else { return }
                    if self.renderStats.wrappedValue != stats {
                        self.renderStats.wrappedValue = stats
                    }
                }
            )
            installGestures(on: container.metalView)
        }

        func update(
            sceneData: NativeSceneData,
            trafficScene: NativeTrafficScene,
            layerState: NativeLayerState,
            trafficDisplayOptions: NativeTrafficDisplayOptions,
            terrainData: TerrainWireframeData?,
            verticalScale: Double
        ) {
            renderer?.update(
                sceneData: sceneData,
                trafficScene: trafficScene,
                layerState: layerState,
                trafficDisplayOptions: trafficDisplayOptions,
                terrainData: terrainData,
                verticalScale: verticalScale
            )
        }

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
            renderer?.orbit(deltaX: Float(translation.x), deltaY: Float(translation.y), state: gesture.state)
            if gesture.state == .changed || gesture.state == .ended {
                gesture.setTranslation(.zero, in: gesture.view)
            }
        }

        @objc private func handleScenePan(_ gesture: UIPanGestureRecognizer) {
            let translation = gesture.translation(in: gesture.view)
            let viewSize = gesture.view?.bounds.size ?? .zero
            renderer?.pan(deltaX: Float(translation.x), deltaY: Float(translation.y), viewSize: viewSize, state: gesture.state)
            if gesture.state == .changed || gesture.state == .ended {
                gesture.setTranslation(.zero, in: gesture.view)
            }
        }

        @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
            renderer?.zoom(scale: Float(gesture.scale), state: gesture.state)
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
    }
}

private final class ApproachMetalContainerView: UIView {
    let metalView = MTKView(frame: .zero)

    override init(frame: CGRect) {
        super.init(frame: frame)
        metalView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(metalView)
        NSLayoutConstraint.activate([
            metalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            metalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            metalView.topAnchor.constraint(equalTo: topAnchor),
            metalView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}
