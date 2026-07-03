import AsyncAlgorithms
import ComposableArchitecture
import Foundation
import OrderedCollections

enum DetailControlPanel: String, CaseIterable, Equatable, Identifiable {
    case selectors
    case layers
    case options
    case debug

    var id: String { rawValue }
}

@Reducer
struct AppFeature {
    @ObservableState
    struct State: Equatable {
        private let trafficRadiusNm = 80
        private let trafficLimit = 250
        private let airportPreviewLimit = 200

        var airportFilter = ""

        var airports: [AirportOption] = []
        var approaches: [ApproachOption] = []
        var selectedAirportID: String?
        var selectedApproachID: String?
        var sceneData: NativeSceneData?
        var verticalScale = 3.0
        var layerState = NativeLayerState()
        var trafficDisplayOptions = NativeTrafficDisplayOptions()
        var errorMessage: String?
        var trafficScene = NativeTrafficScene.empty
        var trafficErrorMessage: String?
        var mrmsScene: NativeMrmsScene?
        var echoTopScene: NativeEchoTopScene?
        var mrmsErrorMessage: String?
        var weatherDisplayOptions = NativeWeatherDisplayOptions()
        var activePanel: DetailControlPanel?
        var hasLoadedInitialData = false
        var trafficGeneration = 0
        var trafficSessionID = UUID()
        var mrmsGeneration = 0

        var filteredAirports: [AirportOption] {
            let trimmed = airportFilter.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                return airports
            }
            let query = trimmed.lowercased()
            return airports.filter { option in
                option.id.lowercased().contains(query) || option.label.lowercased().contains(query)
            }
        }

        var displayedAirports: [AirportOption] {
            let matches = filteredAirports
            guard matches.count > airportPreviewLimit else {
                return matches
            }

            let airportByID = Dictionary(uniqueKeysWithValues: matches.map { ($0.id, $0) })
            var orderedIDs = OrderedSet<String>()
            if let selectedAirportID, airportByID[selectedAirportID] != nil {
                orderedIDs.append(selectedAirportID)
            }
            for airport in matches where orderedIDs.count < airportPreviewLimit {
                orderedIDs.append(airport.id)
            }
            return orderedIDs.compactMap { airportByID[$0] }
        }

        var sceneTitleContext: SceneTitleContext? {
            guard let sceneData else { return nil }
            let selectedApproach = sceneData.approaches.first { $0.procedureID == sceneData.selectedApproachID }
            return SceneTitleContext(
                airportID: sceneData.airport.id,
                approachID: sceneData.selectedApproachID,
                subtitle: selectedApproach.map { "\($0.type) • RWY \($0.runway)" } ?? nil,
                airportLabel: sceneData.airport.name
            )
        }

        var currentApproachIndex: Int? {
            guard let selectedApproachID else { return nil }
            return approaches.firstIndex { $0.procedureID == selectedApproachID }
        }

        var canSelectPreviousApproach: Bool {
            guard let currentApproachIndex else { return false }
            return currentApproachIndex > 0
        }

        var canSelectNextApproach: Bool {
            guard let currentApproachIndex else { return false }
            return currentApproachIndex < approaches.index(before: approaches.endIndex)
        }

        func makeTrafficContext() -> TrafficPollingContext? {
            guard layerState.adsb, let sceneData else { return nil }
            return TrafficPollingContext(
                refLat: sceneData.airport.lat,
                refLon: sceneData.airport.lon,
                airportElevationFeet: sceneData.airport.elevation,
                elevationAirports: sceneData.elevationAirports,
                verticalScale: verticalScale,
                radiusNm: trafficRadiusNm,
                limit: trafficLimit,
                historyMinutes: trafficDisplayOptions.historyMinutes,
                hideGroundTargets: trafficDisplayOptions.hideGroundTargets,
                showDepartedTrafficTrails: trafficDisplayOptions.showDepartedTrafficTrails,
                applyEarthCurvatureCompensation: false
            )
        }

        /// The weather poll loop runs while volume or echo tops are enabled
        /// (web `enabled = mrms || echotops`); the slice rides along on the
        /// volume fetch.
        var isWeatherPollingActive: Bool {
            layerState.mrms || layerState.echotops
        }

