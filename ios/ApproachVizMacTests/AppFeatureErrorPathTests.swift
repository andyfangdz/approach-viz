import ComposableArchitecture
import XCTest

@testable import ApproachViz

@MainActor
final class AppFeatureErrorPathTests: XCTestCase {
    private struct TestSceneError: LocalizedError {
        var errorDescription: String? { "scene load exploded" }
    }

    func testInitialAirportsFailureSurfacesErrorMessage() async {
        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        }

        await store.send(.initialAirportsResponse(.failure(TestSceneError()))) {
            $0.errorMessage = "scene load exploded"
        }
    }

    func testSceneLoadFailureClearsSceneAndSurfacesError() async {
        var initialState = AppFeature.State()
        initialState.selectedAirportID = "KTEB"
        initialState.approaches = [
            ApproachOption(procedureID: "H06-Z", type: "HELICOPTER", runway: "06")
        ]
        initialState.selectedApproachID = "H06-Z"

        let store = TestStore(initialState: initialState) {
            AppFeature()
        }
        store.exhaustivity = .off

        await store.send(
            .sceneLoadResponse(
                airportID: "KTEB",
                requestedApproachID: nil,
                .failure(TestSceneError())
            )
        ) {
            $0.errorMessage = "scene load exploded"
            $0.sceneData = nil
            $0.approaches = []
            $0.selectedApproachID = nil
        }
    }

    func testSuccessfulSceneLoadClearsPreviousError() async {
        var initialState = AppFeature.State()
        initialState.errorMessage = "previous failure"

        let store = TestStore(initialState: initialState) {
            AppFeature()
        }
        store.exhaustivity = .off

        await store.send(
            .sceneLoadResponse(airportID: "KTEB", requestedApproachID: nil, .success(nil))
        ) {
            $0.errorMessage = nil
            $0.selectedAirportID = "KTEB"
        }
    }
}
