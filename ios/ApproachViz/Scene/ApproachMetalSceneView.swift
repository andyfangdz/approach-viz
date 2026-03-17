import MetalKit
import SwiftUI
import UIKit

struct ApproachMetalSceneView: View {
    let sceneData: NativeSceneData
    let verticalScale: Double

    @State private var terrainData: TerrainWireframeData?
    @State private var labels: [ApproachMetalProjectedLabel] = []

    var body: some View {
        ZStack {
            ApproachMetalViewRepresentable(
                sceneData: sceneData,
                terrainData: terrainData,
                verticalScale: verticalScale,
                labels: $labels
            )

            ForEach(labels) { label in
                if label.visible {
                    Text(label.text)
                        .font(.system(size: label.fontSize, weight: .semibold, design: .monospaced))
                        .foregroundStyle(label.color)
                        .shadow(color: Color.black.opacity(0.9), radius: 4)
                        .shadow(color: Color.black.opacity(0.7), radius: 8)
                        .position(x: label.x, y: label.y)
                }
            }
        }
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
    let terrainData: TerrainWireframeData?
    let verticalScale: Double
    @Binding var labels: [ApproachMetalProjectedLabel]

    func makeCoordinator() -> Coordinator {
        Coordinator(labels: $labels)
    }

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.clearColor = MTLClearColor(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0, alpha: 1.0)
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        view.sampleCount = 1
        view.preferredFramesPerSecond = UIScreen.main.maximumFramesPerSecond
        view.enableSetNeedsDisplay = false
        view.isPaused = false
        context.coordinator.attach(to: view)
        context.coordinator.update(sceneData: sceneData, terrainData: terrainData, verticalScale: verticalScale)
        return view
    }

    func updateUIView(_ uiView: MTKView, context: Context) {
        context.coordinator.update(sceneData: sceneData, terrainData: terrainData, verticalScale: verticalScale)
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private var renderer: ApproachMetalRenderer?
        private var labels: Binding<[ApproachMetalProjectedLabel]>

        init(labels: Binding<[ApproachMetalProjectedLabel]>) {
            self.labels = labels
        }

        func attach(to view: MTKView) {
            renderer = ApproachMetalRenderer(view: view) { [weak self] nextLabels in
                DispatchQueue.main.async {
                    self?.labels.wrappedValue = nextLabels
                }
            }
            installGestures(on: view)
        }

        func update(sceneData: NativeSceneData, terrainData: TerrainWireframeData?, verticalScale: Double) {
            renderer?.update(sceneData: sceneData, terrainData: terrainData, verticalScale: verticalScale)
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
