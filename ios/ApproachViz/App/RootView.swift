import SwiftUI

struct RootView: View {
    @State private var appModel = AppModel()

    var body: some View {
        NavigationSplitView {
            AirportSidebarView(appModel: appModel)
        } content: {
            ApproachListView(appModel: appModel)
        } detail: {
            ApproachDetailView(appModel: appModel)
        }
        .task {
            await appModel.loadInitialData()
        }
    }
}

private struct AirportSidebarView: View {
    let appModel: AppModel

    var body: some View {
        VStack(spacing: 12) {
            TextField("Filter airports", text: Binding(
                get: { appModel.airportFilter },
                set: { appModel.airportFilter = $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .padding(.horizontal)
            List(appModel.filteredAirports, selection: Binding(
                get: { appModel.selectedAirportID },
                set: { newValue in
                    appModel.selectedAirportID = newValue
                    guard let airportID = newValue else { return }
                    Task {
                        await appModel.selectAirport(id: airportID)
                    }
                }
            )) { airport in
                VStack(alignment: .leading, spacing: 2) {
                    Text(airport.id)
                        .font(.headline)
                    Text(airport.label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .tag(airport.id)
            }
            .overlay {
                if appModel.filteredAirports.isEmpty {
                    ContentUnavailableView("No airports", systemImage: "airplane")
                }
            }
        }
        .navigationTitle("Airports")
    }
}

private struct ApproachListView: View {
    let appModel: AppModel

    var body: some View {
        List(appModel.approaches, selection: Binding(
            get: { appModel.selectedApproachID },
            set: { newValue in
                appModel.selectedApproachID = newValue
                guard let approachID = newValue else { return }
                Task {
                    await appModel.selectApproach(id: approachID)
                }
            }
        )) { approach in
            VStack(alignment: .leading, spacing: 4) {
                Text(approach.procedureID)
                    .font(.headline)
                Text("\(approach.type) • Runway \(approach.runway)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .tag(approach.procedureID)
        }
        .navigationTitle("Approaches")
        .overlay {
            if appModel.approaches.isEmpty {
                ContentUnavailableView("Select an airport", systemImage: "map")
            }
        }
    }
}

private struct ApproachDetailView: View {
    let appModel: AppModel

    var body: some View {
        ZStack {
            if let sceneData = appModel.sceneData {
                ApproachMetalSceneView(sceneData: sceneData, verticalScale: appModel.verticalScale)
            } else if let errorMessage = appModel.errorMessage {
                ContentUnavailableView("Unable to load data", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
            } else {
                ContentUnavailableView("Choose an approach", systemImage: "airplane.departure")
            }
        }
        .background(Color(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0))
        .navigationTitle(appModel.sceneData?.airport.id ?? "Scene")
        .safeAreaInset(edge: .bottom) {
            if appModel.sceneData != nil {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Vertical Scale \(appModel.verticalScale.formatted(.number.precision(.fractionLength(1))))x")
                        .font(.caption.weight(.semibold))
                    Slider(value: Binding(
                        get: { appModel.verticalScale },
                        set: { appModel.verticalScale = $0 }
                    ), in: 1...8, step: 0.5)
                }
                .padding()
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding()
            }
        }
    }
}
