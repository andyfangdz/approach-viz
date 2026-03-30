import ComposableArchitecture
import SwiftUI
import SwiftUIIntrospect

#if os(macOS)
import AppKit
#endif

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
                    layerState: store.layerState,
                    trafficDisplayOptions: store.trafficDisplayOptions,
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

private struct DetailControlPanelOverlay: View {
    let store: StoreOf<AppFeature>
    @Binding var renderStats: ApproachMetalRenderStats

    var body: some View {
        GeometryReader { proxy in
            VStack {
                Spacer(minLength: 0)
                if let panel = store.activePanel {
                    DetailControlPanelSheet(
                        maxHeight: min(560, proxy.size.height * 0.58),
                    ) {
                        panelContent(for: panel)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .animation(.spring(response: 0.28, dampingFraction: 0.9), value: store.activePanel)
        }
    }

    @ViewBuilder
    private func panelContent(for panel: DetailControlPanel) -> some View {
        switch panel {
        case .selectors:
            NativeSelectorPanel(store: store) {
                store.send(.setActivePanel(nil))
            }
        case .layers:
            NativeLayersPanel(store: store) {
                store.send(.setActivePanel(nil))
            }
        case .options:
            NativeOptionsPanel(store: store) {
                store.send(.setActivePanel(nil))
            }
        case .debug:
            NativeDebugPanel(renderStats: renderStats) {
                store.send(.setActivePanel(nil))
            }
        }
    }
}

private struct DetailControlPanelSheet<Content: View>: View {
    let maxHeight: CGFloat
    let content: Content

    init(maxHeight: CGFloat, @ViewBuilder content: () -> Content) {
        self.maxHeight = maxHeight
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.white.opacity(0.22))
                .frame(width: 44, height: 5)
                .padding(.top, 10)
                .padding(.bottom, 8)
            ScrollView {
                content
            }
            .scrollIndicators(.hidden)
        }
        .frame(maxWidth: .infinity)
        .frame(maxHeight: maxHeight, alignment: .top)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.white.opacity(0.06))
        )
        .shadow(color: .black.opacity(0.24), radius: 22, y: 10)
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
        .platformPointerButton()
        .foregroundStyle(.white)
        .help(title)
        .accessibilityLabel(title)
    }
}

struct NativePanelContainer<Content: View>: View {
    let title: String
    let onClose: () -> Void
    let content: Content

    init(title: String, onClose: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.title = title
        self.onClose = onClose
        self.content = content()
    }

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
                .platformPointerButton()
            }
            content
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NativeSelectorPanel: View {
    private enum SelectorSection: String, CaseIterable, Identifiable {
        case airports
        case approaches

        var id: String { rawValue }

        var title: String {
            switch self {
            case .airports:
                return "Airports"
            case .approaches:
                return "Approaches"
            }
        }
    }

    let store: StoreOf<AppFeature>
    let onClose: () -> Void
    @FocusState private var isAirportFilterFocused: Bool
    @State private var activeSection: SelectorSection = .approaches

    var body: some View {
        NativePanelContainer(title: "Select Scene", onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                Picker("Selector section", selection: $activeSection) {
                    ForEach(SelectorSection.allCases) { section in
                        Text(section.title).tag(section)
                    }
                }
                .pickerStyle(.segmented)

                switch activeSection {
                case .airports:
                    airportSection
                case .approaches:
                    approachSection
                }
            }
        }
        .onAppear {
            syncActiveSectionWithCurrentSelection()
        }
        .onChange(of: store.selectedAirportID) { _, _ in
            syncActiveSectionWithCurrentSelection()
        }
    }

    private var airportSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(
                "Filter airports",
                text: Binding(
                    get: { store.airportFilter },
                    set: { store.send(.setAirportFilter($0)) }
                )
            )
            .textFieldStyle(.roundedBorder)
            .focused($isAirportFilterFocused)
            .modifier(AirportFilterFieldModifier())

            SectionLabel("Airports")
            if store.filteredAirports.isEmpty {
                Text("No airports match the current filter.")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.58))
            } else {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(store.displayedAirports) { airport in
                        SelectorRow(
                            title: airport.id,
                            subtitle: airport.label,
                            isSelected: airport.id == store.selectedAirportID
                        ) {
                            dismissKeyboard()
                            store.send(.airportSelected(airport.id))
                            activeSection = .approaches
                        }
                    }
                }
                if store.filteredAirports.count > store.displayedAirports.count {
                    Text("Showing first \(store.displayedAirports.count) matches. Keep typing to narrow the list.")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.52))
                }
            }
        }
    }

    private var approachSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let selectedAirportID = store.selectedAirportID {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectedAirportID)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Text(store.sceneTitleContext?.airportLabel ?? "Selected airport")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.58))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button("Change Airport") {
                        activeSection = .airports
                        isAirportFilterFocused = true
                    }
                    .buttonStyle(.borderless)
                    .platformPointerButton()
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.04))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.05))
                )
            }

            SectionLabel("Approaches")
            if store.approaches.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Select an airport to load procedures.")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.58))
                    Button("Browse Airports") {
                        activeSection = .airports
                        isAirportFilterFocused = true
                    }
                    .buttonStyle(.borderedProminent)
                    .platformPointerButton()
                    .tint(Color.white.opacity(0.14))
                }
            } else {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(store.approaches) { approach in
                        SelectorRow(
                            title: approach.procedureID,
                            subtitle: "\(approach.type) • Runway \(approach.runway)",
                            isSelected: approach.procedureID == store.selectedApproachID,
                            compactTitle: true
                        ) {
                            dismissKeyboard()
                            store.send(.approachSelected(approach.procedureID))
                        }
                    }
                }
            }
        }
    }

    private func dismissKeyboard() {
        isAirportFilterFocused = false
    }

    private func syncActiveSectionWithCurrentSelection() {
        activeSection = store.selectedAirportID == nil ? .airports : .approaches
    }
}

