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

                Group {
                    SectionLabel("MRMS Weather")
                    if let mrmsErrorMessage = store.mrmsErrorMessage, store.isWeatherPollingActive {
                        Text("Weather unavailable: \(mrmsErrorMessage)")
                            .font(.caption)
                            .foregroundStyle(.orange.opacity(0.9))
                    }
                    Text(mrmsStatusText)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.72))

                    weatherModePicker(
                        title: "Phase Detection",
                        selection: Binding(
                            get: { store.weatherDisplayOptions.phaseMode },
                            set: { store.send(.setWeatherPhaseMode($0)) }
                        ),
                        disabled: !store.layerState.mrms
                    )
                    weatherModePicker(
                        title: "Declutter",
                        selection: Binding(
                            get: { store.weatherDisplayOptions.declutterMode },
                            set: { store.send(.setWeatherDeclutterMode($0)) }
                        ),
                        disabled: !store.layerState.mrms
                    )
                    weatherSlider(
                        title: "MRMS Threshold (\(Int(store.weatherDisplayOptions.minDbz)) dBZ)",
                        value: Binding(
                            get: { store.weatherDisplayOptions.minDbz },
                            set: { store.send(.setWeatherMinDbz($0)) }
                        ),
                        range: 5...60,
                        step: 1,
                        disabled: !store.layerState.mrms
                    )
                    weatherSlider(
                        title: "MRMS Opacity (\(Int((store.weatherDisplayOptions.opacity * 100).rounded()))%)",
                        value: Binding(
                            get: { store.weatherDisplayOptions.opacity },
                            set: { store.send(.setWeatherOpacity($0)) }
                        ),
                        range: 0.05...1,
                        step: 0.05,
                        disabled: !store.layerState.mrms && !store.layerState.echotops
                    )
                }

                Group {
                    SectionLabel("Vertical Slice")
                    weatherSlider(
                        title: "Slice Heading (\(Int(store.weatherDisplayOptions.crossSectionHeadingDeg))°)",
                        value: Binding(
                            get: { store.weatherDisplayOptions.crossSectionHeadingDeg },
                            set: { store.send(.setWeatherSliceHeading($0)) }
                        ),
                        range: 0...359,
                        step: 1,
                        disabled: !store.layerState.slice
                    )
                    weatherSlider(
                        title: "Slice Range (\(Int(store.weatherDisplayOptions.crossSectionRangeNm)) NM)",
                        value: Binding(
                            get: { store.weatherDisplayOptions.crossSectionRangeNm },
                            set: { store.send(.setWeatherSliceRange($0)) }
                        ),
                        range: 30...140,
                        step: 1,
                        disabled: !store.layerState.slice
                    )
                }
            }
        }
    }

    private var mrmsStatusText: String {
        guard store.isWeatherPollingActive else {
            return "Weather layers off"
        }
        var parts: [String] = []
        if store.layerState.mrms || store.layerState.slice {
            if let mrmsScene = store.mrmsScene {
                parts.append("\(mrmsScene.voxelCount) of \(mrmsScene.sourceVoxelCount) voxels")
            } else {
                parts.append("waiting for volume…")
            }
        }
        if store.layerState.echotops {
            if let echoTopScene = store.echoTopScene {
                parts.append("\(echoTopScene.sourceCellCount) echo-top cells")
            } else {
                parts.append("waiting for echo tops…")
            }
        }
        return parts.joined(separator: " • ")
    }

    private func weatherModePicker<Mode: CaseIterable & Hashable>(
        title: String,
        selection: Binding<Mode>,
        disabled: Bool
    ) -> some View where Mode.AllCases: RandomAccessCollection, Mode: WeatherModeLabeled {
        HStack {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(disabled ? .white.opacity(0.35) : .white.opacity(0.86))
            Spacer(minLength: 12)
            Picker(title, selection: selection) {
                ForEach(Array(Mode.allCases), id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .disabled(disabled)
        }
    }

    private func weatherSlider(
        title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double,
        disabled: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(disabled ? .white.opacity(0.35) : .white.opacity(0.86))
            Slider(value: value, in: range, step: step)
                .disabled(disabled)
        }
    }
}

protocol WeatherModeLabeled {
    var label: String { get }
}

extension NativeWeatherPhaseMode: WeatherModeLabeled {}
extension NativeWeatherDeclutterMode: WeatherModeLabeled {}
