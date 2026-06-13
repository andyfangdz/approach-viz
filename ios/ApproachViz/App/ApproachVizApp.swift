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
        #if os(macOS)
        .commands {
            ApproachVizCommands(store: store)
        }
        #endif
    }
}

#if os(macOS)
private struct ApproachVizCommands: Commands {
    let store: StoreOf<AppFeature>

    var body: some Commands {
        CommandMenu("Panels") {
            Button(store.activePanel == .selectors ? "Hide Selectors" : "Show Selectors") {
                store.send(.togglePanel(.selectors))
            }
            .keyboardShortcut("1", modifiers: .command)

            Button(store.activePanel == .layers ? "Hide Layers" : "Show Layers") {
                store.send(.togglePanel(.layers))
            }
            .keyboardShortcut("2", modifiers: .command)

            Button(store.activePanel == .options ? "Hide Options" : "Show Options") {
                store.send(.togglePanel(.options))
            }
            .keyboardShortcut("3", modifiers: .command)

            Button(store.activePanel == .debug ? "Hide Debug" : "Show Debug") {
                store.send(.togglePanel(.debug))
            }
            .keyboardShortcut("4", modifiers: .command)
        }

        CommandMenu("Scene") {
            Button("Previous Approach") {
                store.send(.selectRelativeApproach(-1))
            }
            .keyboardShortcut("[", modifiers: .command)
            .disabled(!store.canSelectPreviousApproach)

            Button("Next Approach") {
                store.send(.selectRelativeApproach(1))
            }
            .keyboardShortcut("]", modifiers: .command)
            .disabled(!store.canSelectNextApproach)

            Divider()

            Button("Decrease Vertical Scale") {
                store.send(.setVerticalScale(max(1, store.verticalScale - 0.5)))
            }
            .keyboardShortcut("-", modifiers: .command)

            Button("Increase Vertical Scale") {
                store.send(.setVerticalScale(min(8, store.verticalScale + 0.5)))
            }
            .keyboardShortcut("=", modifiers: .command)

            Divider()

            Button(store.layerState.adsb ? "Hide ADS-B Traffic" : "Show ADS-B Traffic") {
                store.send(.setLayerEnabled(.adsb, !store.layerState.adsb))
            }
            .keyboardShortcut("t", modifiers: .command)

            Button(store.layerState.mrms ? "Hide MRMS Weather" : "Show MRMS Weather") {
                store.send(.setLayerEnabled(.mrms, !store.layerState.mrms))
            }
            .keyboardShortcut("w", modifiers: [.command, .shift])
        }
    }
}
#endif
