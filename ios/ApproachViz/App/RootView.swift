import FloatingPanel
import SwiftUI
import UIKit

struct RootView: View {
    @State private var appModel = AppModel()

    var body: some View {
        ApproachDetailView(appModel: appModel)
        .task {
            await appModel.loadInitialData()
        }
    }
}
private struct ApproachDetailView: View {
    let appModel: AppModel
    @State private var activePanel: DetailControlPanel?
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
                    capturesRenderStats: activePanel == .debug,
                    renderStats: $renderStats
                )
                .ignoresSafeArea()
            } else if let errorMessage = appModel.errorMessage {
                ContentUnavailableView("Unable to load data", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
            } else {
                ContentUnavailableView("Choose an approach", systemImage: "airplane.departure")
            }
        }
        .background(Color(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0))
        .overlay(alignment: .topLeading) {
            if appModel.sceneData != nil {
                HStack(alignment: .top, spacing: 12) {
                    if let titleContext {
                        SceneSelectionBar(
                            titleContext: titleContext,
                            isShowingSelectors: activePanel == .selectors
                        ) {
                            togglePanel(.selectors)
                        }
                    }
                    Spacer(minLength: 0)
                    FloatingFabButton(
                        systemImage: "ladybug.fill",
                        title: activePanel == .debug ? "Hide debug panel" : "Show debug panel"
                    ) {
                        togglePanel(.debug)
                    }
                }
                .padding()
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if appModel.sceneData != nil {
                HStack(spacing: 12) {
                    FloatingFabButton(
                        systemImage: "gearshape.fill",
                        title: activePanel == .options ? "Hide options panel" : "Show options panel"
                    ) {
                        togglePanel(.options)
                    }
                    FloatingFabButton(
                        systemImage: "square.stack.3d.up.fill",
                        title: activePanel == .layers ? "Hide layers panel" : "Show layers panel"
                    ) {
                        togglePanel(.layers)
                    }
                }
                .padding()
            }
        }
        .overlay {
            if appModel.sceneData != nil {
                DetailControlPanelOverlay(
                    activePanel: $activePanel,
                    appModel: appModel,
                    renderStats: $renderStats
                )
            }
        }
    }

    private func togglePanel(_ panel: DetailControlPanel) {
        activePanel = activePanel == panel ? nil : panel
    }

    @ViewBuilder
    private func panelContent(for panel: DetailControlPanel) -> some View {
        switch panel {
        case .selectors:
            NativeSelectorPanel(appModel: appModel) {
                activePanel = nil
            }
        case .layers:
            NativeLayersPanel(appModel: appModel) {
                activePanel = nil
            }
        case .options:
            NativeOptionsPanel(appModel: appModel) {
                activePanel = nil
            }
        case .debug:
            NativeDebugPanel(renderStats: renderStats) {
                activePanel = nil
            }
        }
    }

    private var titleContext: SceneTitleContext? {
        guard let sceneData = appModel.sceneData else { return nil }
        let selectedApproach = sceneData.approaches.first { $0.procedureID == sceneData.selectedApproachID }
        return SceneTitleContext(
            airportID: sceneData.airport.id,
            approachID: sceneData.selectedApproachID,
            subtitle: selectedApproach.map { "\($0.type) • RWY \($0.runway)" } ?? nil,
            airportLabel: sceneData.airport.name
        )
    }
}

private enum DetailControlPanel: String, CaseIterable, Equatable, Identifiable {
    case selectors
    case layers
    case options
    case debug

    var id: String { rawValue }
}

private struct SceneTitleContext: Equatable {
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
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(
            Capsule()
                .strokeBorder(Color.white.opacity(0.08))
        )
        .accessibilityLabel("Show airport and approach selectors")
    }
}

private struct DetailControlPanelOverlay: View {
    let activePanel: Binding<DetailControlPanel?>
    let appModel: AppModel
    @Binding var renderStats: ApproachMetalRenderStats

    var body: some View {
        NativeFloatingPanelHost(activePanel: activePanel) { panel in
            panelContent(for: panel)
        }
    }

    private func panelContent(for panel: DetailControlPanel) -> AnyView {
        switch panel {
        case .selectors:
            return AnyView(NativeSelectorPanel(appModel: appModel) {
                activePanel.wrappedValue = nil
            })
        case .layers:
            return AnyView(NativeLayersPanel(appModel: appModel) {
                activePanel.wrappedValue = nil
            })
        case .options:
            return AnyView(NativeOptionsPanel(appModel: appModel) {
                activePanel.wrappedValue = nil
            })
        case .debug:
            return AnyView(NativeDebugPanel(renderStats: renderStats) {
                activePanel.wrappedValue = nil
            })
        }
    }
}

