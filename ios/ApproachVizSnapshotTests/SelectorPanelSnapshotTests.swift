import ComposableArchitecture
import SnapshotTesting
import SwiftUI
import XCTest

@testable import ApproachViz

@MainActor
final class SelectorPanelSnapshotTests: XCTestCase {
    override func invokeTest() {
        withSnapshotTesting(
            record: ProcessInfo.processInfo.environment["RECORD_SNAPSHOTS"] == "1" ? .all : .never
        ) {
            super.invokeTest()
        }
    }

    func testSelectorPanel() {
        var state = AppFeature.State()
        state.airports = [
            AirportOption(id: "KTEB", label: "KTEB - TETERBORO"),
            AirportOption(id: "KJFK", label: "KJFK - JOHN F KENNEDY INTL"),
            AirportOption(id: "KLGA", label: "KLGA - LA GUARDIA"),
        ]
        state.approaches = [
            ApproachOption(procedureID: "H06-Z", type: "HELICOPTER", runway: "06"),
            ApproachOption(procedureID: "ILS06", type: "ILS", runway: "06"),
        ]
        state.selectedAirportID = "KTEB"
        state.selectedApproachID = "H06-Z"

        let store = Store(initialState: state) {
            AppFeature()
        }

        let viewController = UIHostingController(
            rootView: NativeSelectorPanel(store: store, onClose: {})
                .frame(width: 390)
                .background(Color.black)
        )

        assertSnapshot(of: viewController, as: .image(on: .iPhone13Pro))
    }
}
