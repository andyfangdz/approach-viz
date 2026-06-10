import ComposableArchitecture
import SwiftUI

struct NativeLayersPanel: View {
    let store: StoreOf<AppFeature>
    let onClose: () -> Void

    var body: some View {
        NativePanelContainer(title: "Layers", onClose: onClose) {
            VStack(alignment: .leading, spacing: 10) {
                LayerToggleRow(
                    title: "Approach",
                    isOn: Binding(
                        get: { store.layerState.approach },
                        set: { store.send(.setLayerEnabled(.approach, $0)) }
                    )
                )
                LayerToggleRow(
                    title: "Airspace",
                    isOn: Binding(
                        get: { store.layerState.airspace },
                        set: { store.send(.setLayerEnabled(.airspace, $0)) }
                    )
                )
                LayerToggleRow(
                    title: "ADS-B Traffic",
                    isOn: Binding(
                        get: { store.layerState.adsb },
                        set: { store.send(.setLayerEnabled(.adsb, $0)) }
                    )
                )
            }
        }
    }
}