        func makeMrmsContext() -> MrmsPollingContext? {
            guard isWeatherPollingActive, let sceneData else { return nil }
            return MrmsPollingContext(
                refLat: sceneData.airport.lat,
                refLon: sceneData.airport.lon,
                fetchMinDbz: 5,
                maxRangeNm: 120,
                includeVolume: layerState.mrms || layerState.slice,
                includeEchoTops: layerState.echotops,
                includeCrossSection: layerState.slice,
                minDbzTenths: Int16((weatherDisplayOptions.minDbz * 10).rounded()),
                phaseMode: weatherDisplayOptions.phaseMode.rustCode,
                declutterMode: weatherDisplayOptions.declutterMode.rustCode,
                crossSectionHeadingDeg: weatherDisplayOptions.crossSectionHeadingDeg,
                crossSectionRangeNm: weatherDisplayOptions.crossSectionRangeNm,
                applyEarthCurvatureCompensation: false
            )
        }

        mutating func applyLoadedScene(_ loadedScene: NativeSceneData?, selectedAirportID: String) {
            sceneData = loadedScene
            approaches = loadedScene?.approaches ?? []
            self.selectedAirportID = selectedAirportID
            self.selectedApproachID = loadedScene?.selectedApproachID
            errorMessage = nil
        }
    }

    enum Action {
        case task
        case setAirportFilter(String)
        case setActivePanel(DetailControlPanel?)
        case initialAirportsResponse(TaskResult<[AirportOption]>)
        case sceneLoadResponse(
            airportID: String,
            requestedApproachID: String?,
            TaskResult<NativeSceneData?>
        )
        case airportSelected(String)
        case approachSelected(String)
        case selectRelativeApproach(Int)
        case togglePanel(DetailControlPanel)
        case setLayerEnabled(LayerKind, Bool)
        case setVerticalScale(Double)
        case setHideGroundTraffic(Bool)
        case setShowTrafficCallsigns(Bool)
        case setHideGroundTrafficCallsigns(Bool)
        case setShowDepartedTrafficTrails(Bool)
        case setTrafficHistoryMinutes(Double)
        case trafficPollRequested(Int, TrafficPollingContext)
        case trafficPollCompleted(Int, NativeTrafficScene, String?)
        case trafficRecomputeCompleted(Int, NativeTrafficScene)
        case mrmsPollRequested(Int, MrmsPollingContext)
        case mrmsPollCompleted(Int, NativeWeatherPollResult)
        case weatherReprepareCompleted(Int, NativeMrmsScene?)
        case weatherReprepareFailed(Int, String)
        case setWeatherMinDbz(Double)
        case setWeatherOpacity(Double)
        case setWeatherPhaseMode(NativeWeatherPhaseMode)
        case setWeatherDeclutterMode(NativeWeatherDeclutterMode)
        case setWeatherSliceHeading(Double)
        case setWeatherSliceRange(Double)
    }

    enum LayerKind: Equatable {
        case approach
        case holdAreas
        case airspace
        case adsb
        case mrms
        case echotops
        case slice
        case guides
    }

    @Dependency(\.sceneClient) var sceneClient
    @Dependency(\.trafficClient) var trafficClient
    @Dependency(\.mrmsClient) var mrmsClient

    private enum CancelID {
        case initialLoad
        case trafficPollingLoop
        case trafficPollRequest
        case trafficRecompute
        case mrmsPollingLoop
        case mrmsReprepare
    }

    // Web MRMS poll cadence (`POLL_INTERVAL_MS` / `RETRY_INTERVAL_MS`).
    private static let mrmsPollInterval: Duration = .seconds(120)
    private static let mrmsRetryInterval: Duration = .seconds(10)

    private let preferredSelections: [(airportID: String, approachID: String)] = [
        ("KTEB", "H06-Z"),
        ("KSBS", "R32-Z"),
        ("KJFK", "I22L"),
        ("KCDW", "L22"),
    ]

    var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case let .setAirportFilter(filter):
                state.airportFilter = filter
                return .none

            case let .setActivePanel(panel):
                state.activePanel = panel
                return .none

            case .task:
                guard !state.hasLoadedInitialData else {
                    return .none
                }
                state.hasLoadedInitialData = true
                return .run { send in
                    await send(.initialAirportsResponse(
                        TaskResult {
                            try await sceneClient.listAirports()
                        }
                    ))
                }
                .cancellable(id: CancelID.initialLoad, cancelInFlight: true)

            case let .initialAirportsResponse(.success(airports)):
                state.airports = airports
                guard let selected = preferredSelection(from: airports) ?? airports.first.map({ ($0.id, nil as String?) }) else {
                    return .none
                }
                state.selectedAirportID = selected.0
                return loadSceneEffect(airportID: selected.0, requestedApproachID: selected.1)

            case let .initialAirportsResponse(.failure(error)):
                state.errorMessage = error.localizedDescription
                return .none

            case let .sceneLoadResponse(airportID, _, .success(loadedScene)):
                state.applyLoadedScene(loadedScene, selectedAirportID: airportID)
                return .merge(
                    restartTrafficEffects(state: &state),
                    restartMrmsEffects(state: &state)
                )

            case let .sceneLoadResponse(_, _, .failure(error)):
                state.errorMessage = error.localizedDescription
                state.sceneData = nil
                state.approaches = []
                state.selectedApproachID = nil
                return .merge(
                    stopTrafficEffects(state: &state),
                    stopMrmsEffects(state: &state)
                )

            case let .airportSelected(airportID):
                state.selectedAirportID = airportID
                return loadSceneEffect(airportID: airportID, requestedApproachID: nil)

            case let .approachSelected(approachID):
                guard let selectedAirportID = state.selectedAirportID else {
                    return .none
                }
                state.activePanel = nil
                return loadSceneEffect(airportID: selectedAirportID, requestedApproachID: approachID)

            case let .selectRelativeApproach(offset):
                guard let selectedAirportID = state.selectedAirportID,
                      let currentIndex = state.currentApproachIndex
                else {
                    return .none
                }
                let nextIndex = min(
                    max(0, currentIndex + offset),
                    state.approaches.index(before: state.approaches.endIndex)
                )
                guard nextIndex != currentIndex else {
                    return .none
                }
                state.activePanel = nil
                return loadSceneEffect(
                    airportID: selectedAirportID,
                    requestedApproachID: state.approaches[nextIndex].procedureID
                )

            case let .togglePanel(panel):
                state.activePanel = state.activePanel == panel ? nil : panel
                return .none

            case let .setLayerEnabled(layer, isEnabled):
                switch layer {
                case .approach:
                    guard state.layerState.approach != isEnabled else { return .none }
                    state.layerState.approach = isEnabled
                    return .none
                case .holdAreas:
                    guard state.layerState.holdAreas != isEnabled else { return .none }
                    state.layerState.holdAreas = isEnabled
                    return .none
                case .airspace:
                    guard state.layerState.airspace != isEnabled else { return .none }
                    state.layerState.airspace = isEnabled
                    return .none
                case .adsb:
                    guard state.layerState.adsb != isEnabled else { return .none }
                    state.layerState.adsb = isEnabled
                    return isEnabled ? restartTrafficEffects(state: &state) : stopTrafficEffects(state: &state)
                case .mrms:
                    guard state.layerState.mrms != isEnabled else { return .none }
                    let wasActive = state.isWeatherPollingActive
                    state.layerState.mrms = isEnabled
                    return weatherLayersChangedEffect(state: &state, wasActive: wasActive)
                case .echotops:
                    guard state.layerState.echotops != isEnabled else { return .none }
                    let wasActive = state.isWeatherPollingActive
                    state.layerState.echotops = isEnabled
                    return weatherLayersChangedEffect(state: &state, wasActive: wasActive)
                case .slice:
                    guard state.layerState.slice != isEnabled else { return .none }
                    state.layerState.slice = isEnabled
                    // The slice rides on the volume fetch; if the poll loop is
                    // already active, poll immediately with the new fetch set.
                    return state.isWeatherPollingActive ? weatherPollNow(state: &state) : .none
                case .guides:
                    guard state.layerState.guides != isEnabled else { return .none }
                    state.layerState.guides = isEnabled
                    return .none
                }

            case let .setVerticalScale(newValue):
                guard state.verticalScale != newValue else {
                    return .none
                }
                state.verticalScale = newValue
                return scheduleTrafficRecompute(state: &state)

            case let .setHideGroundTraffic(enabled):
                guard state.trafficDisplayOptions.hideGroundTargets != enabled else {
                    return .none
                }
                state.trafficDisplayOptions.hideGroundTargets = enabled
                return restartTrafficEffects(state: &state)

            case let .setShowTrafficCallsigns(enabled):
                guard state.trafficDisplayOptions.showCallsignLabels != enabled else {
                    return .none
                }
                state.trafficDisplayOptions.showCallsignLabels = enabled
                return .none

            case let .setHideGroundTrafficCallsigns(enabled):
                guard state.trafficDisplayOptions.hideGroundCallsignLabels != enabled else {
                    return .none
                }
                state.trafficDisplayOptions.hideGroundCallsignLabels = enabled
                return .none

            case let .setShowDepartedTrafficTrails(enabled):
                guard state.trafficDisplayOptions.showDepartedTrafficTrails != enabled else {
                    return .none
                }
                state.trafficDisplayOptions.showDepartedTrafficTrails = enabled
                return restartTrafficEffects(state: &state)

            case let .setTrafficHistoryMinutes(minutes):
                let normalized = min(30, max(1, round(minutes)))
                guard state.trafficDisplayOptions.historyMinutes != normalized else {
                    return .none
                }
                state.trafficDisplayOptions.historyMinutes = normalized
                return restartTrafficEffects(state: &state)

            case let .trafficPollRequested(generation, context):
                guard generation == state.trafficGeneration, state.layerState.adsb else {
                    return .none
                }
                let sessionID = state.trafficSessionID
                return .run { send in
                    do {
                        let scene = try await trafficClient.poll(sessionID, context)
                        await send(.trafficPollCompleted(generation, scene, nil))
                    } catch {
                        let prunedScene = await trafficClient.pruneAfterError(sessionID, context)
                        await send(.trafficPollCompleted(generation, prunedScene, error.localizedDescription))
                    }
                }
                .cancellable(id: CancelID.trafficPollRequest, cancelInFlight: true)

            case let .trafficPollCompleted(generation, scene, errorMessage):
                guard generation == state.trafficGeneration else {
                    return .none
                }
                state.trafficScene = scene
                state.trafficErrorMessage = errorMessage
                return .none

            case let .trafficRecomputeCompleted(generation, scene):
                guard generation == state.trafficGeneration else {
                    return .none
                }
                state.trafficScene = scene
                return .none

            case let .mrmsPollRequested(generation, context):
                guard generation == state.mrmsGeneration, state.isWeatherPollingActive else {
                    return .none
                }
                return .run { send in
                    let result = await mrmsClient.poll(context)
                    await send(.mrmsPollCompleted(generation, result))
                }
                .cancellable(id: CancelID.mrmsPollingLoop, cancelInFlight: true)

            case let .mrmsPollCompleted(generation, result):
                guard generation == state.mrmsGeneration, state.isWeatherPollingActive else {
                    return .none
                }
                // Apply fresh payloads; keep the last good data when a payload
                // fails (web parity); clear payloads that are no longer
                // requested by the current layer set.
                if let scene = result.mrmsScene {
                    state.mrmsScene = scene
                } else if result.volumeError == nil {
                    state.mrmsScene = nil
                }
                if let echoTopScene = result.echoTopScene {
                    state.echoTopScene = echoTopScene
                } else if result.echoTopsError == nil {
                    state.echoTopScene = nil
                }
                state.mrmsErrorMessage = result.firstError
                guard let context = state.makeMrmsContext() else {
                    return .none
                }
                let delay = result.firstError == nil ? Self.mrmsPollInterval : Self.mrmsRetryInterval
                return .run { send in
                    try await Task.sleep(for: delay)
                    await send(.mrmsPollRequested(generation, context))
                }
                .cancellable(id: CancelID.mrmsPollingLoop, cancelInFlight: true)

            case let .weatherReprepareCompleted(generation, scene):
                guard generation == state.mrmsGeneration, state.isWeatherPollingActive else {
                    return .none
                }
                if let scene {
                    state.mrmsScene = scene
                    return .none
                }
                // No cached payload for the current airport — fall back to a
                // full poll so the new prepare options still take effect.
                return weatherPollNow(state: &state)

            case let .weatherReprepareFailed(generation, message):
                guard generation == state.mrmsGeneration, state.isWeatherPollingActive else {
                    return .none
                }
                // Surface the prepare failure (e.g. a corrupt cached payload)
                // instead of silently refetching; the immediate poll either
                // recovers with fresh data or reports its own error.
                state.mrmsErrorMessage = message
                return weatherPollNow(state: &state)

            case let .setWeatherMinDbz(value):
                let normalized = min(60, max(5, value.rounded()))
                guard state.weatherDisplayOptions.minDbz != normalized else { return .none }
                state.weatherDisplayOptions.minDbz = normalized
                return scheduleWeatherReprepare(state: &state)

            case let .setWeatherOpacity(value):
                let normalized = min(1, max(0.05, value))
                guard state.weatherDisplayOptions.opacity != normalized else { return .none }
                // Opacity only shapes the render passes; no Rust re-prepare.
                state.weatherDisplayOptions.opacity = normalized
                return .none

            case let .setWeatherPhaseMode(mode):
                guard state.weatherDisplayOptions.phaseMode != mode else { return .none }
                state.weatherDisplayOptions.phaseMode = mode
                return scheduleWeatherReprepare(state: &state)

            case let .setWeatherDeclutterMode(mode):
                guard state.weatherDisplayOptions.declutterMode != mode else { return .none }
                state.weatherDisplayOptions.declutterMode = mode
                return scheduleWeatherReprepare(state: &state)

            case let .setWeatherSliceHeading(value):
                let wrapped = value.rounded().truncatingRemainder(dividingBy: 360)
                let normalized = wrapped < 0 ? wrapped + 360 : wrapped
                guard state.weatherDisplayOptions.crossSectionHeadingDeg != normalized else {
                    return .none
                }
                state.weatherDisplayOptions.crossSectionHeadingDeg = normalized
                return state.layerState.slice ? scheduleWeatherReprepare(state: &state) : .none

            case let .setWeatherSliceRange(value):
                let normalized = min(140, max(30, value.rounded()))
                guard state.weatherDisplayOptions.crossSectionRangeNm != normalized else {
                    return .none
                }
                state.weatherDisplayOptions.crossSectionRangeNm = normalized
                return state.layerState.slice ? scheduleWeatherReprepare(state: &state) : .none
            }
        }
    }

    private func preferredSelection(from airports: [AirportOption]) -> (String, String?)? {
        preferredSelections.first(where: { selection in
            airports.contains(where: { $0.id == selection.airportID })
        }).map { ($0.airportID, $0.approachID) }
    }

    private func loadSceneEffect(airportID: String, requestedApproachID: String?) -> Effect<Action> {
        .run { send in
            await send(.sceneLoadResponse(
                airportID: airportID,
                requestedApproachID: requestedApproachID,
                TaskResult {
                    try await sceneClient.loadSceneData(airportID, requestedApproachID)
                }
            ))
        }
    }

    private func restartTrafficEffects(state: inout State) -> Effect<Action> {
        state.trafficGeneration += 1
        state.trafficScene = .empty
        state.trafficErrorMessage = nil

        let sessionID = state.trafficSessionID
        let generation = state.trafficGeneration
        guard let context = state.makeTrafficContext() else {
            return .merge(
                .cancel(id: CancelID.trafficPollingLoop),
                .cancel(id: CancelID.trafficPollRequest),
                .cancel(id: CancelID.trafficRecompute),
                .run { _ in await trafficClient.resetSession(sessionID) }
            )
        }

        return .merge(
            .cancel(id: CancelID.trafficPollingLoop),
            .cancel(id: CancelID.trafficPollRequest),
            .cancel(id: CancelID.trafficRecompute),
            .run { _ in await trafficClient.resetSession(sessionID) },
            trafficPollingLoopEffect(generation: generation, context: context)
        )
    }

    private func stopTrafficEffects(state: inout State) -> Effect<Action> {
        state.trafficGeneration += 1
        state.trafficScene = .empty
        state.trafficErrorMessage = nil

        let sessionID = state.trafficSessionID
        return .merge(
            .cancel(id: CancelID.trafficPollingLoop),
            .cancel(id: CancelID.trafficPollRequest),
            .cancel(id: CancelID.trafficRecompute),
            .run { _ in await trafficClient.resetSession(sessionID) }
        )
    }

    private func scheduleTrafficRecompute(state: inout State) -> Effect<Action> {
        guard let context = state.makeTrafficContext() else {
            return .none
        }
        let generation = state.trafficGeneration
        let sessionID = state.trafficSessionID
        return .run { send in
            try await Task.sleep(for: .milliseconds(100))
            let scene = await trafficClient.recompute(sessionID, context)
            await send(.trafficRecomputeCompleted(generation, scene))
        }
        .cancellable(id: CancelID.trafficRecompute, cancelInFlight: true)
    }

    private func restartMrmsEffects(state: inout State) -> Effect<Action> {
        state.mrmsGeneration += 1
        state.mrmsScene = nil
        state.echoTopScene = nil
        state.mrmsErrorMessage = nil

        guard let context = state.makeMrmsContext() else {
            return .merge(
                .cancel(id: CancelID.mrmsPollingLoop),
                .cancel(id: CancelID.mrmsReprepare)
            )
        }

        let generation = state.mrmsGeneration
        return .merge(
            .cancel(id: CancelID.mrmsPollingLoop),
            .cancel(id: CancelID.mrmsReprepare),
            .send(.mrmsPollRequested(generation, context))
        )
    }

    private func stopMrmsEffects(state: inout State) -> Effect<Action> {
        state.mrmsGeneration += 1
        state.mrmsScene = nil
        state.echoTopScene = nil
        state.mrmsErrorMessage = nil
        return .merge(
            .cancel(id: CancelID.mrmsPollingLoop),
            .cancel(id: CancelID.mrmsReprepare)
        )
    }

    /// A volume/echo-tops toggle changed. Stop when the poll gate turned off,
    /// start fresh when it turned on, and otherwise poll immediately so the
    /// new fetch set takes effect without waiting out the 120 s interval.
    private func weatherLayersChangedEffect(state: inout State, wasActive: Bool) -> Effect<Action> {
        let isActive = state.isWeatherPollingActive
        if !isActive {
            return stopMrmsEffects(state: &state)
        }
        if !wasActive {
            return restartMrmsEffects(state: &state)
        }
        return weatherPollNow(state: &state)
    }

    private func weatherPollNow(state: inout State) -> Effect<Action> {
        guard let context = state.makeMrmsContext() else {
            return .none
        }
        // The poll request's run effect replaces any pending re-poll sleep via
        // its shared cancellation ID.
        return .send(.mrmsPollRequested(state.mrmsGeneration, context))
    }

    /// Debounced re-run of the Rust prepare pass over the cached volume binary
    /// when prepare-only options change (threshold, phase, declutter, slice
    /// geometry) — the web worker's re-prepare path, no network fetch.
    private func scheduleWeatherReprepare(state: inout State) -> Effect<Action> {
        guard let context = state.makeMrmsContext(), context.includeVolume else {
            return .none
        }
        let generation = state.mrmsGeneration
        return .run { send in
            try await Task.sleep(for: .milliseconds(150))
            do {
                // nil means "no cached payload" (poll fallback); a thrown
                // error is a real prepare failure and must surface loudly.
                let scene = try await mrmsClient.reprepare(context)
                await send(.weatherReprepareCompleted(generation, scene))
            } catch is CancellationError {
                // Debounce replacement — not a failure.
            } catch {
                await send(.weatherReprepareFailed(generation, error.localizedDescription))
            }
        }
        .cancellable(id: CancelID.mrmsReprepare, cancelInFlight: true)
    }

    private func trafficPollingLoopEffect(generation: Int, context: TrafficPollingContext) -> Effect<Action> {
        .run { send in
            await send(.trafficPollRequested(generation, context))
            for await _ in AsyncTimerSequence(interval: .seconds(5), clock: .continuous) {
                await send(.trafficPollRequested(generation, context))
            }
        }
        .cancellable(id: CancelID.trafficPollingLoop, cancelInFlight: true)
    }
}