private struct SelectorRow: View {
    let title: String
    let subtitle: String
    let isSelected: Bool
    var compactTitle = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(compactTitle ? .subheadline.weight(.semibold) : .headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.62))
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isSelected ? Color.white.opacity(0.12) : Color.white.opacity(0.04))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(isSelected ? Color.white.opacity(0.16) : Color.white.opacity(0.05))
            )
        }
        .buttonStyle(.plain)
        .platformPointerButton()
    }
}

private struct NativeLayersPanel: View {
    let store: StoreOf<AppFeature>
    let onClose: () -> Void

    var body: some View {
        NativePanelContainer(title: "Layers", onClose: onClose) {
            VStack(alignment: .leading, spacing: 10) {
                LayerToggleRow(
                    title: "Approach",
                    isOn: Binding(
                        get: { store.layerState.approach },
                        set: { store.send(.setLayerEnabled(.approach, $0)) }
                    )
                )
                LayerToggleRow(
                    title: "Airspace",
                    isOn: Binding(
                        get: { store.layerState.airspace },
                        set: { store.send(.setLayerEnabled(.airspace, $0)) }
                    )
                )
                LayerToggleRow(
                    title: "ADS-B Traffic",
                    isOn: Binding(
                        get: { store.layerState.adsb },
                        set: { store.send(.setLayerEnabled(.adsb, $0)) }
                    )
                )
            }
        }
    }
}

private struct NativeOptionsPanel: View {
    let store: StoreOf<AppFeature>
    let onClose: () -> Void

    var body: some View {
        NativePanelContainer(title: "Options", onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                Group {
                    SectionLabel("Scene")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Vertical Scale \(store.verticalScale.formatted(.number.precision(.fractionLength(1))))x")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.86))
                        Slider(
                            value: Binding(
                                get: { store.verticalScale },
                                set: { store.send(.setVerticalScale($0)) }
                            ),
                            in: 1...8,
                            step: 0.5
                        )
                    }
                }

                Group {
                    SectionLabel("ADS-B Traffic")
                    if let trafficErrorMessage = store.trafficErrorMessage, store.layerState.adsb {
                        Text("Traffic unavailable: \(trafficErrorMessage)")
                            .font(.caption)
                            .foregroundStyle(.orange.opacity(0.9))
                    }
                    Text("Traffic \(store.trafficScene.renderedTrackCount) targets")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.72))
                    LayerToggleRow(
                        title: "Hide Ground Traffic",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.hideGroundTargets },
                            set: { store.send(.setHideGroundTraffic($0)) }
                        ),
                        disabled: !store.layerState.adsb
                    )
                    LayerToggleRow(
                        title: "Show Traffic Callsigns",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.showCallsignLabels },
                            set: { store.send(.setShowTrafficCallsigns($0)) }
                        ),
                        disabled: !store.layerState.adsb
                    )
                    LayerToggleRow(
                        title: "Hide Ground Callsign Labels",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.hideGroundCallsignLabels },
                            set: { store.send(.setHideGroundTrafficCallsigns($0)) }
                        ),
                        disabled: !store.layerState.adsb || !store.trafficDisplayOptions.showCallsignLabels
                    )
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Traffic History (\(Int(store.trafficDisplayOptions.historyMinutes.rounded())) min)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(store.layerState.adsb ? .white.opacity(0.86) : .white.opacity(0.35))
                        Slider(
                            value: Binding(
                                get: { store.trafficDisplayOptions.historyMinutes },
                                set: { store.send(.setTrafficHistoryMinutes($0)) }
                            ),
                            in: 1...30,
                            step: 1
                        )
                        .disabled(!store.layerState.adsb)
                    }
                    LayerToggleRow(
                        title: "Show Departed Traffic Trails",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.showDepartedTrafficTrails },
                            set: { store.send(.setShowDepartedTrafficTrails($0)) }
                        ),
                        disabled: !store.layerState.adsb
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
        NativePanelContainer(title: "Debug", onClose: onClose) {
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

private struct AirportFilterFieldModifier: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .introspect(.textField, on: .iOS(.v18, .v26)) { textField in
                textField.autocapitalizationType = .none
                textField.autocorrectionType = .no
                textField.smartDashesType = .no
                textField.smartQuotesType = .no
                textField.spellCheckingType = .no
            }
        #else
        content
        #endif
    }
}

private struct PlatformPointerButtonModifier: ViewModifier {
    func body(content: Content) -> some View {
        #if os(macOS)
        content.onHover { hovering in
            if hovering {
                NSCursor.pointingHand.set()
            } else {
                NSCursor.arrow.set()
            }
        }
        #else
        content
        #endif
    }
}

private extension View {
    func platformPointerButton() -> some View {
        modifier(PlatformPointerButtonModifier())
    }
}
