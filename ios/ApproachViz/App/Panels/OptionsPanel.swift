import ComposableArchitecture
import SwiftUI

struct NativeOptionsPanel: View {
    let store: StoreOf<AppFeature>
    let onClose: () -> Void

    var body: some View {
        NativePanelContainer(title: "Options", onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                Group {
                    SectionLabel("Scene")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Vertical Scale \(store.verticalScale.formatted(.number.precision(.fractionLength(1))))x")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.86))
                        Slider(
                            value: Binding(
                                get: { store.verticalScale },
                                set: { store.send(.setVerticalScale($0)) }
                            ),
                            in: 1...8,
                            step: 0.5
                        )
                    }
                }

                Group {
                    SectionLabel("ADS-B Traffic")
                    if let trafficErrorMessage = store.trafficErrorMessage, store.layerState.adsb {
                        Text("Traffic unavailable: \(trafficErrorMessage)")
                            .font(.caption)
                            .foregroundStyle(.orange.opacity(0.9))
                    }
                    Text("Traffic \(store.trafficScene.renderedTrackCount) targets")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.72))
                    LayerToggleRow(
                        title: "Hide Ground Traffic",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.hideGroundTargets },
                            set: { store.send(.setHideGroundTraffic($0)) }
                        ),
                        disabled: !store.layerState.adsb
                    )
                    LayerToggleRow(
                        title: "Show Traffic Callsigns",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.showCallsignLabels },
                            set: { store.send(.setShowTrafficCallsigns($0)) }
                        ),
                        disabled: !store.layerState.adsb
                    )
                    LayerToggleRow(
                        title: "Hide Ground Callsign Labels",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.hideGroundCallsignLabels },
                            set: { store.send(.setHideGroundTrafficCallsigns($0)) }
                        ),
                        disabled: !store.layerState.adsb || !store.trafficDisplayOptions.showCallsignLabels
                    )
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Traffic History (\(Int(store.trafficDisplayOptions.historyMinutes.rounded())) min)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(store.layerState.adsb ? .white.opacity(0.86) : .white.opacity(0.35))
                        Slider(
                            value: Binding(
                                get: { store.trafficDisplayOptions.historyMinutes },
                                set: { store.send(.setTrafficHistoryMinutes($0)) }
                            ),
                            in: 1...30,
                            step: 1
                        )
                        .disabled(!store.layerState.adsb)
                    }
                    LayerToggleRow(
                        title: "Show Departed Traffic Trails",
                        isOn: Binding(
                            get: { store.trafficDisplayOptions.showDepartedTrafficTrails },
                            set: { store.send(.setShowDepartedTrafficTrails($0)) }
                        ),
                        disabled: !store.layerState.adsb
                    )
                }
            }
        }
    }
}