struct SceneClient: Sendable {
    var listAirports: @Sendable () async throws -> [AirportOption]
    var loadSceneData: @Sendable (_ airportID: String, _ requestedApproachID: String?) async throws -> NativeSceneData?
}

private enum SceneClientKey: DependencyKey {
    static let liveValue = SceneClient(
        listAirports: {
            try SceneRepository().listAirports()
        },
        loadSceneData: { airportID, requestedApproachID in
            try SceneRepository()
                .loadSceneData(airportID: airportID, requestedApproachID: requestedApproachID)
        }
    )

    static let testValue = SceneClient(
        listAirports: { [] },
        loadSceneData: { _, _ in nil }
    )
}

extension DependencyValues {
    var sceneClient: SceneClient {
        get { self[SceneClientKey.self] }
        set { self[SceneClientKey.self] = newValue }
    }
}

struct TrafficClient: Sendable {
    var resetSession: @Sendable (UUID) async -> Void
    var poll: @Sendable (UUID, TrafficPollingContext) async throws -> NativeTrafficScene
    var recompute: @Sendable (UUID, TrafficPollingContext) async -> NativeTrafficScene
    var pruneAfterError: @Sendable (UUID, TrafficPollingContext) async -> NativeTrafficScene
}

private actor TrafficSessionPool {
    private var services: [UUID: TrafficService] = [:]

    func resetSession(_ sessionID: UUID) {
        services[sessionID] = TrafficService()
    }

    func poll(_ sessionID: UUID, context: TrafficPollingContext) async throws -> NativeTrafficScene {
        let service = service(for: sessionID)
        return try await service.poll(context: context)
    }

    func recompute(_ sessionID: UUID, context: TrafficPollingContext) async -> NativeTrafficScene {
        let service = service(for: sessionID)
        return await service.recompute(context: context)
    }

    func pruneAfterError(_ sessionID: UUID, context: TrafficPollingContext) async -> NativeTrafficScene {
        let service = service(for: sessionID)
        return await service.pruneAfterError(context: context)
    }

    private func service(for sessionID: UUID) -> TrafficService {
        if let service = services[sessionID] {
            return service
        }
        let service = TrafficService()
        services[sessionID] = service
        return service
    }
}

