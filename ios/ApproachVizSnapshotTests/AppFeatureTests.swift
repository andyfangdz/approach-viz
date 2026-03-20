import ComposableArchitecture
import XCTest

@testable import ApproachViz

@MainActor
final class AppFeatureTests: XCTestCase {
    func testTogglePanelTogglesSamePanelOff() async {
        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        }

        await store.send(.togglePanel(.options)) {
            $0.activePanel = .options
        }
        await store.send(.togglePanel(.options)) {
            $0.activePanel = nil
        }
    }

    func testTaskLoadsPreferredAirportAndScene() async {
        let airports = [
            AirportOption(id: "KJFK", label: "KJFK - JOHN F KENNEDY INTL"),
            AirportOption(id: "KTEB", label: "KTEB - TETERBORO"),
        ]
        let scene = NativeSceneData(
            airport: AirportRecord(
                id: "KTEB",
                name: "TETERBORO",
                lat: 40.8501,
                lon: -74.0608,
                elevation: 9,
                magneticVariation: -13
            ),
            approaches: [
                ApproachOption(procedureID: "H06-Z", type: "HELICOPTER", runway: "06")
            ],
            selectedApproachID: "H06-Z",
            currentApproach: nil,
            runways: [],
            waypoints: [],
            elevationAirports: [],
            airspace: [],
            minimumsSummary: nil,
            missedApproachClimbRequirement: nil,
            cycleInfo: nil
        )

        var initialState = AppFeature.State()
        initialState.layerState.adsb = false

        let store = TestStore(initialState: initialState) {
            AppFeature()
        } withDependencies: {
            $0.sceneClient.listAirports = { airports }
            $0.sceneClient.loadSceneData = { airportID, requestedApproachID in
                XCTAssertEqual(airportID, "KTEB")
                XCTAssertEqual(requestedApproachID, "H06-Z")
                return scene
            }
        }

        await store.send(.task) {
            $0.hasLoadedInitialData = true
        }

        await store.receive(\.initialAirportsResponse.success) {
            $0.airports = airports
            $0.selectedAirportID = "KTEB"
        }

        await store.receive(\.sceneLoadResponse) {
            $0.sceneData = scene
            $0.approaches = scene.approaches
            $0.selectedAirportID = "KTEB"
            $0.selectedApproachID = "H06-Z"
            $0.errorMessage = nil
            $0.trafficGeneration = 1
            $0.trafficScene = .empty
            $0.trafficErrorMessage = nil
        }
    }
}
