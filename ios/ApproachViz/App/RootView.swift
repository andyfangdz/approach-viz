import SwiftUI

struct RootView: View {
    @State private var appModel = AppModel()

    var body: some View {
        NavigationSplitView {
            AirportSidebarView(appModel: appModel)
        } content: {
            ApproachListView(appModel: appModel)
        } detail: {
            ApproachDetailView(appModel: appModel)
        }
        .task {
            await appModel.loadInitialData()
        }
    }
}

private struct AirportSidebarView: View {
    let appModel: AppModel

    var body: some View {
        VStack(spacing: 12) {
            TextField("Filter airports", text: Binding(
                get: { appModel.airportFilter },
                set: { appModel.airportFilter = $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .padding(.horizontal)
            List(appModel.filteredAirports, selection: Binding(
                get: { appModel.selectedAirportID },
                set: { newValue in
                    appModel.selectedAirportID = newValue
                    guard let airportID = newValue else { return }
                    Task {
                        await appModel.selectAirport(id: airportID)
                    }
                }
            )) { airport in
                VStack(alignment: .leading, spacing: 2) {
                    Text(airport.id)
                        .font(.headline)
                    Text(airport.label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .tag(airport.id)
            }
            .overlay {
                if appModel.filteredAirports.isEmpty {
                    ContentUnavailableView("No airports", systemImage: "airplane")
                }
            }
        }
        .navigationTitle("Airports")
    }
}

private struct ApproachListView: View {
    let appModel: AppModel

    var body: some View {
        List(appModel.approaches, selection: Binding(
            get: { appModel.selectedApproachID },
            set: { newValue in
                appModel.selectedApproachID = newValue
                guard let approachID = newValue else { return }
                Task {
                    await appModel.selectApproach(id: approachID)
                }
            }
        )) { approach in
            VStack(alignment: .leading, spacing: 4) {
                Text(approach.procedureID)
                    .font(.headline)
                Text("\(approach.type) • Runway \(approach.runway)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .tag(approach.procedureID)
        }
        .navigationTitle("Approaches")
        .overlay {
            if appModel.approaches.isEmpty {
                ContentUnavailableView("Select an airport", systemImage: "map")
            }
        }
    }
}

private struct ApproachDetailView: View {
    let appModel: AppModel
    @State private var layersCollapsed = true
    @State private var optionsCollapsed = true
    @State private var debugCollapsed = true
    @State private var renderStats = ApproachMetalRenderStats.empty

    var body: some View {
        ZStack {
            if let sceneData = appModel.sceneData {
                ApproachMetalSceneView(
                    sceneData: sceneData,
                    trafficScene: appModel.trafficScene,
                    layerState: appModel.layerState,
                    trafficDisplayOptions: appModel.trafficDisplayOptions,
                    verticalScale: appModel.verticalScale,
                    capturesRenderStats: !debugCollapsed,
                    renderStats: $renderStats
                )
            } else if let errorMessage = appModel.errorMessage {
                ContentUnavailableView("Unable to load data", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
            } else {
                ContentUnavailableView("Choose an approach", systemImage: "airplane.departure")
            }
        }
        .background(Color(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0))
        .navigationTitle(appModel.sceneData?.airport.id ?? "Scene")
        .overlay(alignment: .topLeading) {
            if appModel.sceneData != nil {
                VStack(alignment: .leading, spacing: 12) {
                    if !debugCollapsed {
                        NativeDebugPanel(renderStats: renderStats) {
                            debugCollapsed = true
                        }
                    } else {
                        FloatingFabButton(
                            systemImage: "ladybug.fill",
                            title: "Show debug panel"
                        ) {
                            debugCollapsed = false
                        }
                    }
                }
                .padding()
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if appModel.sceneData != nil {
                VStack(alignment: .trailing, spacing: 12) {
                    if !optionsCollapsed {
                        NativeOptionsPanel(appModel: appModel) {
                            optionsCollapsed = true
                        }
                    }
                    if !layersCollapsed {
                        NativeLayersPanel(appModel: appModel) {
                            layersCollapsed = true
                        }
                    }
                    HStack(spacing: 12) {
                        if optionsCollapsed {
                            FloatingFabButton(
                                systemImage: "gearshape.fill",
                                title: "Show options"
                            ) {
                                optionsCollapsed = false
                            }
                        }
                        if layersCollapsed {
                            FloatingFabButton(
                                systemImage: "square.stack.3d.up.fill",
                                title: "Show layers"
                            ) {
                                layersCollapsed = false
                            }
                        }
                    }
                }
                .padding()
            }
        }
    }
}

private struct FloatingFabButton: View {
    let systemImage: String
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 52, height: 52)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .accessibilityLabel(title)
    }
}

private struct FloatingPanelContainer<Content: View>: View {
    let title: String
    let onClose: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
            }
            content
        }
        .padding(14)
        .frame(maxWidth: 320, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08))
        )
    }
}

private struct NativeLayersPanel: View {
    let appModel: AppModel
    let onClose: () -> Void

    var body: some View {
        FloatingPanelContainer(title: "Layers", onClose: onClose) {
            VStack(alignment: .leading, spacing: 10) {
                LayerToggleRow(
                    title: "Approach",
                    isOn: Binding(
                        get: { appModel.layerState.approach },
                        set: { appModel.setLayerEnabled(\.approach, $0) }
                    )
                )
                LayerToggleRow(
                    title: "Airspace",
                    isOn: Binding(
                        get: { appModel.layerState.airspace },
                        set: { appModel.setLayerEnabled(\.airspace, $0) }
                    )
                )
                LayerToggleRow(
                    title: "ADS-B Traffic",
                    isOn: Binding(
                        get: { appModel.layerState.adsb },
                        set: { appModel.setLayerEnabled(\.adsb, $0) }
                    )
                )
            }
        }
    }
}

private struct NativeOptionsPanel: View {
    let appModel: AppModel
    let onClose: () -> Void

    var body: some View {
        FloatingPanelContainer(title: "Options", onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                Group {
                    SectionLabel("Scene")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Vertical Scale \(appModel.verticalScale.formatted(.number.precision(.fractionLength(1))))x")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.86))
                        Slider(
                            value: Binding(
                                get: { appModel.verticalScale },
                                set: { appModel.setVerticalScale($0) }
                            ),
                            in: 1...8,
                            step: 0.5
                        )
                    }
                }

                Group {
                    SectionLabel("ADS-B Traffic")
                    if let trafficErrorMessage = appModel.trafficErrorMessage, appModel.layerState.adsb {
                        Text("Traffic unavailable: \(trafficErrorMessage)")
                            .font(.caption)
                            .foregroundStyle(.orange.opacity(0.9))
                    }
                    Text("Traffic \(appModel.trafficScene.renderedTrackCount) targets")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.72))
                    LayerToggleRow(
                        title: "Hide Ground Traffic",
                        isOn: Binding(
                            get: { appModel.trafficDisplayOptions.hideGroundTargets },
                            set: { appModel.setHideGroundTraffic($0) }
                        ),
                        disabled: !appModel.layerState.adsb
                    )
                    LayerToggleRow(
                        title: "Show Traffic Callsigns",
                        isOn: Binding(
                            get: { appModel.trafficDisplayOptions.showCallsignLabels },
                            set: { appModel.setShowTrafficCallsigns($0) }
                        ),
                        disabled: !appModel.layerState.adsb
                    )
                    LayerToggleRow(
                        title: "Hide Ground Callsign Labels",
                        isOn: Binding(
                            get: { appModel.trafficDisplayOptions.hideGroundCallsignLabels },
                            set: { appModel.setHideGroundTrafficCallsigns($0) }
                        ),
                        disabled: !appModel.layerState.adsb || !appModel.trafficDisplayOptions.showCallsignLabels
                    )
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Traffic History (\(Int(appModel.trafficDisplayOptions.historyMinutes.rounded())) min)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(appModel.layerState.adsb ? .white.opacity(0.86) : .white.opacity(0.35))
                        Slider(
                            value: Binding(
                                get: { appModel.trafficDisplayOptions.historyMinutes },
                                set: { appModel.setTrafficHistoryMinutes($0) }
                            ),
                            in: 1...30,
                            step: 1
                        )
                        .disabled(!appModel.layerState.adsb)
                    }
                    LayerToggleRow(
                        title: "Show Departed Traffic Trails",
                        isOn: Binding(
                            get: { appModel.trafficDisplayOptions.showDepartedTrafficTrails },
                            set: { appModel.setShowDepartedTrafficTrails($0) }
                        ),
                        disabled: !appModel.layerState.adsb
                    )
                }
            }
        }
    }
}