private enum TrafficClientKey: DependencyKey {
    static let liveValue: TrafficClient = {
        let pool = TrafficSessionPool()
        return TrafficClient(
            resetSession: { sessionID in
                await pool.resetSession(sessionID)
            },
            poll: { sessionID, context in
                try await pool.poll(sessionID, context: context)
            },
            recompute: { sessionID, context in
                await pool.recompute(sessionID, context: context)
            },
            pruneAfterError: { sessionID, context in
                await pool.pruneAfterError(sessionID, context: context)
            }
        )
    }()

    static let testValue = TrafficClient(
        resetSession: { _ in },
        poll: { _, _ in .empty },
        recompute: { _, _ in .empty },
        pruneAfterError: { _, _ in .empty }
    )
}

extension DependencyValues {
    var trafficClient: TrafficClient {
        get { self[TrafficClientKey.self] }
        set { self[TrafficClientKey.self] = newValue }
    }
}

struct MrmsClient: Sendable {
    var poll: @Sendable (MrmsPollingContext) async -> NativeWeatherPollResult
    var reprepare: @Sendable (MrmsPollingContext) async throws -> NativeMrmsScene?
}

private enum MrmsClientKey: DependencyKey {
    static let liveValue: MrmsClient = {
        let service = MrmsService()
        return MrmsClient(
            poll: { context in
                await service.poll(context: context)
            },
            reprepare: { context in
                try await service.reprepare(context: context)
            }
        )
    }()

    static let testValue = MrmsClient(
        poll: { _ in
            NativeWeatherPollResult(
                mrmsScene: nil,
                echoTopScene: nil,
                volumeError: nil,
                echoTopsError: nil
            )
        },
        reprepare: { _ in nil }
    )
}

extension DependencyValues {
    var mrmsClient: MrmsClient {
        get { self[MrmsClientKey.self] }
        set { self[MrmsClientKey.self] = newValue }
    }
}
