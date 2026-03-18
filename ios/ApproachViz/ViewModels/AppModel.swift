import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    private let trafficPollIntervalNs: UInt64 = 5_000_000_000
    private let trafficRadiusNm = 80
    private let trafficLimit = 250

    private let preferredSelections: [(airportID: String, approachID: String)] = [
        ("KTEB", "H06-Z"),
        ("KSBS", "R32-Z"),
        ("KJFK", "I22L"),
        ("KCDW", "L22"),
    ]

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

    private let repository: SceneRepository
    @ObservationIgnored private var trafficService = TrafficService()
    @ObservationIgnored private var trafficPollTask: Task<Void, Never>?
    @ObservationIgnored private var trafficRecomputeTask: Task<Void, Never>?
    @ObservationIgnored private var trafficSessionToken = UUID()

    init(repository: SceneRepository = SceneRepository()) {
        self.repository = repository
    }

    func loadInitialData() async {
        guard airports.isEmpty else { return }
        do {
            let loadedAirports = try repository.listAirports()
            self.airports = loadedAirports
            if let preferred = preferredSelections.first(where: { selection in
                loadedAirports.contains(where: { $0.id == selection.airportID })
            }) {
                self.selectedAirportID = preferred.airportID
                let loadedScene = try repository.loadSceneData(
                    airportID: preferred.airportID,
                    requestedApproachID: preferred.approachID
                )
                applyLoadedScene(loadedScene, selectedAirportID: preferred.airportID)
            } else if let airportID = loadedAirports.first?.id {
                self.selectedAirportID = airportID
                await selectAirport(id: airportID)
            }
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    func selectAirport(id: String) async {
        do {
            errorMessage = nil
            let loadedScene = try repository.loadSceneData(airportID: id, requestedApproachID: nil)
            applyLoadedScene(loadedScene, selectedAirportID: id)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    func selectApproach(id: String) async {
        guard let selectedAirportID else { return }
        do {
            errorMessage = nil
            let loadedScene = try repository.loadSceneData(airportID: selectedAirportID, requestedApproachID: id)
            applyLoadedScene(loadedScene, selectedAirportID: selectedAirportID)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    func setVerticalScale(_ newValue: Double) {
        guard verticalScale != newValue else { return }
        verticalScale = newValue
        scheduleTrafficRecompute()
    }

    func setLayerEnabled(_ keyPath: WritableKeyPath<NativeLayerState, Bool>, _ enabled: Bool) {
        guard layerState[keyPath: keyPath] != enabled else { return }
        layerState[keyPath: keyPath] = enabled
        if keyPath == \.adsb {
            if enabled {
                restartTrafficPolling()
            } else {
                stopTrafficPolling()
            }
        }
    }

    func setHideGroundTraffic(_ enabled: Bool) {
        guard trafficDisplayOptions.hideGroundTargets != enabled else { return }
        trafficDisplayOptions.hideGroundTargets = enabled
        restartTrafficPolling()
    }

    func setShowTrafficCallsigns(_ enabled: Bool) {
        guard trafficDisplayOptions.showCallsignLabels != enabled else { return }
        trafficDisplayOptions.showCallsignLabels = enabled
    }

    func setHideGroundTrafficCallsigns(_ enabled: Bool) {
        guard trafficDisplayOptions.hideGroundCallsignLabels != enabled else { return }
        trafficDisplayOptions.hideGroundCallsignLabels = enabled
    }

    func setShowDepartedTrafficTrails(_ enabled: Bool) {
        guard trafficDisplayOptions.showDepartedTrafficTrails != enabled else { return }
        trafficDisplayOptions.showDepartedTrafficTrails = enabled
        restartTrafficPolling()
    }

    func setTrafficHistoryMinutes(_ minutes: Double) {
        let normalized = min(30, max(1, round(minutes)))
        guard trafficDisplayOptions.historyMinutes != normalized else { return }
        trafficDisplayOptions.historyMinutes = normalized
        restartTrafficPolling()
    }

    private func applyLoadedScene(_ loadedScene: NativeSceneData?, selectedAirportID: String) {
        sceneData = loadedScene
        approaches = loadedScene?.approaches ?? []
        self.selectedAirportID = selectedAirportID
        self.selectedApproachID = loadedScene?.selectedApproachID
        errorMessage = nil
        restartTrafficPolling()
    }

    private func restartTrafficPolling() {
        trafficPollTask?.cancel()
        trafficRecomputeTask?.cancel()
        trafficService = TrafficService()
        trafficSessionToken = UUID()
        trafficScene = .empty
        trafficErrorMessage = nil

        let token = trafficSessionToken
        trafficPollTask = Task { [weak self] in
            guard let self else { return }
            await self.runTrafficPollingLoop(token: token)
        }
    }

    private func stopTrafficPolling() {
        trafficPollTask?.cancel()
        trafficRecomputeTask?.cancel()
        trafficSessionToken = UUID()
        trafficScene = .empty
        trafficErrorMessage = nil
    }

    private func runTrafficPollingLoop(token: UUID) async {
        while !Task.isCancelled {
            guard let context = makeTrafficContext(token: token) else { return }
            do {
                let trafficScene = try await trafficService.poll(context: context)
                guard token == trafficSessionToken, !Task.isCancelled else { return }
                self.trafficScene = trafficScene
                self.trafficErrorMessage = nil
            } catch {
                let prunedTrafficScene = await trafficService.pruneAfterError(context: context)
                guard token == trafficSessionToken, !Task.isCancelled else { return }
                self.trafficScene = prunedTrafficScene
                self.trafficErrorMessage = error.localizedDescription
            }

            do {
                try await Task.sleep(nanoseconds: trafficPollIntervalNs)
            } catch {
                return
            }
        }
    }

    private func scheduleTrafficRecompute() {
        guard layerState.adsb else { return }
        trafficRecomputeTask?.cancel()
        let token = trafficSessionToken
        trafficRecomputeTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: .milliseconds(100))
            } catch {
                return
            }
            guard let context = self.makeTrafficContext(token: token) else { return }
            let recomputedTrafficScene = await self.trafficService.recompute(context: context)
            guard token == self.trafficSessionToken, !Task.isCancelled else { return }
            self.trafficScene = recomputedTrafficScene
        }
    }

    private func makeTrafficContext(token: UUID) -> TrafficPollingContext? {
        guard token == trafficSessionToken, layerState.adsb, let sceneData else { return nil }
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
}
