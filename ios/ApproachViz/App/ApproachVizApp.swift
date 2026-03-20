import ComposableArchitecture
import SwiftUI

@main
struct ApproachVizApp: App {
    private let store = Store(initialState: AppFeature.State()) {
        AppFeature()
    }

    var body: some Scene {
        WindowGroup {
            RootView(store: store)
                .preferredColorScheme(.dark)
        }
    }
}
