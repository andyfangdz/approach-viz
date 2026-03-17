import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    private let preferredSelections: [(airportID: String, approachID: String)] = [
        ("KSBS", "R32-Z"),
        ("KJFK", "I22L"),
        ("KCDW", "L22"),
        ("KTEB", "H06-Z"),
    ]

    var airportFilter = ""
    var airports: [AirportOption] = []
    var approaches: [ApproachOption] = []
    var selectedAirportID: String?
    var selectedApproachID: String?
    var sceneData: NativeSceneData?
    var verticalScale = 3.0
    var errorMessage: String?

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
                self.sceneData = loadedScene
                self.approaches = loadedScene?.approaches ?? []
                self.selectedApproachID = loadedScene?.selectedApproachID
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
            self.sceneData = loadedScene
            self.approaches = loadedScene?.approaches ?? []
            self.selectedAirportID = id
            self.selectedApproachID = loadedScene?.selectedApproachID
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    func selectApproach(id: String) async {
        guard let selectedAirportID else { return }
        do {
            errorMessage = nil
            let loadedScene = try repository.loadSceneData(airportID: selectedAirportID, requestedApproachID: id)
            self.sceneData = loadedScene
            self.approaches = loadedScene?.approaches ?? []
            self.selectedApproachID = loadedScene?.selectedApproachID
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }
}