private struct NativeFloatingPanelHost: UIViewControllerRepresentable {
    let activePanel: Binding<DetailControlPanel?>
    let content: (DetailControlPanel) -> AnyView

    func makeCoordinator() -> Coordinator {
        Coordinator(activePanel: activePanel)
    }

    func makeUIViewController(context: Context) -> FloatingPanelOverlayViewController {
        context.coordinator.makeContainerViewController()
    }

    func updateUIViewController(_ uiViewController: FloatingPanelOverlayViewController, context: Context) {
        context.coordinator.update(
            in: uiViewController,
            activePanel: activePanel.wrappedValue,
            content: content
        )
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency FloatingPanelControllerDelegate {
        private let activePanel: Binding<DetailControlPanel?>
        private let floatingPanelController = FloatingPanelController()
        private var contentController: UIHostingController<AnyView>?
        private weak var containerViewController: FloatingPanelOverlayViewController?
        private var displayedPanel: DetailControlPanel?

        init(activePanel: Binding<DetailControlPanel?>) {
            self.activePanel = activePanel
            super.init()
            floatingPanelController.delegate = self
            floatingPanelController.layout = DetailControlPanelLayout()
            floatingPanelController.isRemovalInteractionEnabled = true
            floatingPanelController.backdropView.dismissalTapGestureRecognizer.isEnabled = false
            floatingPanelController.backdropView.isUserInteractionEnabled = false
            floatingPanelController.surfaceView.grabberHandle.isHidden = false
            floatingPanelController.surfaceView.grabberAreaOffset = 0
            floatingPanelController.surfaceView.backgroundColor = .clear
            floatingPanelController.surfaceView.containerView.backgroundColor = .clear
            floatingPanelController.surfaceView.appearance = makeGlassSurfaceAppearance()
        }

        func makeContainerViewController() -> FloatingPanelOverlayViewController {
            let viewController = FloatingPanelOverlayViewController()
            viewController.view.backgroundColor = .clear
            viewController.hitTestProvider = { [weak self] point, event in
                guard let self else { return false }
                return self.panelContains(point: point, event: event, in: viewController.view)
            }
            containerViewController = viewController
            return viewController
        }

        func update(
            in viewController: FloatingPanelOverlayViewController,
            activePanel: DetailControlPanel?,
            content: (DetailControlPanel) -> AnyView
        ) {
            containerViewController = viewController

            guard let activePanel else {
                displayedPanel = nil
                if floatingPanelController.parent != nil {
                    floatingPanelController.removePanelFromParent(animated: true)
                }
                return
            }

            let contentView = AnyView(
                ZStack {
                    NativeBlurView(style: .systemUltraThinMaterialDark)
                    ScrollView {
                        content(activePanel)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .scrollIndicators(.hidden)
                }
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.06))
                )
            )

            if let contentController {
                contentController.rootView = contentView
            } else {
                let contentController = UIHostingController(rootView: contentView)
                contentController.view.backgroundColor = .clear
                self.contentController = contentController
                floatingPanelController.set(contentViewController: contentController)
            }

            if floatingPanelController.parent == nil {
                floatingPanelController.addPanel(toParent: viewController, animated: false)
            }

            if displayedPanel != activePanel {
                displayedPanel = activePanel
                floatingPanelController.move(to: .half, animated: false)
            }

            DispatchQueue.main.async { [weak self] in
                self?.trackHostedScrollViewIfAvailable()
            }
        }

        func floatingPanelDidMove(_ fpc: FloatingPanelController) {
            containerViewController?.view.setNeedsLayout()
        }

        private func panelContains(point: CGPoint, event: UIEvent?, in rootView: UIView) -> Bool {
            guard floatingPanelController.parent != nil else { return false }
            let containerView = floatingPanelController.surfaceView.containerView
            let pointInContainer = rootView.convert(point, to: containerView)
            return containerView.point(inside: pointInContainer, with: event)
        }

        private func trackHostedScrollViewIfAvailable() {
            guard
                let contentController,
                let scrollView = findScrollView(in: contentController.view)
            else {
                return
            }
            if floatingPanelController.trackingScrollView !== scrollView {
                floatingPanelController.track(scrollView: scrollView)
            }
        }

        private func findScrollView(in view: UIView) -> UIScrollView? {
            if let scrollView = view as? UIScrollView {
                return scrollView
            }
            for subview in view.subviews {
                if let scrollView = findScrollView(in: subview) {
                    return scrollView
                }
            }
            return nil
        }

