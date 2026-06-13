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

    private static func makeTestScene() -> NativeSceneData {
        NativeSceneData(
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
    }

    private static func makeTestMrmsScene() -> NativeMrmsScene {
        NativeMrmsScene(
            voxelCount: 1,
            sourceVoxelCount: 2,
            validVoxelCount: 1,
            generatedAtMs: 1_000,
            scanTimeMs: 2_000,
            centerXNm: [1],
            centerYNm: [0.5],
            centerZNm: [-2],
            sizeXNm: [0.5],
            sizeYNm: [0.3],
            sizeZNm: [0.6],
            dbz: [35],
            phaseCode: [0]
        )
    }

    func testTaskLoadsPreferredAirportAndScene() async {
        let airports = [
            AirportOption(id: "KJFK", label: "KJFK - JOHN F KENNEDY INTL"),
            AirportOption(id: "KTEB", label: "KTEB - TETERBORO"),
        ]
        let scene = Self.makeTestScene()

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
            $0.mrmsGeneration = 1
        }
    }

    func testMrmsLayerToggleStartsAndStopsPolling() async {
        let mrmsScene = Self.makeTestMrmsScene()

        var initialState = AppFeature.State()
        initialState.layerState.adsb = false
        initialState.sceneData = Self.makeTestScene()

        let store = TestStore(initialState: initialState) {
            AppFeature()
        } withDependencies: {
            $0.mrmsClient.poll = { context in
                XCTAssertEqual(context.refLat, 40.8501, accuracy: 1e-9)
                XCTAssertEqual(context.refLon, -74.0608, accuracy: 1e-9)
                XCTAssertEqual(context.maxRangeNm, 120)
                XCTAssertEqual(context.minDbzTenths, 50)
                XCTAssertEqual(context.phaseMode, 1)
                XCTAssertTrue(context.includeVolume)
                XCTAssertFalse(context.includeEchoTops)
                XCTAssertFalse(context.includeCrossSection)
                return NativeWeatherPollResult(
                    mrmsScene: mrmsScene,
                    echoTopScene: nil,
                    volumeError: nil,
                    echoTopsError: nil
                )
            }
        }

        await store.send(.setLayerEnabled(.mrms, true)) {
            $0.layerState.mrms = true
            $0.mrmsGeneration = 1
        }

        await store.receive(\.mrmsPollRequested)
        await store.receive(\.mrmsPollCompleted) {
            $0.mrmsScene = mrmsScene
        }

        // Toggling off cancels the pending re-poll delay and clears the volume.
        await store.send(.setLayerEnabled(.mrms, false)) {
            $0.layerState.mrms = false
            $0.mrmsGeneration = 2
            $0.mrmsScene = nil
        }
    }

    func testMrmsPollFailureKeepsLastVolumeAndRecordsError() async {
        let mrmsScene = Self.makeTestMrmsScene()

        var initialState = AppFeature.State()
        initialState.layerState.adsb = false
        initialState.layerState.mrms = true
        initialState.sceneData = Self.makeTestScene()
        initialState.mrmsScene = mrmsScene
        initialState.mrmsGeneration = 1

        let store = TestStore(initialState: initialState) {
            AppFeature()
        } withDependencies: {
            $0.mrmsClient.poll = { _ in
                NativeWeatherPollResult(
                    mrmsScene: nil,
                    echoTopScene: nil,
                    volumeError: "volume fetch failed",
                    echoTopsError: nil
                )
            }
        }

        guard let context = store.state.makeMrmsContext() else {
            XCTFail("expected an active weather context")
            return
        }
        await store.send(.mrmsPollRequested(1, context))
        await store.receive(\.mrmsPollCompleted) {
            $0.mrmsErrorMessage = "volume fetch failed"
        }

        // The last good volume stays on screen while the retry is pending.
        XCTAssertNotNil(store.state.mrmsScene)

        await store.send(.setLayerEnabled(.mrms, false)) {
            $0.layerState.mrms = false
            $0.mrmsGeneration = 2
            $0.mrmsScene = nil
            $0.mrmsErrorMessage = nil
        }
    }

    func testEchoTopsToggleJoinsActivePollLoop() async {
        let mrmsScene = Self.makeTestMrmsScene()
        let echoTopScene = NativeEchoTopScene(
            sourceCellCount: 3,
            generatedAtMs: 1_000,
            scanTimeMs: 2_000,
            footprintXNm: 0.5,
            footprintYNm: 0.6,
            maxTop18Feet: 32_000,
            maxTop30Feet: 25_000,
            maxTop50Feet: 0,
            maxTop60Feet: 0,
            top18: .init(xNm: [1], zNm: [2], yNm: [5]),
            top30: .init(xNm: [], zNm: [], yNm: []),
            top50: .init(xNm: [], zNm: [], yNm: [])
        )

        var initialState = AppFeature.State()
        initialState.layerState.adsb = false
        initialState.layerState.mrms = true
        initialState.sceneData = Self.makeTestScene()
        initialState.mrmsGeneration = 1

        let store = TestStore(initialState: initialState) {
            AppFeature()
        } withDependencies: {
            $0.mrmsClient.poll = { context in
                XCTAssertTrue(context.includeEchoTops)
                return NativeWeatherPollResult(
                    mrmsScene: context.includeVolume ? mrmsScene : nil,
                    echoTopScene: echoTopScene,
                    volumeError: nil,
                    echoTopsError: nil
                )
            }
        }

        // The poll gate is already active, so the toggle polls immediately
        // with the widened fetch set instead of restarting the loop.
        await store.send(.setLayerEnabled(.echotops, true)) {
            $0.layerState.echotops = true
        }
        await store.receive(\.mrmsPollRequested)
        await store.receive(\.mrmsPollCompleted) {
            $0.mrmsScene = mrmsScene
            $0.echoTopScene = echoTopScene
        }

        await store.send(.setLayerEnabled(.mrms, false)) {
            $0.layerState.mrms = false
        }
        await store.receive(\.mrmsPollRequested)
        await store.receive(\.mrmsPollCompleted) {
            // Volume is no longer requested, so it clears; echo tops persist.
            $0.mrmsScene = nil
        }

        await store.send(.setLayerEnabled(.echotops, false)) {
            $0.layerState.echotops = false
            $0.mrmsGeneration = 2
            $0.echoTopScene = nil
        }
    }

    func testWeatherThresholdChangeReprepares() async {
        let initialScene = Self.makeTestMrmsScene()
        let repreparedScene = Self.makeTestMrmsScene()

        var initialState = AppFeature.State()
        initialState.layerState.adsb = false
        initialState.layerState.mrms = true
        initialState.sceneData = Self.makeTestScene()
        initialState.mrmsScene = initialScene
        initialState.mrmsGeneration = 1

        let store = TestStore(initialState: initialState) {
            AppFeature()
        } withDependencies: {
            $0.mrmsClient.reprepare = { context in
                XCTAssertEqual(context.minDbzTenths, 200)
                return repreparedScene
            }
        }

        await store.send(.setWeatherMinDbz(20)) {
            $0.weatherDisplayOptions.minDbz = 20
        }
        // The re-prepare effect debounces for 150 ms before hitting the client.
        await store.receive(\.weatherReprepareCompleted, timeout: .seconds(2)) {
            $0.mrmsScene = repreparedScene
        }
    }

    func testWeatherReprepareFailureSurfacesErrorAndPollsFresh() async {
        let initialScene = Self.makeTestMrmsScene()
        let freshScene = Self.makeTestMrmsScene()

        var initialState = AppFeature.State()
        initialState.layerState.adsb = false
        initialState.layerState.mrms = true
        initialState.sceneData = Self.makeTestScene()
        initialState.mrmsScene = initialScene
        initialState.mrmsGeneration = 1

        struct ReprepareError: Error, LocalizedError {
            var errorDescription: String? { "cached payload corrupt" }
        }

        let store = TestStore(initialState: initialState) {
            AppFeature()
        } withDependencies: {
            $0.mrmsClient.reprepare = { _ in throw ReprepareError() }
            $0.mrmsClient.poll = { _ in
                NativeWeatherPollResult(
                    mrmsScene: freshScene,
                    echoTopScene: nil,
                    volumeError: nil,
                    echoTopsError: nil
                )
            }
        }

        await store.send(.setWeatherMinDbz(20)) {
            $0.weatherDisplayOptions.minDbz = 20
        }
        // A real prepare failure surfaces loudly and falls back to a fresh
        // poll, which recovers and clears the error.
        await store.receive(\.weatherReprepareFailed, timeout: .seconds(2)) {
            $0.mrmsErrorMessage = "cached payload corrupt"
        }
        await store.receive(\.mrmsPollRequested)
        await store.receive(\.mrmsPollCompleted) {
            $0.mrmsScene = freshScene
            $0.mrmsErrorMessage = nil
        }

        await store.send(.setLayerEnabled(.mrms, false)) {
            $0.layerState.mrms = false
            $0.mrmsGeneration = 2
            $0.mrmsScene = nil
        }
    }

    func testSliceOptionsNormalizeAndOnlyReprepareWhenSliceEnabled() async {
        var initialState = AppFeature.State()
        initialState.layerState.adsb = false
        initialState.sceneData = Self.makeTestScene()

        let store = TestStore(initialState: initialState) {
            AppFeature()
        }

        // Slice layer off: option updates apply but trigger no effects.
        await store.send(.setWeatherSliceHeading(405)) {
            $0.weatherDisplayOptions.crossSectionHeadingDeg = 45
        }
        await store.send(.setWeatherSliceRange(500)) {
            $0.weatherDisplayOptions.crossSectionRangeNm = 140
        }
        await store.send(.setWeatherOpacity(0.5)) {
            $0.weatherDisplayOptions.opacity = 0.5
        }
    }
}
