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
                LayerToggleRow(
                    title: "MRMS Volume",
                    isOn: Binding(
                        get: { store.layerState.mrms },
                        set: { store.send(.setLayerEnabled(.mrms, $0)) }
                    )
                )
                LayerToggleRow(
                    title: "Echo Tops",
                    isOn: Binding(
                        get: { store.layerState.echotops },
                        set: { store.send(.setLayerEnabled(.echotops, $0)) }
                    )
                )
                LayerToggleRow(
                    title: "Vertical Slice",
                    isOn: Binding(
                        get: { store.layerState.slice },
                        set: { store.send(.setLayerEnabled(.slice, $0)) }
                    )
                )
                LayerToggleRow(
                    title: "Altitude Guides",
                    isOn: Binding(
                        get: { store.layerState.guides },
                        set: { store.send(.setLayerEnabled(.guides, $0)) }
                    )
                )
            }
        }
    }
}