private struct NativeDebugPanel: View {
    let renderStats: ApproachMetalRenderStats
    let onClose: () -> Void

    var body: some View {
        FloatingPanelContainer(title: "Debug", onClose: onClose) {
            VStack(alignment: .leading, spacing: 6) {
                DebugStatRow(label: "Invalidated", value: renderStats.invalidationSummary)
                DebugStatRow(label: "Draw", value: String(format: "%.2f ms", renderStats.drawCPUms))
                DebugStatRow(label: "Sync", value: String(format: "%.2f ms", renderStats.syncCPUms))
                DebugStatRow(label: "Upload", value: String(format: "%.2f ms", renderStats.uploadCPUms))
                DebugStatRow(label: "Labels", value: String(format: "%.2f ms", renderStats.labelCPUms))
                DebugStatRow(label: "Calls", value: "\(renderStats.drawCallCount)")
                DebugStatRow(label: "Triangles", value: "\(renderStats.triangleCount)")
                DebugStatRow(label: "Lines", value: "\(renderStats.lineCount)")
                DebugStatRow(label: "Points", value: "\(renderStats.pointCount)")
                DebugStatRow(label: "Labels Visible", value: "\(renderStats.labelCount)")
            }
            .font(.system(.caption, design: .monospaced))
        }
    }
}

private struct LayerToggleRow: View {
    let title: String
    let isOn: Binding<Bool>
    var disabled = false

    var body: some View {
        Toggle(isOn: isOn) {
            Text(title)
                .font(.subheadline)
        }
        .toggleStyle(.switch)
        .disabled(disabled)
        .foregroundStyle(disabled ? .white.opacity(0.35) : .white.opacity(0.92))
    }
}

private struct SectionLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(.white.opacity(0.58))
            .textCase(.uppercase)
    }
}

private struct DebugStatRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(.white.opacity(0.6))
            Spacer()
            Text(value)
                .foregroundStyle(.white.opacity(0.92))
        }
    }
}
