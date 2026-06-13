import ComposableArchitecture
import XCTest

@testable import ApproachViz

@MainActor
final class AppFeatureMacTests: XCTestCase {
    func testSelectRelativeApproachLoadsAdjacentProcedure() async {
        let approaches = [
            ApproachOption(procedureID: "H06-Z", type: "HELICOPTER", runway: "06"),
            ApproachOption(procedureID: "ILS06", type: "ILS", runway: "06"),
            ApproachOption(procedureID: "RNAV24", type: "RNAV", runway: "24"),
        ]

        let nextScene = NativeSceneData(
            airport: AirportRecord(
                id: "KTEB",
                name: "TETERBORO",
                lat: 40.8501,
                lon: -74.0608,
                elevation: 9,
                magneticVariation: -13
            ),
            approaches: approaches,
            selectedApproachID: "ILS06",
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
        initialState.selectedAirportID = "KTEB"
        initialState.selectedApproachID = "H06-Z"
        initialState.approaches = approaches
        initialState.activePanel = .selectors

        let store = TestStore(initialState: initialState) {
            AppFeature()
        } withDependencies: {
            $0.sceneClient.loadSceneData = { airportID, requestedApproachID in
                XCTAssertEqual(airportID, "KTEB")
                XCTAssertEqual(requestedApproachID, "ILS06")
                return nextScene
            }
        }

        await store.send(.selectRelativeApproach(1)) {
            $0.activePanel = nil
        }

        await store.receive(\.sceneLoadResponse) {
            $0.sceneData = nextScene
            $0.approaches = approaches
            $0.selectedAirportID = "KTEB"
            $0.selectedApproachID = "ILS06"
            $0.errorMessage = nil
            $0.trafficGeneration = 1
            $0.trafficScene = .empty
            $0.trafficErrorMessage = nil
            $0.mrmsGeneration = 1
        }
    }

    func testSelectRelativeApproachClampsAtUpperBound() async {
        var initialState = AppFeature.State()
        initialState.layerState.adsb = false
        initialState.selectedAirportID = "KTEB"
        initialState.selectedApproachID = "RNAV24"
        initialState.approaches = [
            ApproachOption(procedureID: "H06-Z", type: "HELICOPTER", runway: "06"),
            ApproachOption(procedureID: "RNAV24", type: "RNAV", runway: "24"),
        ]

        let store = TestStore(initialState: initialState) {
            AppFeature()
        }

        await store.send(.selectRelativeApproach(1))
    }
}