        private func makeGlassSurfaceAppearance() -> FloatingPanel.SurfaceAppearance {
            let appearance = FloatingPanel.SurfaceAppearance()
            appearance.backgroundColor = .clear
            appearance.borderColor = nil
            appearance.borderWidth = 0
            appearance.cornerCurve = .continuous
            appearance.cornerRadius = 24
            return appearance
        }
    }
}

@MainActor
private final class FloatingPanelOverlayViewController: UIViewController {
    var hitTestProvider: ((CGPoint, UIEvent?) -> Bool)?

    override func loadView() {
        view = FloatingPanelPassthroughView()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let passthroughView = view as? FloatingPanelPassthroughView {
            passthroughView.hitTestProvider = { [weak self] point, event in
                self?.hitTestProvider?(point, event) ?? false
            }
        }
    }
}

@MainActor
private final class FloatingPanelPassthroughView: UIView {
    var hitTestProvider: ((CGPoint, UIEvent?) -> Bool)?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        hitTestProvider?(point, event) ?? false
    }
}

private struct NativeBlurView: UIViewRepresentable {
    let style: UIBlurEffect.Style

    func makeUIView(context: Context) -> UIVisualEffectView {
        UIVisualEffectView(effect: UIBlurEffect(style: style))
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        uiView.effect = UIBlurEffect(style: style)
    }
}

private final class DetailControlPanelLayout: FloatingPanelBottomLayout {
    override var initialState: FloatingPanelState { .half }

    override var anchors: [FloatingPanelState: FloatingPanelLayoutAnchoring] {
        [
            .full: FloatingPanelLayoutAnchor(absoluteInset: 16, edge: .top, referenceGuide: .safeArea),
            .half: FloatingPanelLayoutAnchor(fractionalInset: 0.48, edge: .bottom, referenceGuide: .safeArea),
            .tip: FloatingPanelLayoutAnchor(absoluteInset: 88, edge: .bottom, referenceGuide: .safeArea),
        ]
    }

    override func backdropAlpha(for state: FloatingPanelState) -> CGFloat {
        0
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

private struct NativePanelContainer<Content: View>: View {
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
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NativeSelectorPanel: View {
    let appModel: AppModel
    let onClose: () -> Void
    @FocusState private var isAirportFilterFocused: Bool

    private let airportPreviewLimit = 200

    private var displayedAirports: [AirportOption] {
        let airports = appModel.filteredAirports
        guard airports.count > airportPreviewLimit else {
            return airports
        }
        if let selectedAirportID = appModel.selectedAirportID,
           let selectedAirport = airports.first(where: { $0.id == selectedAirportID }) {
            let remaining = airports.lazy.filter { $0.id != selectedAirportID }.prefix(airportPreviewLimit - 1)
            return [selectedAirport] + Array(remaining)
        }
        return Array(airports.prefix(airportPreviewLimit))
    }

    var body: some View {
        NativePanelContainer(title: "Select Scene", onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                TextField("Filter airports", text: Binding(
                    get: { appModel.airportFilter },
                    set: { appModel.airportFilter = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .focused($isAirportFilterFocused)

                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Airports")
                    if appModel.filteredAirports.isEmpty {
                        Text("No airports match the current filter.")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.58))
                    } else {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(displayedAirports) { airport in
                                SelectorRow(
                                    title: airport.id,
                                    subtitle: airport.label,
                                    isSelected: airport.id == appModel.selectedAirportID
                                ) {
                                    dismissKeyboard()
                                    Task {
                                        await appModel.selectAirport(id: airport.id)
                                    }
                                }
                            }
                        }
                        if appModel.filteredAirports.count > displayedAirports.count {
                            Text("Showing first \(displayedAirports.count) matches. Keep typing to narrow the list.")
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.52))
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Approaches")
                    if appModel.approaches.isEmpty {
                        Text("Select an airport to load procedures.")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.58))
                    } else {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(appModel.approaches) { approach in
                                SelectorRow(
                                    title: approach.procedureID,
                                    subtitle: "\(approach.type) • Runway \(approach.runway)",
                                    isSelected: approach.procedureID == appModel.selectedApproachID,
                                    compactTitle: true
                                ) {
                                    dismissKeyboard()
                                    Task {
                                        await appModel.selectApproach(id: approach.procedureID)
                                        onClose()
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func dismissKeyboard() {
        isAirportFilterFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
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
    }
}

private struct NativeLayersPanel: View {
    let appModel: AppModel
    let onClose: () -> Void

    var body: some View {
        NativePanelContainer(title: "Layers", onClose: onClose) {
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
        NativePanelContainer(title: "Options", onClose: onClose) {
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
