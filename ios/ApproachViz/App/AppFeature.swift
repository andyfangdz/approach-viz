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
        var activePanel: DetailControlPanel?
        var hasLoadedInitialData = false
        var trafficGeneration = 0
        var trafficSessionID = UUID()

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
    }

    enum LayerKind: Equatable {
        case approach
        case airspace
        case adsb
    }

    @Dependency(\.sceneClient) var sceneClient
    @Dependency(\.trafficClient) var trafficClient

    private enum CancelID {
        case initialLoad
        case trafficPollingLoop
        case trafficPollRequest
        case trafficRecompute
    }

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
                return restartTrafficEffects(state: &state)

            case let .sceneLoadResponse(_, _, .failure(error)):
                state.errorMessage = error.localizedDescription
                state.sceneData = nil
                state.approaches = []
                state.selectedApproachID = nil
                return stopTrafficEffects(state: &state)

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
                case .airspace:
                    guard state.layerState.airspace != isEnabled else { return .none }
                    state.layerState.airspace = isEnabled
                    return .none
                case .adsb:
                    guard state.layerState.adsb != isEnabled else { return .none }
                    state.layerState.adsb = isEnabled
                    return isEnabled ? restartTrafficEffects(state: &state) : stopTrafficEffects(state: &state)
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
            try SceneRepository().loadSceneData(airportID: airportID, requestedApproachID: requestedApproachID)
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
