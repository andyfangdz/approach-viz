import ComposableArchitecture
import SwiftUI

struct RootView: View {
    let store: StoreOf<AppFeature>

    init(store: StoreOf<AppFeature> = Store(initialState: AppFeature.State()) {
        AppFeature()
    }) {
        self.store = store
    }

    var body: some View {
        ApproachDetailView(store: store)
            .task {
                _ = store.send(.task)
            }
    }
}

private struct ApproachDetailView: View {
    let store: StoreOf<AppFeature>
    @State private var renderStats = ApproachMetalRenderStats.empty

    var body: some View {
        ZStack {
            if let sceneData = store.sceneData {
                ApproachMetalSceneView(
                    sceneData: sceneData,
                    trafficScene: store.trafficScene,
                    mrmsScene: store.mrmsScene,
                    echoTopScene: store.echoTopScene,
                    layerState: store.layerState,
                    trafficDisplayOptions: store.trafficDisplayOptions,
                    weatherDisplayOptions: store.weatherDisplayOptions,
                    verticalScale: store.verticalScale,
                    capturesRenderStats: store.activePanel == .debug,
                    renderStats: $renderStats
                )
                .ignoresSafeArea()
            } else if let errorMessage = store.errorMessage {
                ContentUnavailableView(
                    "Unable to load data",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else {
                ContentUnavailableView("Choose an approach", systemImage: "airplane.departure")
            }
        }
        .background(Color(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0))
        .overlay(alignment: .topLeading) {
            if store.sceneData != nil {
                HStack(alignment: .top, spacing: 12) {
                    if let titleContext = store.sceneTitleContext {
                        SceneSelectionBar(
                            titleContext: titleContext,
                            isShowingSelectors: store.activePanel == .selectors
                        ) {
                            store.send(.togglePanel(.selectors))
                        }
                    }
                    Spacer(minLength: 0)
                    FloatingFabButton(
                        systemImage: "ladybug.fill",
                        title: store.activePanel == .debug ? "Hide debug panel" : "Show debug panel"
                    ) {
                        store.send(.togglePanel(.debug))
                    }
                }
                .padding()
            }
        }
        .overlay(alignment: .bottomLeading) {
            if store.sceneData != nil,
               store.layerState.slice,
               let crossSection = store.mrmsScene?.crossSection {
                CrossSectionHUDView(
                    crossSection: crossSection,
                    headingDeg: store.weatherDisplayOptions.crossSectionHeadingDeg,
                    rangeNm: store.weatherDisplayOptions.crossSectionRangeNm,
                    echoTopScene: store.echoTopScene
                )
                .padding()
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if store.sceneData != nil {
                HStack(spacing: 12) {
                    FloatingFabButton(
                        systemImage: "gearshape.fill",
                        title: store.activePanel == .options ? "Hide options panel" : "Show options panel"
                    ) {
                        store.send(.togglePanel(.options))
                    }
                    FloatingFabButton(
                        systemImage: "square.stack.3d.up.fill",
                        title: store.activePanel == .layers ? "Hide layers panel" : "Show layers panel"
                    ) {
                        store.send(.togglePanel(.layers))
                    }
                }
                .padding()
            }
        }
        .overlay {
            if store.sceneData != nil {
                DetailControlPanelOverlay(store: store, renderStats: $renderStats)
            }
        }
    }
}

struct SceneTitleContext: Equatable {
    let airportID: String
    let approachID: String
    let subtitle: String?
    let airportLabel: String
}

private struct SceneSelectionBar: View {
    let titleContext: SceneTitleContext
    let isShowingSelectors: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(titleContext.airportID)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Text(titleContext.approachID)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.white.opacity(0.84))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    Text(titleContext.subtitle ?? titleContext.airportLabel)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Image(systemName: isShowingSelectors ? "chevron.up.circle.fill" : "chevron.down.circle.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.84))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .platformPointerButton()
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(
            Capsule()
                .strokeBorder(Color.white.opacity(0.08))
        )
        .help("Show airport and approach selectors")
        .accessibilityLabel("Show airport and approach selectors")
    }
}
